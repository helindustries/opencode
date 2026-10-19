# Mesh and remote control

The mesh is a small registry of shared opencode sessions that every machine on a LAN runs once.
Nodes find each other, sync their registries over mutual TLS and converge on the union. Remote
control, built into the opencode server, publishes sessions into the local node; the desktop app
reads them back through the server and opens sessions shared from other machines.

## Running a node

```sh
opencode mesh run                 # foreground; run it as a login item or system service
opencode mesh trust               # this node's id and the peers it trusts
opencode mesh trust peer.pem      # admit another node's certificate (node.pem in its storage)
opencode mesh peers               # peers and their status
opencode mesh list [--all]        # sessions the mesh knows; --all includes forgotten ones
opencode mesh stats | checked
```

Pairing is once per mesh: admit one node's `node.pem` on another and the other way round. Every
sync carries the trust bundle along, so a third node trusted by either side is trusted everywhere.

## Config

`~/.config/opencode/ocmesh.toml` (or `$OCMESH_CONFIG`, or `--config`); every key is optional.

```toml
port = 47613          # loopback API for opencode and the CLI
peer_port = 47614     # mutual-TLS API for other nodes
bind = "0.0.0.0"
storage_dir = "..."   # default: %LOCALAPPDATA%\ocmesh on Windows, ~/.local/share/ocmesh elsewhere
peers = ["192.0.2.10:47614"]
quiet = false
tls = "mutual"        # "off": loopback only, no peers
node_name = "..."     # default: the host name
```

With `quiet = true` a node advertises nothing: its peer port completes only a mutual-TLS handshake
with a trusted certificate within 2 s and closes anything else without a reply. Peers are found
through the operating system's neighbour (ARP) table instead: each new address and MAC pair gets
one handshake on the peer port, and the result joins a list of checked addresses the whole mesh
shares, so a node that joins later skips what was already checked. A newcomer checks its own table
only until it reaches its first peer, which hands it the rest of the mesh.

The storage format, identities and config are those of the earlier Python ocmesh, so an existing
node keeps its id, trust and registry.

## Remote control

On by default. `/rc` in the TUI shares the open session; `/rc <host>` connects to another node.
Settings live in the `remote_control` section of `opencode.json`:

```jsonc
{
  "remote_control": {
    "enabled": true,                       // off switch
    "mesh_url": "http://127.0.0.1:47613",  // the local node
    "publish": false,                      // share every session while remote control is on
    "project_filter": [],                  // limit publish to these projects or directories
    "client_name": "...",                  // owner name shown to other machines
    "server_url": "...",                   // URL other machines reach this server at
    "desktop": "attach"                    // or "notify": rows are listed but not opened
  }
}
```

A session opened from another machine is attached with the credential its server published, so
that server must listen on the LAN (`opencode service set hostname 0.0.0.0`) and have a password.
