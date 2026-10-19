import { NodeServices } from "@effect/platform-node"
import { EffectFlock } from "@opencode/util/effect-flock"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { expect, spyOn } from "bun:test"
import { Effect, FileSystem, Layer, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { Updater } from "../src/services/updater"
import { testEffect } from "../../core/test/lib/effect"

const releases = { url: "https://example.test/fork/releases", target: "windows-x64-baseline" }

const it = testEffect(NodeServices.layer)
const binary = process.platform === "win32" ? "opencode.exe" : "opencode"

function fixture(input: { latest?: unknown; reports?: string } = {}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-fork-updater-" })
    // A Cygwin home, which is not the home the CLI resolves.
    const executable = path.join(root, "cygwin", ".opencode", "bin", binary)
    yield* fs.makeDirectory(path.dirname(executable), { recursive: true })
    yield* fs.writeFileString(executable, "old binary")
    const requests: string[] = []
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        spyOn(globalThis, "fetch").mockImplementation(
          Object.assign(
            async (request: string | URL | Request) => {
              const url = request instanceof Request ? request.url : request.toString()
              requests.push(url)
              if (url.endsWith("/latest.json")) return Response.json(input.latest ?? { version: "2.0.32-mesh.5" })
              if (url.endsWith(`.gz`)) return new Response(gzipSync(Buffer.from("new binary")))
              return new Response("not found", { status: 404 })
            },
            { preconnect: fetch.preconnect },
          ),
        ),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    )
    const global = Global.make({
      home: path.join(root, "home"),
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      tmp: path.join(root, "tmp"),
      bin: path.join(root, "bin"),
      log: path.join(root, "log"),
      repos: path.join(root, "repos"),
    })
    const commands: string[][] = []
    const updater = yield* Updater.Service.pipe(
      Effect.provide(Updater.layer),
      Effect.provideService(Updater.ForkReleases, releases),
      Effect.provide(
        LayerNode.compile(EffectFlock.node, {
          replacements: [Global.node.replace(Layer.succeed(Global.Service, global))],
        }),
      ),
      Effect.provideService(Global.Service, global),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        realPath: (target) => (target === process.execPath ? fs.realPath(executable) : fs.realPath(target)),
      }),
      Effect.provideService(
        AppProcess.Service,
        AppProcess.Service.of({
          ...spawner,
          run: (command) =>
            Effect.suspend(() => {
              if (command._tag !== "StandardCommand") return Effect.die("Unexpected piped command")
              commands.push([command.command, ...command.args])
              return Effect.succeed({
                command: command.command,
                exitCode: 0,
                stdout: Buffer.from(`opencode v${input.reports ?? "2.0.32-mesh.5"}\n`),
                stderr: Buffer.alloc(0),
                stdoutTruncated: false,
                stderrTruncated: false,
              })
            }),
          runStream: () => Stream.die("Unexpected streaming command"),
        }),
      ),
    )
    return { updater, fs, executable, requests, commands }
  })
}

it.live("a fork install in any .opencode/bin reads its version from the fork's latest release", () =>
  Effect.gen(function* () {
    const test = yield* fixture()
    expect(yield* test.updater.method()).toBe("curl")
    expect(yield* test.updater.latest()).toBe("2.0.32-mesh.5")
    expect(test.requests).toEqual([`${releases.url}/latest/download/latest.json`])
  }),
)

it.live("a release without a version is reported, not installed", () =>
  Effect.gen(function* () {
    const test = yield* fixture({ latest: { tag: "v2" } })
    const error = yield* test.updater.latest().pipe(Effect.flip)
    expect(error.message).toContain('expected a release version in latest.json, got {"tag":"v2"}')
  }),
)

it.live("upgrade replaces the running binary with the release's and sweeps earlier leftovers", () =>
  Effect.gen(function* () {
    const test = yield* fixture()
    const leftover = `${test.executable}.0badf00d.old`
    yield* test.fs.writeFileString(leftover, "older binary")
    yield* test.updater.upgrade("curl", "v2.0.32-mesh.5")
    expect(test.requests).toEqual([`${releases.url}/download/v2.0.32-mesh.5/opencode-${releases.target}.gz`])
    expect(test.commands).toHaveLength(1)
    expect(test.commands[0][1]).toBe("--version")
    expect(yield* test.fs.readFileString(test.executable)).toBe("new binary")
    const names = yield* test.fs.readDirectory(path.dirname(test.executable))
    expect(names.filter((name) => name.endsWith(".new"))).toEqual([])
    expect(names).not.toContain(path.basename(leftover))
    // Windows cannot replace a running image, so the old one is moved aside instead.
    expect(names.filter((name) => name.endsWith(".old")).length).toBe(process.platform === "win32" ? 1 : 0)
  }),
)

it.live("a downloaded binary that reports another version leaves the installed one in place", () =>
  Effect.gen(function* () {
    const test = yield* fixture({ reports: "2.0.32-mesh.4" })
    const error = yield* test.updater.upgrade("curl", "2.0.32-mesh.5").pipe(Effect.flip)
    expect(error.message).toContain("to report 2.0.32-mesh.5, got opencode v2.0.32-mesh.4")
    expect(yield* test.fs.readFileString(test.executable)).toBe("old binary")
    expect(yield* test.fs.readDirectory(path.dirname(test.executable))).toEqual([binary])
  }),
)
