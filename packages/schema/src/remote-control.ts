export * as RemoteControl from "./remote-control.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"

export const Harness = "opencode"

// Mirrors ocmesh/protocol.py, the single source of truth for the record's JSON shape.
export interface Record extends Schema.Schema.Type<typeof Record> {}
export const Record = Schema.Struct({
  session_id: Schema.String,
  origin_host: Schema.String,
  harness: Schema.String,
  harness_version: Schema.String,
  capabilities: Schema.Array(Schema.String),
  server_url: Schema.String,
  title: Schema.String,
  directory: Schema.String,
  project_id: Schema.String,
  origin_user: Schema.String,
  client_hint: Schema.Literals(["desktop", "tui", "mobile"]),
  auth_blob: Schema.String,
  group_tag: Schema.NullOr(Schema.String),
  shared_at: Schema.Number,
  last_seen: Schema.Number,
  revoked: Schema.Boolean,
  origin_addr: Schema.NullOr(Schema.String),
}).annotate({ identifier: "RemoteControl.Record" })

export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Status = Schema.Struct({
  active: Schema.Boolean,
  target: Schema.NullOr(Schema.String),
  shared: Schema.Array(Schema.String),
  publish: Schema.Boolean,
  desktop: Schema.Literals(["attach", "notify"]),
  attachable: Schema.Boolean.annotate({
    description: "Whether this server knows a URL and credential other machines can attach with.",
  }),
  mesh: Schema.Struct({
    url: Schema.String,
    reachable: Schema.Boolean,
    node_id: Schema.NullOr(Schema.String),
    error: Schema.NullOr(Schema.String),
  }),
}).annotate({ identifier: "RemoteControl.Status" })

export interface Peer extends Schema.Schema.Type<typeof Peer> {}
export const Peer = Schema.Struct({
  address: Schema.String,
  node_id: Schema.NullOr(Schema.String),
  status: Schema.String,
  error: Schema.NullOr(Schema.String),
}).annotate({ identifier: "RemoteControl.Peer" })

const meshError = Schema.Struct({ url: Schema.String })
const refused = Schema.toStandardSchemaV1(Schema.Struct({ status: Schema.Number }))

export const Definition = Rpc.define({
  id: "rc",
  methods: {
    status: { input: Schema.toStandardSchemaV1(Schema.Undefined), output: Schema.toStandardSchemaV1(Status) },
    "sessions.list": {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({ harness: optional(Schema.String), include_local: optional(Schema.Boolean) }),
      ),
      output: Schema.toStandardSchemaV1(Schema.Array(Record)),
      errors: { mesh_unreachable: Schema.toStandardSchemaV1(meshError) },
    },
    "sessions.revoke": {
      input: Schema.toStandardSchemaV1(Schema.Struct({ origin_host: Schema.String, session_id: Schema.String })),
      output: Schema.toStandardSchemaV1(Record),
      errors: {
        mesh_unreachable: Schema.toStandardSchemaV1(meshError),
        not_found: Schema.toStandardSchemaV1(Schema.Struct({ session_id: Schema.String })),
      },
    },
    "mesh.ping": {
      input: Schema.toStandardSchemaV1(Schema.Struct({ target: optional(Schema.String) })),
      output: Schema.toStandardSchemaV1(Schema.Struct({ node_id: Schema.String, peer: Schema.NullOr(Peer) })),
      errors: {
        mesh_unreachable: Schema.toStandardSchemaV1(meshError),
        mesh_refused: refused,
        invalid_target: Schema.toStandardSchemaV1(Schema.Struct({ target: Schema.String })),
      },
    },
    "share.start": {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          session_id: optional(Schema.String),
          target: optional(Schema.String).annotate({ description: "Peer mesh as host or host:port." }),
          client_hint: optional(Schema.Literals(["desktop", "tui", "mobile"])),
        }),
      ),
      output: Schema.toStandardSchemaV1(Status),
      errors: {
        mesh_unreachable: Schema.toStandardSchemaV1(meshError),
        mesh_refused: refused,
        invalid_target: Schema.toStandardSchemaV1(Schema.Struct({ target: Schema.String })),
      },
    },
    "share.stop": { input: Schema.toStandardSchemaV1(Schema.Undefined), output: Schema.toStandardSchemaV1(Status) },
  },
  events: {
    "mesh.changed": {
      schema: Schema.toStandardSchemaV1(Schema.Struct({ reason: Schema.String })),
    },
    "state.changed": {
      schema: Schema.toStandardSchemaV1(Schema.Struct({ active: Schema.Boolean })),
    },
  },
})
