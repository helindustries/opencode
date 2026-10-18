import { createSignal, Show } from "solid-js"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@opencode/ui/dialog"
import { List } from "@opencode/ui/list"
import { useLanguage } from "@/runtime/i18n/language"
import { sessionLabel } from "@/session/title"
import type { HomeSessionRecord } from "./controller"
import type { HomeUserGroup } from "./groups"

type Choice = { id: string | undefined; title: string }

// Keyboard path for group assignment: pick a session, then a group or a new one.
export function HomeSessionGroupDialog(props: {
  records: HomeSessionRecord[]
  groups: HomeUserGroup[]
  groupOf: (sessionID: string) => HomeUserGroup | undefined
  onAssign: (sessionID: string, groupID: string | undefined) => void
  onCreate: (sessionID: string) => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [session, setSession] = createSignal<HomeSessionRecord>()

  const sessions = () =>
    props.records.map((record) => ({ id: record.session.id, title: sessionLabel(record.session), record }))

  const choices = (): Choice[] => {
    const current = session() && props.groupOf(session()!.session.id)

    return [
      ...props.groups
        .filter((group) => group.id !== current?.id)
        .map((group) => ({ id: group.id, title: group.title })),
      { id: undefined, title: language.t("home.sessions.group.newWith") },
      ...(current ? [{ id: "", title: language.t("home.sessions.group.ungroup") }] : []),
    ]
  }

  const choose = (choice: Choice | undefined) => {
    const target = session()

    if (!choice || !target) return

    if (choice.id === undefined) props.onCreate(target.session.id)
    else props.onAssign(target.session.id, choice.id || undefined)
    dialog.close()
  }

  return (
    <Dialog>
      <DialogHeader>
        <DialogTitle>
          {session() ? language.t("home.sessions.group.pickGroup") : language.t("home.sessions.group.pickSession")}
        </DialogTitle>
      </DialogHeader>
      <DialogBody>
        <Show
          when={session()}
          fallback={
            <List
              class="flex-1 px-3 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
              search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
              emptyMessage={language.t("home.sessions.empty")}
              key={(item) => item.id}
              items={sessions}
              filterKeys={["title"]}
              onSelect={(item) => {
                setSession(item?.record)
                // The group list replaces this one inside the open dialog, so its autofocus never fires.
                requestAnimationFrame(() =>
                  document.querySelector<HTMLInputElement>(".home-session-group-choices input")?.focus(),
                )
              }}
            >
              {(item) => <span class="truncate text-left font-normal">{item.title}</span>}
            </List>
          }
        >
          <List
            class="home-session-group-choices flex-1 px-3 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
            search={{ placeholder: language.t("common.search.placeholder"), autofocus: true }}
            emptyMessage={language.t("home.sessions.empty")}
            key={(item) => item.id ?? "new"}
            items={choices}
            filterKeys={["title"]}
            onSelect={choose}
          >
            {(item) => <span class="truncate text-left font-normal">{item.title}</span>}
          </List>
        </Show>
      </DialogBody>
    </Dialog>
  )
}
