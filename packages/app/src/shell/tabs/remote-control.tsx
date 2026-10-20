import { Schema } from "effect"
import { createEffect, createMemo } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode/ui/context"
import { RemoteControl } from "@opencode/schema/remote-control"
import { useLanguage } from "@/runtime/i18n/language"
import { useGlobal } from "@/runtime/server/runtime"
import { showToast } from "@/shell/notifications/toast"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { meshConnection } from "@/servers/mesh/controller"
import { createMeshFeed } from "@/servers/mesh/feed"
import { sharedSessions, staleCredentials } from "./sidebar-model"
import { useTabs } from "./tabs"

const Opened = Persistence.struct({ keys: Persistence.array(Schema.String) })

// The tab list shows every shared session without being asked; a tab the user closes stays closed,
// so the sessions already opened once are remembered.
export const { use: useRemoteControl, provider: RemoteControlProvider } = createSimpleContext({
  name: "RemoteControl",
  gate: false,
  init: () => {
    const servers = useServers()
    const global = useGlobal()
    const tabs = useTabs()
    const language = useLanguage()
    const feed = createMeshFeed(() => servers.visible[0])
    const [opened, setOpened, , openedReady] = persisted(Persist.global("rc.opened-tabs"), Opened, { keys: [] })

    const shared = createMemo(() =>
      sharedSessions<ServerConnection.Any>({
        local: feed.host(),
        localShared: feed.status()?.shared ?? [],
        localRecords: feed.local(),
        remote: feed
          .connected()
          .filter(feed.attachable)
          .map((record) => ({ ...record, connection: meshConnection(record, language) })),
      }),
    )
    // A sharing server picks a new password whenever it restarts and its record carries the current one, but a server
    // saved for an earlier share keeps the password it was saved with; its tabs then show "Unknown Session".
    createEffect(() => {
      const remote = feed
        .connected()
        .filter(feed.attachable)
        .map((record) => meshConnection(record, language))
      const saved = servers.list.flatMap((conn) => (conn.type === "http" ? [conn] : []))

      for (const conn of staleCredentials(remote, saved)) servers.add(conn)
    })
    const sessionKey = (server: ServerConnection.Key, sessionId: string) => `${server}\n${sessionId}`
    const byKey = createMemo(
      () => new Map(shared().map((item) => [sessionKey(ServerConnection.key(item.server), item.sessionId), item])),
    )
    // A group just picked shows at once; the mesh record carries it after the sharing server republishes.
    const [picked, setPicked] = createStore<Record<string, string | null>>({})
    const group = (server: ServerConnection.Key, sessionId: string) => {
      const key = sessionKey(server, sessionId)
      const item = byKey().get(key)

      return item ? (key in picked ? picked[key]! : item.group) : undefined
    }
    createEffect(() => {
      for (const [key, item] of byKey())
        if (key in picked && picked[key] === item.group) setPicked(produce((draft) => delete draft[key]))
    })

    createEffect(() => {
      if (!openedReady()) return
      const fresh = shared().filter((item) => !opened.keys.includes(item.id))

      if (fresh.length === 0) return
      for (const item of fresh) {
        const conn = item.server.type === "http" ? (servers.add(item.server) ?? item.server) : item.server
        tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: item.sessionId })
      }
      setOpened("keys", (current) => [...current, ...fresh.map((item) => item.id)])
    })

    return {
      feed,
      shared: (server: ServerConnection.Key, sessionId: string) => byKey().has(sessionKey(server, sessionId)),
      /** The mesh group of a shared session, null for none; undefined when the session is not shared. */
      group,
      async setGroup(server: ServerConnection.Key, sessionId: string, title: string | null) {
        const key = sessionKey(server, sessionId)
        const item = byKey().get(key)

        if (!item) return
        setPicked(key, title)
        const done = await global
          .ensureServerCtx(item.server)
          .sdk.api.rpc(RemoteControl.Definition)
          ["share.group"]({ session_id: sessionId, group: title })
          .catch(() => undefined)

        if (done) return
        setPicked(produce((draft) => delete draft[key]))
        showToast({ variant: "error", title: language.t("session.tab.group.meshFailed") })
      },
    }
  },
})
