import { Key } from "@solid-primitives/keyed"
import { createMemo, Show } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import { InlineInput } from "@opencode/ui/inline-input"
import { Menu } from "@opencode/ui/menu"
import { useLanguage } from "@/runtime/i18n/language"
import type { MeshController } from "./controller"
import type { MeshFeed, MeshRecord } from "./feed"

const SECTION_LABEL = "text-v2-text-text-muted [font-weight:440]"

// Registry refreshes replace the record objects, so menu and rename state live here, keyed by
// origin and session, the same way the home session rows keep theirs.
type RowUI = {
  menu: { id: string; x: number; y: number } | undefined
  editor: { id: string; draft: string; saving: boolean } | undefined
}

const rowID = (record: MeshRecord) => `${record.origin_host}/${record.session_id}`

export function MeshSessions(props: { feed: MeshFeed; controller: MeshController }) {
  const language = useLanguage()
  const [ui, setUI] = createStore<RowUI>({ menu: undefined, editor: undefined })

  const visible = () =>
    props.feed.available() && props.feed.connected().length + props.feed.past().length + props.feed.unsupported() > 0

  return (
    <Show when={visible()}>
      <section
        data-component="home-mesh"
        class="flex flex-col pt-1 pr-3 pb-2 md:pt-3"
        aria-label={language.t("home.mesh.title")}
      >
        <div class={`flex h-7 items-center ps-1.5 md:ps-3 ${SECTION_LABEL}`}>{language.t("home.mesh.title")}</div>
        <MeshGroup
          title={language.t("home.mesh.connected")}
          records={props.feed.connected()}
          connected
          {...props}
          ui={ui}
          setUI={setUI}
        />
        <MeshGroup
          title={language.t("home.mesh.past")}
          records={props.feed.past()}
          connected={false}
          {...props}
          ui={ui}
          setUI={setUI}
        />
        <Show when={props.feed.unsupported() > 0}>
          <div data-slot="home-mesh-unsupported" class="ps-1.5 pt-2 text-12-regular text-v2-text-text-faint md:ps-3">
            {language.plural("home.mesh.unsupported", props.feed.unsupported())}
          </div>
        </Show>
      </section>
    </Show>
  )
}

function MeshGroup(props: {
  title: string
  records: MeshRecord[]
  connected: boolean
  feed: MeshFeed
  controller: MeshController
  ui: RowUI
  setUI: SetStoreFunction<RowUI>
}) {
  return (
    <Show when={props.records.length > 0}>
      <div data-slot="home-mesh-group" class="flex min-w-0 flex-col gap-px pt-2">
        <div class="flex h-6 items-center ps-1.5 text-12-medium text-v2-text-text-faint md:ps-3">{props.title}</div>
        <Key each={props.records} by={rowID}>
          {(record) => <MeshRow {...props} record={record()} />}
        </Key>
      </div>
    </Show>
  )
}

function MeshRow(props: {
  record: MeshRecord
  connected: boolean
  feed: MeshFeed
  controller: MeshController
  ui: RowUI
  setUI: SetStoreFunction<RowUI>
}) {
  const language = useLanguage()
  const id = () => rowID(props.record)
  const title = () => props.record.title || props.record.session_id

  const owner = createMemo(() =>
    language.t("home.mesh.owner", { user: props.record.origin_user, host: new URL(props.record.server_url).hostname }),
  )

  const attachable = () => props.feed.attachable(props.record)
  const menu = () => (props.ui.menu?.id === id() ? props.ui.menu : undefined)
  const editor = () => (props.ui.editor?.id === id() ? props.ui.editor : undefined)
  const selector = () => `[data-component="home-mesh-row-container"][data-row-id="${CSS.escape(id())}"]`
  const rowButton = () => document.querySelector<HTMLButtonElement>(`${selector()} [data-component="home-mesh-row"]`)

  const openMenu = (element: HTMLElement, clientX: number, clientY: number) => {
    const bounds = element.getBoundingClientRect()
    props.setUI("menu", { id: id(), x: clientX - bounds.left, y: clientY - bounds.top })
  }

  const openEditor = () => {
    props.setUI("editor", { id: id(), draft: title(), saving: false })
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>(`${selector()} [data-component="home-mesh-rename"]`)
      input?.focus()
      input?.select()
    })
  }

  const closeEditor = () => {
    if (editor()?.saving) return
    props.setUI("editor", (value) => (value?.id === id() ? undefined : value))
  }

  const saveEditor = async () => {
    const current = editor()

    if (!current || current.saving) return

    if (current.draft.trim() === "" || current.draft === title()) return closeEditor()
    props.setUI("editor", { ...current, saving: true })
    const saved = await props.controller.rename(props.record, current.draft.trim())
    props.setUI("editor", (value) => (value?.id !== id() ? value : saved ? undefined : { ...value, saving: false }))

    if (saved) requestAnimationFrame(() => rowButton()?.focus())
  }

  return (
    <div
      data-component="home-mesh-row-container"
      data-row-id={id()}
      class="group/session relative flex h-10 min-w-0 items-center rounded-[6px]"
      onContextMenu={(event) => {
        if (editor()) return
        event.preventDefault()
        openMenu(event.currentTarget, event.clientX, event.clientY)
      }}
    >
      <Show
        when={!editor()}
        fallback={
          <div class="flex h-10 min-w-0 w-full flex-1 items-center gap-2 py-3 ps-1.5 pe-3 md:ps-3">
            <InlineInput
              data-component="home-mesh-rename"
              aria-label={language.t("common.rename")}
              dir="auto"
              value={editor()?.draft ?? ""}
              disabled={editor()?.saving ?? false}
              class="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-base [font-weight:530] outline-none"
              style={{ "--inline-input-shadow": "none", "text-align": "start" }}
              onInput={(event) => {
                const draft = event.currentTarget.value
                props.setUI("editor", (value) => (value?.id === id() ? { ...value, draft } : value))
              }}
              onKeyDown={(event) => {
                event.stopPropagation()

                if (event.isComposing || event.keyCode === 229) return

                if (event.key === "Enter") {
                  event.preventDefault()
                  void saveEditor()

                  return
                }

                if (event.key !== "Escape") return
                event.preventDefault()
                closeEditor()
                requestAnimationFrame(() => rowButton()?.focus())
              }}
              onBlur={closeEditor}
            />
          </div>
        }
      >
        <button
          type="button"
          data-component="home-mesh-row"
          aria-haspopup="menu"
          aria-expanded={!!menu()}
          aria-disabled={!attachable()}
          class={`
            flex h-10 min-w-0 w-full flex-1 cursor-default items-center gap-2 rounded-[6px] border-0 bg-transparent
            py-3 ps-1.5 pe-3 md:ps-3 text-start text-v2-text-text-muted [font-weight:530]
            transition-[background-color] duration-[120ms] ease-in-out
            hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none
          `}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && (event.key !== "F10" || !event.shiftKey)) return
            event.preventDefault()
            const bounds = event.currentTarget.getBoundingClientRect()
            openMenu(event.currentTarget, bounds.left + 12, bounds.bottom)
          }}
          onClick={() => {
            if (attachable()) void props.controller.attach(props.record)
          }}
        >
          <span
            aria-hidden="true"
            class="size-1.5 shrink-0 rounded-full"
            classList={{ "bg-v2-state-fg-success": props.connected, "bg-v2-background-bg-layer-04": !props.connected }}
          />
          <span class="min-w-0 truncate text-v2-text-text-base">{title()}</span>
          <span class="min-w-0 shrink truncate text-12-regular text-v2-text-text-faint">{owner()}</span>
          <Show when={!attachable()}>
            <span class="ms-auto shrink-0 text-12-regular text-v2-text-text-faint">
              {language.t("home.mesh.notAttachable")}
            </span>
          </Show>
        </button>
      </Show>
      <Menu
        modal={false}
        placement="bottom-start"
        gutter={2}
        open={!!menu()}
        onOpenChange={(open) => {
          if (open) return
          props.setUI("menu", (value) => (value?.id === id() ? undefined : value))
        }}
      >
        <Menu.Trigger
          as="span"
          aria-hidden="true"
          tabIndex={-1}
          class="pointer-events-none absolute size-px"
          style={{ left: `${menu()?.x ?? 0}px`, top: `${menu()?.y ?? 0}px` }}
        />
        <Menu.Portal>
          <Menu.Content
            onCloseAutoFocus={(event) => {
              event.preventDefault()

              if (!editor()) requestAnimationFrame(() => rowButton()?.focus())
            }}
          >
            <Show when={attachable()}>
              <Menu.Item onSelect={openEditor}>{language.t("common.rename")}</Menu.Item>
            </Show>
            <Show when={props.connected && attachable() && props.controller.attached(props.record)}>
              <Menu.Item onSelect={() => void props.controller.attach(props.record)}>
                {language.t("home.mesh.reattach")}
              </Menu.Item>
              <Menu.Item onSelect={() => props.controller.disconnect(props.record)}>
                {language.t("common.disconnect")}
              </Menu.Item>
            </Show>
            <Show when={!props.connected}>
              <Menu.Separator />
              <Menu.Item onSelect={() => void props.controller.forget(props.record)}>
                {language.t("home.mesh.forget")}
              </Menu.Item>
            </Show>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </div>
  )
}
