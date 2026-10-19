import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { get, printJSON } from "./node"

export default Runtime.handler(
  Commands.commands.mesh.commands.peers,
  Effect.fn("cli.mesh.peers")(function* (input) {
    printJSON(yield* get(input.config, "/v1/peers"))
  }),
)
