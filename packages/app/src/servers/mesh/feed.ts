import { RemoteControl } from "@opencode/schema/remote-control"
import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { HomeController } from "@/home/model"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"

// The plugin heartbeats every 60s; three missed beats is "no longer connected".
export const connectedWindow = 3 * 60_000

const clockInterval = 30_000

export type MeshRecord = RemoteControl.Record

export function createMeshFeed(home: HomeController) {
  const global = useGlobal()
  const servers = useServers()

  const [state, setState] = createStore<{
    status: RemoteControl.Status | undefined
    records: readonly MeshRecord[]
    now: number
  }>({ status: undefined, records: [], now: Date.now() })

  // The remote-control plugin runs on this machine's own server; remote servers attached from the
  // mesh may carry it too, but their registry is the same mesh seen from elsewhere.
  const host = createMemo(() => servers.visible.find((conn) => ServerConnection.local(conn)) ?? home.server.focused())

  const api = createMemo(() => {
    const conn = host()

    return conn ? global.ensureServerCtx(conn).sdk.api : undefined
  })

  const client = createMemo(() => api()?.rpc(RemoteControl.Definition))

  createEffect(() => {
    const server = api()
    const rc = client()

    if (!server || !rc) return

    // A server without the plugin answers every rc call with an error the browser logs, so the plugin list
    // decides first; listing plugins also starts this location's plugin instance.
    const refresh = async () => {
      const plugins = await server.plugin.list().catch(() => undefined)
      const loaded = plugins?.data.some((plugin) => plugin.id === RemoteControl.PluginID) ?? false
      const status = loaded ? await rc.status(undefined).catch(() => undefined) : undefined
      const records = status ? await rc["sessions.list"]({}).catch(() => []) : []
      setState("status", reconcile(status))
      setState("records", reconcile(records, { key: "session_id" }))
    }

    void refresh()
    const offMesh = rc.events.on("mesh.changed", () => void refresh())
    const offState = rc.events.on("state.changed", () => void refresh())
    const clock = setInterval(() => setState("now", Date.now()), clockInterval)
    onCleanup(() => {
      offMesh()
      offState()
      clearInterval(clock)
    })
  })

  const supported = createMemo(() => state.records.filter((record) => record.harness === RemoteControl.Harness))
  const connected = (record: MeshRecord) => state.now - record.last_seen < connectedWindow

  return {
    client,
    available: () => state.status !== undefined,
    connected: createMemo(() => supported().filter(connected)),
    past: createMemo(() => supported().filter((record) => !connected(record))),
    unsupported: () => state.records.length - supported().length,
    attachable: (record: MeshRecord) =>
      state.status?.desktop !== "notify" && record.capabilities.includes("attach") && record.auth_blob !== "",
    refresh: () => {
      const rc = client()

      if (!rc) return Promise.resolve()

      return rc["sessions.list"]({}).then(
        (records) => setState("records", reconcile(records, { key: "session_id" })),
        () => undefined,
      )
    },
  }
}

export type MeshFeed = ReturnType<typeof createMeshFeed>
