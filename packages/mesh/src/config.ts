// The mesh config, ~/.config/opencode/ocmesh.toml (or OCMESH_CONFIG, or --config); every key is
// optional and the names are the Python ocmesh's, so an existing config keeps working. quiet turns
// on the 2 s handshake deadline and peer discovery through the neighbour table.

import os from "node:os"
import path from "node:path"

export const defaultPort = 47613
export const defaultPeerPort = 47614
export const tlsModes = ["mutual", "off"] as const
export const configEnv = "OCMESH_CONFIG"

export type MeshConfig = {
  port: number
  peerPort: number
  bind: string
  storageDir: string
  peers: string[]
  tls: (typeof tlsModes)[number]
  nodeName: string
  quiet: boolean
}

export function defaultConfigPath() {
  return path.join(os.homedir(), ".config", "opencode", "ocmesh.toml")
}

export function defaultStorageDir() {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, "ocmesh")
  return path.join(os.homedir(), ".local", "share", "ocmesh")
}

export function defaultConfig(): MeshConfig {
  return {
    port: defaultPort,
    peerPort: defaultPeerPort,
    bind: "0.0.0.0",
    storageDir: defaultStorageDir(),
    peers: [],
    tls: "mutual",
    nodeName: os.hostname(),
    quiet: false,
  }
}

export function splitAddress(address: string): [string, number] {
  const separator = address.lastIndexOf(":")
  const host = address.slice(0, Math.max(separator, 0))
  const port = address.slice(separator + 1)
  if (separator < 1 || !/^\d+$/.test(port))
    throw new Error(`peer address: expected 'host:port', got ${JSON.stringify(address)}`)
  return [host.replace(/^\[|\]$/g, ""), Number(port)]
}

// A missing file means all defaults.
export async function loadConfig(file?: string): Promise<MeshConfig> {
  const source = file ?? process.env[configEnv] ?? defaultConfigPath()
  const handle = Bun.file(source)
  const table: Record<string, unknown> = (await handle.exists()) ? Bun.TOML.parse(await handle.text()) as Record<string, unknown> : {}
  const defaults = defaultConfig()
  const peers = typed(table, "peers", "array", defaults.peers) as unknown[]
  if (!peers.every((peer) => typeof peer === "string" && peer.includes(":")))
    throw new Error(`ocmesh config: peers expected a list of 'host:port' strings, got ${JSON.stringify(peers)}`)
  const tls = typed(table, "tls", "string", defaults.tls)
  if (!tlsModes.includes(tls as MeshConfig["tls"]))
    throw new Error(`ocmesh config: tls expected one of ${tlsModes.join(", ")}, got ${JSON.stringify(tls)}`)
  if (table.discover_mdns === true)
    throw new Error("ocmesh config: discover_mdns = true is not supported; use quiet = true, peers, or /rc <host>")
  const quiet = typed(table, "quiet", "boolean", defaults.quiet) as boolean
  if (quiet && tls !== "mutual")
    throw new Error(`ocmesh config: quiet = true expected tls = "mutual", got ${JSON.stringify(tls)}`)
  const storage = typed(table, "storage_dir", "string", defaults.storageDir) as string
  return {
    port: typed(table, "port", "integer", defaults.port) as number,
    peerPort: typed(table, "peer_port", "integer", defaults.peerPort) as number,
    bind: typed(table, "bind", "string", defaults.bind) as string,
    storageDir: storage.startsWith("~") ? path.join(os.homedir(), storage.slice(1)) : storage,
    peers: peers as string[],
    tls: tls as MeshConfig["tls"],
    nodeName: typed(table, "node_name", "string", defaults.nodeName) as string,
    quiet,
  }
}

function typed(table: Record<string, unknown>, name: string, expected: "string" | "integer" | "boolean" | "array", fallback: unknown) {
  const value = table[name] ?? fallback
  const matches =
    expected === "array"
      ? Array.isArray(value)
      : expected === "integer"
        ? Number.isInteger(value)
        : typeof value === expected
  if (!matches) throw new Error(`ocmesh config: ${name} expected ${expected}, got ${JSON.stringify(value)}`)
  return value
}
