import { Plugin } from "@opencode/plugin/tui"
import { RemoteControl } from "@opencode/schema/remote-control"
import { createSignal, Show } from "solid-js"

export default Plugin.define({
  id: "opencode.remote-control.tui",
  async setup(context) {
    const rc = context.client.rpc(RemoteControl.Definition)
    const [status, setStatus] = createSignal<RemoteControl.Status>()
    const refresh = () => rc.status(undefined).then(setStatus, () => setStatus(undefined))
    const toast = (variant: "info" | "success" | "warning" | "error", message: string) =>
      context.ui.toast.show({ title: "Remote control", message, variant })

    rc.events.on("state.changed", () => void refresh())
    rc.events.on("mesh.changed", () => void refresh())
    void refresh()

    const start = (input: { session_id?: string; target?: string }) =>
      rc["share.start"]({ ...input, client_hint: "tui" }).then(
        (next) => {
          setStatus(next)
          if (!next.attachable)
            return toast("warning", "Sharing, but other machines cannot attach: set server_url and OPENCODE_PASSWORD")
          if (next.target) return toast("success", `Syncing with ${next.target}`)
          toast("success", input.session_id ? "Sharing this session with the mesh" : "Remote control on")
        },
        (error: Error) => toast("error", error.message),
      )

    const run = async (target: string | undefined) => {
      const route = context.ui.router.current()
      const sessionID = route.type === "session" ? route.sessionID : undefined
      const current = await rc.status(undefined).catch((error: Error) => error)
      if (current instanceof Error) return toast("error", `Plugin unavailable on this server: ${current.message}`)
      setStatus(current)
      if (!current.mesh.reachable) return toast("error", `Mesh unreachable at ${current.mesh.url}`)
      if (target && current.active && current.target?.split(":")[0] === target.split(":")[0])
        return toast("warning", `Already connected to ${current.target}`)
      if (target || !current.active) return start({ session_id: sessionID, target })

      const choice = await context.ui.dialog.select({
        title: "Remote control",
        options: [
          ...(sessionID && !current.shared.includes(sessionID)
            ? [{ title: "Share this session", value: "share", description: "Add it to the sessions this machine shares" }]
            : []),
          {
            title: "Stay connected",
            value: "stay",
            description: `${current.shared.length} shared${current.target ? `, syncing with ${current.target}` : ""}`,
          },
          {
            title: "Disconnect",
            value: "disconnect",
            description: "Stop sharing and remove this machine's sessions from the mesh",
          },
        ],
      })
      if (choice === "share") return start({ session_id: sessionID })
      if (choice !== "disconnect") return
      await rc["share.stop"](undefined).then(
        (next) => {
          setStatus(next)
          toast("info", "Disconnected; sessions are no longer shared")
        },
        (error: Error) => toast("error", error.message),
      )
    }

    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => (
        <Show when={status()?.active}>
          <box flexShrink={0}>
            <text
              fg={
                !status()?.mesh.reachable
                  ? context.theme.text.feedback.error.base
                  : input.sessionID && status()?.shared.includes(input.sessionID)
                    ? context.theme.text.feedback.success.base
                    : context.theme.text.muted
              }
            >
              {status()?.mesh.reachable ? "rc" : "rc: mesh unreachable"}
            </text>
          </box>
        </Show>
      ),
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "remote-control.toggle",
          title: "Remote control",
          description: "Share this session with other machines; /rc <host> syncs with that machine",
          group: "Remote control",
          palette: true,
          slash: { name: "rc", aliases: ["remote-control"], arguments: true },
          run: (input) => void run(input?.trim() || undefined),
        },
      ],
    }))
  },
})
