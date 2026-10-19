import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { authBlob, own } from "@opencode/core/plugin/remote-control/endpoint"

const keys = ["XDG_STATE_HOME", "OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"] as const
let saved: Record<string, string | undefined> = {}
let state = ""

beforeEach(async () => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  state = await mkdtemp(join(tmpdir(), "rc-endpoint-"))
  process.env["XDG_STATE_HOME"] = state
  await mkdir(join(state, "opencode"))
})

afterEach(async () => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  await rm(state, { recursive: true, force: true })
})

const register = (info: object) => Bun.write(join(state, "opencode", "service.json"), JSON.stringify(info))

test("the managed service registration is used when it names this process", async () => {
  await register({ url: "http://127.0.0.1:45278", pid: process.pid, password: "pw" })
  expect(await own(undefined)).toEqual({ url: "http://127.0.0.1:45278", password: "pw" })
})

test("another process's registration is not ours", async () => {
  await register({ url: "http://127.0.0.1:45278", pid: process.pid + 1, password: "pw" })
  expect(await own(undefined)).toBeUndefined()
})

test("no registration and no override means not attachable", async () => {
  expect(await own(undefined)).toBeUndefined()
})

test("server_url overrides discovery and takes the password from the environment", async () => {
  await register({ url: "http://127.0.0.1:45278", pid: process.pid, password: "pw" })
  process.env["OPENCODE_SERVER_PASSWORD"] = "legacy"
  expect(await own("http://192.0.2.4:4096")).toEqual({ url: "http://192.0.2.4:4096", password: "legacy" })
})

test("auth blobs are basic-auth tokens, empty without a password", () => {
  expect(Buffer.from(authBlob({ url: "x", password: "pw" }), "base64").toString()).toBe("opencode:pw")
  expect(authBlob({ url: "x" })).toBe("")
  expect(authBlob(undefined)).toBe("")
})
