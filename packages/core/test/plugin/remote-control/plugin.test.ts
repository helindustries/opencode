import { describe, expect, test } from "bun:test"
import { RemoteControlPlugin } from "@opencode/core/plugin/remote-control/plugin"
import { Directory, Document, Info } from "@opencode/schema/config"
import { AbsolutePath } from "@opencode/core/schema"
import { Schema } from "effect"

const decode = Schema.decodeUnknownSync(Info)
const document = (info: unknown) => new Document({ type: "document", info: decode(info) })

describe("RemoteControlPlugin.options", () => {
  test("later config documents override earlier ones key by key", () => {
    expect(
      RemoteControlPlugin.options([
        document({ remote_control: { publish: true, desktop: "notify" } }),
        new Directory({ type: "directory", path: AbsolutePath.make("/work") }),
        document({ shell: "zsh" }),
        document({ remote_control: { desktop: "attach", client_name: "ada" } }),
      ]),
    ).toEqual({ publish: true, desktop: "attach", client_name: "ada" })
  })

  test("no section means default options", () => {
    expect(RemoteControlPlugin.options([document({})])).toEqual({})
  })
})
