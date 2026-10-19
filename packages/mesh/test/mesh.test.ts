// Three nodes. A and C are each paired only with B, and A seeds C's address, so A <-> C only works
// once both learned the other's certificate through B's trust bundle; after that C's sessions reach
// A by two paths.

import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import path from "node:path"
import type { SessionRecord } from "../src/protocol"
import { call, Mesh, peerUp, record, sessions, temporaryDirectory, waitFor } from "./fixture"

const addresses = { a: "127.0.0.2", b: "127.0.0.3", c: "127.0.0.4" }

function threeNodes(root: string) {
  return Mesh.create(root, addresses, [
    ["a", "b"],
    ["c", "b"],
  ])
}

async function startThree(mesh: Mesh) {
  const b = await mesh.start("b", { quiet: false })
  const c = await mesh.start("c", { quiet: false, peers: [mesh.address("b")] })
  const a = await mesh.start("a", { quiet: false, peers: [mesh.address("b"), mesh.address("c")] })
  return { a, b, c }
}

describe("mesh", () => {
  test("every node holds the union; trust travels; one record per session; a stopped peer keeps its sessions", async () => {
    using directory = temporaryDirectory()
    await using mesh = await threeNodes(directory.path)
    const { a, b, c } = await startThree(mesh)
    for (const [name, service] of Object.entries({ a, b, c }))
      await call(service.loopback.port, "POST", "/v1/sessions", record(`ses_${name}`, { title: `on ${name}` }))

    const expected = ["ses_a", "ses_b", "ses_c"]
    for (const service of [a, b, c])
      await waitFor(
        async () => (await sessions(service)).map((item) => item.session_id).sort().join() === expected.join(),
        "the union",
      )

    await waitFor(() => readdirSync(path.join(directory.path, "c", "trust")).length === 2, "c to learn a's certificate through b")
    await waitFor(() => peerUp(a, mesh.address("c")), "a to reach c directly")

    await call(c.loopback.port, "POST", "/v1/sessions", record("ses_c", { title: "renamed on c" }))
    await waitFor(async () => (await sessions(a)).some((item) => item.session_id === "ses_c" && item.title === "renamed on c"), "the rename to reach a")
    const fromC = (await sessions(a)).filter((item) => item.session_id === "ses_c")
    expect(fromC).toHaveLength(1)
    expect(fromC[0].origin_addr).toBe(addresses.c)

    await c.stop()
    mesh.services.delete("c")
    await waitFor(async () => !(await peerUp(a, mesh.address("c"))), "a to see c down", 15_000)
    expect((await sessions(a)).map((item) => item.session_id).sort()).toEqual(expected)
  })

  test("a revocation travels as a tombstone and a stale re-share cannot undo it", async () => {
    using directory = temporaryDirectory()
    await using mesh = await threeNodes(directory.path)
    const { a, b } = await startThree(mesh)
    const stored = await call<SessionRecord>(a.loopback.port, "POST", "/v1/sessions", record("ses_gone"))
    await waitFor(async () => (await sessions(b)).some((item) => item.session_id === "ses_gone"), "b to learn ses_gone")
    expect((await call(b.loopback.port, "DELETE", `/v1/sessions/${stored.body.origin_host}/ses_gone`)).status).toBe(200)
    await waitFor(async () => !(await sessions(a)).some((item) => item.session_id === "ses_gone"), "a to receive the tombstone")
    await call(a.loopback.port, "POST", "/v1/sessions", record("ses_gone", { shared_at: stored.body.shared_at }))
    expect((await sessions(a)).some((item) => item.session_id === "ses_gone")).toBe(false)
  })
})
