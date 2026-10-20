import { batch, createEffect, createMemo, createResource, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable, useSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints, type Draggable } from "@dnd-kit/dom"
import { RestrictToHorizontalAxis, RestrictToVerticalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { arrayMove } from "@dnd-kit/helpers"
import { tabHref, tabKey, type SessionTab, type Tab } from "@/shell/tabs/tabs"
import { ServerConnection } from "@/runtime/server/registry"
import { DraftTabItem, TabNavItem, type TabGrouping } from "@/shell/titlebar/tab-nav"
import { useRemoteControl } from "@/shell/tabs/remote-control"
import { useTabGroups, type TabGroup } from "@/shell/tabs/groups"
import { groupAfterDrop, groupEntry, isGroupEntry, meshGroups, tabSections } from "@/shell/tabs/sidebar-model"
import { TabGroupHeader } from "@/shell/titlebar/tab-group-header"
import { useGlobal, useServerCtx, type ServerCtx } from "@/runtime/server/runtime"
import { useLanguage } from "@/runtime/i18n/language"
import { useCommand } from "@/shell/commands/command"
import { useTabs } from "@/shell/tabs/tabs"
import { useSessionTabAvatarState } from "@/shell/layout/project-avatar-state"
import { createTabComposerState } from "@/composer/persistence"
import { base64Encode } from "@opencode/util/encode"
import { showToast } from "@/shell/notifications/toast"
import { adjacentTabKey, mergeVisibleTabOrder } from "./tab-order"
import type { SessionInfo } from "@opencode/client/promise"

function SessionTabSlot(props: {
  tab: SessionTab
  id: string
  index: number
  active: boolean
  orientation: "horizontal" | "vertical"
  session: SessionInfo | undefined
  preparing: boolean
  unread: boolean
  loading: boolean
  fallbackTitle?: string
  shared: boolean
  grouping: TabGrouping | undefined
  onRename: (title: string) => Promise<void>
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index
    },
  })

  let ref!: HTMLDivElement

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active}
      data-orientation={props.orientation}
      class="relative flex"
      classList={{
        "w-56 min-w-7 max-w-56 flex-shrink": props.orientation === "horizontal",
        "w-full shrink-0": props.orientation === "vertical",
      }}
    >
      <TabNavItem
        ref={(el) => {
          ref = el
        }}
        href={tabHref(props.tab)}
        server={props.tab.server}
        session={props.session}
        preparing={props.preparing}
        unread={props.unread}
        loading={props.loading}
        fallbackTitle={props.fallbackTitle}
        shared={props.shared}
        grouping={props.grouping}
        onRename={props.onRename}
        onNavigate={() => props.onNavigate(ref)}
        onClose={props.onClose}
        active={props.active}
        dragging={sortable.isDragSource()}
        orientation={props.orientation}
      />
    </div>
  )
}

// A header takes part in sorting only as a place to drop: the pointer sensor never starts a drag on it.
function GroupHeaderSlot(props: { id: string; index: number; children: JSX.Element }) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index
    },
  })

  return (
    <div ref={sortable.ref} class="w-full shrink-0">
      {props.children}
    </div>
  )
}

function SessionTabEntry(props: {
  tab: SessionTab
  id: string
  index: number
  active: boolean
  orientation: "horizontal" | "vertical"
  serverCtx: ServerCtx | undefined
  grouping: TabGrouping | undefined
  onVisibleChange: (visible: boolean) => void
  onUnreadChange: (unread: boolean) => void
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const tabs = useTabs()
  const language = useLanguage()
  const remoteControl = useRemoteControl()
  const sdk = createMemo(() => props.serverCtx?.sdk ?? null)
  const pending = createMemo(() => tabs.pendingSession(props.tab.server, props.tab.sessionId))
  const cachedSession = createMemo(() => props.serverCtx?.data.session.get(props.tab.sessionId))
  const persisted = createMemo(() => tabs.info[props.id])

  const status = useSessionTabAvatarState(
    () => props.tab.server,
    () => props.tab.sessionId,
    () => true,
  )

  // A busy session shows its progress indicator instead of the unread dot.
  const unread = createMemo(() => status.unread() && !status.loading())

  const [loadedSession] = createResource(
    () => {
      if (pending()) return null
      const ctx = props.serverCtx

      return ctx ? { id: props.tab.sessionId, ctx } : null
    },
    ({ id, ctx }) =>
      ctx.data.session
        .sync(id)
        .then(() => ctx.data.session.get(id))
        .catch(() => undefined),
  )

  const session = createMemo(() => (pending() ? undefined : (cachedSession() ?? loadedSession())))
  const missingSession = createMemo(() => !pending() && !!props.serverCtx && !loadedSession.loading && !session())
  const visible = createMemo(() => !!pending() || !!session() || missingSession() || !!persisted()?.title)

  const rename = async (title: string) => {
    const value = session()
    const ctx = props.serverCtx

    if (!value || !ctx) return

    ctx.data.session.remember({ ...value, title })

    try {
      await ctx.sdk.api.session.update({ sessionID: value.id, title })
    } catch (err) {
      const current = session()
      const currentCtx = props.serverCtx

      if (current && currentCtx) currentCtx.data.session.remember({ ...current, title: value.title })
      showToast({
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  createEffect(() => props.onVisibleChange(visible()))
  createEffect(() => props.onUnreadChange(unread()))

  createEffect(() => {
    const ctx = props.serverCtx
    const value = session()

    if (!ctx || !value || props.active || ctx.sdk.connection.status() !== "connected") return

    const timer = window.setTimeout(
      () =>
        void Promise.allSettled([
          ctx.data.session.sync(value.id, { children: true }),
          // The selected timeline loads the transcript; inactive tabs need attention, metadata, and the inbox,
          // whose waiting work keeps the tab busy.
          ctx.data.session.permission.sync(value.id),
          ctx.data.session.form.sync(value.id),
          ctx.data.session.pending.sync(value.id),
        ]),
      300 + props.index * 50,
    )

    onCleanup(() => window.clearTimeout(timer))
  })

  createEffect(() => {
    const value = session()

    if (!value) return
    tabs.rememberSessionInfo(
      props.tab,
      value,
      props.serverCtx?.data.session.message.list(value.id).some((message) => message.type === "user") ?? false,
    )
    const current = sdk()

    if (!current) return
    createTabComposerState(tabs, props.tab, current.scope, {
      dir: base64Encode(value.location.directory),
      id: value.id,
    })
  })

  return (
    <Show when={visible()}>
      <SessionTabSlot
        tab={props.tab}
        id={props.id}
        index={props.index}
        active={props.active}
        orientation={props.orientation}
        session={session()}
        preparing={!!pending()}
        unread={unread()}
        loading={status.loading()}
        fallbackTitle={
          pending()
            ? language.t("session.tab.session")
            : (persisted()?.title ?? (missingSession() ? language.t("session.tab.unknown") : undefined))
        }
        shared={remoteControl.shared(props.tab.server, props.tab.sessionId)}
        grouping={props.grouping}
        onRename={rename}
        onNavigate={props.onNavigate}
        onClose={props.onClose}
      />
    </Show>
  )
}

function DraftTabSlot(props: {
  tab: Extract<Tab, { type: "draft" }>
  id: string
  index: number
  active: boolean
  orientation: "horizontal" | "vertical"
  title: string
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index
    },
  })

  let ref!: HTMLDivElement

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active}
      data-orientation={props.orientation}
      class="relative flex"
      classList={{
        "w-56 min-w-7 max-w-56 flex-shrink": props.orientation === "horizontal",
        "w-full shrink-0": props.orientation === "vertical",
      }}
    >
      <DraftTabItem
        ref={(el) => {
          ref = el
        }}
        href={tabHref(props.tab)}
        title={props.title}
        onNavigate={() => props.onNavigate(ref)}
        onClose={props.onClose}
        active={props.active}
        dragging={sortable.isDragSource()}
        orientation={props.orientation}
      />
    </div>
  )
}

export function TitlebarTabStrip(props: {
  orientation?: "horizontal" | "vertical"
  tabs: Tab[]
  currentTab: Tab | undefined
  onNavigate: (tab: Tab, el?: HTMLDivElement) => void
  onClose: (tab: Tab) => void
  onReorder: (keys: string[]) => void
}) {
  const global = useGlobal()
  const language = useLanguage()
  const command = useCommand()
  const vertical = () => props.orientation === "vertical"
  let listRef!: HTMLDivElement
  const groups = useTabGroups()
  const [visibility, setVisibility] = createStore<Record<string, boolean>>({})
  const [unread, setUnread] = createStore<Record<string, boolean>>({})
  const [renaming, setRenaming] = createSignal<string>()
  const remoteControl = useRemoteControl()
  const byKey = createMemo(() => new Map(props.tabs.map((tab) => [tabKey(tab), tab])))
  // A shared session's group lives in its mesh record, so every machine shows it alike.
  const tags = createMemo(
    () =>
      new Map(
        props.tabs.flatMap((tab) => {
          const title = tab.type === "session" ? remoteControl.group(tab.server, tab.sessionId) : undefined

          return title === undefined ? [] : [[tabKey(tab), title] as const]
        }),
      ),
  )
  const shownGroups = createMemo(() => meshGroups(groups.list(), tags()))
  // Only the vertical tab list shows groups; the titlebar keeps one flat row.
  const sections = createMemo(() =>
    vertical()
      ? tabSections(props.tabs.map(tabKey), shownGroups().groups)
      : [{ group: undefined, keys: props.tabs.map(tabKey) }],
  )
  // A collapsed group still shows its active tab, so the session on screen keeps its place in the list.
  const shown = (group: TabGroup | undefined, key: string) =>
    !group?.collapsed || (props.currentTab !== undefined && tabKey(props.currentTab) === key)
  const visibleTabs = createMemo(() =>
    sections().flatMap((section) =>
      section.keys.flatMap((key) => {
        const tab = byKey().get(key)

        return tab && (tab.type === "draft" || visibility[key]) && shown(section.group, key) ? [tab] : []
      }),
    ),
  )
  const visibleTabIds = () => visibleTabs().map(tabKey)
  // The drag order: visible tabs with each group's header ahead of its tabs.
  const entries = createMemo(() => {
    const visible = new Set(visibleTabIds())

    return sections().flatMap((section) => [
      ...(section.group ? [groupEntry(section.group.id)] : []),
      ...section.keys.filter((key) => visible.has(key)),
    ])
  })
  const [dropGroup, setDropGroup] = createSignal<string>()
  // While sorting, dnd-kit moves the dragged tab's node, also into another group's container. Solid clears a list
  // that becomes empty by emptying its container, so a node moved out of it would stay behind next to the one
  // rendered in its new group; the node goes back to where Solid put it before the drop changes any state.
  let dragOrigin: { element: Element; parent: Node; next: Node | null } | undefined
  const restoreDragged = () => {
    const origin = dragOrigin
    dragOrigin = undefined

    if (origin && (origin.element.parentNode !== origin.parent || origin.element.nextSibling !== origin.next))
      origin.parent.insertBefore(origin.element, origin.next)
  }

  // Groups forget tabs that were closed. Desktop storage loads after the first render, and pruning against the
  // initial empty list would save it over the stored groups; an empty tab list is the store before it loads.
  createEffect(() => {
    if (groups.ready() && props.tabs.length > 0) groups.prune(new Set(props.tabs.map(tabKey)))
  })

  // A group another machine gave a shared session appears here too, and goes when no tab is left in it; that waits
  // for the mesh records, before which every such group looks empty.
  createEffect(() => {
    if (!groups.ready()) return
    for (const title of shownGroups().missing) groups.createFromMesh(title)

    if (remoteControl.feed.available())
      for (const group of shownGroups().groups) if (group.mesh && group.members.length === 0) groups.remove(group.id)
  })

  const tagShared = (key: string, title: string | null) => {
    const tab = byKey().get(key)

    if (tab?.type === "session") void remoteControl.setGroup(tab.server, tab.sessionId, title)
  }

  const assignTab = (key: string, groupID: string | undefined) => {
    if (!tags().has(key)) return groups.assign(key, groupID)
    groups.assign(key, undefined)
    tagShared(key, groups.list().find((group) => group.id === groupID)?.title ?? null)
  }

  // Group edits that retag shared tabs run batched: between the retag and the group change, the effect above would
  // see a title no group has and create it.
  const createGroup = (key?: string) =>
    batch(() => {
      const shared = key !== undefined && tags().has(key)
      const title = language.t("home.sessions.group.new")
      const id = groups.create(title, shared ? undefined : key)

      if (shared) tagShared(key, title)
      setRenaming(id)
    })

  const sharedMembers = (groupID: string) =>
    shownGroups()
      .groups.find((group) => group.id === groupID)
      ?.members.filter((key) => tags().has(key)) ?? []

  const renameGroup = (groupID: string, title: string) =>
    batch(() => {
      for (const key of sharedMembers(groupID)) tagShared(key, title)
      groups.rename(groupID, title)
    })

  const removeGroup = (groupID: string) =>
    batch(() => {
      for (const key of sharedMembers(groupID)) tagShared(key, null)
      groups.remove(groupID)
    })

  const grouping = (key: string): TabGrouping | undefined =>
    vertical()
      ? {
          groups: groups.list(),
          current: shownGroups().groups.find((group) => group.members.includes(key))?.id,
          assign: (groupID) => assignTab(key, groupID),
          create: () => createGroup(key),
          createEmpty: () => createGroup(),
        }
      : undefined

  const trackDrop = (source: Draggable | null) => {
    if (vertical() && isSortable(source)) {
      const next = arrayMove(entries(), source.initialIndex, source.index)
      setDropGroup(groupAfterDrop(next, source.id.toString(), shownGroups().groups))
    }
  }

  command.register("titlebar-tab-cycle", () => [
    {
      id: `tab.prev`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowLeft,ctrl+shift+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(-1),
    },
    {
      id: `tab.next`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowRight,ctrl+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(1),
    },
    {
      id: "session.previous",
      category: language.t("command.category.session"),
      title: language.t("command.session.previous"),
      keybind: "alt+arrowup",
      onSelect: () => selectAdjacentTab(-1),
    },
    {
      id: "session.next",
      category: language.t("command.category.session"),
      title: language.t("command.session.next"),
      keybind: "alt+arrowdown",
      onSelect: () => selectAdjacentTab(1),
    },
    {
      id: "session.previous.unseen",
      category: language.t("command.category.session"),
      title: language.t("command.session.previous.unseen"),
      keybind: "shift+alt+arrowup",
      onSelect: () => selectAdjacentTab(-1, (key) => !!unread[key]),
    },
    {
      id: "session.next.unseen",
      category: language.t("command.category.session"),
      title: language.t("command.session.next.unseen"),
      keybind: "shift+alt+arrowdown",
      onSelect: () => selectAdjacentTab(1, (key) => !!unread[key]),
    },
  ])

  function selectAdjacentTab(offset: -1 | 1, include?: (key: string) => boolean) {
    const current = props.currentTab
    const key = adjacentTabKey(visibleTabIds(), current ? tabKey(current) : undefined, offset, include)
    const next = props.tabs.find((tab) => tabKey(tab) === key)

    if (next) props.onNavigate(next)
  }

  return (
    <div
      data-slot={vertical() ? "vertical-tabs" : "titlebar-tabs"}
      data-orientation={vertical() ? "vertical" : "horizontal"}
      class="relative min-w-0"
      classList={{ "min-h-0 overflow-hidden": vertical() }}
    >
      <div
        data-slot={vertical() ? "vertical-tabs-scroll" : "titlebar-tabs-scroll"}
        class="flex min-w-0 no-scrollbar [app-region:no-drag]"
        classList={{
          "flex-row items-center gap-1.5 overflow-x-auto": !vertical(),
          "max-h-full flex-col overflow-y-auto overflow-x-hidden": vertical(),
        }}
      >
        <DragDropProvider
          sensors={[
            PointerSensor.configure({
              activationConstraints: (event) =>
                event.pointerType === "touch"
                  ? [new PointerActivationConstraints.Distance({ value: 8 })]
                  : [new PointerActivationConstraints.Distance({ value: 4 })],
              preventActivation: (event) =>
                event.target instanceof Element &&
                !!event.target.closest(
                  '[data-slot="tab-close"], [contenteditable="true"], [data-slot="tab-group-header"]',
                ),
            }),
          ]}
          modifiers={[
            vertical() ? RestrictToVerticalAxis : RestrictToHorizontalAxis,
            RestrictToElement.configure({ element: () => listRef }),
          ]}
          plugins={(defaults) => [
            ...defaults.filter((plugin) => plugin !== Accessibility),
            AutoScroller.configure({ acceleration: 8, threshold: vertical() ? { x: 0, y: 0.05 } : { x: 0.05, y: 0 } }),
            Feedback.configure({ dropAnimation: null }),
          ]}
          onDragStart={(event) => {
            const source = event.operation.source

            if (!source) return
            const element = source.element

            if (element?.parentNode) dragOrigin = { element, parent: element.parentNode, next: element.nextSibling }
            const tab = props.tabs.find((item) => tabKey(item) === source.id.toString())

            if (!tab) return

            if (vertical()) {
              trackDrop(source)

              return
            }
            const tabEl = source.element?.querySelector<HTMLDivElement>("[data-titlebar-tab]")
            props.onNavigate(tab, tabEl ?? undefined)
          }}
          onDragOver={(event) => trackDrop(event.operation.source)}
          onDragMove={(event) => trackDrop(event.operation.source)}
          onDragEnd={(event) => {
            const current = entries()
            const source = event.operation.source

            setDropGroup(undefined)
            restoreDragged()

            if (event.canceled || !isSortable(source)) return

            const { initialIndex, index } = source

            if (initialIndex !== index) {
              const next = arrayMove(current, source.initialIndex, source.index)
              const moved = source.id.toString()
              const tabsOnly = (order: string[]) => order.filter((entry) => !isGroupEntry(entry))

              if (vertical()) assignTab(moved, groupAfterDrop(next, moved, shownGroups().groups))
              props.onReorder(mergeVisibleTabOrder(props.tabs.map(tabKey), tabsOnly(current), tabsOnly(next)))
            }
          }}
        >
          <div
            data-titlebar-tab-list
            data-orientation={vertical() ? "vertical" : "horizontal"}
            class="flex w-full min-w-0"
            classList={{ "flex-row items-center": !vertical(), "flex-col items-stretch": vertical() }}
            ref={listRef}
          >
            {/* Sections are keyed by group id: a group's update replaces its object, and keying by
                object would remount the header and its tabs and drop keyboard focus. */}
            <For each={sections().map((section) => section.group?.id ?? "")}>
              {(id) => {
                const section = () => sections().find((item) => (item.group?.id ?? "") === id)

                return (
                  <div
                    data-slot="tab-group-section"
                    data-drop-target={id !== "" && dropGroup() === id}
                    classList={{
                      "flex flex-col items-stretch": vertical(),
                      contents: !vertical(),
                      "mt-2 rounded-[8px] border border-transparent pb-1": id !== "",
                      "border-v2-border-border-focus bg-v2-background-bg-layer-02": id !== "" && dropGroup() === id,
                    }}
                  >
                    <Show when={section()?.group}>
                      {(group) => (
                        <GroupHeaderSlot id={groupEntry(id)} index={entries().indexOf(groupEntry(id))}>
                          <TabGroupHeader
                            group={group()}
                            count={section()?.keys.length ?? 0}
                            first={groups.list()[0]?.id === id}
                            last={groups.list().at(-1)?.id === id}
                            renaming={renaming() === id}
                            onRenamed={(title) => {
                              setRenaming(undefined)

                              if (title) renameGroup(id, title)
                            }}
                            onRename={() => setRenaming(id)}
                            onToggle={() => groups.toggle(id)}
                            onMove={(offset) => groups.move(id, offset)}
                            onDelete={() => removeGroup(id)}
                            onCreate={() => createGroup()}
                          />
                        </GroupHeaderSlot>
                      )}
                    </Show>
                    <div
                      classList={{
                        "flex flex-col items-stretch": vertical(),
                        contents: !vertical(),
                        "ps-3": id !== "",
                      }}
                    >
                      <For each={section()?.keys.filter((key) => shown(section()?.group, key)) ?? []}>
                        {(key) => (
                          <Show when={byKey().get(key)} keyed>
                            {renderTab}
                          </Show>
                        )}
                      </For>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </DragDropProvider>
      </div>
      <Show when={!vertical()}>
        <div
          data-slot="titlebar-tabs-fade-left"
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-[linear-gradient(to_right,var(--v2-background-bg-deep),transparent)]"
        />
        <div
          data-slot="titlebar-tabs-fade-right"
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-[linear-gradient(to_left,var(--v2-background-bg-deep),transparent)]"
        />
      </Show>
    </div>
  )

  function renderTab(tab: Tab) {
    const id = tabKey(tab)
    let ref!: HTMLDivElement
    const visibleIndex = () => visibleTabs().findIndex((item) => tabKey(item) === id)
    const sortIndex = () => entries().indexOf(id)
    useTabShortcut(visibleIndex, () => props.onNavigate(tab, ref))

    const serverCtx = useServerCtx(() => {
      if (tab.type !== "session") return

      return global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
    })

    if (tab.type === "session") {
      return (
        <SessionTabEntry
          tab={tab}
          id={id}
          index={sortIndex()}
          active={props.currentTab === tab}
          orientation={vertical() ? "vertical" : "horizontal"}
          serverCtx={serverCtx()}
          grouping={grouping(id)}
          onVisibleChange={(visible) => setVisibility(id, visible)}
          onUnreadChange={(value) => setUnread(id, value)}
          onNavigate={(element) => {
            ref = element
            props.onNavigate(tab, element)
          }}
          onClose={() => props.onClose(tab)}
        />
      )
    }

    return (
      <DraftTabSlot
        tab={tab}
        id={id}
        index={sortIndex()}
        active={props.currentTab === tab}
        orientation={vertical() ? "vertical" : "horizontal"}
        title={language.t("session.tab.session")}
        onNavigate={(element) => {
          ref = element
          props.onNavigate(tab, element)
        }}
        onClose={() => props.onClose(tab)}
      />
    )
  }
}

function useTabShortcut(index: () => number, onSelect: () => void) {
  const command = useCommand()

  command.register(() => {
    const number = index() + 1

    if (number < 1 || number > 9) return []

    return [
      {
        id: `tab.${number}`,
        category: "tab",
        title: "",
        keybind: `mod+${number}`,
        hidden: true,
        onSelect,
      },
    ]
  })
}
