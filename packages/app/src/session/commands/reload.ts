import type { useData } from "@/runtime/server/current"
import type { useLanguage } from "@/runtime/i18n/language"
import { dismissToast, showToast } from "@/shell/notifications/toast"

// Session, message and pending-inbox syncs are memoized per key, so a reload has to invalidate all three
// before syncing; otherwise the cached result answers and a stalled view stays stalled.
export async function reloadSession(input: {
  data: ReturnType<typeof useData>
  language: ReturnType<typeof useLanguage>
  sessionID: string
}) {
  const progress = showToast({
    variant: "loading",
    title: input.language.t("session.reload.syncing"),
    persistent: true,
  })

  input.data.session.invalidate(input.sessionID)
  input.data.session.message.invalidate(input.sessionID)
  input.data.session.pending.invalidate(input.sessionID)

  const reloaded = await Promise.all([
    input.data.session.sync(input.sessionID),
    input.data.session.message.sync(input.sessionID),
    input.data.session.pending.sync(input.sessionID),
  ]).then(
    () => true,
    () => false,
  )

  dismissToast(progress)
  showToast(
    reloaded
      ? { variant: "success", title: input.language.t("session.reload.synced") }
      : { variant: "error", title: input.language.t("session.reload.failed") },
  )

  return reloaded
}
