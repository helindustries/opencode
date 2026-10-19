// The node: identity, registry and event bus behind both listeners and the peer followers.

import os from "node:os"
import path from "node:path"
import type { MeshConfig } from "./config"
import { EventBus } from "./events"
import { type Identity, loadIdentity } from "./identity"
import {
  makeOrigin,
  type NeighbourCheck,
  originNode,
  parseCheck,
  parseRecord,
  reachable,
  type SessionRecord,
} from "./protocol"
import { loadCipher, Store } from "./store"

export const maxClockSkewMs = 60_000

export class MeshNode {
  readonly bus = new EventBus()

  constructor(
    readonly config: MeshConfig,
    readonly identity: Identity,
    readonly store: Store,
  ) {}

  static async open(config: MeshConfig) {
    const identity = await loadIdentity(config.storageDir, config.nodeName)
    return new MeshNode(config, identity, new Store(path.join(config.storageDir, "sessions.db"), await loadCipher(config.storageDir)))
  }

  get nodeID() {
    return this.identity.nodeID
  }

  close() {
    this.store.close()
  }

  // A loopback publisher (an opencode server on this machine) shares a session hosted here.
  publishLocal(payload: unknown) {
    const harness = typeof payload === "object" && payload !== null ? (payload as { harness?: unknown }).harness : undefined
    const record = parseRecord(payload, makeOrigin(String(harness ?? ""), this.nodeID))
    const now = Date.now()
    return this.commit({
      ...record,
      origin_addr: null,
      origin_user: record.origin_user || os.userInfo().username,
      last_seen: now,
      shared_at: Math.min(record.shared_at, now),
    })
  }

  // Merges a record a peer told us about. Our own live records coming back are dropped, which
  // stops a ring of peers from echoing updates forever; our own tombstones are kept, since any
  // node may forget a session we share.
  acceptFromPeer(payload: unknown, peerNodeID: string, peerHost: string) {
    const record = parseRecord(payload)
    if (originNode(record.origin_host) === this.nodeID && !record.revoked) return undefined
    const ceiling = Date.now() + maxClockSkewMs
    const heardFrom = originNode(record.origin_host) === peerNodeID ? peerHost : undefined
    return this.commit({
      ...record,
      last_seen: Math.min(record.last_seen, ceiling),
      shared_at: Math.min(record.shared_at, ceiling),
      origin_addr: heardFrom ?? record.origin_addr,
    })
  }

  revoke(originHost: string, sessionID: string) {
    const existing = this.store.get(originHost, sessionID)
    if (!existing) return undefined
    return this.commit({ ...existing, revoked: true, last_seen: Date.now() })
  }

  sessions(harness?: string, includeRevoked = false) {
    return this.store.sessions(harness, includeRevoked).map(reachable)
  }

  peers() {
    return this.store.peers()
  }

  setPeer(address: string, nodeID: string | null, status: string, error: string | null) {
    if (this.store.setPeer(address, nodeID, status, error, Date.now())) this.bus.publish("peers.changed", this.peers())
  }

  recordCheck(check: NeighbourCheck) {
    if (this.store.upsertCheck(check)) this.bus.publish("checked.update", check)
  }

  acceptCheckFromPeer(payload: unknown) {
    const check = parseCheck(payload)
    this.recordCheck({ ...check, checked_at: Math.min(check.checked_at, Date.now() + maxClockSkewMs) })
  }

  checks() {
    return this.store.checks()
  }

  stats() {
    const peers = this.peers()
    return {
      node_id: this.nodeID,
      node_name: this.config.nodeName,
      sessions: this.store.counts(),
      peers: { total: peers.length, up: peers.filter((peer) => peer.status === "up").length },
    }
  }

  private commit(record: SessionRecord) {
    const [stored, changed] = this.store.upsert(record)
    if (changed) this.bus.publish(stored.revoked ? "session.revoke" : "session.upsert", stored)
    return stored
  }
}
