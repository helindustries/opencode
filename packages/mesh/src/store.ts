// SQLite registry of every session the mesh knows about, keyed by (origin_host, session_id), plus
// the peer status table and the mesh-wide list of checked neighbours. The schema and the
// encrypted auth_blob are the Python ocmesh's, so an existing node's storage opens as is.
//
// Merge rules: live records are last-writer-wins on last_seen. A tombstone (revoked, its
// last_seen being the revocation time) beats any share whose shared_at is not newer, so a
// heartbeat from a stale publisher can never resurrect a forgotten session; only a fresh share
// started after the revocation can.

import { Database } from "bun:sqlite"
import { chmodSync } from "node:fs"
import path from "node:path"
import { Fernet } from "./fernet"
import type { CheckOutcome, ClientHint, NeighbourCheck, SessionRecord } from "./protocol"

const schema = `
create table if not exists sessions (
    origin_host text not null,
    session_id text not null,
    harness text not null,
    harness_version text not null,
    capabilities text not null,
    server_url text not null,
    title text not null,
    directory text not null,
    project_id text not null,
    origin_user text not null,
    client_hint text not null,
    auth_blob blob,
    group_tag text,
    shared_at integer not null,
    last_seen integer not null,
    revoked integer not null,
    origin_addr text,
    primary key (origin_host, session_id)
);
create table if not exists peers (
    address text primary key,
    node_id text,
    status text not null,
    error text,
    last_ok integer,
    last_change integer not null
);
create table if not exists checked (
    address text not null,
    mac text not null,
    outcome text not null,
    checked_at integer not null,
    checked_by text not null,
    primary key (address, mac)
);
`

const columns = [
  "origin_host",
  "session_id",
  "harness",
  "harness_version",
  "capabilities",
  "server_url",
  "title",
  "directory",
  "project_id",
  "origin_user",
  "client_hint",
  "auth_blob",
  "group_tag",
  "shared_at",
  "last_seen",
  "revoked",
  "origin_addr",
] as const

export type Peer = {
  address: string
  node_id: string | null
  status: string
  error: string | null
  last_ok: number | null
  last_change: number
}

type SessionRow = Omit<SessionRecord, "capabilities" | "auth_blob" | "revoked"> & {
  capabilities: string
  auth_blob: Uint8Array | null
  revoked: number
}

// The key that encrypts auth_blob at rest never leaves the machine.
export async function loadCipher(storageDir: string) {
  const keyPath = path.join(storageDir, "blob.key")
  if (!(await Bun.file(keyPath).exists())) {
    await Bun.write(keyPath, Fernet.generateKey())
    if (process.platform !== "win32") chmodSync(keyPath, 0o600)
  }
  // A fresh handle: one made before the write still reports the file as empty.
  return new Fernet((await Bun.file(keyPath).text()).trim())
}

// The record to store, or undefined when incoming changes nothing.
export function merge(existing: SessionRecord | undefined, incoming: SessionRecord): SessionRecord | undefined {
  if (!existing) return incoming
  if (existing.revoked && incoming.revoked)
    return incoming.last_seen > existing.last_seen ? { ...existing, last_seen: incoming.last_seen } : undefined
  if (existing.revoked) return incoming.shared_at > existing.last_seen ? incoming : undefined
  if (incoming.revoked)
    return incoming.last_seen >= existing.shared_at
      ? { ...existing, revoked: true, auth_blob: "", last_seen: incoming.last_seen }
      : undefined
  if (incoming.last_seen <= existing.last_seen) return undefined
  return incoming.origin_addr || !existing.origin_addr ? incoming : { ...incoming, origin_addr: existing.origin_addr }
}

export class Store {
  readonly db: Database

  constructor(
    file: string,
    private readonly cipher: Fernet,
  ) {
    this.db = new Database(file, { create: true })
    this.db.exec("pragma journal_mode=wal")
    this.db.exec(schema)
  }

  close() {
    this.db.close()
  }

  get(originHost: string, sessionID: string) {
    const row = this.db
      .query<SessionRow, [string, string]>(
        `select ${columns.join(", ")} from sessions where origin_host = ? and session_id = ?`,
      )
      .get(originHost, sessionID)
    return row ? this.fromRow(row) : undefined
  }

  // Merges incoming; returns the stored record and whether anything changed.
  upsert(incoming: SessionRecord): [SessionRecord, boolean] {
    const existing = this.get(incoming.origin_host, incoming.session_id)
    const merged = merge(existing, incoming)
    if (merged)
      this.db
        .query(`insert or replace into sessions (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`)
        .run(...this.toRow(merged))
    return [merged ?? existing!, merged !== undefined]
  }

  sessions(harness?: string, includeRevoked = false) {
    const where = [harness ? "harness = ?" : undefined, includeRevoked ? undefined : "revoked = 0"].filter(Boolean)
    const sql = `select ${columns.join(", ")} from sessions${where.length ? ` where ${where.join(" and ")}` : ""} order by last_seen desc`
    return this.db
      .query<SessionRow, string[]>(sql)
      .all(...(harness ? [harness] : []))
      .map((row) => this.fromRow(row))
  }

  counts() {
    const byHarness = Object.fromEntries(
      this.db
        .query<{ harness: string; count: number }, []>(
          "select harness, count(*) as count from sessions where revoked = 0 group by harness",
        )
        .all()
        .map((row) => [row.harness, row.count]),
    )
    const revoked = this.db.query<{ count: number }, []>("select count(*) as count from sessions where revoked = 1").get()!
    return {
      live: Object.values(byHarness).reduce((sum, count) => sum + count, 0),
      revoked: revoked.count,
      by_harness: byHarness,
    }
  }

  // Records a peer's state; returns whether its status changed.
  setPeer(address: string, nodeID: string | null, status: string, error: string | null, now: number) {
    const row = this.db
      .query<Pick<Peer, "node_id" | "status" | "last_ok" | "last_change">, [string]>(
        "select node_id, status, last_ok, last_change from peers where address = ?",
      )
      .get(address)
    const changed = !row || row.status !== status
    this.db
      .query("insert or replace into peers values (?, ?, ?, ?, ?, ?)")
      .run(
        address,
        nodeID ?? row?.node_id ?? null,
        status,
        error,
        status === "up" ? now : (row?.last_ok ?? null),
        changed ? now : row.last_change,
      )
    return changed
  }

  peers() {
    return this.db
      .query<Peer, []>("select address, node_id, status, error, last_ok, last_change from peers")
      .all()
  }

  // Keeps the newest check per address and MAC. Keyed by the pair, because two nodes whose
  // neighbour tables briefly disagree about an address would otherwise each see the other's
  // check as a changed MAC and re-check it in turn forever.
  upsertCheck(check: NeighbourCheck) {
    const row = this.db
      .query<{ checked_at: number }, [string, string]>("select checked_at from checked where address = ? and mac = ?")
      .get(check.address, check.mac)
    const changed = !row || check.checked_at > row.checked_at
    if (changed)
      this.db
        .query("insert or replace into checked values (?, ?, ?, ?, ?)")
        .run(check.address, check.mac, check.outcome, check.checked_at, check.checked_by)
    return changed
  }

  checks() {
    return this.db
      .query<NeighbourCheck & { outcome: CheckOutcome }, []>(
        "select address, mac, outcome, checked_at, checked_by from checked order by address, mac",
      )
      .all()
  }

  private toRow(record: SessionRecord) {
    return columns.map((column) => {
      if (column === "capabilities") return JSON.stringify(record.capabilities)
      if (column === "auth_blob") return record.auth_blob ? this.cipher.encrypt(record.auth_blob) : null
      if (column === "revoked") return record.revoked ? 1 : 0
      return record[column]
    })
  }

  private fromRow(row: SessionRow): SessionRecord {
    return {
      ...row,
      client_hint: row.client_hint as ClientHint,
      capabilities: JSON.parse(row.capabilities),
      auth_blob: row.auth_blob ? this.cipher.decrypt(row.auth_blob) : "",
      revoked: Boolean(row.revoked),
    }
  }
}
