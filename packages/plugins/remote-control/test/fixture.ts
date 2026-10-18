import type { Plugin } from "@opencode/plugin"
import type { RemoteControl } from "@opencode/schema/remote-control"

const pollDeadline = 2_000

// In-memory stand-in for the ocmesh loopback API: enough of POST/DELETE/GET to watch what the
// plugin sends. ocmesh's own contract is covered by its pytest suite.
export function fakeMesh(nodeID = "a".repeat(32)) {
  const records = new Map<string, RemoteControl.Record>()
  const deleted: string[] = []
  const peers: string[] = []
  const revokeOnUpsert = new Set<string>()
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/health") return Response.json({ ok: true, node_id: nodeID })
      if (url.pathname === "/v1/sessions" && request.method === "POST") {
        const body = (await request.json()) as RemoteControl.Record
        const record = {
          ...body,
          origin_host: `${body.harness}@${nodeID}`,
          revoked: revokeOnUpsert.has(body.session_id),
          last_seen: Date.now(),
          group_tag: null,
          origin_addr: null,
        }
        records.set(body.session_id, record)
        return Response.json(record)
      }
      if (url.pathname === "/v1/sessions") return Response.json([...records.values()].filter((item) => !item.revoked))
      if (url.pathname.startsWith("/v1/sessions/") && request.method === "DELETE") {
        const sessionID = decodeURIComponent(url.pathname.split("/").pop()!)
        const record = records.get(sessionID)
        if (!record) return Response.json({ error: `no session ${sessionID}` }, { status: 404 })
        deleted.push(sessionID)
        records.set(sessionID, { ...record, revoked: true })
        return Response.json({ ...record, revoked: true })
      }
      if (url.pathname === "/v1/peers" && request.method === "POST") {
        peers.push(((await request.json()) as { address: string }).address)
        return Response.json(peers.map((address) => ({ address, node_id: null, status: "down", error: "test" })))
      }
      if (url.pathname === "/v1/peers")
        return Response.json(peers.map((address) => ({ address, node_id: null, status: "down", error: "test" })))
      return new Response("not found", { status: 404 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    nodeID,
    records,
    deleted,
    peers,
    revokeOnUpsert,
    stop: () => server.stop(true),
  }
}

type Session = { id: string; title?: string; projectID: string; location: { directory: string }; parentID?: string }

// The slice of Plugin.Context the remote-control server touches, backed by plain maps.
export function fakeContext(options: Record<string, unknown>, directory = "/work") {
  const sessions = new Map<string, Session>()
  const storage = new Map<string, unknown>()
  const emitted: Array<[string, unknown]> = []
  const queue: unknown[] = []
  const waiters: Array<() => void> = []
  let handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>> = {}

  const context = {
    app: { name: "opencode", version: "9.9.9", channel: "test" },
    location: { directory, project: { id: "global", directory, canonical: directory } },
    options,
    session: {
      get: async (input: { sessionID: string }) => {
        const session = sessions.get(input.sessionID)
        if (!session) throw new Error(`no session ${input.sessionID}`)
        return session
      },
      list: async () => ({ data: [...sessions.values()], cursor: {} }),
    },
    event: {
      subscribe: (input: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!input.signal.aborted) {
            if (queue.length > 0) yield queue.shift()
            else await new Promise<void>((resolve) => waiters.push(resolve))
          }
        },
      }),
    },
    storage: {
      get: async (key: string) => structuredClone(storage.get(key)),
      set: async (key: string, value: unknown) => void storage.set(key, structuredClone(value)),
    },
    rpc: {
      register: async (_definition: unknown, implementation: typeof handlers) => {
        handlers = implementation
        return {
          events: { emit: async (name: string, data: unknown) => void emitted.push([name, data]) },
          dispose: async () => {},
        }
      },
    },
  } as unknown as Plugin.Context

  return {
    context,
    sessions,
    storage,
    emitted,
    event(value: unknown) {
      queue.push(value)
      waiters.splice(0).forEach((resolve) => resolve())
    },
    call: (method: string, input?: unknown) =>
      handlers[method]!(input, {
        signal: new AbortController().signal,
        error: (type: string, message: string, data: unknown) => ({ type, message, data }),
      }),
  }
}

export async function until<T>(read: () => T | undefined | false, what: string) {
  const deadline = Date.now() + pollDeadline
  while (Date.now() < deadline) {
    const value = read()
    if (value) return value
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}
