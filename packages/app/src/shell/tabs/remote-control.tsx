import { Schema } from "effect"
import { createEffect, createMemo } from "solid-js"
import { createSimpleContext } from "@opencode/ui/context"
import { useLanguage } from "@/runtime/i18n/language"
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
    const tabs = useTabs()
    const language = useLanguage()
    const feed = createMeshFeed(() => servers.visible[0])
    const [opened, setOpened, , openedReady] = persisted(Persist.global("rc.opened-tabs"), Opened, { keys: [] })

    const shared = createMemo(() =>
      sharedSessions<ServerConnection.Any>({
        local: feed.host(),
        localShared: feed.status()?.shared ?? [],
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
    const keys = createMemo(
      () => new Set(shared().map((item) => `${ServerConnection.key(item.server)}\n${item.sessionId}`)),
    )

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
      shared: (server: ServerConnection.Key, sessionId: string) => keys().has(`${server}\n${sessionId}`),
    }
  },
})
