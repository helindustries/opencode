import { describe, expect, test } from "bun:test"
import { groupAfterDrop, sharedSessions, staleCredentials, tabSections } from "./sidebar-model"

const work = { id: "work", title: "Work", members: ["c", "a"] }
const idle = { id: "idle", title: "Idle", members: ["gone"] }

describe("tabSections", () => {
  test("ungrouped tabs come first, then each group's tabs in tab order", () => {
    expect(tabSections(["a", "b", "c", "d"], [work])).toEqual([
      { group: undefined, keys: ["b", "d"] },
      { group: work, keys: ["a", "c"] },
    ])
  })

  test("a group whose tabs are all closed is not shown", () => {
    expect(tabSections(["a", "b"], [idle, work])).toEqual([
      { group: undefined, keys: ["b"] },
      { group: work, keys: ["a"] },
    ])
  })
})

describe("groupAfterDrop", () => {
  test("a tab dropped after a group member joins that group", () => {
    expect(groupAfterDrop(["b", "a", "d", "c"], "d", [work])).toBe("work")
    expect(groupAfterDrop(["a", "d", "b"], "d", [work])).toBe("work")
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
  test("this machine's shares and other machines' shares each get a stable id", () => {
    expect(
      sharedSessions({
        local: "local-server",
        localShared: ["ses_own"],
        remote: [{ origin_host: "opencode@node-b", session_id: "ses_far", connection: "remote-server" }],
      }),
    ).toEqual([
      { id: "local/ses_own", server: "local-server", sessionId: "ses_own" },
      { id: "opencode@node-b/ses_far", server: "remote-server", sessionId: "ses_far" },
    ])
  })

  test("without a local server only other machines' shares are listed", () => {
    expect(sharedSessions({ local: undefined, localShared: ["ses_own"], remote: [] })).toEqual([])
  })
})
