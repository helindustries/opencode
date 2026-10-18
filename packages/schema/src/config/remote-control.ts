export * as ConfigRemoteControl from "./remote-control.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export const DefaultMeshURL = "http://127.0.0.1:47613"

// Options of the remote-control plugin entry: `plugins: [{ package, options: <Info> }]`.
export class Info extends Schema.Class<Info>("Config.RemoteControl")({
  enabled: Schema.Boolean.pipe(optional).annotate({
    description: "Turn the plugin off without removing it. Default true.",
  }),
  mesh_url: Schema.String.pipe(optional).annotate({
    description: `Base URL of the ocmesh loopback API. Default ${DefaultMeshURL}.`,
  }),
  publish: Schema.Boolean.pipe(optional).annotate({
    description: "While remote control is on, share every session of this server, not only /rc ones.",
  }),
  project_filter: Schema.String.pipe(Schema.Array, optional).annotate({
    description: "Only auto-publish sessions whose project ID or directory is listed.",
  }),
  client_name: Schema.String.pipe(optional).annotate({
    description: "Name shown to other machines as the session owner. Default: the OS user.",
  }),
  server_url: Schema.String.pipe(optional).annotate({
    description: "URL other machines reach this server at. Default: the managed service's registered URL.",
  }),
  desktop: Schema.Literals(["attach", "notify"]).pipe(optional).annotate({
    description: "attach: desktop rows open the session on click. notify: rows are listed only.",
  }),
}) {}

export const decode = Schema.decodeUnknownSync(Info, { onExcessProperty: "error" })
