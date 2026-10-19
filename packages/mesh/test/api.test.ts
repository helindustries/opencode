import { describe, expect, test } from "bun:test"
import path from "node:path"
import tls from "node:tls"
import { loadIdentity } from "../src/identity"
import type { SessionRecord } from "../src/protocol"
import { MeshService } from "../src/service"
import { call, config, record, temporaryDirectory } from "./fixture"

async function open(directory: string, fields: Parameters<typeof config>[1] = {}) {
  const service = await MeshService.open(config(path.join(directory, "node"), fields))
  service.start()
  return { service, [Symbol.asyncDispose]: () => service.stop() }
}

// Reads the event stream until an event of that name arrives.
async function nextEvent(response: Response, name: string) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`event stream ended before ${name}`)
    buffer += decoder.decode(chunk.value)
    const match = new RegExp(`event: ${name.replace(".", "\\.")}\\ndata: (.*)\\n\\n`).exec(buffer)
    if (match) {
      reader.releaseLock()
      return JSON.parse(match[1]) as SessionRecord
    }
  }
}

describe("api", () => {
  test("answers health on loopback with the node id it wrote", async () => {
    using directory = temporaryDirectory()
    await using node = await open(directory.path)
    const health = await call(node.service.loopback.port, "GET", "/health")
    expect(health.status).toBe(200)
    expect(health.body.node_id).toBe(node.service.node.nodeID)
    expect(await Bun.file(path.join(directory.path, "node", "node.pem")).exists()).toBe(true)
  })

  test("an upsert reaches the event stream, a revocation arrives as a tombstone", async () => {
    using directory = temporaryDirectory()
    await using node = await open(directory.path)
    const port = node.service.loopback.port
    const events = await fetch(`http://127.0.0.1:${port}/v1/events`)
    const upsert = nextEvent(events, "session.upsert")
    const stored = await call<SessionRecord>(port, "POST", "/v1/sessions", record("ses_1"))
    expect(stored.status).toBe(200)
    expect(stored.body.origin_host).toBe(`opencode@${node.service.node.nodeID}`)
    expect((await upsert).session_id).toBe("ses_1")

    const revoke = nextEvent(events, "session.revoke")
    const revoked = await call<SessionRecord>(port, "DELETE", `/v1/sessions/${stored.body.origin_host}/ses_1`)
    expect(revoked.body.revoked).toBe(true)
    expect((await revoke).revoked).toBe(true)
    expect((await call<SessionRecord[]>(port, "GET", "/v1/sessions")).body).toEqual([])
    expect((await call<SessionRecord[]>(port, "GET", "/v1/sessions?include_revoked=1")).body).toHaveLength(1)
    await events.body!.cancel()
  })

  test("filters by harness", async () => {
    using directory = temporaryDirectory()
    await using node = await open(directory.path)
    const port = node.service.loopback.port
    await call(port, "POST", "/v1/sessions", record("ses_open"))
    await call(port, "POST", "/v1/sessions", record("ses_other", { harness: "other" }))
    const filtered = await call<SessionRecord[]>(port, "GET", "/v1/sessions?harness=opencode")
    expect(filtered.body.map((item) => item.session_id)).toEqual(["ses_open"])
  })

  test("refuses foreign Host headers, non-JSON bodies and peers while sync is off", async () => {
    using directory = temporaryDirectory()
    await using node = await open(directory.path)
    const port = node.service.loopback.port
    expect((await call(port, "GET", "/health", undefined, { host: "evil.example" })).status).toBe(403)
    const plain = await fetch(`http://127.0.0.1:${port}/v1/sessions`, { method: "POST", body: "x" })
    expect(plain.status).toBe(415)
    expect((await call(port, "POST", "/v1/peers", { address: "127.0.0.1:1" })).status).toBe(409)
  })

  test("the peer port refuses a certificate the trust bundle does not hold", async () => {
    using directory = temporaryDirectory()
    await using node = await open(directory.path, { tls: "mutual" })
    const stranger = await loadIdentity(path.join(directory.path, "stranger"), "stranger")
    const outcome = await new Promise<string>((resolve) => {
      const socket = tls.connect({
        host: "127.0.0.1",
        port: node.service.lan!.port,
        ...stranger.tlsOptions(),
        ca: node.service.node.identity.certPEM,
        checkServerIdentity: () => undefined,
      })
      socket.on("secureConnect", () => socket.write("GET /health HTTP/1.1\r\nHost: x\r\n\r\n"))
      let reply = ""
      socket.on("data", (chunk: Buffer) => (reply += chunk))
      socket.on("close", () => resolve(reply))
      socket.on("error", () => resolve(reply))
    })
    expect(outcome).not.toContain("HTTP/1.1")
  })
})
