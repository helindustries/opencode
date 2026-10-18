import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import type { RemoteControl } from "@opencode/schema/remote-control"
import tui from "../tui.tsx"

const idle: RemoteControl.Status = {
  active: false,
  target: null,
  shared: [],
  publish: false,
  desktop: "attach",
  attachable: true,
  mesh: { url: "http://127.0.0.1:47613", reachable: true, node_id: "n", error: null },
}

// Drives /rc through the plugin's registered command with the RPC client and dialog replaced by
// recorders; route, dialog choice and server status are the dimensions that change the outcome.
async function rc(options: {
  status?: RemoteControl.Status | Error
  route?: { type: string; sessionID?: string }
  choice?: string
  start?: Error
}) {
  const calls: Array<[string, unknown]> = []
  const toasts: Array<{ message: string; variant?: string }> = []
  const offered: string[][] = []
  let command: { run: (input?: string) => unknown } | undefined
  const status = options.status ?? idle
  const client = {
    status: async () => {
      if (status instanceof Error) throw status
      return status
    },
    "share.start": async (input: unknown) => {
      calls.push(["share.start", input])
      if (options.start) throw options.start
      return { ...idle, active: true, target: (input as { target?: string }).target ?? null }
    },
    "share.stop": async () => {
      calls.push(["share.stop", undefined])
      return idle
    },
    events: { on: () => () => {} },
  }
  const context = {
    client: { rpc: () => client },
    theme: { text: { muted: 0, feedback: { success: { base: 1 }, error: { base: 2 } } } },
    keymap: {
      layer: (factory: () => { commands: Array<{ slash?: { name: string }; run: (input?: string) => unknown }> }) => {
        command = factory().commands.find((item) => item.slash?.name === "rc")
      },
    },
    ui: {
      router: { current: () => options.route ?? { type: "home" } },
      toast: { show: (toast: { message: string; variant?: string }) => void toasts.push(toast) },
      dialog: {
        select: async (input: { options: Array<{ value: string }> }) => {
          offered.push(input.options.map((option) => option.value))
          return options.choice
        },
      },
      slot: () => () => {},
    },
  } as unknown as Plugin.Context
  await tui.setup(context)
  return {
    calls,
    toasts,
    offered,
    run: async (input?: string) => {
      await command!.run(input)
      await Bun.sleep(0)
    },
  }
}

test("/rc while off starts sharing the open session", async () => {
  const run = await rc({ route: { type: "session", sessionID: "ses_1" } })
  await run.run("")
  expect(run.calls).toEqual([["share.start", { session_id: "ses_1", target: undefined, client_hint: "tui" }]])
  expect(run.toasts.at(-1)).toMatchObject({ variant: "success", message: "Sharing this session with the mesh" })
})

test("/rc while on offers stay or disconnect, and disconnect stops sharing", async () => {
  const run = await rc({
    status: { ...idle, active: true, shared: ["ses_1"] },
    route: { type: "session", sessionID: "ses_1" },
    choice: "disconnect",
  })
  await run.run("")
  expect(run.offered).toEqual([["stay", "disconnect"]])
  expect(run.calls).toEqual([["share.stop", undefined]])
})

test("staying connected changes nothing", async () => {
  const run = await rc({ status: { ...idle, active: true }, choice: "stay" })
  await run.run("")
  expect(run.calls).toEqual([])
})

test("an unshared open session can be added from the menu", async () => {
  const run = await rc({
    status: { ...idle, active: true },
    route: { type: "session", sessionID: "ses_2" },
    choice: "share",
  })
  await run.run("")
  expect(run.offered).toEqual([["share", "stay", "disconnect"]])
  expect(run.calls[0]).toEqual(["share.start", { session_id: "ses_2", client_hint: "tui" }])
})

test("/rc <host> syncs with that machine", async () => {
  const run = await rc({})
  await run.run("192.168.1.2")
  expect(run.calls).toEqual([["share.start", { session_id: undefined, target: "192.168.1.2", client_hint: "tui" }]])
  expect(run.toasts.at(-1)).toMatchObject({ variant: "success", message: "Syncing with 192.168.1.2" })
})

test("/rc <host> for the machine already synced says so", async () => {
  const run = await rc({ status: { ...idle, active: true, target: "192.168.1.2:47614" } })
  await run.run("192.168.1.2")
  expect(run.calls).toEqual([])
  expect(run.toasts.at(-1)).toMatchObject({ variant: "warning", message: "Already connected to 192.168.1.2:47614" })
})

test("failures surface their reason", async () => {
  const unreachable = await rc({ status: { ...idle, mesh: { ...idle.mesh, reachable: false } } })
  await unreachable.run("")
  expect(unreachable.toasts.at(-1)).toMatchObject({
    variant: "error",
    message: "Mesh unreachable at http://127.0.0.1:47613",
  })

  const refused = await rc({ start: new Error("not a host or host:port: bad") })
  await refused.run("bad")
  expect(refused.toasts.at(-1)).toMatchObject({ variant: "error", message: "not a host or host:port: bad" })

  const missing = await rc({ status: new Error("rpc.method_not_found") })
  await missing.run("")
  expect(missing.toasts.at(-1)).toMatchObject({ variant: "error" })
  expect(missing.toasts.at(-1)!.message).toContain("Plugin unavailable")
})
