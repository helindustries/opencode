import type { SessionRecord } from "@opencode/mesh/protocol"
import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { get } from "./node"

export default Runtime.handler(
  Commands.commands.mesh.commands.list,
  Effect.fn("cli.mesh.list")(function* (input) {
    const query = new URLSearchParams()
    if (input.all) query.set("include_revoked", "1")
    if (Option.isSome(input.harness)) query.set("harness", input.harness.value)
    const records = (yield* get(input.config, `/v1/sessions?${query}`)) as SessionRecord[]
    process.stdout.write(
      records
        .map(
          (record) =>
            `${record.origin_host.padEnd(48)} ${record.session_id.padEnd(32)} ${(record.revoked ? "revoked" : record.harness).padEnd(10)} ${record.title || "-"}  ${record.server_url}${EOL}`,
        )
        .join(""),
    )
  }),
)
