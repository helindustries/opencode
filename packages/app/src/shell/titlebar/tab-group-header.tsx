import { onMount, Show } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { Menu } from "@opencode/ui/menu"
import { useLanguage } from "@/runtime/i18n/language"
import type { TabGroup } from "@/shell/tabs/groups"

function TitleEditor(props: { title: string; onDone: (title: string | undefined) => void }) {
  let input!: HTMLInputElement
  let done = false
  const finish = (title: string | undefined) => {
    if (done) return
    done = true
    props.onDone(title?.trim() || undefined)
  }

  onMount(() => {
    input.focus()
    input.select()
  })

  return (
    <input
      ref={input}
      data-slot="tab-group-title-editor"
      value={props.title}
      aria-label={props.title}
      class="h-6 min-w-0 flex-1 rounded-[4px] bg-v2-background-bg-layer-02 px-1 text-[12px] font-medium text-v2-text-text-base outline-none"
      onKeyDown={(event) => {
        event.stopPropagation()

        if (event.key === "Enter") finish(input.value)

        if (event.key === "Escape") finish(undefined)
      }}
      onBlur={() => finish(input.value)}
    />
  )
}

export function TabGroupHeader(props: {
  group: TabGroup
  count: number
  first: boolean
  last: boolean
  renaming: boolean
  onRename: () => void
  onRenamed: (title: string | undefined) => void
  onToggle: () => void
  onMove: (offset: -1 | 1) => void
  onDelete: () => void
}) {
  const language = useLanguage()

  return (
    <div data-slot="tab-group-header" data-group={props.group.id} class="mt-2 flex h-7 w-full min-w-0 items-center">
      <Show when={!props.renaming} fallback={<TitleEditor title={props.group.title} onDone={props.onRenamed} />}>
        <Menu.Context modal={false}>
          <Menu.Context.Trigger
            as="button"
            type="button"
            data-slot="tab-group-toggle"
            aria-expanded={!props.group.collapsed}
            aria-label={language.t("session.tab.group.toggle", { title: props.group.title, count: props.count })}
            class="flex h-full min-w-0 flex-1 items-center gap-1 rounded-[6px] px-1.5 text-[12px] font-medium text-v2-text-text-muted hover:text-v2-text-text-base focus-visible:outline focus-visible:outline-1"
            onClick={props.onToggle}
            onDblClick={(event: MouseEvent) => {
              event.preventDefault()
              props.onRename()
            }}
            onKeyDown={(event: KeyboardEvent) => {
              if (event.key !== "F2") return
              event.preventDefault()
              props.onRename()
            }}
          >
            <Icon name={props.group.collapsed ? "chevron-right" : "chevron-down"} size="small" />
            <span class="min-w-0 flex-1 truncate text-start">{props.group.title}</span>
            <span class="shrink-0 text-[11px] text-v2-text-text-faint [font-variant-numeric:tabular-nums]">
              {props.count}
            </span>
          </Menu.Context.Trigger>
          <Menu.Context.Portal>
            <Menu.Context.Content>
              <Menu.Item onSelect={props.onRename}>{language.t("common.rename")}</Menu.Item>
              <Menu.Item disabled={props.first} onSelect={() => props.onMove(-1)}>
                {language.t("home.sessions.group.moveUp")}
              </Menu.Item>
              <Menu.Item disabled={props.last} onSelect={() => props.onMove(1)}>
                {language.t("home.sessions.group.moveDown")}
              </Menu.Item>
              <Menu.Separator />
              <Menu.Item onSelect={props.onDelete}>{language.t("home.sessions.group.delete")}</Menu.Item>
            </Menu.Context.Content>
          </Menu.Context.Portal>
        </Menu.Context>
      </Show>
    </div>
  )
}
