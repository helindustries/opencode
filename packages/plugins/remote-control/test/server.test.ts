import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import plugin, { peerAddress } from "../server.ts"
import { fakeContext, fakeMesh, until } from "./fixture.ts"

const password = "s3cret"
let saved: string | undefined
const cleanups: Array<() => Promise<void> | void> = []

beforeEach(() => {
  saved = process.env["OPENCODE_PASSWORD"]
  process.env["OPENCODE_PASSWORD"] = password
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  if (saved === undefined) delete process.env["OPENCODE_PASSWORD"]
  else process.env["OPENCODE_PASSWORD"] = saved
})

async function start(options: Record<string, unknown> = {}) {
  const mesh = fakeMesh()
  const fake = fakeContext({ mesh_url: mesh.url, server_url: "http://127.0.0.1:4096", ...options })
  fake.sessions.set("ses_1", { id: "ses_1", title: "first", projectID: "global", location: { directory: "/work" } })
  const dispose = await plugin.setup(fake.context)
  cleanups.push(() => mesh.stop())
  if (dispose) cleanups.push(dispose)
  return { mesh, ...fake }
}

describe("server plugin", () => {
  test("nothing is shared until remote control starts", async () => {
    const run = await start({ publish: true })
    run.event({ type: "session.created", data: { sessionID: "ses_1", projectID: "global", location: { directory: "/work" } } })
    await Bun.sleep(50)
    expect(run.mesh.records.size).toBe(0)
  })

  test("share.start publishes the session with an attach credential", async () => {
    const run = await start()
    const status = (await run.call("share.start", { session_id: "ses_1" })) as { active: boolean; attachable: boolean }
    expect(status).toMatchObject({ active: true, attachable: true })
    const record = await until(() => run.mesh.records.get("ses_1"), "ses_1 published")
    expect(record).toMatchObject({
      harness: "opencode",
      harness_version: "9.9.9",
      title: "first",
      directory: "/work",
      server_url: "http://127.0.0.1:4096",
      client_hint: "tui",
    })
    expect(Buffer.from(record.auth_blob, "base64").toString()).toBe(`opencode:${password}`)
    expect(run.emitted).toContainEqual(["state.changed", { active: true }])
  })

  test("a rename republishes and a delete revokes", async () => {
    const run = await start()
    await run.call("share.start", { session_id: "ses_1" })
    await until(() => run.mesh.records.get("ses_1"), "ses_1 published")
    run.sessions.get("ses_1")!.title = "renamed"
    run.event({ type: "session.renamed", data: { sessionID: "ses_1", title: "renamed" } })
    await until(() => run.mesh.records.get("ses_1")?.title === "renamed", "rename published")
    run.sessions.delete("ses_1")
    run.event({ type: "session.deleted", data: { sessionID: "ses_1" } })
    await until(() => run.mesh.deleted.includes("ses_1"), "ses_1 revoked")
  })

  test("publish mode shares new sessions of its own location only", async () => {
    const run = await start({ publish: true })
    await run.call("share.start", {})
    run.sessions.set("ses_2", { id: "ses_2", projectID: "global", location: { directory: "/elsewhere" } })
    run.event({ type: "session.created", data: { sessionID: "ses_2", projectID: "global", location: { directory: "/elsewhere" } } })
    run.sessions.set("ses_3", { id: "ses_3", title: "new", projectID: "global", location: { directory: "/work" } })
    run.event({ type: "session.created", data: { sessionID: "ses_3", projectID: "global", location: { directory: "/work" } } })
    await until(() => run.mesh.records.get("ses_3"), "ses_3 published")
    expect(run.mesh.records.has("ses_2")).toBe(false)
  })

  test("share.stop revokes every shared session and persists the off state", async () => {
    const run = await start()
    await run.call("share.start", { session_id: "ses_1" })
    await until(() => run.mesh.records.get("ses_1"), "ses_1 published")
    const status = (await run.call("share.stop")) as { active: boolean; shared: string[] }
    expect(status).toMatchObject({ active: false, shared: [] })
    expect(run.mesh.deleted).toEqual(["ses_1"])
    expect(run.storage.get("state")).toEqual({ active: false, target: null, shared: {} })
  })

  test("a session another machine forgot is no longer shared", async () => {
    const run = await start()
    run.mesh.revokeOnUpsert.add("ses_1")
    await run.call("share.start", { session_id: "ses_1" })
    await until(() => run.mesh.records.get("ses_1"), "ses_1 published")
    await until(() => !(run.storage.get("state") as { shared: object }).shared.hasOwnProperty("ses_1"), "share dropped")
  })

  test("sessions.list hides this machine's own records unless asked", async () => {
    const run = await start()
    await run.call("share.start", { session_id: "ses_1" })
    await until(() => run.mesh.records.get("ses_1"), "ses_1 published")
    expect(await run.call("sessions.list", {})).toEqual([])
    expect(((await run.call("sessions.list", { include_local: true })) as unknown[]).length).toBe(1)
  })

  test("targets are validated and handed to the mesh as peers", async () => {
    const run = await start()
    expect(await run.call("share.start", { target: "bad host!" })).toMatchObject({ type: "invalid_target" })
    await run.call("share.start", { target: "192.168.1.2" })
    expect(run.mesh.peers).toEqual(["192.168.1.2:47614"])
  })

  test("an unreachable mesh is reported, not thrown", async () => {
    const run = await start()
    run.mesh.stop()
    expect(await run.call("share.start", { session_id: "ses_1" })).toMatchObject({
      type: "mesh_unreachable",
      data: { url: run.mesh.url },
    })
    expect(await run.call("status")).toMatchObject({ active: false, mesh: { reachable: false } })
  })

  test("invalid options fail setup with the offending key", async () => {
    const fake = fakeContext({ mesh_url: "http://127.0.0.1:1", desktop: "always" })
    await expect(plugin.setup(fake.context)).rejects.toThrow(/desktop/)
  })
})

test.each([
  ["192.168.1.2", "192.168.1.2:47614"],
  ["tyr.local:5000", "tyr.local:5000"],
  ["[fe80::1]:47614", "[fe80::1]:47614"],
  ["bad host!", null],
  ["", null],
])("peerAddress(%p)", (input, expected) => {
  expect(peerAddress(input)).toBe(expected)
})
