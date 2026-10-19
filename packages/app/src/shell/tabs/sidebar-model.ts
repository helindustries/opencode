export type TabGroupMembers = { id: string; collapsed?: boolean; members: readonly string[] }

export type TabSection<TGroup extends TabGroupMembers> = { group: TGroup | undefined; keys: string[] }

/** Ungrouped tabs first, then each group's tabs, all in tab order; a group without open tabs is left out. */
export function tabSections<TGroup extends TabGroupMembers>(
  keys: readonly string[],
  groups: readonly TGroup[],
): TabSection<TGroup>[] {
  const grouped = new Set(groups.flatMap((group) => group.members))
  const sections: TabSection<TGroup>[] = [{ group: undefined, keys: keys.filter((key) => !grouped.has(key)) }]

  for (const group of groups) {
    const members = new Set(group.members)
    const own = keys.filter((key) => members.has(key))

    if (own.length > 0) sections.push({ group, keys: own })
  }

  return sections
}

/** A dragged tab joins the section of the tab it now follows; at the very top it leaves its group. */
export function groupAfterDrop(order: readonly string[], moved: string, groups: readonly TabGroupMembers[]) {
  const previous = order[order.indexOf(moved) - 1]

  return previous === undefined ? undefined : groups.find((group) => group.members.includes(previous))?.id
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

export type SharedSession<TServer> = { id: string; server: TServer; sessionId: string }

/** Every session shared through remote control, this machine's own first; `id` stays stable across restarts. */
export function sharedSessions<TServer>(input: {
  local: TServer | undefined
  localShared: readonly string[]
  remote: readonly { origin_host: string; session_id: string; connection: TServer }[]
}): SharedSession<TServer>[] {
  const local = input.local
  const own = local
    ? input.localShared.map((sessionId) => ({ id: `local/${sessionId}`, server: local, sessionId }))
    : []

  return [
    ...own,
    ...input.remote.map((record) => ({
      id: `${record.origin_host}/${record.session_id}`,
      server: record.connection,
      sessionId: record.session_id,
    })),
  ]
}
