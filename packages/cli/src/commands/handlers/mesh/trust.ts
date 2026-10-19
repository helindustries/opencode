import { loadIdentity } from "@opencode/mesh/identity"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { config } from "./node"

export default Runtime.handler(
  Commands.commands.mesh.commands.trust,
  Effect.fn("cli.mesh.trust")(function* (input) {
    const loaded = yield* config(input.config)
    const identity = yield* Effect.tryPromise({
      try: () => loadIdentity(loaded.storageDir, loaded.nodeName),
      catch: (error) => error as Error,
    })
    if (input.files.length === 0) {
      process.stdout.write(`this node  ${identity.nodeID}  ${identity.certPath}${EOL}`)
      process.stdout.write(identity.trusted().map((entry) => `trusted    ${entry.nodeID}${EOL}`).join(""))
      return
    }
    for (const file of input.files) {
      const admitted = yield* Effect.try({
        try: () => identity.admit(readFileSync(file, "utf8")),
        catch: (error) => new Error(`${file}: expected a peer's node.pem: ${(error as Error).message}`),
      })
      process.stdout.write(`${file}: ${admitted ? `admitted ${admitted}` : "already trusted"}${EOL}`)
    }
  }),
)
