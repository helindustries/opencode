# Mesh and remote control

The mesh functions as a lightweight registry of shared opencode sessions, maintained by every machine on a LAN. Nodes discover each other, synchronize their registries via mutual TLS, and converge on a unified view. Remote control, integrated into the opencode server, publishes sessions to the local node; the desktop application retrieves these from the server and opens sessions shared from other machines.

## Running a node

```sh
opencode mesh run                 # foreground; run it as a login item or system service
opencode mesh trust               # this node's id and the peers it trusts
opencode mesh trust peer.pem      # admit another node's certificate (node.pem in its storage)
opencode mesh peers               # peers and their status
opencode mesh list [--all]        # sessions the mesh knows; --all includes forgotten ones
opencode mesh stats | checked
```

Pairing is performed once per mesh: admit one node's `node.pem` on another and vice versa. Every sync includes the trust bundle, ensuring that any third node trusted by either side is trusted across the entire mesh.

## Config

`~/.config/opencode/ocmesh.toml` (or `$OCMESH_CONFIG`, or `--config`); every key is optional.

```toml
port = 47613          # loopback API for opencode and the CLI
peer_port = 47614     # mutual-TLS API for other nodes
internal_port = 47615 # loopback port the peer port forwards decrypted requests to
bind = "0.0.0.0"
storage_dir = "..."   # default: %LOCALAPPDATA%\ocmesh on Windows, ~/.local/share/ocmesh elsewhere
peers = ["192.0.2.10:47614"]
quiet = false
tls = "mutual"        # "off": loopback only, no peers
node_name = "..."     # default: the host name
```

When `quiet = true`, a node advertises nothing: its peer port completes only a mutual-TLS handshake with a trusted certificate within 2 s and closes any other connection without a reply. Peers are discovered via the operating system's neighbor (ARP) table: each new address and MAC pair triggers one handshake on the peer port, adding the result to a shared list of checked addresses across the mesh. This allows a node joining later to skip addresses already verified. A newcomer checks its own table only until it reaches its first peer, which then provides the rest of the mesh information.

The storage format, identities, and configuration structure are identical to those of the earlier Python ocmesh, meaning an existing node retains its id, trust, and registry.

## Remote control

Remote control is enabled by default. `/rc` in the TUI shares the current open session; `/rc <host>` connects to another node. Configuration resides in the `remote_control` section of `opencode.json`:

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

A session opened from another machine is attached using the credentials published by its server; therefore, that server must listen on the LAN (`opencode service set hostname 0.0.0.0`) and be protected by a password.
