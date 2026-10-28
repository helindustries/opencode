import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import type { SessionMessageInfo } from "@opencode/client"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

test("write and edit headers show the line counts their metadata reports", async () => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 100, height: 40, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const session = {
    id: "ses_changes",
    title: "Changes",
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const change = (file: string, status: "added" | "modified", additions: number, deletions: number) => ({
    file,
    status,
    additions,
    deletions,
    patch: `--- ${file}\n+++ ${file}\n@@ -1,1 +1,1 @@\n-old\n+new\n`,
  })
  const tool = (id: string, name: string, input: Record<string, string>, files: ReturnType<typeof change>[]) => ({
    type: "tool" as const,
    id,
    name,
    time: { created: 1, completed: 2 },
    state: {
      status: "completed" as const,
      input,
      content: [{ type: "text" as const, text: "ok" }] as [{ type: "text"; text: string }],
      metadata: { files },
    },
  })
  const messages: SessionMessageInfo[] = [
    { type: "user", id: "user-change", text: "Change files", time: { created: 0 } },
    {
      type: "assistant",
      id: "answer-change",
      agent: "build",
      model: { providerID: "fixture", id: "fixture" },
      finish: "stop",
      time: { created: 1, completed: 2 },
      content: [
        tool("write-over", "write", { path: "over.ts", content: "new\n" }, [change("over.ts", "modified", 18, 6)]),
        tool("write-new", "write", { path: "fresh.ts", content: "new\n" }, [change("fresh.ts", "added", 30, 0)]),
        tool("edit-one", "edit", { path: "edited.ts", oldString: "old", newString: "new" }, [
          change("edited.ts", "modified", 7, 2),
        ]),
      ],
    },
  ]
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages.toReversed(), cursor: {} })
    if (url.pathname === `/api/session/${session.id}/inbox` || url.pathname === `/api/session/${session.id}/permission`)
      return json({ data: [] })
  }, createEventStream())
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => ({ animations: false, tabs: { enabled: false } }),
        update: async () => ({}),
      },
      packages: { prepare: async () => ({ directory: "" }) },
      args: { sessionID: session.id },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  const header = (label: string) =>
    setup
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes(label))
      ?.trim()
  try {
    await setup.waitForFrame((frame) => frame.includes("edited.ts"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    expect(header("over.ts")).toMatch(/# Wrote over\.ts\s+\+18\s+-6$/)
    // A created file has no deletions, so no "-0".
    expect(header("fresh.ts")).toMatch(/# Wrote fresh\.ts\s+\+30$/)
    expect(header("edited.ts")).toMatch(/← Edit edited\.ts\s+\+7\s+-2$/)
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)
