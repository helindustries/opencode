export type TabGroupMembers = { id: string; collapsed?: boolean; members: readonly string[] }

export type TabSection<TGroup extends TabGroupMembers> = { group: TGroup | undefined; keys: string[] }

/** Ungrouped tabs first, then each group with its tabs, all in tab order. */
export function tabSections<TGroup extends TabGroupMembers>(
  keys: readonly string[],
  groups: readonly TGroup[],
): TabSection<TGroup>[] {
  const grouped = new Set(groups.flatMap((group) => group.members))

  return [
    { group: undefined, keys: keys.filter((key) => !grouped.has(key)) },
    ...groups.map((group) => ({ group, keys: keys.filter((key) => group.members.includes(key)) })),
  ]
}

const GROUP_ENTRY = "group:"

/** The drag order names a group header so a tab dropped right below it joins that group. */
export const groupEntry = (groupID: string) => GROUP_ENTRY + groupID

export const isGroupEntry = (entry: string) => entry.startsWith(GROUP_ENTRY)

/** A dragged tab joins the group whose header or tab it now follows; at the very top it leaves its group. */
export function groupAfterDrop(order: readonly string[], moved: string, groups: readonly TabGroupMembers[]) {
  const previous = order[order.indexOf(moved) - 1]

  if (previous === undefined) return undefined

  return isGroupEntry(previous)
    ? previous.slice(GROUP_ENTRY.length)
    : groups.find((group) => group.members.includes(previous))?.id
}

export type ServerCredentials = { url: string; password?: string }

/** The current connections whose saved server, at the same address, holds another password. */
export function staleCredentials<TConnection extends { http: ServerCredentials }>(
  current: readonly TConnection[],
  saved: readonly { http: ServerCredentials }[],
) {
  return current.filter((conn) =>
    saved.some((item) => item.http.url === conn.http.url && item.http.password !== conn.http.password),
  )
}

export type SharedSession<TServer> = { id: string; server: TServer; sessionId: string; group: string | null }

type GroupTagged = { session_id: string; group_tag: string | null }

/** Every session shared through remote control, this machine's own first; `id` stays stable across restarts. */
export function sharedSessions<TServer>(input: {
  local: TServer | undefined
  localShared: readonly string[]
  localRecords: readonly GroupTagged[]
  remote: readonly (GroupTagged & { origin_host: string; connection: TServer })[]
}): SharedSession<TServer>[] {
  const local = input.local
  const own = local
    ? input.localShared.map((sessionId) => ({
        id: `local/${sessionId}`,
        server: local,
        sessionId,
        group: input.localRecords.find((record) => record.session_id === sessionId)?.group_tag ?? null,
      }))
    : []

  return [
    ...own,
    ...input.remote.map((record) => ({
      id: `${record.origin_host}/${record.session_id}`,
      server: record.connection,
      sessionId: record.session_id,
      group: record.group_tag,
    })),
  ]
}

/**
 * The groups with their members as shown: a shared tab sits in the group titled as its mesh record says, wherever the
 * window keeps it; `missing` are the titles no group has yet.
 */
export function meshGroups<TGroup extends TabGroupMembers & { title: string }>(
  groups: readonly TGroup[],
  tags: ReadonlyMap<string, string | null>,
) {
  const local = (key: string) => !tags.has(key)
  const tagged = [...tags].flatMap(([key, title]) => (title === null ? [] : [{ key, title }]))
  const titles = new Set(groups.map((group) => group.title))

  return {
    groups: groups.map((group) => ({
      ...group,
      members: [
        ...group.members.filter(local),
        // A title two groups share takes its shared tabs into the first of them.
        ...tagged
          .filter((item) => item.title === group.title && groups.find((other) => other.title === item.title) === group)
          .map((item) => item.key),
      ],
    })),
    missing: [...new Set(tagged.map((item) => item.title).filter((title) => !titles.has(title)))],
  }
}
