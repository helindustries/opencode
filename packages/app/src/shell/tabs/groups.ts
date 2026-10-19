import { Schema } from "effect"
import { createSimpleContext } from "@opencode/ui/context"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"

const Group = Persistence.struct({
  id: Schema.String,
  title: Schema.String,
  collapsed: Persistence.optional(Schema.Boolean),
  members: Persistence.array(Schema.String),
})

export type TabGroup = typeof Group.Type

const Groups = Persistence.struct({ groups: Persistence.array(Group) })

function withMember(groups: readonly TabGroup[], key: string, groupID: string | undefined) {
  return groups.map((group) => {
    const members = group.members.filter((member) => member !== key)

    return { ...group, members: group.id === groupID ? [...members, key] : members }
  })
}

// Groups belong to the window, like its tabs: titles, collapsed state and member tab keys.
export const { use: useTabGroups, provider: TabGroupsProvider } = createSimpleContext({
  name: "TabGroups",
  gate: false,
  init: () => {
    const [store, setStore] = persisted(Persist.window("tabs.groups"), Groups, { groups: [] })
    const update = (change: (groups: TabGroup[]) => TabGroup[]) => setStore("groups", (groups) => change([...groups]))

    return {
      list: () => store.groups,
      of: (key: string) => store.groups.find((group) => group.members.includes(key)),
      assign: (key: string, groupID: string | undefined) => update((groups) => withMember(groups, key, groupID)),
      create(title: string, key: string) {
        const id = `group_${crypto.randomUUID()}`
        update((groups) => [...withMember(groups, key, undefined), { id, title, members: [key] }])

        return id
      },
      rename: (groupID: string, title: string) =>
        update((groups) => groups.map((group) => (group.id === groupID ? { ...group, title } : group))),
      toggle: (groupID: string) =>
        update((groups) =>
          groups.map((group) => (group.id === groupID ? { ...group, collapsed: !group.collapsed } : group)),
        ),
      move(groupID: string, offset: -1 | 1) {
        update((groups) => {
          const index = groups.findIndex((group) => group.id === groupID)
          const target = index + offset

          if (index === -1 || target < 0 || target >= groups.length) return groups
          ;[groups[index], groups[target]] = [groups[target]!, groups[index]!]

          return groups
        })
      },
      remove: (groupID: string) => update((groups) => groups.filter((group) => group.id !== groupID)),
      /** Drops members whose tabs are gone, and the groups left empty. */
      prune: (keys: ReadonlySet<string>) =>
        update((groups) =>
          groups
            .map((group) => ({ ...group, members: group.members.filter((key) => keys.has(key)) }))
            .filter((group) => group.members.length > 0),
        ),
    }
  },
})

export type TabGroups = ReturnType<typeof useTabGroups>
