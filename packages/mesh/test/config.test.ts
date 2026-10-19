import { describe, expect, test } from "bun:test"
import path from "node:path"
import { loadConfig, splitAddress } from "../src/config"
import { temporaryDirectory } from "./fixture"

async function load(directory: string, toml: string) {
  const file = path.join(directory, "ocmesh.toml")
  await Bun.write(file, toml)
  return loadConfig(file)
}

describe("config", () => {
  test("a missing file means all defaults", async () => {
    using directory = temporaryDirectory()
    const config = await loadConfig(path.join(directory.path, "missing.toml"))
    expect(config.port).toBe(47613)
    expect(config.peerPort).toBe(47614)
    expect(config.quiet).toBe(false)
  })

  test("reads a Python ocmesh config and rejects contradictions", async () => {
    using directory = temporaryDirectory()
    expect((await load(directory.path, "quiet = true\n")).quiet).toBe(true)
    expect(load(directory.path, 'quiet = true\ntls = "off"\n')).rejects.toThrow('expected tls = "mutual"')
    expect(load(directory.path, "discover_mdns = true\n")).rejects.toThrow("discover_mdns = true is not supported")
    expect((await load(directory.path, "discover_mdns = false\n")).quiet).toBe(false)
    expect(load(directory.path, 'peers = ["no-port"]\n')).rejects.toThrow("peers expected a list of 'host:port'")
    expect(load(directory.path, 'port = "47613"\n')).rejects.toThrow("port expected integer")
  })

  test("splits host and port, IPv6 included", () => {
    expect(splitAddress("192.0.2.2:47614")).toEqual(["192.0.2.2", 47614])
    expect(splitAddress("[fe80::1]:47614")).toEqual(["fe80::1", 47614])
    expect(() => splitAddress("192.0.2.2")).toThrow("expected 'host:port'")
  })
})
