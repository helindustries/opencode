import { Option, Schema } from "effect"

declare const OPENCODE_VERSION: string
declare const OPENCODE_CHANNEL: string
declare const OPENCODE_ARTIFACT: string
declare const OPENCODE_RELEASE_HIGHLIGHTS: string
declare const OPENCODE_RELEASES: string
declare const OPENCODE_RELEASE_TARGET: string

const version = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
// A fork build updates from its own release page instead of opencode.ai and npm.
const releases =
  typeof OPENCODE_RELEASES === "string" && typeof OPENCODE_RELEASE_TARGET === "string"
    ? { url: OPENCODE_RELEASES.replace(/\/+$/, ""), target: OPENCODE_RELEASE_TARGET }
    : undefined
const channel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
const artifact = typeof OPENCODE_ARTIFACT === "string" ? OPENCODE_ARTIFACT : "cli"
// Stable release builds embed the release notes' Highlights; every other build has none.
const highlights =
  typeof OPENCODE_RELEASE_HIGHLIGHTS === "string"
    ? Option.getOrElse(
        Schema.decodeUnknownOption(
          Schema.fromJsonString(Schema.Array(Schema.Struct({ title: Schema.String, body: Schema.String }))),
        )(OPENCODE_RELEASE_HIGHLIGHTS),
        () => [],
      )
    : []

export {
  version as OPENCODE_VERSION,
  channel as OPENCODE_CHANNEL,
  artifact as OPENCODE_ARTIFACT,
  highlights as OPENCODE_HIGHLIGHTS,
  releases as OPENCODE_RELEASES,
}
export const OPENCODE_LOCAL = channel === "local"
