import type { RemoteControl } from "@opencode/schema/remote-control"

const requestTimeout = 5_000
const retryInitial = 1_000
const retryMax = 30_000
const queueLimit = 1_000

export type Publication = Pick<
  RemoteControl.Record,
  | "session_id"
  | "harness"
  | "harness_version"
  | "capabilities"
  | "server_url"
  | "title"
  | "directory"
  | "project_id"
  | "origin_user"
  | "client_hint"
  | "auth_blob"
  | "shared_at"
>

export class MeshUnreachable extends Error {
  constructor(
    readonly url: string,
    cause: unknown,
  ) {
    super(`mesh unreachable at ${url}`, { cause })
  }
}

export class MeshRejected extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export type Mesh = ReturnType<typeof create>

// Publishing never blocks the session hot path: publish() only queues, and a single flush loop
// drains the queue with backoff while the mesh is down. The queue keeps the latest publication per
// session and drops the oldest beyond queueLimit.
export function create(url: string, handlers: { stored: (record: RemoteControl.Record) => void }) {
  const pending = new Map<string, Publication>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let flushing = false
  let delay = retryInitial

  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(new URL(path, url), {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeout),
    }).catch((cause: unknown) => {
      throw new MeshUnreachable(url, cause)
    })
    const payload = (await response.json().catch(() => ({}))) as T & { error?: string }
    if (!response.ok) throw new MeshRejected(response.status, payload.error ?? response.statusText)
    return payload
  }

  const schedule = (wait: number) => {
    if (timer === undefined && !flushing) timer = setTimeout(() => void flush(), wait)
  }

  const flush = async () => {
    timer = undefined
    flushing = true
    const failure = await drain()
    flushing = false
    if (failure) {
      schedule(delay)
      delay = Math.min(delay * 2, retryMax)
      return
    }
    delay = retryInitial
    if (pending.size > 0) schedule(0)
  }

  const drain = async () => {
    for (const [id, publication] of pending) {
      const result = await request<RemoteControl.Record>("POST", "/v1/sessions", publication).catch(
        (error: Error) => error,
      )
      if (result instanceof MeshUnreachable) return true
      if (pending.get(id) === publication) pending.delete(id)
      if (result instanceof Error) console.warn(`remote-control: mesh refused ${id}: ${result.message}`)
      else handlers.stored(result as RemoteControl.Record)
    }
    return false
  }

  return {
    url,
    publish(publication: Publication) {
      pending.delete(publication.session_id)
      pending.set(publication.session_id, publication)
      if (pending.size > queueLimit) pending.delete(pending.keys().next().value!)
      schedule(0)
    },
    pending: () => pending.size,
    health: () => request<{ node_id: string }>("GET", "/health"),
    list: (harness?: string) =>
      request<RemoteControl.Record[]>("GET", harness ? `/v1/sessions?harness=${encodeURIComponent(harness)}` : "/v1/sessions"),
    revoke: (originHost: string, sessionID: string) =>
      request<RemoteControl.Record>(
        "DELETE",
        `/v1/sessions/${encodeURIComponent(originHost)}/${encodeURIComponent(sessionID)}`,
      ),
    peers: () => request<RemoteControl.Peer[]>("GET", "/v1/peers"),
    addPeer: (address: string) => request<RemoteControl.Peer[]>("POST", "/v1/peers", { address }),
    follow(onEvent: (name: string) => void, signal: AbortSignal) {
      void (async () => {
        let wait = retryInitial
        while (!signal.aborted) {
          const response = await fetch(new URL("/v1/events", url), { signal }).catch(() => undefined)
          if (response?.ok && response.body) {
            wait = retryInitial
            onEvent("connected")
            await consume(response.body, onEvent)
          }
          await sleep(wait, signal)
          wait = Math.min(wait * 2, retryMax)
        }
      })()
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

// A dropped stream (mesh restart, abort) ends the read with an error; the caller reconnects.
async function consume(body: ReadableStream<Uint8Array>, onEvent: (name: string) => void) {
  try {
    for await (const name of events(body)) onEvent(name)
  } catch {}
}

async function* events(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let buffer = ""
  let name = ""
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines.map((value) => value.replace(/\r$/, ""))) {
      if (line.startsWith("event:")) name = line.slice(6).trim()
      if (line === "" && name) {
        yield name
        name = ""
      }
    }
  }
}

function sleep(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
