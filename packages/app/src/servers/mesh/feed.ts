import { RemoteControl } from "@opencode/schema/remote-control"
import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"

// Remote control re-publishes shared sessions every 60s; three missed beats is "no longer connected".
export const connectedWindow = 3 * 60_000

const clockInterval = 30_000

export type MeshRecord = RemoteControl.Record

export function createMeshFeed(fallback: () => ServerConnection.Any | undefined) {
  const global = useGlobal()
  const servers = useServers()

  const [state, setState] = createStore<{
    status: RemoteControl.Status | undefined
    records: readonly MeshRecord[]
    now: number
  }>({ status: undefined, records: [], now: Date.now() })

  // Remote control runs in this machine's own server; remote servers attached from the mesh carry it
  // too, but their registry is the same mesh seen from elsewhere.
  const host = createMemo(() => servers.visible.find((conn) => ServerConnection.local(conn)) ?? fallback())

  const api = createMemo(() => {
    const conn = host()

    return conn ? global.ensureServerCtx(conn).sdk.api : undefined
  })

  const client = createMemo(() => api()?.rpc(RemoteControl.Definition))

  createEffect(() => {
    const server = api()
    const rc = client()

    if (!server || !rc) return

    // A server without remote control (an upstream opencode) answers every rc call with an error the
    // browser logs, so the plugin list decides first; listing plugins also starts this location's
    // remote control instance.
    const refresh = async () => {
      const plugins = await server.plugin.list().catch(() => undefined)
      const loaded = plugins?.data.some((plugin) => plugin.id === RemoteControl.PluginID) ?? false
      const status = loaded ? await rc.status(undefined).catch(() => undefined) : undefined
      const records = status ? await rc["sessions.list"]({ include_local: true }).catch(() => []) : []
      // Together: records without their status count this machine's own as remote, a status without its records
      // reads as a mesh that holds nothing.
      batch(() => {
        setState("records", reconcile(records, { key: "session_id" }))
        setState("status", reconcile(status))
      })
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

  // This machine's own records are listed too, for the sidebar group they carry.
  const isLocal = (record: MeshRecord) =>
    !!state.status?.mesh.node_id && record.origin_host === `${RemoteControl.Harness}@${state.status.mesh.node_id}`
  const remote = createMemo(() => state.records.filter((record) => !isLocal(record)))
  const supported = createMemo(() => remote().filter((record) => record.harness === RemoteControl.Harness))
  const connected = (record: MeshRecord) => state.now - record.last_seen < connectedWindow

  return {
    client,
    host,
    status: () => state.status,
    available: () => state.status !== undefined,
    connected: createMemo(() => supported().filter(connected)),
    past: createMemo(() => supported().filter((record) => !connected(record))),
    local: createMemo(() => state.records.filter(isLocal)),
    unsupported: () => remote().length - supported().length,
    attachable: (record: MeshRecord) =>
      state.status?.desktop !== "notify" && record.capabilities.includes("attach") && record.auth_blob !== "",
    refresh: () => {
      const rc = client()

      if (!rc) return Promise.resolve()

      return rc["sessions.list"]({ include_local: true }).then(
        (records) => setState("records", reconcile(records, { key: "session_id" })),
        () => undefined,
      )
    },
  }
}

export type MeshFeed = ReturnType<typeof createMeshFeed>
