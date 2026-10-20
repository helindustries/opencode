import { describe, expect, test } from "bun:test"
import { groupAfterDrop, groupEntry, meshGroups, sharedSessions, staleCredentials, tabSections } from "./sidebar-model"

const work = { id: "work", title: "Work", members: ["c", "a"] }
const idle = { id: "idle", title: "Idle", members: ["gone"] }

describe("tabSections", () => {
  test("ungrouped tabs come first, then each group's tabs in tab order", () => {
    expect(tabSections(["a", "b", "c", "d"], [work])).toEqual([
      { group: undefined, keys: ["b", "d"] },
      { group: work, keys: ["a", "c"] },
    ])
  })

  test("a group whose tabs are all closed still has its section, so tabs can be dropped into it", () => {
    expect(tabSections(["a", "b"], [idle, work])).toEqual([
      { group: undefined, keys: ["b"] },
      { group: idle, keys: [] },
      { group: work, keys: ["a"] },
    ])
  })
})

describe("groupAfterDrop", () => {
  test("a tab dropped after a group member joins that group", () => {
    expect(groupAfterDrop(["b", "a", "d", "c"], "d", [work])).toBe("work")
    expect(groupAfterDrop(["a", "d", "b"], "d", [work])).toBe("work")
  })

  test("a tab dropped right below a group's header joins that group, even an empty one", () => {
    expect(groupAfterDrop(["b", groupEntry("work"), "d", "a", "c"], "d", [work])).toBe("work")
    expect(groupAfterDrop(["b", groupEntry("idle"), "d", groupEntry("work"), "a"], "d", [idle, work])).toBe("idle")
  })

  test("a tab dropped above the first group's header is ungrouped", () => {
    expect(groupAfterDrop(["b", "a", groupEntry("work"), "c"], "a", [work])).toBeUndefined()
  })

  test("a tab dropped after an ungrouped tab, or at the top, is ungrouped", () => {
    expect(groupAfterDrop(["b", "a", "c"], "a", [work])).toBeUndefined()
    expect(groupAfterDrop(["a", "b", "c"], "a", [work])).toBeUndefined()
  })
})

describe("staleCredentials", () => {
  test("a saved server whose password the share no longer carries is refreshed, others are left alone", () => {
    const fresh = { http: { url: "http://192.0.2.4:4096", password: "new" } }
    const same = { http: { url: "http://192.0.2.6:4096", password: "kept" } }
    const unsaved = { http: { url: "http://192.0.2.9:4096", password: "any" } }
    const saved = [{ http: { url: "http://192.0.2.4:4096", password: "old" } }, same]
    expect(staleCredentials([fresh, same, unsaved], saved)).toEqual([fresh])
  })
})

describe("sharedSessions", () => {
  test("this machine's shares and other machines' shares each get a stable id and their mesh group", () => {
    expect(
      sharedSessions({
        local: "local-server",
        localShared: ["ses_own", "ses_new"],
        localRecords: [{ session_id: "ses_own", group_tag: "Work" }],
        remote: [
          { origin_host: "opencode@node-b", session_id: "ses_far", group_tag: null, connection: "remote-server" },
        ],
      }),
    ).toEqual([
      { id: "local/ses_own", server: "local-server", sessionId: "ses_own", group: "Work" },
      { id: "local/ses_new", server: "local-server", sessionId: "ses_new", group: null },
      { id: "opencode@node-b/ses_far", server: "remote-server", sessionId: "ses_far", group: null },
    ])
  })

  test("without a local server only other machines' shares are listed", () => {
    expect(sharedSessions({ local: undefined, localShared: ["ses_own"], localRecords: [], remote: [] })).toEqual([])
  })
})

describe("meshGroups", () => {
  test("a shared tab joins the group its mesh record names and leaves the one the window keeps it in", () => {
    const tags = new Map([
      ["c", "Idle"],
      ["x", null],
    ])
    expect(meshGroups([work, idle], tags).groups.map((group) => group.members)).toEqual([["a"], ["gone", "c"]])
  })

  test("a mesh group no window group carries is reported once as missing", () => {
    const tags = new Map([
      ["c", "Remote"],
      ["d", "Remote"],
      ["e", "Work"],
    ])
    expect(meshGroups([work], tags)).toMatchObject({ missing: ["Remote"] })
    expect(meshGroups([work], tags).groups[0]?.members).toEqual(["a", "e"])
  })

  test("of two groups with the same title, the first takes the shared tabs", () => {
    const twin = { id: "twin", title: "Work", members: [] }
    expect(meshGroups([work, twin], new Map([["d", "Work"]])).groups.map((group) => group.members)).toEqual([
      ["c", "a", "d"],
      [],
    ])
  })
})
