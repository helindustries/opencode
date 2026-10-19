import { createRouter, handshakeTimeoutMs, type Listener, quietHandshakeTimeoutMs, serveLoopback, servePeers } from "./api"
import type { MeshConfig } from "./config"
import { NeighbourWatcher } from "./neighbours"
import { MeshNode } from "./node"
import { PeerManager } from "./sync"

export class MeshService {
  private constructor(
    readonly node: MeshNode,
    readonly loopback: Listener,
    readonly lan?: Awaited<ReturnType<typeof servePeers>>,
    readonly peers?: PeerManager,
    readonly watcher?: NeighbourWatcher,
  ) {}

  // Binds both listeners; nothing connects out until start().
  static async open(config: MeshConfig) {
    const node = await MeshNode.open(config)
    const holder: { peers?: PeerManager } = {}
    const route = createRouter(node, () => holder.peers && ((address, nodeID) => holder.peers!.add(address, nodeID)))
    const loopback = await Promise.resolve()
      .then(() => serveLoopback(config.port, route))
      .catch((error: Error) => {
        node.close()
        throw new Error(`ocmesh: cannot listen on 127.0.0.1:${config.port}: ${error.message}`)
      })
    if (config.tls !== "mutual") return new MeshService(node, loopback)
    const lan = await servePeers({
      bind: config.bind,
      port: config.peerPort,
      internalPort: config.internalPort,
      handshakeTimeoutMs: config.quiet ? quietHandshakeTimeoutMs : handshakeTimeoutMs,
      tlsOptions: () => node.identity.tlsOptions(),
      route,
    }).catch(async (error: Error) => {
      await loopback.close()
      node.close()
      throw error
    })
    const peers = new PeerManager(node, lan.port, () => lan.refresh(), config.bind)
    holder.peers = peers
    const watcher = config.quiet ? new NeighbourWatcher(node, peers, lan.port) : undefined
    return new MeshService(node, loopback, lan, peers, watcher)
  }

  start() {
    this.node.config.peers.forEach((address) => this.peers?.add(address))
    this.node.peers().forEach((peer) => this.peers?.add(peer.address, peer.node_id))
    this.watcher?.start()
  }

  async stop() {
    await this.peers?.stop()
    await this.watcher?.stop()
    this.node.bus.close()
    await this.loopback.close()
    await this.lan?.close()
    this.node.close()
  }
}
