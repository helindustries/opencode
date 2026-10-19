export * as RemoteControlPlugin from "./plugin.js"

import { define } from "@opencode/plugin/effect/plugin"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import type { Entry } from "@opencode/schema/config"
import { RemoteControl } from "@opencode/schema/remote-control"
import { Effect } from "effect"
import { Config } from "../../config.js"
import server from "./server.js"

const promise = fromPromise(server)

// Remote control ships with opencode instead of being installed, so its options are the
// remote_control section of opencode.json, read when it starts.
export const Plugin = define({
  id: RemoteControl.PluginID,
  effect: Effect.fn(function* (host) {
    const config = yield* Config.Service
    yield* promise.effect({ ...host, options: options(yield* config.entries()) })
  }),
})

// Entries come lowest priority first, so a later document overrides an earlier one key by key.
export function options(entries: readonly Entry[]) {
  return Object.assign(
    {},
    ...entries.flatMap((entry) =>
      entry.type === "document" && entry.info.remote_control ? [{ ...entry.info.remote_control }] : [],
    ),
  )
}
