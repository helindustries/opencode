import { Schema } from "effect"
import { createMemo } from "solid-js"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"

const Group = Persistence.struct({
  id: Schema.String,
  title: Schema.String,
  server: Schema.String,
  members: Persistence.array(Schema.String),
})

export type HomeUserGroup = typeof Group.Type

export const HomeSessionGroupsSchema = Persistence.struct({ groups: Persistence.array(Group) })

// User-defined sidebar groups are client-local structure: titles plus ordered member session IDs, per
// server. A session belongs to at most one group, and a group that loses its last member goes away.
export function createHomeSessionGroups(server: () => string | undefined) {
  const [store, setStore] = persisted(Persist.global("home.session-groups"), HomeSessionGroupsSchema, { groups: [] })
  const list = createMemo(() => store.groups.filter((group) => group.server === server()))

  const update = (change: (groups: HomeUserGroup[]) => HomeUserGroup[]) =>
    setStore("groups", (groups) =>
      change(groups.map((group) => ({ ...group, members: [...group.members] }))).filter(
        (group) => group.members.length > 0,
      ),
    )

  const detach = (groups: HomeUserGroup[], sessionID: string) =>
    groups.map((group) =>
      group.server === server() ? { ...group, members: group.members.filter((id) => id !== sessionID) } : group,
    )

  return {
    list,
    of: (sessionID: string) => list().find((group) => group.members.includes(sessionID)),
    assign(sessionID: string, groupID: string | undefined) {
      update((groups) =>
        detach(groups, sessionID).map((group) =>
          group.id === groupID ? { ...group, members: [...group.members, sessionID] } : group,
        ),
      )
    },
    create(title: string, sessionID: string) {
      const current = server()

      if (!current) return
      const id = `group_${crypto.randomUUID()}`
      update((groups) => [...detach(groups, sessionID), { id, title, server: current, members: [sessionID] }])

      return id
    },
    rename(groupID: string, title: string) {
      update((groups) => groups.map((group) => (group.id === groupID ? { ...group, title } : group)))
    },
    move(groupID: string, offset: -1 | 1) {
      update((groups) => {
        const own = groups.filter((group) => group.server === server())
        const index = own.findIndex((group) => group.id === groupID)
        const target = index + offset

        if (index === -1 || target < 0 || target >= own.length) return groups

        const reordered = [...own]

        ;[reordered[index], reordered[target]] = [reordered[target]!, reordered[index]!]

        return [...groups.filter((group) => group.server !== server()), ...reordered]
      })
    },
    remove(groupID: string) {
      update((groups) => groups.filter((group) => group.id !== groupID))
    },
  }
}

export type HomeSessionGroups = ReturnType<typeof createHomeSessionGroups>
