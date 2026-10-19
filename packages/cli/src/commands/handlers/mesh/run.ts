import { MeshService } from "@opencode/mesh/service"
import { Effect } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { config } from "./node"

export default Runtime.handler(
  Commands.commands.mesh.commands.run,
  Effect.fn("cli.mesh.run")(function* (input) {
    const loaded = yield* config(input.config)
    yield* Effect.tryPromise({
      try: async () => {
        const service = await MeshService.open(loaded)
        service.start()
        const lan = service.lan ? `, peers on ${loaded.bind}:${service.lan.port}` : ""
        process.stdout.write(`ocmesh ${service.node.nodeID} on 127.0.0.1:${service.loopback.port}${lan}${EOL}`)
        await new Promise<void>((resolve) => {
          process.once("SIGINT", () => resolve())
          process.once("SIGTERM", () => resolve())
        })
        await service.stop()
      },
      catch: (error) => error as Error,
    })
  }),
)
