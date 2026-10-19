// Peer followers. Each known peer gets one loop that pulls the peer's trust bundle, full registry
// (tombstones included), checked neighbours and peer list, then follows its event stream until
// the connection drops, and starts over with backoff. Following every peer of a peer is what lets
// the first node a newcomer reaches populate it. Over connections the follower opens itself it
// also pushes this node's records and changes, so a peer that cannot connect out (a firewall that
// only admits inbound, a macOS job without Local Network permission) still learns them. A peer
// going down only marks the peer down; the sessions it shared stay in the registry.
//
// Trap: streamTimeoutMs must outlast the server's keepalive interval, or idle streams are
// mistaken for dead peers.

import type { ClientRequest, IncomingMessage } from "node:http"
import https from "node:https"
import type { TLSSocket } from "node:tls"
import { peerPortHeader } from "./api"
import { splitAddress } from "./config"
import { resetEvent, type Subscription } from "./events"
import { fingerprintDER } from "./identity"
import { log } from "./log"
import type { MeshNode } from "./node"
import { originNode, reachable, type SessionRecord } from "./protocol"
import type { Peer } from "./store"

export const connectTimeoutMs = 5_000
export const streamTimeoutMs = 45_000
export const backoffInitialMs = 1_000
export const backoffMaxMs = 30_000

const wildcardHosts = new Set(["", "0.0.0.0", "::"])
const logger = log("sync")

export class PeerError extends Error {}

export class PeerManager {
  // A node bound to one address also connects out from it: peers follow back to the address a
  // connection came from, which must be the one listening.
  readonly sourceAddress: string | undefined
  private readonly followers = new Map<string, Follower>()
  private stopped = false

  constructor(
    readonly node: MeshNode,
    public advertisedPort: number,
    private readonly onAdmit: () => void,
    bind = "",
  ) {
    this.sourceAddress = wildcardHosts.has(bind) ? undefined : bind
  }

  admit(pem: string) {
    if (this.node.identity.admit(pem)) this.onAdmit()
  }

  add(address: string, nodeID?: string | null) {
    if (nodeID === this.node.nodeID || this.stopped || this.followers.has(address)) return
    const follower = new Follower(this, address)
    this.followers.set(address, follower)
    follower.start()
  }

  addresses() {
    return [...this.followers.keys()]
  }

  // Waits until every follower pulled its peer once or failed trying, so what the mesh already
  // knows is here before anything acts on what is missing.
  async settle(timeoutMs: number) {
    const all = [...this.followers.values()].map((follower) => follower.attempted)
    await Promise.race([Promise.all(all), Bun.sleep(timeoutMs)])
  }

  async stop() {
    this.stopped = true
    const followers = [...this.followers.values()]
    this.followers.clear()
    followers.forEach((follower) => follower.stop())
    await Promise.race([Promise.all(followers.map((follower) => follower.done)), Bun.sleep(connectTimeoutMs)])
  }
}

class Follower {
  readonly host: string
  readonly port: number
  readonly attempted: Promise<void>
  done: Promise<void> = Promise.resolve()
  private stopped = false
  private streamed = false
  private markAttempted = () => {}
  private wake = () => {}
  private readonly requests = new Set<ClientRequest>()

  constructor(
    private readonly manager: PeerManager,
    readonly address: string,
  ) {
    ;[this.host, this.port] = splitAddress(address)
    this.attempted = new Promise((resolve) => (this.markAttempted = resolve))
  }

  start() {
    this.done = this.run()
  }

  stop() {
    this.stopped = true
    this.markAttempted()
    this.requests.forEach((request) => request.destroy())
    this.wake()
  }

  private async run() {
    let backoff = backoffInitialMs
    while (!this.stopped) {
      this.streamed = false
      await this.syncOnce().catch((error: Error) => {
        if (this.stopped) return
        logger(`peer ${this.address} down: ${error.message}`)
        this.manager.node.setPeer(this.address, null, "down", error.message)
      })
      this.markAttempted()
      if (this.streamed) backoff = backoffInitialMs
      await this.pause(backoff)
      backoff = Math.min(backoff * 2, backoffMaxMs)
    }
  }

  private async syncOnce() {
    const node = this.manager.node
    const trust = await this.request("GET", "/v1/trust", connectTimeoutMs)
    const der = (trust.socket as TLSSocket).getPeerCertificate(true)?.raw
    const peerID = der ? fingerprintDER(der) : undefined
    if (!peerID || peerID === node.nodeID) {
      this.stopped = true
      trust.destroy()
      throw new PeerError(`${this.address} is this node`)
    }
    const bundle = (await readJSON(trust, `${this.address}/v1/trust`)) as { certificates: string[] }
    bundle.certificates.forEach((pem) => this.manager.admit(pem))
    const records = (await this.getJSON("/v1/sessions?include_revoked=1")) as unknown[]
    records.forEach((record) => node.acceptFromPeer(record, peerID, this.host))
    const checks = (await this.getJSON("/v1/checked")) as unknown[]
    checks.forEach((check) => node.acceptCheckFromPeer(check))
    this.inherit((await this.getJSON("/v1/peers")) as Peer[])
    this.markAttempted()

    const changes = node.bus.subscribe()
    try {
      const events = await this.request("GET", "/v1/events", streamTimeoutMs)
      if (events.statusCode !== 200) throw new PeerError(`${this.address}/v1/events: expected 200, got ${events.statusCode}`)
      node.setPeer(this.address, peerID, "up", null)
      this.streamed = true
      void this.push(peerID, changes)
      for await (const event of sseEvents(events)) {
        if (event.name === "session.upsert" || event.name === "session.revoke")
          node.acceptFromPeer(event.data, peerID, this.host)
        if (event.name === "checked.update") node.acceptCheckFromPeer(event.data)
        if (event.name === "peers.changed") this.inherit(event.data as Peer[])
      }
    } finally {
      node.bus.unsubscribe(changes)
      changes.reset()
    }
    throw new PeerError(`${this.address}: event stream ended`)
  }

  private inherit(peers: Peer[]) {
    peers.forEach((peer) => this.manager.add(peer.address, peer.node_id))
  }

  private async push(peerID: string, changes: Subscription) {
    await this.post(peerID, this.manager.node.store.sessions(undefined, true))
      .then(async () => {
        for (;;) {
          const event = await changes.next()
          if (!event || event.name === resetEvent) return
          if (event.name.startsWith("session.")) await this.post(peerID, [event.data as SessionRecord])
        }
      })
      .catch((error: Error) => logger(`push to ${this.address} stopped: ${error.message}`))
  }

  // A peer refuses its own live records back (409), so those are left out.
  private async post(peerID: string, records: SessionRecord[]) {
    const wanted = records.filter((record) => originNode(record.origin_host) !== peerID || record.revoked)
    for (const record of wanted) {
      if (this.stopped) return
      const response = await this.request("POST", "/v1/sessions", connectTimeoutMs, JSON.stringify(reachable(record)))
      const body = await readBody(response)
      if (response.statusCode !== 200)
        throw new PeerError(`${this.address}: push expected 200, got ${response.statusCode}: ${body.slice(0, 200)}`)
    }
  }

  private async getJSON(pathname: string) {
    return readJSON(await this.request("GET", pathname, connectTimeoutMs), `${this.address}${pathname}`)
  }

  private request(method: string, pathname: string, timeoutMs: number, body?: string) {
    return new Promise<IncomingMessage>((resolve, reject) => {
      const request = https.request(
        {
          host: this.host,
          port: this.port,
          path: pathname,
          method,
          agent: false,
          localAddress: this.manager.sourceAddress,
          ...this.manager.node.identity.tlsOptions(),
          checkServerIdentity: () => undefined,
          headers: {
            [peerPortHeader]: String(this.manager.advertisedPort),
            ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
          },
        },
        resolve,
      )
      this.requests.add(request)
      request.once("close", () => this.requests.delete(request))
      request.setTimeout(timeoutMs, () =>
        request.destroy(new PeerError(`${this.address}${pathname}: nothing received for ${timeoutMs} ms`)),
      )
      request.once("error", reject)
      request.end(body)
    })
  }

  private pause(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      this.wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }
}

async function readBody(response: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of response) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

async function readJSON(response: IncomingMessage, what: string): Promise<unknown> {
  const body = await readBody(response)
  if (response.statusCode !== 200) throw new PeerError(`${what}: expected 200, got ${response.statusCode}`)
  return JSON.parse(body)
}

async function* sseEvents(response: IncomingMessage) {
  let buffer = ""
  let name = "message"
  let data = ""
  for await (const chunk of response) {
    buffer += (chunk as Buffer).toString("utf8")
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).replace(/\r$/, "")
      buffer = buffer.slice(index + 1)
      if (!line) {
        if (data) yield { name, data: JSON.parse(data) as unknown }
        name = "message"
        data = ""
        continue
      }
      if (line.startsWith("event:")) name = line.slice(6).trim()
      if (line.startsWith("data:")) data += line.slice(5).trim()
    }
  }
}
