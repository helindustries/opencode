import { userInfo } from "node:os"
import { Plugin } from "@opencode/plugin"
import { ConfigRemoteControl } from "@opencode/schema/config/remote-control"
import { RemoteControl } from "@opencode/schema/remote-control"
import { authBlob, own } from "./endpoint.js"
import { create, MeshRejected, MeshUnreachable, type Mesh } from "./mesh.js"

const heartbeatInterval = 60_000
const pingDeadline = 5_000
const pingInterval = 250
const defaultPeerPort = 47614
const capabilities = ["attach", "prompt", "question", "permission"]
const stateKey = "state"

type Hint = RemoteControl.Record["client_hint"]
type Share = { at: number; hint: Hint }
type State = { active: boolean; target: string | null; shared: Record<string, Share> }
type Instance = { sync: () => Promise<void>; emit: (event: "mesh.changed" | "state.changed", data: object) => void }
type Runtime = {
  mesh: Mesh
  state: State
  instances: Set<Instance>
  nodeID?: string
  abort: AbortController
  save: () => Promise<void>
}

// Server plugins are instantiated once per location while the event bus and plugin storage are
// global, so the mesh client, the persisted /rc state and the mesh event stream are shared here.
const runtimes = new Map<string, Promise<Runtime>>()

export default Plugin.define({
  id: RemoteControl.PluginID,
  async setup(ctx) {
    const config = ConfigRemoteControl.decode(ctx.options)
    if (config.enabled === false) return
    const url = config.mesh_url ?? ConfigRemoteControl.DefaultMeshURL
    const runtime = await acquire(ctx.storage, url)
    const endpoint = await own(config.server_url)
    const directory = ctx.location.directory
    const owner = config.client_name ?? userInfo().username
    const abort = new AbortController()
    const published = new Set<string>()

    const origin = async () => {
      runtime.nodeID ??= (await runtime.mesh.health()).node_id
      return `${RemoteControl.Harness}@${runtime.nodeID}`
    }
    const matches = (projectID: string) =>
      !config.project_filter?.length ||
      config.project_filter.includes(projectID) ||
      config.project_filter.includes(directory)

    const publish = async (sessionID: string) => {
      const session = await ctx.session.get({ sessionID }).catch(() => undefined)
      const share = runtime.state.shared[sessionID]
      if (!session && share) return forget(sessionID)
      if (!session || !share || session.location.directory !== directory) return
      published.add(sessionID)
      runtime.mesh.publish({
        session_id: sessionID,
        harness: RemoteControl.Harness,
        harness_version: ctx.app.version,
        capabilities: endpoint?.password ? capabilities : [],
        server_url: endpoint?.url ?? "",
        title: session.title ?? "",
        directory,
        project_id: session.projectID,
        origin_user: owner,
        client_hint: share.hint,
        auth_blob: authBlob(endpoint),
        shared_at: share.at,
      })
    }

    const forget = async (sessionID: string) => {
      published.delete(sessionID)
      delete runtime.state.shared[sessionID]
      await runtime.save()
      const host = await origin().catch(() => undefined)
      if (host) await runtime.mesh.revoke(host, sessionID).catch(() => undefined)
    }

    const adopt = async (sessionID: string, hint: Hint) => {
      if (runtime.state.shared[sessionID]) return
      runtime.state.shared[sessionID] = { at: Date.now(), hint }
      await runtime.save()
    }

    const sync = async () => {
      if (!runtime.state.active) return
      if (config.publish) {
        const sessions = await ctx.session.list({ directory, parentID: null }).catch(() => undefined)
        for (const session of sessions?.data.filter((item) => matches(item.projectID)) ?? [])
          await adopt(session.id, "tui")
      }
      await Promise.all(Object.keys(runtime.state.shared).map(publish))
    }

    const status = async (): Promise<RemoteControl.Status> => {
      const mesh = await runtime.mesh.health().then(
        (health) => ({ reachable: true, node_id: health.node_id, error: null }),
        (error: Error) => ({ reachable: false, node_id: null, error: error.message }),
      )
      return {
        active: runtime.state.active,
        target: runtime.state.target,
        shared: Object.keys(runtime.state.shared),
        publish: config.publish ?? false,
        desktop: config.desktop ?? "attach",
        attachable: Boolean(endpoint?.password),
        mesh: { url, ...mesh },
      }
    }

    const broadcast = (event: "mesh.changed" | "state.changed", data: object) =>
      runtime.instances.values().next().value?.emit(event, data)

    const registration = await ctx.rpc.register(RemoteControl.Definition, {
      status: () => status(),
      "sessions.list": async (input, context) => {
        const records = await runtime.mesh.list(input.harness).catch((error: Error) => error)
        if (records instanceof MeshUnreachable) return context.error("mesh_unreachable", records.message, { url })
        if (records instanceof Error) throw records
        if (input.include_local) return records
        const local = await origin().catch(() => undefined)
        return records.filter((record) => record.origin_host !== local)
      },
      "sessions.revoke": async (input, context) => {
        const record = await runtime.mesh.revoke(input.origin_host, input.session_id).catch((error: Error) => error)
        if (record instanceof MeshUnreachable) return context.error("mesh_unreachable", record.message, { url })
        if (record instanceof MeshRejected && record.status === 404)
          return context.error("not_found", record.message, { session_id: input.session_id })
        if (record instanceof Error) throw record
        broadcast("mesh.changed", { reason: "session.revoke" })
        return record
      },
      "mesh.ping": async (input, context) => {
        const address = input.target === undefined ? undefined : peerAddress(input.target)
        if (address === null)
          return context.error("invalid_target", `not a host or host:port: ${input.target}`, { target: input.target! })
        const health = await runtime.mesh.health().catch((error: Error) => error)
        if (health instanceof Error) return context.error("mesh_unreachable", health.message, { url })
        if (address === undefined) return { node_id: health.node_id, peer: null }
        const added = await runtime.mesh.addPeer(address).catch((error: Error) => error)
        if (added instanceof MeshRejected) return context.error("mesh_refused", added.message, { status: added.status })
        if (added instanceof Error) return context.error("mesh_unreachable", added.message, { url })
        return { node_id: health.node_id, peer: await settledPeer(runtime.mesh, address) }
      },
      "share.start": async (input, context) => {
        const address = input.target === undefined ? undefined : peerAddress(input.target)
        if (address === null)
          return context.error("invalid_target", `not a host or host:port: ${input.target}`, { target: input.target! })
        const reached = await (address ? runtime.mesh.addPeer(address) : runtime.mesh.health()).catch(
          (error: Error) => error,
        )
        if (reached instanceof MeshRejected)
          return context.error("mesh_refused", reached.message, { status: reached.status })
        if (reached instanceof Error) return context.error("mesh_unreachable", reached.message, { url })
        runtime.state.active = true
        runtime.state.target = address ?? runtime.state.target
        if (input.session_id)
          runtime.state.shared[input.session_id] ??= { at: Date.now(), hint: input.client_hint ?? "tui" }
        await runtime.save()
        await Promise.all([...runtime.instances].map((instance) => instance.sync()))
        broadcast("state.changed", { active: true })
        return status()
      },
      "share.stop": async () => {
        const host = await origin().catch(() => undefined)
        if (host)
          await Promise.all(
            Object.keys(runtime.state.shared).map((sessionID) =>
              runtime.mesh.revoke(host, sessionID).catch(() => undefined),
            ),
          )
        runtime.state = { active: false, target: null, shared: {} }
        await runtime.save()
        broadcast("state.changed", { active: false })
        return status()
      },
    })

    const instance: Instance = {
      sync,
      emit: (event, data) => void registration.events.emit(event, data as never),
    }
    runtime.instances.add(instance)

    // The bus is global and session.deleted carries no location, so ownership comes from the
    // sessions this instance published, not from the event.
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        if (event.type === "session.created") {
          if (
            event.data.location.directory === directory &&
            runtime.state.active &&
            config.publish &&
            !event.data.parentID &&
            matches(event.data.projectID)
          ) {
            await adopt(event.data.sessionID, "tui")
            await publish(event.data.sessionID)
          }
          continue
        }
        if (event.type === "session.renamed" || event.type === "session.moved") {
          if (published.has(event.data.sessionID)) await publish(event.data.sessionID)
          continue
        }
        if (event.type === "session.deleted" && published.has(event.data.sessionID)) await forget(event.data.sessionID)
      }
    })()

    // Re-publishing refreshes last_seen, which is what desktops read as "connected".
    const heartbeat = setInterval(() => void sync(), heartbeatInterval)
    await sync()

    return async () => {
      clearInterval(heartbeat)
      abort.abort()
      await registration.dispose()
      runtime.instances.delete(instance)
      if (runtime.instances.size === 0) {
        runtime.abort.abort()
        runtime.mesh.dispose()
        runtimes.delete(url)
      }
    }
  },
})

function acquire(storage: Plugin.Context["storage"], url: string) {
  const existing = runtimes.get(url)
  if (existing) return existing
  const created = storage.get(stateKey).then((stored) => {
    const runtime: Runtime = {
      state: isState(stored) ? stored : { active: false, target: null, shared: {} },
      instances: new Set(),
      abort: new AbortController(),
      save: () => storage.set(stateKey, runtime.state),
      mesh: create(url, {
        stored: (record) => {
          runtime.nodeID = record.origin_host.slice(record.origin_host.lastIndexOf("@") + 1)
          // Another machine forgot this session: stop sharing it instead of re-announcing it.
          if (!record.revoked || !runtime.state.shared[record.session_id]) return
          delete runtime.state.shared[record.session_id]
          void runtime.save()
        },
      }),
    }
    runtime.mesh.follow((reason) => {
      runtime.instances.values().next().value?.emit("mesh.changed", { reason })
    }, runtime.abort.signal)
    return runtime
  })
  runtimes.set(url, created)
  return created
}

export function peerAddress(target: string) {
  const match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(target.trim())
  if (!match) return null
  return `${match[1]}:${match[2] ?? defaultPeerPort}`
}

async function settledPeer(mesh: Mesh, address: string) {
  const deadline = Date.now() + pingDeadline
  while (Date.now() < deadline) {
    const peer = (await mesh.peers()).find((item) => item.address === address)
    if (peer) return peer
    await Bun.sleep(pingInterval)
  }
  return null
}

function isState(value: unknown): value is State {
  return typeof value === "object" && value !== null && "active" in value && "shared" in value
}
