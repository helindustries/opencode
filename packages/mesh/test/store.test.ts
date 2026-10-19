import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Fernet } from "../src/fernet"
import { parseRecord } from "../src/protocol"
import { loadCipher, merge, Store } from "../src/store"
import { record, temporaryDirectory } from "./fixture"

// Made by Python's cryptography (ocmesh's blob.key format): the key and a token of the auth_blob below.
const pythonKey = "DymU2BLXou_D-JoI1bSy9cT4S-j2ky8x1yRf3hd5urk="
const pythonToken =
  "gAAAAABq1VwG1V8X1L-CnEfLe2OWrtPnJA0_9lPIaw9FPeszQ63-4jbpTDocryXcfAmLAERNYrYqmtQO6EQYE77C59xUr8aQIH5DDVjpLCxhw1d-kpL5uig="

function stored(sessionID: string, fields: Record<string, unknown> = {}) {
  return parseRecord(record(sessionID, fields), "opencode@node")
}

async function openStore(directory: string) {
  return new Store(path.join(directory, "sessions.db"), await loadCipher(directory))
}

describe("store", () => {
  test("round trip, and a second write of the same key updates instead of duplicating", async () => {
    using directory = temporaryDirectory()
    const store = await openStore(directory.path)
    store.upsert(stored("ses_1", { last_seen: 1000 }))
    const [updated, changed] = store.upsert(stored("ses_1", { title: "renamed", last_seen: 2000 }))
    expect(changed).toBe(true)
    expect(updated.title).toBe("renamed")
    expect(store.sessions().map((item) => item.session_id)).toEqual(["ses_1"])
    expect(store.get("opencode@node", "ses_1")?.auth_blob).toBe("b3BlbmNvZGU6c2VjcmV0")
    store.close()
  })

  test("a tombstone survives a restart and a stale heartbeat, but not a newer share", async () => {
    using directory = temporaryDirectory()
    const first = await openStore(directory.path)
    first.upsert(stored("ses_1", { shared_at: 1000, last_seen: 1000 }))
    first.upsert(stored("ses_1", { revoked: true, last_seen: 2000 }))
    first.close()
    const second = await openStore(directory.path)
    expect(second.upsert(stored("ses_1", { shared_at: 1000, last_seen: 3000 }))[1]).toBe(false)
    expect(second.get("opencode@node", "ses_1")?.revoked).toBe(true)
    expect(second.get("opencode@node", "ses_1")?.auth_blob).toBe("")
    expect(second.upsert(stored("ses_1", { shared_at: 2500, last_seen: 2500 }))[1]).toBe(true)
    expect(second.get("opencode@node", "ses_1")?.revoked).toBe(false)
    second.close()
  })

  test("an older live record changes nothing and keeps the known origin address", () => {
    const existing = stored("ses_1", { last_seen: 2000, origin_addr: "192.168.1.4" })
    expect(merge(existing, stored("ses_1", { last_seen: 1000 }))).toBeUndefined()
    expect(merge(existing, stored("ses_1", { last_seen: 3000 }))?.origin_addr).toBe("192.168.1.4")
  })

  test("auth_blob is encrypted at rest", async () => {
    using directory = temporaryDirectory()
    const store = await openStore(directory.path)
    store.upsert(stored("ses_1"))
    const raw = store.db.query<{ auth_blob: Uint8Array }, []>("select auth_blob from sessions").get()!
    expect(Buffer.from(raw.auth_blob).toString("ascii")).not.toContain("b3BlbmNvZGU6c2VjcmV0")
    store.close()
  })

  test("reads what Python's ocmesh encrypted, and writes what it can read", () => {
    const fernet = new Fernet(pythonKey)
    expect(fernet.decrypt(pythonToken)).toBe("b3BlbmNvZGU6c2VjcmV0")
    const token = fernet.encrypt("round trip")
    expect(token.toString("ascii")).toMatch(/^gAAAAA[A-Za-z0-9_-]+=*$/)
    expect(fernet.decrypt(token)).toBe("round trip")
    expect(() => new Fernet(Fernet.generateKey()).decrypt(pythonToken)).toThrow("signature does not match")
  })
})
