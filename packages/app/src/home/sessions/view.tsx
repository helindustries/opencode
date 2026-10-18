import type { SessionInfo } from "@opencode/client/promise"
import { Key } from "@solid-primitives/keyed"
import { createEffect, createMemo, For, Index, on, onCleanup, Show } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import { InlineInput } from "@opencode/ui/inline-input"
import { Spinner } from "@opencode/ui/spinner"
import { ScrollView } from "@opencode/ui/scroll-view"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { Tooltip } from "@opencode/ui/tooltip"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import { SessionTabAvatarView } from "@/shell/layout/session-tab-avatar"
import { sessionLabel } from "@/session/title"
import { shouldOpenSessionInBackground } from "./open"
import { createAltHold } from "./alt-hold"
import "./view.css"
import {
  HomeSessionStatusController,
  homeSessionSearchKey,
  type HomeSessionGroup,
  type HomeSessionRecord,
  type OpenSessionOptions,
} from "./controller"
import type { HomeUserGroup } from "./groups"

const SHOW_HOME_SESSION_ARCHIVE = false

const HOME_SECTION_LABEL = "text-v2-text-text-muted [font-weight:440]"

const HOME_SESSION_SEARCH_RESULTS_ID = "home-session-search-results"

const HOME_SESSION_LONG_PRESS_MS = 500

// Middle-click or Cmd+click on macOS (Ctrl+click elsewhere) opens a session
// tab in the background without navigating, matching browser conventions.
function isBackgroundOpen(event: MouseEvent) {
  return shouldOpenSessionInBackground({
    button: event.button,
    mac: typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform),
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
  })
}

export type HomeSessionsViewProps = {
  language: ReturnType<typeof useLanguage>
  groups: HomeSessionGroup[]
  loading: boolean
  desktop: boolean
  location: (record: HomeSessionRecord) => { worktree: string; branch: string | undefined }
  onRevealLocations: (record?: HomeSessionRecord) => void
  showProjectName: boolean
  server: ServerConnection.Key
  canCreateSession: boolean
  searchValue: string
  searchPlaceholder: string
  searchOpen: boolean
  searchLoading: boolean
  searchResults: HomeSessionRecord[]
  searchActive: string
  searchNoResultsLabel: string
  titleOpacity: (id: HomeSessionGroup["id"]) => number
  isOpenTab: (record: HomeSessionRecord) => boolean
  onCreateSession: () => void
  onOpenSession: (session: SessionInfo, options?: OpenSessionOptions) => void
  onArchiveSession: (session: SessionInfo) => Promise<void>
  onRenameSession: (server: ServerConnection.Key, session: SessionInfo, title: string) => Promise<boolean>
  onExportSession: (server: ServerConnection.Key, session: SessionInfo) => Promise<void>
  onDeleteSession: (server: ServerConnection.Key, session: SessionInfo) => void
  onSetHoverTarget: (element: HTMLElement) => void
  onSetThumbTrack: (element: HTMLDivElement) => void
  onSetContent: (element: HTMLDivElement) => void
  onSetHeader: (id: HomeSessionGroup["id"], element: HTMLDivElement) => void
  onWheel: (event: WheelEvent) => void
  onSetSearchRoot: (element: HTMLDivElement) => void
  onSetSearchInput: (element: HTMLInputElement) => void
  onSetSearchList: (element: HTMLDivElement) => void
  onSearchFocus: () => void
  onSearchInput: (value: string) => void
  onSearchClose: () => void
  onSearchMove: (delta: number) => void
  onSearchSelectActive: () => void
  onSearchHighlight: (record: HomeSessionRecord) => void
  onSearchSelect: (record: HomeSessionRecord, options?: OpenSessionOptions) => void
  userGroups: HomeUserGroup[]
  groupOf: (sessionID: string) => HomeUserGroup | undefined
  onAssignGroup: (sessionID: string, groupID: string | undefined) => void
  onCreateGroup: (sessionID: string) => string | undefined
  onRenameGroup: (groupID: string, title: string) => void
  onMoveGroup: (groupID: string, offset: -1 | 1) => void
  onDeleteGroup: (groupID: string) => void
}

// Session store updates recreate row components, so row-local state would
// close an open context menu or drop an in-progress rename. Keep both keyed
// by session ID at the view root, like the projects list does.
type HomeSessionRowUI = {
  menu: { id: string; x: number; y: number } | undefined
  editor: { id: string; draft: string; renaming: boolean } | undefined
  groupMenu: { id: string; x: number; y: number } | undefined
  groupEditor: { id: string; draft: string } | undefined
  dragging: string | undefined
  dropTarget: string | undefined
}

export function HomeSessionsView(props: HomeSessionsViewProps) {
  const [rowUI, setRowUI] = createStore<HomeSessionRowUI>({
    menu: undefined,
    editor: undefined,
    groupMenu: undefined,
    groupEditor: undefined,
    dragging: undefined,
    dropTarget: undefined,
  })
  const endDrag = () => setRowUI({ dragging: undefined, dropTarget: undefined })
  const startGroupRename = (groupID: string | undefined) => {
    const group = props.userGroups.find((item) => item.id === groupID)
    if (!group) return
    setRowUI("groupEditor", { id: group.id, draft: group.title })
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>(
        `[data-component="home-session-group-rename"][data-group-id="${group.id}"]`,
      )
      input?.focus()
      input?.select()
    })
  }
  // A drop on a user group assigns the dragged session to it; a drop on a calendar group takes it
  // out of any user group, which is the drag equivalent of "Remove from group".
  const dropHandlers = (target: () => HomeSessionGroup) => ({
    onDragOver: (event: DragEvent) => {
      if (!rowUI.dragging) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
      setRowUI("dropTarget", target().id)
    },
    onDrop: (event: DragEvent) => {
      const sessionID = rowUI.dragging
      if (!sessionID) return
      event.preventDefault()
      props.onAssignGroup(sessionID, target().user?.id)
      endDrag()
    },
  })
  const [hover, setHover] = createStore<{ sessionID: string | undefined }>({ sessionID: undefined })
  const showLocations = createAltHold(props.desktop, props.onRevealLocations)

  return (
    <section
      ref={props.onSetHoverTarget}
      class="min-h-0 min-w-0 flex-1 flex flex-col"
      aria-label={props.language.t("sidebar.project.recentSessions")}
    >
      <div
        class="sticky top-0 z-30 shrink-0 bg-v2-background-bg-base pb-1 pt-6 md:pb-3 lg:pt-12"
        onWheel={props.onWheel}
      >
        <HomeSessionSearch
          {...props}
          showLocations={showLocations()}
          hoveredSession={hover.sessionID}
          onHoverSession={(sessionID) => setHover("sessionID", sessionID)}
        />
        <Show when={props.groups.length > 0 && props.canCreateSession}>
          <div class="pointer-events-none absolute right-0 top-[68px] z-20 flex md:top-[84px] lg:top-[108px]">
            <Button
              data-action="home-new-session"
              variant="ghost-muted"
              size="normal"
              icon="edit"
              class="pointer-events-auto h-7 px-2 [font-weight:530]"
              onClick={props.onCreateSession}
            >
              {props.language.t("command.session.new")}
            </Button>
          </div>
        </Show>
      </div>
      <div class="pointer-events-none sticky top-[68px] z-40 h-0 -mr-3 md:top-[84px] lg:top-[108px]">
        <div
          ref={props.onSetThumbTrack}
          data-component="home-session-scroll-track"
          class="relative ml-auto h-[calc(100cqh-68px)] w-3 md:h-[calc(100cqh-84px)] lg:h-[calc(100cqh-108px)]"
        />
      </div>
      <div class="-mr-3 min-h-[calc(100cqh-64px)] md:min-h-[calc(100cqh-72px)] lg:min-h-[calc(100cqh-96px)]">
        <Show
          when={!props.loading}
          fallback={
            <div class="pt-1 md:pt-3">
              <HomeSessionSkeleton label={props.language.t("common.loading")} />
            </div>
          }
        >
          <Show
            when={props.groups.length > 0}
            fallback={
              <HomeSessionsEmpty
                onNewSession={props.canCreateSession ? props.onCreateSession : undefined}
                language={props.language}
              />
            }
          >
            <div ref={props.onSetContent} class="flex flex-col pt-1 pr-3 pb-16 md:pt-3">
              <Show when={rowUI.dragging}>
                <div
                  data-component="home-session-group-new-drop"
                  class="mb-3 flex h-10 items-center justify-center rounded-[6px] border border-dashed text-12-regular text-v2-text-text-muted"
                  classList={{
                    "border-v2-border-border-base bg-v2-overlay-simple-overlay-hover": rowUI.dropTarget === "new",
                    "border-v2-border-border-muted": rowUI.dropTarget !== "new",
                  }}
                  onDragOver={(event) => {
                    event.preventDefault()
                    setRowUI("dropTarget", "new")
                  }}
                  onDrop={(event) => {
                    const sessionID = rowUI.dragging
                    if (!sessionID) return
                    event.preventDefault()
                    endDrag()
                    startGroupRename(props.onCreateGroup(sessionID))
                  }}
                >
                  {props.language.t("home.sessions.group.dropNew")}
                </div>
              </Show>
              {/* Index keeps group subtrees mounted when the group arrays are
                  rebuilt, so store updates cannot recreate rows mid-gesture. */}
              <Index each={props.groups}>
                {(group, index) => (
                  <>
                    <HomeSessionGroupHeader
                      groupKey={group().id}
                      title={group().title}
                      titleOpacity={props.titleOpacity(group().id)}
                      onSetRef={(element) => props.onSetHeader(group().id, element)}
                      elevated={index === 0}
                      group={group().user}
                      language={props.language}
                      rowUI={rowUI}
                      setRowUI={setRowUI}
                      first={index === 0}
                      last={!props.groups[index + 1]?.user}
                      onRename={startGroupRename}
                      onSaveRename={props.onRenameGroup}
                      onMove={props.onMoveGroup}
                      onDelete={props.onDeleteGroup}
                      drop={dropHandlers(group)}
                    />
                    <div
                      data-slot="home-session-group-body"
                      data-drop-target={rowUI.dropTarget === group().id}
                      class={`flex min-w-0 flex-col gap-px rounded-[6px] pt-2 md:pt-4 ${index === props.groups.length - 1 ? "" : "mb-6"}`}
                      classList={{ "bg-v2-overlay-simple-overlay-hover": rowUI.dropTarget === group().id }}
                      {...dropHandlers(group)}
                    >
                      {/* Rows key by session ID: session.sync replaces the
                          stored session object wholesale, so reference-keyed
                          rows would be disposed mid-interaction whenever a
                          sync response lands. */}
                      <Key each={group().sessions} by={(record) => record.session.id}>
                        {(record) => (
                          <HomeSessionRow
                            {...props}
                            record={record()}
                            rowUI={rowUI}
                            setRowUI={setRowUI}
                            onEndDrag={endDrag}
                            onStartGroupRename={startGroupRename}
                            showLocations={showLocations()}
                            hoveredSession={hover.sessionID}
                            onHoverSession={(sessionID) => setHover("sessionID", sessionID)}
                          />
                        )}
                      </Key>
                    </div>
                  </>
                )}
              </Index>
            </div>
          </Show>
        </Show>
      </div>
    </section>
  )
}

function HomeSessionLeadingController(props: {
  server: HomeSessionsViewProps["server"]
  isOpenTab: HomeSessionsViewProps["isOpenTab"]
  record: HomeSessionRecord
}) {
  return (
    <HomeSessionStatusController
      server={props.server}
      record={props.record}
      isOpenTab={props.isOpenTab}
      render={(state) => (
        <HomeSessionLeading
          record={props.record}
          open={state.open()}
          unread={state.unread()}
          loading={state.loading()}
        />
      )}
    />
  )
}

function HomeSessionLeading(props: { record: HomeSessionRecord; open: boolean; unread: boolean; loading: boolean }) {
  return (
    <div class="relative shrink-0">
      <Show when={props.open}>
        <span
          aria-hidden="true"
          class={`
            pointer-events-none absolute top-1/2 h-3 w-0.5 -translate-y-1/2
            rounded-[2px] bg-v2-background-bg-layer-04
          `}
          style={{ right: "calc(100% + 4px)" }}
        />
      </Show>
      <SessionTabAvatarView
        project={props.record.project}
        directory={props.record.session.location.directory}
        unread={props.unread}
        loading={props.loading}
      />
    </div>
  )
}

function HomeSessionSearch(
  props: HomeSessionsViewProps & {
    showLocations: boolean
    hoveredSession: string | undefined
    onHoverSession: (sessionID: string | undefined) => void
  },
) {
  return (
    <div class="w-full">
      <div ref={props.onSetSearchRoot} data-component="home-session-search" class="relative z-30 w-full">
        <Show when={props.searchOpen}>
          <div
            data-component="home-session-search-panel"
            class={`
              absolute flex flex-col overflow-hidden rounded-[12px]
              bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)]
            `}
            style={{
              top: "-6px",
              "inset-inline-start": "-6px",
              width: "calc(100% + 12px)",
            }}
          >
            <div class="flex flex-col pt-9">
              <div id={HOME_SESSION_SEARCH_RESULTS_ID} role="listbox" class="flex flex-col gap-4 pt-4">
                <Show
                  when={!props.searchLoading}
                  fallback={
                    <div class="flex items-center justify-center px-4 py-3 text-v2-text-text-muted [font-weight:440]">
                      <Spinner class="size-4" />
                    </div>
                  }
                >
                  <Show
                    when={props.searchResults.length > 0}
                    fallback={
                      <p
                        class={`
                          my-1.5 px-4 pb-2 text-[13px] leading-4 tracking-[-0.04px]
                          text-v2-text-text-muted [font-weight:440]
                        `}
                      >
                        {props.searchNoResultsLabel}
                      </p>
                    }
                  >
                    <div class="flex flex-col">
                      <p
                        class={`
                          my-1.5 pl-[18px] pr-6 text-[13px] leading-4 tracking-[-0.04px]
                          text-v2-text-text-muted [font-weight:440]
                        `}
                      >
                        {props.language.t("home.sessions.search.sessions")}
                      </p>
                      <ScrollView class="max-h-[min(20rem,40dvh)]" viewportRef={props.onSetSearchList}>
                        <div class="flex flex-col gap-px pb-2">
                          <For each={props.searchResults}>
                            {(record) => (
                              <HomeSessionSearchResultRow
                                {...props}
                                record={record}
                                selected={props.searchActive === homeSessionSearchKey(record)}
                              />
                            )}
                          </For>
                        </div>
                      </ScrollView>
                    </div>
                  </Show>
                </Show>
              </div>
            </div>
          </div>
        </Show>
        <label
          class={`
            relative z-20 flex h-9 w-full items-center gap-2 rounded-[6px] py-1 ps-3 pe-2
            bg-v2-background-bg-layer-02/60 text-v2-icon-icon-muted transition-[background-color,box-shadow]
            duration-[120ms] ease-in-out hover:bg-v2-background-bg-layer-02 focus-within:bg-v2-background-bg-layer-02
          `}
        >
          <Icon name="magnifying-glass" />
          <input
            ref={props.onSetSearchInput}
            class={`
              relative z-20 min-w-0 flex-1 border-0 bg-transparent outline-0
              text-v2-text-text-base [font-weight:440] placeholder:text-v2-text-text-faint
            `}
            value={props.searchValue}
            placeholder={props.searchPlaceholder}
            aria-label={props.searchPlaceholder}
            aria-expanded={props.searchOpen}
            aria-controls={HOME_SESSION_SEARCH_RESULTS_ID}
            aria-autocomplete="list"
            aria-activedescendant={
              props.searchActive && props.searchOpen ? `home-session-search-option-${props.searchActive}` : undefined
            }
            onFocus={props.onSearchFocus}
            onInput={(event) => props.onSearchInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                props.onSearchClose()
                event.currentTarget.blur()

                return
              }

              if (!props.searchOpen || props.searchResults.length === 0) return

              if (event.altKey || event.metaKey) return

              if (event.key === "ArrowDown") {
                event.preventDefault()
                props.onSearchMove(1)

                return
              }

              if (event.key === "ArrowUp") {
                event.preventDefault()
                props.onSearchMove(-1)

                return
              }

              if (event.key === "Enter" && !event.isComposing) {
                event.preventDefault()
                props.onSearchSelectActive()
              }
            }}
          />
          <Show when={props.searchValue}>
            <IconButton
              type="button"
              variant="ghost-muted"
              size="small"
              class="relative z-20 shrink-0"
              icon={<Icon name="close" size="large" class="text-v2-icon-icon-muted" />}
              aria-label={props.searchPlaceholder}
              onClick={() => {
                props.onSearchClose()
                props.onSearchFocus()
              }}
            />
          </Show>
        </label>
      </div>
    </div>
  )
}

function HomeSessionSearchResultRow(
  props: HomeSessionsViewProps & {
    record: HomeSessionRecord
    selected: boolean
    showLocations: boolean
    hoveredSession: string | undefined
    onHoverSession: (sessionID: string | undefined) => void
  },
) {
  const title = createMemo(() => sessionLabel(props.record.session))
  const location = createMemo(() => props.location(props.record))
  const showProjectName = () => props.showProjectName && props.record.projectName
  const key = () => homeSessionSearchKey(props.record)

  return (
    <button
      type="button"
      id={`home-session-search-option-${key()}`}
      data-key={key()}
      data-component="home-session-search-row"
      data-project-name={!!showProjectName()}
      role="option"
      aria-selected={props.selected}
      class={`
        flex h-10 w-full shrink-0 cursor-default items-center border-0 py-3 pl-[18px] pr-6 text-left
        transition-[background-color] duration-[120ms] ease-in-out
        hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none
      `}
      classList={{
        "bg-v2-overlay-simple-overlay-hover": props.selected,
        "gap-1.5": props.desktop,
        "gap-2": !props.desktop,
      }}
      onMouseEnter={() => {
        props.onSearchHighlight(props.record)
        props.onHoverSession(props.record.session.id)
        props.onRevealLocations(props.record)
      }}
      onMouseLeave={() => props.onHoverSession(undefined)}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      onClick={(event) => props.onSearchSelect(props.record, { background: isBackgroundOpen(event) })}
      onAuxClick={(event) => {
        if (!isBackgroundOpen(event)) return
        event.preventDefault()
        props.onSearchSelect(props.record, { background: true })
      }}
    >
      <HomeSessionLeadingController server={props.server} isOpenTab={props.isOpenTab} record={props.record} />
      <div data-slot="home-session-labels" class="flex min-w-0 flex-1 items-center gap-1.5">
        <HomeSessionTitle title={title()} showProjectName={!!showProjectName()} search />
        <Show when={showProjectName()}>
          <HomeSessionProjectName name={props.record.projectName} trailing={props.desktop} search />
        </Show>
        <HomeSessionLocation
          location={location()}
          show={props.showLocations || props.hoveredSession === props.record.session.id}
          instantHide={
            !props.showLocations &&
            props.hoveredSession !== undefined &&
            props.hoveredSession !== props.record.session.id
          }
          desktop={props.desktop}
        />
      </div>
    </button>
  )
}

function HomeSessionGroupHeader(props: {
  groupKey: string
  title: string
  titleOpacity: number
  onSetRef: (element: HTMLDivElement) => void
  elevated?: boolean
  group: HomeUserGroup | undefined
  language: HomeSessionsViewProps["language"]
  rowUI: HomeSessionRowUI
  setRowUI: SetStoreFunction<HomeSessionRowUI>
  first: boolean
  last: boolean
  onRename: (groupID: string) => void
  onSaveRename: (groupID: string, title: string) => void
  onMove: (groupID: string, offset: -1 | 1) => void
  onDelete: (groupID: string) => void
  drop: { onDragOver: (event: DragEvent) => void; onDrop: (event: DragEvent) => void }
}) {
  const id = () => props.group?.id
  let header: HTMLDivElement | undefined
  // Index keeps header elements by position, so a reordered group lands on another element; the scroll
  // controller keys header offsets by group, so the element must be registered again under its new group.
  createEffect(
    on(
      () => props.groupKey,
      () => {
        if (header) props.onSetRef(header)
      },
      { defer: true },
    ),
  )
  const menu = () => (props.rowUI.groupMenu?.id === id() ? props.rowUI.groupMenu : undefined)
  const editor = () => (props.rowUI.groupEditor?.id === id() ? props.rowUI.groupEditor : undefined)
  const titleButton = () =>
    document.querySelector<HTMLButtonElement>(`[data-component="home-session-group-title"][data-group-id="${id()}"]`)

  const openMenu = (element: HTMLElement, clientX: number, clientY: number) => {
    const groupID = id()
    if (!groupID) return
    const bounds = element.getBoundingClientRect()
    props.setRowUI("groupMenu", { id: groupID, x: clientX - bounds.left, y: clientY - bounds.top })
  }
  const closeEditor = (save: boolean) => {
    const current = editor()
    if (!current) return
    if (save && current.draft.trim()) props.onSaveRename(current.id, current.draft.trim())
    props.setRowUI("groupEditor", undefined)
  }

  return (
    <div
      ref={(element) => {
        header = element
        props.onSetRef(element)
      }}
      class={`
        sticky top-[68px] flex h-7 min-w-0 items-center justify-between
        bg-v2-background-bg-base ps-1.5 md:ps-3 md:top-[84px] lg:top-[108px]
      `}
      classList={{
        "home-session-group-header z-[5]": !!props.elevated,
        "z-10": !props.elevated,
        "pointer-events-none": !props.group && !props.rowUI.dragging,
      }}
      {...props.drop}
    >
      <Show
        when={props.group}
        fallback={
          <div class={HOME_SECTION_LABEL} style={{ opacity: props.titleOpacity }}>
            {props.title}
          </div>
        }
      >
        <Show
          when={!editor()}
          fallback={
            <InlineInput
              data-component="home-session-group-rename"
              data-group-id={id()}
              aria-label={props.language.t("common.rename")}
              value={editor()?.draft ?? ""}
              class={`${HOME_SECTION_LABEL} min-w-0 flex-1 outline-none`}
              style={{ "--inline-input-shadow": "none", "text-align": "start" }}
              onInput={(event) => {
                const draft = event.currentTarget.value
                props.setRowUI("groupEditor", (value) => (value?.id === id() ? { ...value, draft } : value))
              }}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.isComposing || event.keyCode === 229) return
                if (event.key !== "Enter" && event.key !== "Escape") return
                event.preventDefault()
                closeEditor(event.key === "Enter")
                requestAnimationFrame(() => titleButton()?.focus())
              }}
              onBlur={() => closeEditor(true)}
            />
          }
        >
          <button
            type="button"
            data-component="home-session-group-title"
            data-group-id={id()}
            aria-haspopup="menu"
            aria-expanded={!!menu()}
            class={`${HOME_SECTION_LABEL} cursor-default rounded-sm border-0 bg-transparent p-0 text-start focus-visible:outline-none focus-visible:bg-v2-overlay-simple-overlay-hover`}
            style={{ opacity: props.titleOpacity }}
            onContextMenu={(event) => {
              event.preventDefault()
              openMenu(event.currentTarget, event.clientX, event.clientY)
            }}
            onDblClick={() => {
              const groupID = id()
              if (groupID) props.onRename(groupID)
            }}
            onKeyDown={(event) => {
              if (event.key === "F2") {
                event.preventDefault()
                const groupID = id()
                if (groupID) props.onRename(groupID)
                return
              }
              if (event.key !== "ContextMenu" && (event.key !== "F10" || !event.shiftKey)) return
              event.preventDefault()
              const bounds = event.currentTarget.getBoundingClientRect()
              openMenu(event.currentTarget, bounds.left + 12, bounds.bottom)
            }}
          >
            {props.title}
          </button>
        </Show>
        <Menu
          modal={false}
          placement="bottom-start"
          gutter={2}
          open={!!menu()}
          onOpenChange={(open) => {
            if (!open) props.setRowUI("groupMenu", undefined)
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
                if (!editor()) requestAnimationFrame(() => titleButton()?.focus())
              }}
            >
              <Menu.Item onSelect={() => props.onRename(id()!)}>{props.language.t("common.rename")}</Menu.Item>
              <Menu.Item disabled={props.first} onSelect={() => props.onMove(id()!, -1)}>
                {props.language.t("home.sessions.group.moveUp")}
              </Menu.Item>
              <Menu.Item disabled={props.last} onSelect={() => props.onMove(id()!, 1)}>
                {props.language.t("home.sessions.group.moveDown")}
              </Menu.Item>
              <Menu.Separator />
              <Menu.Item onSelect={() => props.onDelete(id()!)}>
                {props.language.t("home.sessions.group.delete")}
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu>
      </Show>
    </div>
  )
}

function HomeSessionRow(
  props: HomeSessionsViewProps & {
    record: HomeSessionRecord
    rowUI: HomeSessionRowUI
    setRowUI: SetStoreFunction<HomeSessionRowUI>
    showLocations: boolean
    hoveredSession: string | undefined
    onHoverSession: (sessionID: string | undefined) => void
    onEndDrag: () => void
    onStartGroupRename: (groupID: string | undefined) => void
  },
) {
  const title = createMemo(() => sessionLabel(props.record.session))
  const location = createMemo(() => props.location(props.record))
  const showProjectName = () => props.showProjectName && props.record.projectName
  const sessionID = () => props.record.session.id
  const menu = () => (props.rowUI.menu?.id === sessionID() ? props.rowUI.menu : undefined)
  const editor = () => (props.rowUI.editor?.id === sessionID() ? props.rowUI.editor : undefined)
  let longPressTimer: ReturnType<typeof setTimeout> | undefined
  let longPressStart: { x: number; y: number } | undefined
  let suppressClick = false
  let menuInteractedOutside = false

  // Focus targets are looked up by session ID: session store updates recreate
  // row components, so instance refs can point at detached nodes by the time
  // deferred focus runs.
  const rowSelector = () => `[data-component="home-session-row-container"][data-session-id="${sessionID()}"]`

  const rowButton = () =>
    document.querySelector<HTMLButtonElement>(`${rowSelector()} [data-component="home-session-row"]`)

  const renameInput = () =>
    document.querySelector<HTMLInputElement>(`${rowSelector()} [data-component="home-session-rename"]`)

  const clearLongPress = () => {
    if (longPressTimer !== undefined) clearTimeout(longPressTimer)
    longPressTimer = undefined
    longPressStart = undefined
  }

  onCleanup(clearLongPress)

  const openMenu = (element: HTMLElement, clientX: number, clientY: number) => {
    const bounds = element.getBoundingClientRect()
    props.setRowUI("menu", { id: sessionID(), x: clientX - bounds.left, y: clientY - bounds.top })
  }

  const openEditor = () => {
    props.setRowUI("editor", { id: sessionID(), draft: title(), renaming: false })
    requestAnimationFrame(() => {
      const input = renameInput()
      input?.focus()
      input?.select()
    })
  }

  const closeEditor = () => {
    if (editor()?.renaming) return
    props.setRowUI("editor", (value) => (value?.id === sessionID() ? undefined : value))
  }

  const saveEditor = async () => {
    const current = editor()

    if (!current || current.renaming) return
    props.setRowUI("editor", { ...current, renaming: true })
    const saved = await props.onRenameSession(props.server, props.record.session, current.draft)
    // Disabling the input during the request drops focus to the body; restore
    // it unless the user focused another control while the rename was pending.
    const restore = document.activeElement === document.body || document.activeElement === renameInput()
    props.setRowUI("editor", (value) => {
      if (value?.id !== sessionID()) return value

      return saved ? undefined : { ...value, renaming: false }
    })

    if (!restore) return
    requestAnimationFrame(() => {
      if (saved) {
        rowButton()?.focus()

        return
      }

      renameInput()?.focus()
    })
  }

  return (
    <div
      data-component="home-session-row-container"
      data-project-name={!!showProjectName()}
      data-session-id={props.record.session.id}
      class="group/session relative flex h-10 min-w-0 items-center rounded-[6px] outline-none focus:outline-none focus-visible:outline-none"
      classList={{ "opacity-60": props.rowUI.dragging === sessionID() }}
      draggable={!editor()}
      onDragStart={(event) => {
        event.dataTransfer?.setData("text/plain", sessionID())
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
        // Chrome cancels a drag whose source moves during dragstart, and showing the new-group drop
        // zone shifts every row, so the drag state lands a frame later.
        const id = sessionID()
        requestAnimationFrame(() => props.setRowUI("dragging", id))
      }}
      onDragEnd={props.onEndDrag}
      onContextMenu={(event) => {
        // While renaming, keep the native menu so paste and spelling work.
        if (editor()) return
        event.preventDefault()
        openMenu(event.currentTarget, event.clientX, event.clientY)
      }}
    >
      <Show
        when={!editor()}
        fallback={
          <div
            data-slot="home-session-editor"
            class="flex h-10 min-w-0 w-full flex-1 items-center py-3 ps-1.5 pe-3 md:ps-3 md:pe-10"
            classList={{ "gap-1.5": props.desktop, "gap-2": !props.desktop }}
          >
            <HomeSessionLeadingController server={props.server} isOpenTab={props.isOpenTab} record={props.record} />
            <div data-slot="home-session-labels" class="contents">
              <InlineInput
                data-component="home-session-rename"
                aria-label={props.language.t("common.rename")}
                dir="auto"
                value={editor()?.draft ?? ""}
                disabled={editor()?.renaming ?? false}
                class={`
                block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-base
                [font-weight:530] field-sizing-content outline-none focus:outline-none focus-visible:outline-none
                 ${showProjectName() ? "max-w-[min(70%,480px)] flex-[0_1_auto]" : "flex-[1_1_auto]"}
              `}
                style={{ "--inline-input-shadow": "none", "text-align": "start" }}
                onInput={(event) => {
                  const draft = event.currentTarget.value
                  props.setRowUI("editor", (value) => (value?.id === sessionID() ? { ...value, draft } : value))
                }}
                onKeyDown={(event) => {
                  event.stopPropagation()

                  // Enter and Escape during IME composition commit or cancel
                  // the composition, not the rename. Safari can report the
                  // composition-confirming keydown with isComposing false but
                  // keyCode 229.
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
              <Show when={showProjectName()}>
                <HomeSessionProjectName name={props.record.projectName} />
              </Show>
            </div>
          </div>
        }
      >
        <button
          type="button"
          data-component="home-session-row"
          aria-haspopup="menu"
          aria-expanded={!!menu()}
          class={`
            flex h-10 min-w-0 w-full flex-1 shrink-0 cursor-default items-center rounded-[6px] border-0
            bg-transparent py-3 ps-1.5 pe-3 md:ps-3 md:pe-10 text-start text-v2-text-text-muted [font-weight:530]
            transition-[background-color,color,box-shadow] duration-[120ms] ease-in-out
            hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none
          `}
          classList={{ "gap-1.5": props.desktop, "gap-2": !props.desktop }}
          onMouseDown={(event) => {
            if (event.button === 1) event.preventDefault()
          }}
          onMouseEnter={() => {
            props.onHoverSession(props.record.session.id)
            props.onRevealLocations(props.record)
          }}
          onMouseLeave={() => props.onHoverSession(undefined)}
          onPointerDown={(event) => {
            suppressClick = false

            if (event.pointerType !== "touch") return
            clearLongPress()
            const element = event.currentTarget
            const x = event.clientX
            const y = event.clientY
            longPressStart = { x, y }
            longPressTimer = setTimeout(() => {
              suppressClick = true
              clearLongPress()
              openMenu(element, x, y)
            }, HOME_SESSION_LONG_PRESS_MS)
          }}
          onPointerMove={(event) => {
            if (!longPressStart) return

            if (Math.abs(event.clientX - longPressStart.x) <= 8 && Math.abs(event.clientY - longPressStart.y) <= 8)
              return
            clearLongPress()
          }}
          onPointerUp={clearLongPress}
          onPointerCancel={() => {
            clearLongPress()
            suppressClick = false
          }}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && (event.key !== "F10" || !event.shiftKey)) return
            event.preventDefault()
            const bounds = event.currentTarget.getBoundingClientRect()
            openMenu(event.currentTarget, bounds.left + 12, bounds.bottom)
          }}
          onClick={(event) => {
            // The flag stays set until the long-press compatibility click
            // arrives, however delayed; keyboard activation (detail 0) is
            // never that click and passes through.
            if (suppressClick) {
              suppressClick = false

              if (event.detail !== 0) {
                event.preventDefault()

                return
              }
            }

            props.onOpenSession(props.record.session, { background: isBackgroundOpen(event) })
          }}
          onAuxClick={(event) => {
            if (!isBackgroundOpen(event)) return
            event.preventDefault()
            props.onOpenSession(props.record.session, { background: true })
          }}
        >
          <HomeSessionLeadingController server={props.server} isOpenTab={props.isOpenTab} record={props.record} />
          <div
            data-slot="home-session-labels"
            class="min-w-0 flex-1 items-center gap-1.5"
            classList={{ flex: props.desktop, contents: !props.desktop }}
          >
            <HomeSessionTitle title={title()} showProjectName={!!showProjectName()} />
            <Show when={showProjectName()}>
              <HomeSessionProjectName name={props.record.projectName} trailing={props.desktop} />
            </Show>
            <HomeSessionLocation
              location={location()}
              show={props.showLocations || props.hoveredSession === props.record.session.id}
              instantHide={
                !props.showLocations &&
                props.hoveredSession !== undefined &&
                props.hoveredSession !== props.record.session.id
              }
              desktop={props.desktop}
            />
          </div>
        </button>
      </Show>
      <Menu
        modal={false}
        placement="bottom-start"
        gutter={2}
        open={!!menu()}
        onOpenChange={(open) => {
          if (open) return
          props.setRowUI("menu", (value) => (value?.id === sessionID() ? undefined : value))
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
            onInteractOutside={() => {
              menuInteractedOutside = true
            }}
            onCloseAutoFocus={(event) => {
              // The trigger is an invisible positioning span, so Kobalte's
              // default close focus restore has no useful target. Skip the
              // row focus when the rename editor owns focus or the user
              // dismissed the menu by interacting elsewhere.
              event.preventDefault()
              const outside = menuInteractedOutside
              menuInteractedOutside = false

              if (outside || editor()) return
              requestAnimationFrame(() => rowButton()?.focus())
            }}
          >
            <Menu.Item onSelect={openEditor}>{props.language.t("common.rename")}</Menu.Item>
            <Menu.Sub gutter={0} overlap>
              <Menu.SubTrigger data-action="home-session-move-to-group">
                {props.language.t("home.sessions.group.moveTo")}
              </Menu.SubTrigger>
              <Menu.Portal>
                <Menu.SubContent>
                  <For each={props.userGroups}>
                    {(group) => (
                      <Menu.Item
                        disabled={props.groupOf(sessionID())?.id === group.id}
                        onSelect={() => props.onAssignGroup(sessionID(), group.id)}
                      >
                        {group.title}
                      </Menu.Item>
                    )}
                  </For>
                  <Show when={props.userGroups.length > 0}>
                    <Menu.Separator />
                  </Show>
                  <Menu.Item onSelect={() => props.onStartGroupRename(props.onCreateGroup(sessionID()))}>
                    {props.language.t("home.sessions.group.newWith")}
                  </Menu.Item>
                  <Show when={props.groupOf(sessionID())}>
                    <Menu.Item onSelect={() => props.onAssignGroup(sessionID(), undefined)}>
                      {props.language.t("home.sessions.group.ungroup")}
                    </Menu.Item>
                  </Show>
                </Menu.SubContent>
              </Menu.Portal>
            </Menu.Sub>
            <Menu.Item onSelect={() => void props.onExportSession(props.server, props.record.session)}>
              {props.language.t("common.export")}…
            </Menu.Item>
            <Menu.Separator />
            <Menu.Item onSelect={() => props.onDeleteSession(props.server, props.record.session)}>
              {props.language.t("common.delete")}…
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
      <Show when={SHOW_HOME_SESSION_ARCHIVE}>
        <div
          class={`
            hover-reveal absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1
            group-hover/session:opacity-100 focus-within:opacity-100
          `}
        >
          <Tooltip class="flex shrink-0 items-center" placement="bottom" value={props.language.t("common.archive")}>
            <IconButton
              data-action="home-session-archive"
              variant="ghost-muted"
              size="large"
              icon={<Icon name="archive" />}
              aria-label={props.language.t("common.archive")}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                void props.onArchiveSession(props.record.session)
              }}
            />
          </Tooltip>
        </div>
      </Show>
    </div>
  )
}

function HomeSessionTitle(props: { title: string; showProjectName: boolean; search?: boolean }) {
  return (
    <span
      data-component="home-session-title"
      dir="auto"
      class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-base [font-weight:530]"
      classList={{
        "text-[13px] leading-4 tracking-[-0.04px]": !!props.search,
        "max-w-[min(70%,480px)] flex-[0_1_auto]": props.showProjectName,
        "flex-[1_1_auto]": !props.showProjectName,
      }}
    >
      {props.title}
    </span>
  )
}

function HomeSessionLocation(props: {
  location: { worktree: string; branch: string | undefined }
  show: boolean
  instantHide: boolean
  desktop: boolean
}) {
  if (!props.desktop) return null

  return (
    <span
      dir="ltr"
      aria-hidden={!props.show || undefined}
      class="flex min-w-0 shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap ease-out motion-reduce:transition-none"
      classList={{
        "-ms-1.5 max-w-0 opacity-0": !props.show,
        "max-w-[60%] opacity-100": props.show,
        "transition-[max-width,opacity] duration-[120ms]": !props.instantHide,
        "transition-none": props.instantHide,
      }}
    >
      <Icon name="outline-worktree" class="shrink-0 text-v2-icon-icon-muted" />
      <span class="min-w-0 overflow-hidden text-ellipsis [font-weight:440]">{props.location.worktree}</span>
      <Show when={props.location.branch}>
        {(branch) => (
          <>
            <Icon name="branch" class="shrink-0 text-v2-icon-icon-muted" />
            <span class="min-w-0 overflow-hidden text-ellipsis [font-weight:440]">{branch()}</span>
          </>
        )}
      </Show>
    </span>
  )
}

function HomeSessionProjectName(props: { name: string; search?: boolean; trailing?: boolean }) {
  return (
    <span
      data-component="home-session-project-name"
      dir="auto"
      class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-muted [font-weight:440]"
      classList={{
        "flex-[0_1_auto]": !!props.trailing,
        "flex-[1_1_auto]": !props.trailing,
        "text-[13px] leading-4 tracking-[-0.04px]": !!props.search,
      }}
    >
      {props.name}
    </span>
  )
}

function HomeSessionsEmpty(props: { onNewSession?: () => void; language: ReturnType<typeof useLanguage> }) {
  return (
    <div class="flex min-h-full flex-col items-center gap-4 px-6 pt-[52px] text-center">
      <div
        class={`
          shrink-0 text-[13px] leading-text-compact tracking-[-0.04px]
          text-v2-text-text-base [font-weight:530]
        `}
      >
        {props.language.t("home.sessions.empty")}
      </div>
      <p
        class={`
          mb-1 text-center text-[13px] leading-5 tracking-[-0.04px]
          text-v2-text-text-muted [font-weight:440]
        `}
      >
        {props.language.t("home.sessions.empty.description")}
      </p>
      <Show when={props.onNewSession}>
        {(onNewSession) => (
          <Button data-action="home-new-session" variant="neutral" size="normal" icon="edit" onClick={onNewSession()}>
            {props.language.t("command.session.new")}
          </Button>
        )}
      </Show>
    </div>
  )
}

function HomeSessionSkeleton(props: { label: string }) {
  return (
    <div class="flex min-w-0 flex-col gap-4">
      <div class="flex h-7 min-w-0 items-center justify-between ps-1.5 pe-4 md:ps-4">
        <div class={HOME_SECTION_LABEL}>{props.label}</div>
      </div>
      <div class="flex min-w-0 flex-col gap-px" aria-hidden="true">
        <For each={[0, 1, 2, 3]}>{() => <div class="h-10 rounded-[6px] bg-v2-background-bg-deep opacity-70" />}</For>
      </div>
    </div>
  )
}
