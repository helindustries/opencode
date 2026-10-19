import { Plugin } from "@opencode/plugin/tui"
import { RemoteControl } from "@opencode/schema/remote-control"
import { createEffect, createRoot, createSignal, on, Show } from "solid-js"

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
          toast(
            "success",
            input.session_id
              ? "Sharing this session with the mesh"
              : "Remote control on; the next session shown here will be shared",
          )
        },
        (error: Error) => toast("error", error.message),
      )

    // A new session exists only once its first prompt is sent, so /rc without a session shares
    // whichever session this TUI shows next: the one the first prompt creates, or one opened.
    const [pending, setPending] = createSignal(false)
    const routeSession = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }
    const dispose = createRoot((dispose) => {
      createEffect(
        on(routeSession, (sessionID) => {
          if (!sessionID || !pending()) return
          setPending(false)
          void start({ session_id: sessionID })
        }),
      )
      return dispose
    })
    const sharePending = () => setPending(true)

    const run = async (target: string | undefined) => {
      const sessionID = routeSession()
      const current = await rc.status(undefined).catch((error: Error) => error)
      if (current instanceof Error)
        return toast("error", `Remote control unavailable on this server: ${current.message}`)
      setStatus(current)
      if (!current.mesh.reachable) return toast("error", `Mesh unreachable at ${current.mesh.url}`)
      if (target && current.active && current.target?.split(":")[0] === target.split(":")[0])
        return toast("warning", `Already connected to ${current.target}`)
      if (target || !current.active) {
        if (!sessionID) sharePending()
        return start({ session_id: sessionID, target })
      }

      const choice = await context.ui.dialog.select({
        title: "Remote control",
        options: [
          ...(sessionID && !current.shared.includes(sessionID)
            ? [
                {
                  title: "Share this session",
                  value: "share",
                  description: "Add it to the sessions this machine shares",
                },
              ]
            : []),
          ...(!sessionID
            ? [
                {
                  title: "Share the next session",
                  value: "next",
                  description: "The one the first prompt creates, or the one opened next",
                },
              ]
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
      if (choice === "next") {
        sharePending()
        return toast("info", "The next session shown here will be shared")
      }
      if (choice !== "disconnect") return
      setPending(false)
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

    return dispose
  },
})
