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
      client_name: "paul",
      server_url: "http://192.168.1.4:45278",
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

  test("the published config schema types remote-control plugin options", async () => {
    const schema = await generate()
    const entry = schema.$defs["Config.Plugin.EntryEncoded"] as { allOf: unknown[] }
    expect(entry.allOf).toContainEqual({
      if: { properties: { package: { pattern: "remote-control" } }, required: ["package"] },
      then: { properties: { options: { $ref: "#/$defs/Config.RemoteControl" } } },
    })
    const options = schema.$defs["Config.RemoteControl"] as {
      additionalProperties: boolean
      properties: Record<string, { description?: string }>
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
    expect(options.properties["mesh_url"]?.description).toContain("47613")
  })
})
