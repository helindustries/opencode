import { loadConfig } from "@opencode/mesh/config"
import { Effect, Option } from "effect"
import { EOL } from "node:os"

const requestTimeoutMs = 5_000

export function config(path: Option.Option<string>) {
  return Effect.tryPromise({
    try: () => loadConfig(Option.getOrUndefined(path)),
    catch: (error) => error as Error,
  })
}

// GETs a path from the running node's loopback API.
export function get(path: Option.Option<string>, pathname: string) {
  return Effect.gen(function* () {
    const loaded = yield* config(path)
    const url = `http://127.0.0.1:${loaded.port}${pathname}`
    return yield* Effect.tryPromise({
      try: () => fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) }).then((response) => response.json() as Promise<unknown>),
      catch: (error) =>
        new Error(`no mesh node answering at ${url} (${(error as Error).message}); start one with 'opencode mesh run'`),
    })
  })
}

export function printJSON(value: unknown) {
  process.stdout.write(JSON.stringify(value, null, 2) + EOL)
}
