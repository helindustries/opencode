#!/usr/bin/env bun
// Publishes a fork release from files built on each platform, so fork CLIs and desktops built with
// the same OPENCODE_RELEASES update from it:
//   OPENCODE_RELEASES=https://github.com/<owner>/<repo>/releases bun script/fork-release.ts <version> <dir> <notes>
// <dir> holds opencode-<target>.gz per CLI and the desktop installers with their latest*.yml.
import { $ } from "bun"
import { readdir } from "node:fs/promises"
import path from "node:path"

const [version, directory, notes] = process.argv.slice(2)
const releases = process.env.OPENCODE_RELEASES?.replace(/\/+$/, "")
if (!version || !directory || !notes || !releases)
  throw new Error("expected OPENCODE_RELEASES and the arguments <version> <dir> <notes file>")
const repository = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases$/.exec(releases)?.[1]
if (!repository) throw new Error(`expected a GitHub releases URL in OPENCODE_RELEASES, got ${releases}`)

const names = await readdir(directory)
for (const required of ["latest.yml", "latest-mac.yml"])
  if (!names.includes(required)) throw new Error(`expected ${required} in ${directory}`)
if (!names.some((name) => name.startsWith("opencode-") && name.endsWith(".gz")))
  throw new Error(`expected at least one opencode-<target>.gz in ${directory}`)

// The feed is read through /latest/download/, but differential desktop updates find the installed
// version's blockmap by swapping the version inside the file's URL, so the URLs carry it.
for (const name of ["latest.yml", "latest-mac.yml"]) {
  const file = path.join(directory, name)
  const text = await Bun.file(file).text()
  if (!text.includes(`version: ${version}`)) throw new Error(`expected version ${version} in ${file}`)
  await Bun.write(
    file,
    text.replace(/^(\s*(?:- )?(?:url|path): )(?!https?:)(\S+)$/gm, `$1${releases}/download/v${version}/$2`),
  )
}
await Bun.write(path.join(directory, "latest.json"), JSON.stringify({ version }) + "\n")

const assets = (await readdir(directory)).map((name) => path.join(directory, name))
await $`gh release create v${version} --repo ${repository} --target dev --title v${version} --notes-file ${notes} ${assets}`
