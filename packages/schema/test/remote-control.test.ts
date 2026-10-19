import { describe, expect, test } from "bun:test"
import { generate } from "../script/config-schema.js"
import { ConfigRemoteControl } from "../src/config/remote-control.js"

describe("Config.RemoteControl", () => {
  test("accepts the documented keys", () => {
    const options = {
      enabled: true,
      mesh_url: "http://127.0.0.1:47613",
      publish: true,
      project_filter: ["global", "/work"],
      client_name: "ada",
      server_url: "http://192.0.2.4:45278",
      desktop: "notify",
    } as const
    expect({ ...ConfigRemoteControl.decode(options) }).toEqual(options)
    expect({ ...ConfigRemoteControl.decode({}) }).toEqual({})
  })

  test("rejects unknown keys and wrong values with the key named", () => {
    expect(() => ConfigRemoteControl.decode({ mesh: "x" })).toThrow(/mesh/)
    expect(() => ConfigRemoteControl.decode({ desktop: "always" })).toThrow(/desktop/)
    expect(() => ConfigRemoteControl.decode({ publish: "yes" })).toThrow(/publish/)
  })

  test("the published config schema has a typed remote_control section", async () => {
    const schema = await generate()
    const options = schema.properties["remote_control"] as {
      additionalProperties: boolean
      properties: Record<string, unknown>
    }
    expect(options.additionalProperties).toBe(false)
    expect(Object.keys(options.properties).sort()).toEqual([
      "client_name",
      "desktop",
      "enabled",
      "mesh_url",
      "project_filter",
      "publish",
      "server_url",
    ])
  })
})
