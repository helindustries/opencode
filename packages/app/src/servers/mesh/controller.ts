import type { HomeController } from "@/home/model"
import { useLanguage } from "@/runtime/i18n/language"
import { authFromToken, createApiForServer } from "@/runtime/server/api"
import { useCheckServerHealth } from "@/runtime/server/health"
import { normalizeServerUrl, ServerConnection, useServers } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"
import { showToast } from "@/shell/notifications/toast"
import type { MeshFeed, MeshRecord } from "./feed"

const http = (record: MeshRecord) => ({
  url: normalizeServerUrl(record.server_url) ?? record.server_url,
  password: authFromToken(record.auth_blob)?.password,
})

export const meshConnection = (
  record: MeshRecord,
  language: ReturnType<typeof useLanguage>,
): ServerConnection.Http => ({
  type: "http",
  http: http(record),
  displayName: language.t("home.mesh.owner", { user: record.origin_user, host: new URL(record.server_url).hostname }),
})

export function createMeshController(home: HomeController, feed: MeshFeed) {
  const language = useLanguage()
  const servers = useServers()
  const global = useGlobal()
  const checkHealth = useCheckServerHealth()

  const connection = (record: MeshRecord) => meshConnection(record, language)

  const failed = (key: Parameters<typeof language.t>[0], record: MeshRecord) =>
    showToast({ variant: "error", title: language.t(key, { server: record.server_url }) })

  return {
    attached: (record: MeshRecord) =>
      servers.list.some((conn) => ServerConnection.key(conn) === ServerConnection.key(connection(record))),
    // Attaching adds the sharing server as an ordinary HTTP server, so the session opens through the
    // same cross-server path as any paired server: timeline, prompts and docks bind to it.
    async attach(record: MeshRecord) {
      const target = connection(record)
      const health = await checkHealth(target.http)

      if (!health.healthy) return failed("home.mesh.attach.unreachable", record)
      const conn = servers.add(target) ?? target

      const session = await global
        .ensureServerCtx(conn)
        .sdk.api.session.get({ sessionID: record.session_id })
        .catch(() => undefined)

      if (!session) return failed("home.mesh.attach.missing", record)
      home.project.openProjectSession(conn, session.location.directory, session)
    },
    disconnect(record: MeshRecord) {
      servers.remove(ServerConnection.key(connection(record)))
    },
    async forget(record: MeshRecord) {
      const result = await feed
        .client()
        ?.["sessions.revoke"]({ origin_host: record.origin_host, session_id: record.session_id })
        .catch(() => undefined)

      if (!result) return showToast({ variant: "error", title: language.t("home.mesh.forget.failed") })
      await feed.refresh()
    },
    // The rename goes to the sharing server itself; its remote control republishes the new title.
    async rename(record: MeshRecord, title: string) {
      const renamed = await createApiForServer({ server: http(record) })
        .session.update({ sessionID: record.session_id, title })
        .then(
          () => true,
          () => false,
        )

      if (!renamed) failed("home.mesh.rename.failed", record)

      return renamed
    },
  }
}

export type MeshController = ReturnType<typeof createMeshController>
