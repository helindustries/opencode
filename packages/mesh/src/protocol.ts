// The session record as it travels between opencode servers, mesh nodes and desktop clients.
// Field names and defaults match the Python ocmesh, so registries and peers of either kind agree.

export const clientHints = ["desktop", "tui", "mobile"] as const
export const checkOutcomes = ["peer", "untrusted", "closed"] as const

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"])

export type ClientHint = (typeof clientHints)[number]
export type CheckOutcome = (typeof checkOutcomes)[number]

export type SessionRecord = {
  session_id: string
  origin_host: string
  harness: string
  server_url: string
  title: string
  directory: string
  project_id: string
  origin_user: string
  client_hint: ClientHint
  auth_blob: string
  harness_version: string
  capabilities: string[]
  group_tag: string | null
  shared_at: number
  last_seen: number
  revoked: boolean
  origin_addr: string | null
}

// One neighbour-table address checked for a mesh peer port. The mesh shares these, so an address
// is checked once by the mesh rather than once by every node; "peer" means a trusted node
// answered, possibly the checking node itself.
export type NeighbourCheck = {
  address: string
  mac: string
  outcome: CheckOutcome
  checked_at: number
  checked_by: string
}

export class ProtocolError extends Error {}

export function makeOrigin(harness: string, nodeID: string) {
  return `${harness}@${nodeID}`
}

// A machine may run several harnesses, each its own origin; the node is the part after the "@".
export function originNode(originHost: string) {
  return originHost.slice(originHost.lastIndexOf("@") + 1)
}

export function recordKey(record: SessionRecord) {
  return `${record.origin_host}\u0000${record.session_id}`
}

// Points server_url at the address the origin was heard from, so a client on another machine
// reaches an opencode server that only knows its own loopback port.
export function reachable(record: SessionRecord): SessionRecord {
  if (!record.origin_addr || !URL.canParse(record.server_url)) return record
  const url = new URL(record.server_url)
  if (!loopbackHosts.has(url.hostname.replace(/^\[|\]$/g, ""))) return record
  url.hostname = record.origin_addr.includes(":") ? `[${record.origin_addr}]` : record.origin_addr
  // URL adds a "/" path to a bare origin; the record keeps the shape it was published with.
  const rewritten = url.toString()
  return { ...record, server_url: record.server_url.endsWith("/") ? rewritten : rewritten.replace(/\/$/, "") }
}

// Parses and validates an incoming record. originHost, when given, overrides whatever the sender
// claimed: loopback publishers do not know the node identity.
export function parseRecord(payload: unknown, originHost?: string): SessionRecord {
  const object = requireObject(payload, "record")
  const hint = text(object, "client_hint") || "tui"
  if (!clientHints.includes(hint as ClientHint))
    throw new ProtocolError(`client_hint: expected one of ${clientHints.join(", ")}, got ${JSON.stringify(hint)}`)
  const capabilities = object.capabilities ?? []
  if (!Array.isArray(capabilities) || !capabilities.every((item) => typeof item === "string"))
    throw new ProtocolError("capabilities: expected a list of strings")
  const lastSeen = millis(object, "last_seen", Date.now())
  return {
    session_id: text(object, "session_id", true),
    origin_host: originHost ?? text(object, "origin_host", true),
    harness: text(object, "harness", true),
    server_url: text(object, "server_url"),
    title: text(object, "title"),
    directory: text(object, "directory"),
    project_id: text(object, "project_id"),
    origin_user: text(object, "origin_user"),
    client_hint: hint as ClientHint,
    auth_blob: text(object, "auth_blob"),
    harness_version: text(object, "harness_version"),
    capabilities,
    group_tag: nullableText(object, "group_tag"),
    shared_at: millis(object, "shared_at", lastSeen),
    last_seen: lastSeen,
    revoked: Boolean(object.revoked ?? false),
    origin_addr: nullableText(object, "origin_addr"),
  }
}

export function parseCheck(payload: unknown): NeighbourCheck {
  const object = requireObject(payload, "check")
  const outcome = text(object, "outcome", true)
  if (!checkOutcomes.includes(outcome as CheckOutcome))
    throw new ProtocolError(`outcome: expected one of ${checkOutcomes.join(", ")}, got ${JSON.stringify(outcome)}`)
  if (!("checked_at" in object)) throw new ProtocolError("checked_at: expected epoch milliseconds, got nothing")
  return {
    address: text(object, "address", true),
    mac: text(object, "mac", true),
    outcome: outcome as CheckOutcome,
    checked_at: millis(object, "checked_at", 0),
    checked_by: text(object, "checked_by", true),
  }
}

function requireObject(payload: unknown, name: string) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    throw new ProtocolError(`${name}: expected a JSON object, got ${Array.isArray(payload) ? "array" : typeof payload}`)
  return payload as Record<string, unknown>
}

function text(object: Record<string, unknown>, name: string, required = false) {
  const value = object[name] ?? ""
  if (typeof value !== "string") throw new ProtocolError(`${name}: expected a string, got ${typeof value}`)
  if (required && !value) throw new ProtocolError(`${name}: expected a non-empty string`)
  return value
}

function nullableText(object: Record<string, unknown>, name: string) {
  const value = object[name] ?? null
  if (value !== null && typeof value !== "string") throw new ProtocolError(`${name}: expected a string or null`)
  return value
}

function millis(object: Record<string, unknown>, name: string, fallback: number) {
  const value = object[name] ?? fallback
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ProtocolError(`${name}: expected epoch milliseconds, got ${JSON.stringify(value)}`)
  return Math.trunc(value)
}
