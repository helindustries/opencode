// Peer discovery from the OS neighbour (ARP) table, used in quiet mode. Only machines this one
// already exchanged traffic with are candidates. Each new address/MAC pair gets one mutual-TLS
// handshake on the peer port, and the outcome joins the mesh-wide list of checked addresses, so a
// node joining later skips what the mesh already checked.

import { isIP } from "node:net"
import tls from "node:tls"
import { splitAddress } from "./config"
import { fingerprintDER, type Identity } from "./identity"
import { log } from "./log"
import type { MeshNode } from "./node"
import type { CheckOutcome, NeighbourCheck } from "./protocol"
import type { PeerManager } from "./sync"

export const pollMs = 30_000
export const recheckMs = 6 * 3_600_000
export const probeTimeoutMs = 2_000
export const settleTimeoutMs = 30_000
export const arpTimeoutMs = 10_000

const procArpPath = "/proc/net/arp"
const procArpIncomplete = "0x0"
const unusableMacs = new Set(["ff:ff:ff:ff:ff:ff", "00:00:00:00:00:00"])
const arpLine = /(\d{1,3}(?:\.\d{1,3}){3})\)?\s+(?:at\s+)?([0-9a-fA-F]{1,2}(?:[:-][0-9a-fA-F]{1,2}){5})\b/
// Failures on this machine's side: they say nothing about the address, and recording them as
// closed would make the whole mesh skip a real peer.
const localFailures = new Set(["EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EACCES", "EPERM"])
const logger = log("neighbours")

export type Neighbour = { address: string; mac: string }

export class NeighbourError extends Error {}

export function parseProcArp(text: string) {
  return unique(
    text
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields.length >= 4 && fields[2] !== procArpIncomplete)
      .map((fields) => neighbour(fields[0], fields[3])),
  )
}

// `arp -an` on macOS and `arp -a` on Windows; Windows localises the type column, so only the
// address and the MAC are read.
export function parseArpOutput(text: string) {
  return unique(
    text
      .split("\n")
      .map((line) => arpLine.exec(line))
      .filter((match) => match !== null)
      .map((match) => neighbour(match[1], match[2])),
  )
}

export async function readNeighbours(): Promise<Neighbour[]> {
  const procArp = Bun.file(procArpPath)
  if (await procArp.exists()) return parseProcArp(await procArp.text())
  const command = process.platform === "win32" ? ["arp", "-a"] : ["arp", "-an"]
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", windowsHide: true })
  const timer = setTimeout(() => child.kill(), arpTimeoutMs)
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timer)
  if (code !== 0) throw new NeighbourError(`${command.join(" ")}: expected exit 0, got ${code}: ${errors.trim()}`)
  return parseArpOutput(output)
}

// The outcome of one handshake with address:port, and the node behind it when trusted.
export function probe(identity: Identity, address: string, port: number, localAddress?: string) {
  return new Promise<{ outcome: CheckOutcome; nodeID?: string }>((resolve, reject) => {
    const socket = tls.connect({
      host: address,
      port,
      localAddress,
      timeout: probeTimeoutMs,
      ...identity.tlsOptions(),
      checkServerIdentity: () => undefined,
    })
    const connected = { value: false }
    socket.once("connect", () => (connected.value = true))
    socket.once("secureConnect", () => {
      const der = socket.getPeerCertificate(true)?.raw
      socket.destroy()
      resolve(der ? { outcome: "peer", nodeID: fingerprintDER(der) } : { outcome: "untrusted" })
    })
    socket.once("timeout", () => {
      socket.destroy()
      resolve({ outcome: connected.value ? "untrusted" : "closed" })
    })
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy()
      if (localFailures.has(error.code ?? ""))
        return reject(new NeighbourError(`cannot reach ${address}:${port} from here: ${error.message}`))
      // Once the TCP connection stood, a failure is the handshake: a node that does not trust us,
      // or a service that is not a mesh node.
      resolve({ outcome: connected.value ? "untrusted" : "closed" })
    })
  })
}

export class NeighbourWatcher {
  reader: () => Promise<Neighbour[]> = readNeighbours
  pollMs = pollMs
  private stopped = false
  private wake = () => {}
  private done: Promise<void> = Promise.resolve()

  constructor(
    private readonly node: MeshNode,
    private readonly peers: PeerManager,
    private readonly peerPort: number,
  ) {}

  start() {
    this.done = this.run()
  }

  async stop() {
    this.stopped = true
    this.wake()
    await Promise.race([this.done, Bun.sleep(arpTimeoutMs + probeTimeoutMs)])
  }

  // Checks due neighbours until the first new peer. That peer's first sync brings its peers and its
  // checked list, which usually leaves nothing for the next pass to check.
  async checkOnce() {
    await this.peers.settle(settleTimeoutMs)
    const checked = new Map(this.node.checks().map((check) => [`${check.address} ${check.mac}`, check]))
    const followed = new Set(this.peers.addresses().map((address) => splitAddress(address)[0]))
    const due = (neighbour: Neighbour) => {
      const previous = checked.get(`${neighbour.address} ${neighbour.mac}`)
      return !previous || Date.now() - previous.checked_at > recheckMs
    }
    for (const neighbour of await this.reader()) {
      if (this.stopped) return
      if (followed.has(neighbour.address) || !due(neighbour)) continue
      const result = await probe(this.node.identity, neighbour.address, this.peerPort, this.peers.sourceAddress)
      logger(`checked ${neighbour.address} (${neighbour.mac}): ${result.outcome}`)
      const check: NeighbourCheck = { ...neighbour, outcome: result.outcome, checked_at: Date.now(), checked_by: this.node.nodeID }
      this.node.recordCheck(check)
      if (result.outcome === "peer" && result.nodeID !== this.node.nodeID) {
        this.peers.add(`${neighbour.address}:${this.peerPort}`, result.nodeID)
        return
      }
    }
  }

  private async run() {
    while (!this.stopped) {
      await this.checkOnce().catch((error: Error) =>
        logger(`neighbour check failed, retrying in ${this.pollMs / 1000}s: ${error.message}`),
      )
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.pollMs)
        this.wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  }
}

// Undefined for entries that cannot host a peer: multicast, broadcast, loopback, incomplete.
function neighbour(address: string, macText: string): Neighbour | undefined {
  const mac = macText
    .split(/[:-]/)
    .map((part) => part.padStart(2, "0").toLowerCase())
    .join(":")
  if (isIP(address) !== 4 || unusableMacs.has(mac)) return undefined
  const first = Number(address.split(".")[0])
  if (first === 127 || first === 0 || (first >= 224 && first <= 239)) return undefined
  return { address, mac }
}

function unique(neighbours: (Neighbour | undefined)[]) {
  const found = new Map<string, Neighbour>()
  neighbours.filter((entry) => entry !== undefined).forEach((entry) => found.has(entry.address) || found.set(entry.address, entry))
  return [...found.values()]
}
