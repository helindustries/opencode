import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { defaultConfig, type MeshConfig } from "../src/config"
import { loadIdentity } from "../src/identity"
import type { Neighbour } from "../src/neighbours"
import type { NeighbourCheck, SessionRecord } from "../src/protocol"
import { MeshService } from "../src/service"
import type { Peer } from "../src/store"

export const pollIntervalMs = 25
export const fastNeighbourPollMs = 100

export function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mesh-test-"))
  return { path: directory, [Symbol.dispose]: () => rmSync(directory, { recursive: true, force: true }) }
}

export async function freePort() {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as net.AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

// Polls until condition returns something truthy, for at most timeoutMs, and returns that value.
export async function waitFor<T>(condition: () => T | Promise<T>, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await condition()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await Bun.sleep(pollIntervalMs)
  }
}

export async function call<T = Record<string, unknown>>(
  port: number,
  method: string,
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as T }
}

export function record(sessionID = "ses_1", fields: Record<string, unknown> = {}) {
  return {
    session_id: sessionID,
    harness: "opencode",
    harness_version: "1.0.0",
    server_url: "http://127.0.0.1:4096",
    title: "first",
    directory: "/work",
    auth_blob: "b3BlbmNvZGU6c2VjcmV0",
    ...fields,
  }
}

export function config(storageDir: string, fields: Partial<MeshConfig> = {}): MeshConfig {
  return { ...defaultConfig(), port: 0, peerPort: 0, bind: "127.0.0.1", storageDir, nodeName: "test", tls: "off", ...fields }
}

// Mesh nodes named after their loopback address, all on one peer port the way machines on a LAN
// share it; every node trusts every other unless paired is given. Binding 127.0.0.2 and up needs
// the whole 127/8 on loopback, which Linux and Windows have and macOS does not.
export class Mesh {
  readonly services = new Map<string, MeshService>()

  private constructor(
    readonly root: string,
    readonly addresses: Record<string, string>,
    readonly peerPort: number,
  ) {}

  static async create(root: string, addresses: Record<string, string>, paired?: [string, string][]) {
    const identities = Object.fromEntries(
      await Promise.all(Object.keys(addresses).map(async (name) => [name, await loadIdentity(path.join(root, name), name)] as const)),
    )
    const pairs = paired ?? Object.keys(addresses).flatMap((left) => Object.keys(addresses).filter((right) => right !== left).map((right) => [left, right] as [string, string]))
    pairs.forEach(([left, right]) => {
      identities[left].admit(identities[right].certPEM)
      identities[right].admit(identities[left].certPEM)
    })
    return new Mesh(root, addresses, await freePort())
  }

  address(name: string) {
    return `${this.addresses[name]}:${this.peerPort}`
  }

  async start(name: string, options: { neighbours?: Neighbour[]; peers?: string[]; quiet?: boolean } = {}) {
    const service = await MeshService.open(
      config(path.join(this.root, name), {
        peerPort: this.peerPort,
        bind: this.addresses[name],
        tls: "mutual",
        nodeName: name,
        quiet: options.quiet ?? true,
        peers: options.peers ?? [],
      }),
    )
    if (service.watcher) {
      const neighbours = options.neighbours ?? []
      service.watcher.reader = async () => neighbours
      service.watcher.pollMs = fastNeighbourPollMs
    }
    service.start()
    this.services.set(name, service)
    return service
  }

  async stop() {
    await Promise.all([...this.services.values()].map((service) => service.stop()))
    this.services.clear()
  }

  // Declared after the temporary directory, so the nodes close their databases before it goes.
  [Symbol.asyncDispose]() {
    return this.stop()
  }
}

export async function peerUp(service: MeshService, address: string) {
  const reply = await call<Peer[]>(service.loopback.port, "GET", "/v1/peers")
  return reply.body.some((peer) => peer.address === address && peer.status === "up")
}

export async function checks(service: MeshService) {
  const reply = await call<NeighbourCheck[]>(service.loopback.port, "GET", "/v1/checked")
  return new Map(reply.body.map((check) => [`${check.address} ${check.mac}`, check]))
}

export async function sessions(service: MeshService) {
  return (await call<SessionRecord[]>(service.loopback.port, "GET", "/v1/sessions")).body
}
