# Remote control

Shares this server's sessions with other machines through
[ocmesh](../../../../ocmesh/README.md), a LAN session registry that runs once
per machine. Desktop clients list the shared sessions through this plugin's RPC
port and attach to them as ordinary remote servers.

## Setup

1. Run ocmesh on every machine (`python -m ocmesh install`) and pair them once
   (`python -m ocmesh trust <peer node.pem>` on both sides).
2. Enable the plugin in `opencode.json`:

   ```jsonc
   {
     "plugins": [
       {
         "package": "/path/to/opencode/packages/plugins/remote-control",
         "options": {
           // every key is optional; editors complete them from the config schema
           "mesh_url": "http://127.0.0.1:47613",
           "publish": false,
           "project_filter": [],
           "client_name": "paul",
           "server_url": "http://192.168.1.4:45278",
           "desktop": "attach",
         },
       },
     ],
   }
   ```

3. Let other machines reach this server: `opencode service set hostname 0.0.0.0`
   (the service listens on `127.0.0.1` by default).

| Option           | Default                  |                                                              |
| ---------------- | ------------------------ | ------------------------------------------------------------ |
| `enabled`        | `true`                   | `false` turns the plugin off without removing it             |
| `mesh_url`       | `http://127.0.0.1:47613` | ocmesh loopback API                                          |
| `publish`        | `false`                  | while on, share every top-level session, not only `/rc` ones |
| `project_filter` | all                      | project IDs or directories that `publish` covers             |
| `client_name`    | OS user                  | owner name other machines see                                |
| `server_url`     | managed service URL      | where other machines reach this server                       |
| `desktop`        | `attach`                 | `notify`: desktops list the rows without opening them        |

Unknown keys fail plugin setup with the key named.

## `/rc`

| Input               | Effect                                                               |
| ------------------- | -------------------------------------------------------------------- |
| `/rc` while off     | turns remote control on and shares the open session                  |
| `/rc` while on      | menu: share the open session, stay connected, or disconnect          |
| `/rc <host>[:port]` | asks the local ocmesh to sync with that machine (default port 47614) |

Disconnect revokes every session this machine shared, mesh-wide. The state is
kept server-side, so it survives TUI restarts. The prompt footer shows `rc`
while on: green when the open session is shared, red when the mesh is down.

## Server URL and credential

Plugins are not told their server's URL or password. The plugin reads both from
the managed service's registration file when its pid is this process, which
covers `opencode service`. A plain `opencode serve` needs `server_url` and
`OPENCODE_PASSWORD`. Without them sessions are still listed but carry no
`attach` capability. The credential travels as `auth_blob`, the Basic token
`opencode:<password>`, over loopback and mutual TLS only; ocmesh stores it
encrypted.

## RPC (`rc`)

Defined in `@opencode/schema/remote-control`.

| Method                       |                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `status`                     | on/off, target, shared session IDs, mesh reachability, `attachable`              |
| `sessions.list`              | mesh records, optionally by `harness`; this machine's own unless `include_local` |
| `sessions.revoke`            | tombstone a record mesh-wide                                                     |
| `mesh.ping`                  | mesh node ID; with `target`, adds the peer and reports its status                |
| `share.start` / `share.stop` | what `/rc` calls                                                                 |

Events: `mesh.changed` on every registry change, `state.changed` on start and stop.

## Notes

- Server plugins start per location on the first plugin request touching it:
  a TUI or desktop on this machine connecting is enough, plain session API
  calls are not. Until then a restarted server sends no heartbeat, so other
  desktops list its sessions under Past (they can still be opened). Sessions
  created before the start are published by the startup sync; the 60 s
  heartbeat then keeps `last_seen` fresh.
- Publishing is fire-and-forget: a bounded queue retries with 1 s to 30 s
  backoff while the mesh is down.

## Tests

```sh
bun test        # against an in-memory mesh
bun typecheck
```
