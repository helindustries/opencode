// HTTP API. One router serves two listeners: plain HTTP on loopback, where the caller is the local
// user, and mutual TLS on the LAN, where the caller is the peer whose certificate the trust bundle
// admitted.
//
// Bun's HTTP server does not expose the client certificate, so the peer port is a node:tls server
// that verifies the certificate, then forwards the decrypted stream to an internal loopback HTTP
// server. The internal server recognises each forwarded connection by the local port it came
// from; a local process that connects to it directly has no such entry and is refused.

import net from "node:net"
import tls from "node:tls"
import manifest from "../package.json" with { type: "json" }
import { splitAddress } from "./config"
import { resetEvent } from "./events"
import { fingerprintDER } from "./identity"
import { log } from "./log"
import type { MeshNode } from "./node"
import { ProtocolError, reachable, type SessionRecord } from "./protocol"

export const peerPortHeader = "x-ocmesh-peer-port"
export const keepaliveMs = 15_000
export const handshakeTimeoutMs = 10_000
export const quietHandshakeTimeoutMs = 2_000

const maxBodyBytes = 1 << 20
const loopbackNames = new Set(["127.0.0.1", "localhost", "::1"])
const logger = log("api")

export type Caller = { kind: "loopback" } | { kind: "peer"; nodeID: string; address: string }
export type OnPeer = (address: string, nodeID?: string) => void

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function createRouter(node: MeshNode, onPeer: () => OnPeer | undefined) {
  return async (request: Request, caller: Caller) => {
    const url = new URL(request.url)
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
    const route = `${request.method} ${parts.join("/")}`
    try {
      checkCaller(request, caller, onPeer())
      if (route === "GET health") return json({ ok: true, node_id: node.nodeID, version: manifest.version })
      if (route === "GET v1/sessions") {
        const includeRevoked = ["1", "true"].includes(url.searchParams.get("include_revoked") ?? "")
        return json(node.sessions(url.searchParams.get("harness") ?? undefined, includeRevoked))
      }
      if (route === "POST v1/sessions") return json(reachable(await postSession(node, request, caller)))
      if (request.method === "DELETE" && parts.length === 4 && parts[0] === "v1" && parts[1] === "sessions") {
        const record = node.revoke(parts[2], parts[3])
        if (!record) throw new HttpError(404, `no session ${parts[3]} from ${parts[2]}`)
        return json(reachable(record))
      }
      if (route === "GET v1/events") return stream(node)
      if (route === "GET v1/stats") return json(node.stats())
      if (route === "GET v1/peers") return json(node.peers())
      if (route === "POST v1/peers") return json(await postPeer(node, request, caller, onPeer()))
      if (route === "GET v1/checked") return json(node.checks())
      if (route === "GET v1/trust") return json({ node_id: node.nodeID, certificates: node.identity.bundle() })
      throw new HttpError(404, `no route for ${request.method} ${url.pathname}`)
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status)
      if (error instanceof ProtocolError) return json({ error: error.message }, 400)
      throw error
    }
  }
}

// Loopback trusts the local user but refuses foreign Host headers, which is what a DNS-rebinding
// web page would send. The LAN listener already required a trusted certificate.
function checkCaller(request: Request, caller: Caller, onPeer: OnPeer | undefined) {
  if (caller.kind === "loopback") {
    const host = (request.headers.get("host") ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "")
    if (!loopbackNames.has(host))
      throw new HttpError(403, `loopback API expects a loopback Host header, got ${JSON.stringify(host)}`)
    return
  }
  const port = request.headers.get(peerPortHeader)
  if (onPeer && port && /^\d+$/.test(port)) onPeer(`${caller.address}:${Number(port)}`, caller.nodeID)
}

async function readJSON(request: Request) {
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json"))
    throw new HttpError(415, "expected Content-Type: application/json")
  const length = Number(request.headers.get("content-length") ?? 0)
  if (!(length > 0 && length <= maxBodyBytes))
    throw new HttpError(400, `expected a JSON body of 1..${maxBodyBytes} bytes`)
  const text = await request.text()
  if (!text) throw new HttpError(400, "expected valid JSON: empty body")
  return parseJSON(text)
}

function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new HttpError(400, `expected valid JSON: ${(error as Error).message}`)
  }
}

async function postSession(node: MeshNode, request: Request, caller: Caller): Promise<SessionRecord> {
  const payload = await readJSON(request)
  if (caller.kind === "loopback") return node.publishLocal(payload)
  const record = node.acceptFromPeer(payload, caller.nodeID, caller.address)
  if (!record) throw new HttpError(409, "a peer may not publish records of this node")
  return record
}

// Loopback only: the local user asks this node to sync with another machine.
async function postPeer(node: MeshNode, request: Request, caller: Caller, onPeer: OnPeer | undefined) {
  if (caller.kind !== "loopback") throw new HttpError(403, "peers can only be added over the loopback API")
  if (!onPeer) throw new HttpError(409, 'peer sync is off (tls = "off")')
  const payload = await readJSON(request)
  const address = typeof payload === "object" && payload !== null ? (payload as { address?: unknown }).address : undefined
  if (typeof address !== "string") throw new HttpError(400, "address: expected a 'host:port' string")
  try {
    splitAddress(address)
  } catch (error) {
    throw new HttpError(400, (error as Error).message)
  }
  onPeer(address)
  return node.peers()
}

function stream(node: MeshNode) {
  const subscription = node.bus.subscribe()
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"))
      },
      async pull(controller) {
        const event = await subscription.next(keepaliveMs)
        if (!event) return controller.enqueue(encoder.encode(": keepalive\n\n"))
        if (event.name === resetEvent) {
          node.bus.unsubscribe(subscription)
          return controller.close()
        }
        const data = event.name.startsWith("session.") ? reachable(event.data as SessionRecord) : event.data
        controller.enqueue(encoder.encode(`event: ${event.name}\ndata: ${JSON.stringify(data)}\n\n`))
      },
      cancel() {
        node.bus.unsubscribe(subscription)
      },
    }),
    { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
  )
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status })
}

export type Listener = { port: number; close: () => Promise<void> }

export function serveLoopback(port: number, route: ReturnType<typeof createRouter>): Listener {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    // Event streams idle between keepalives; Bun's default 10 s idle timeout would cut them.
    idleTimeout: 0,
    fetch: (request) => route(request, { kind: "loopback" }),
  })
  return { port: server.port!, close: () => server.stop(true) }
}

type Forwarded = { nodeID: string; address: string }

export function servePeers(input: {
  bind: string
  port: number
  handshakeTimeoutMs: number
  tlsOptions: () => tls.SecureContextOptions
  route: ReturnType<typeof createRouter>
}) {
  const forwarded = new Map<number, Forwarded>()
  const internal = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(request, server) {
      const peer = forwarded.get(server.requestIP(request)?.port ?? -1)
      if (!peer) return json({ error: "expected a connection through the peer port" }, 403)
      return input.route(request, { kind: "peer", ...peer })
    },
  })
  const listener = tls.createServer({ ...input.tlsOptions(), requestCert: true, rejectUnauthorized: true })
  // Bun ignores tls.Server's handshakeTimeout, so the deadline is kept here: a connection that has
  // not completed its handshake in time is closed without a byte.
  const pending = new Map<string, Timer>()
  const key = (socket: net.Socket) => `${socket.remoteAddress}:${socket.remotePort}`
  listener.on("connection", (socket: net.Socket) => {
    const id = key(socket)
    pending.set(id, setTimeout(() => {
      pending.delete(id)
      socket.destroy()
    }, input.handshakeTimeoutMs))
    socket.once("close", () => {
      clearTimeout(pending.get(id))
      pending.delete(id)
    })
  })
  listener.on("secureConnection", (socket) => {
    clearTimeout(pending.get(key(socket)))
    pending.delete(key(socket))
    forward(socket, internal.port!, forwarded)
  })
  listener.on("tlsClientError", (error, socket) =>
    logger(`connection from ${socket.remoteAddress} dropped: ${error.message}`),
  )
  return new Promise<{ port: number; refresh: () => void; close: () => Promise<void> }>((resolve, reject) => {
    listener.once("error", reject)
    listener.listen({ host: input.bind, port: input.port }, () => {
      listener.off("error", reject)
      resolve({
        port: (listener.address() as net.AddressInfo).port,
        // Called after a certificate is admitted, so the peer it belongs to can connect.
        refresh: () => listener.setSecureContext(input.tlsOptions()),
        close: async () => {
          await new Promise<void>((done) => listener.close(() => done()))
          await internal.stop(true)
        },
      })
    })
  })
}

function forward(socket: tls.TLSSocket, internalPort: number, forwarded: Map<number, Forwarded>) {
  const der = socket.getPeerCertificate(true)?.raw
  if (!der) return socket.destroy()
  socket.pause()
  const upstream = net.connect(internalPort, "127.0.0.1")
  const address = (socket.remoteAddress ?? "").replace(/^::ffff:/, "")
  upstream.once("connect", () => {
    const port = upstream.localPort!
    forwarded.set(port, { nodeID: fingerprintDER(der), address })
    upstream.once("close", () => forwarded.delete(port))
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  const end = () => {
    socket.destroy()
    upstream.destroy()
  }
  socket.once("close", end)
  socket.once("error", end)
  upstream.once("close", end)
  upstream.once("error", end)
}
