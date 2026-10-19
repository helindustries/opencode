// Quiet mode: neighbour-table discovery, the mesh-wide checked list, inherited peers and push sync.
// Nodes run in-process on distinct loopback addresses sharing one peer port and read a fake
// neighbour table.

import { describe, expect, spyOn, test } from "bun:test"
import { EventEmitter } from "node:events"
import net from "node:net"
import path from "node:path"
import tls from "node:tls"
import { loadIdentity } from "../src/identity"
import { type Neighbour, NeighbourError, NeighbourWatcher, parseArpOutput, parseProcArp, probeTimeoutMs } from "../src/neighbours"
import { MeshService } from "../src/service"
import { call, checks, config, Mesh, peerUp, record, sessions, temporaryDirectory, waitFor } from "./fixture"

const missing = "127.0.0.9"
const idleSlackMs = 1_500
const quietPassesMs = 3 * probeTimeoutMs
const addresses = { a: "127.0.0.2", c: "127.0.0.3", d: "127.0.0.4" }

const procArp = `IP address       HW type     Flags       HW address            Mask     Device
192.168.1.2      0x1         0x2         a0:ce:c8:ec:f8:b4     *        eth0
192.168.1.7      0x1         0x0         00:00:00:00:00:00     *        eth0
192.168.1.4      0x1         0x2         b4:2e:99:f4:5e:b9     *        eth0
`

const macosArp = `? (192.168.1.1) at 0:11:22:a:b:c on en6 ifscope [ethernet]
? (192.168.1.2) at a0:ce:c8:ec:f8:b4 on en6 ifscope permanent [ethernet]
? (192.168.1.9) at (incomplete) on en6 ifscope [ethernet]
? (192.168.1.255) at ff:ff:ff:ff:ff:ff on en6 ifscope [ethernet]
? (224.0.0.251) at 1:0:5e:0:0:fb on en6 ifscope permanent [ethernet]
`

const windowsArp = `
Schnittstelle: 192.168.1.10 --- 0x7
  Internetadresse       Physische Adresse     Typ
  192.168.1.2           a0-ce-c8-ec-f8-b4     dynamisch
  192.168.1.255         ff-ff-ff-ff-ff-ff     statisch
  224.0.0.22            01-00-5e-00-00-16     statisch
  255.255.255.255       ff-ff-ff-ff-ff-ff     statisch
`

function mac(address: string) {
  return `02:00:00:00:00:${address.split(".")[3].padStart(2, "0")}`
}

function neighbour(address: string): Neighbour {
  return { address, mac: mac(address) }
}

describe("neighbour tables", () => {
  test("/proc/net/arp skips incomplete entries", () => {
    expect(parseProcArp(procArp)).toEqual([
      { address: "192.168.1.2", mac: "a0:ce:c8:ec:f8:b4" },
      { address: "192.168.1.4", mac: "b4:2e:99:f4:5e:b9" },
    ])
  })

  test("macOS arp normalises MACs and skips broadcast and multicast", () => {
    expect(parseArpOutput(macosArp)).toEqual([
      { address: "192.168.1.1", mac: "00:11:22:0a:0b:0c" },
      { address: "192.168.1.2", mac: "a0:ce:c8:ec:f8:b4" },
    ])
  })

  test("Windows arp reads localised output", () => {
    expect(parseArpOutput(windowsArp)).toEqual([{ address: "192.168.1.2", mac: "a0:ce:c8:ec:f8:b4" }])
  })
})

describe("quiet mode", () => {
  test("the peer port answers nothing without a trusted handshake", async () => {
    using directory = temporaryDirectory()
    await using mesh = await Mesh.create(directory.path, addresses)
    await mesh.start("a")
    const target = { host: addresses.a, port: mesh.peerPort }

    const plain = await new Promise<string>((resolve) => {
      const socket = net.connect(target, () => socket.write("GET /health HTTP/1.0\r\n\r\n"))
      let reply = ""
      socket.on("data", (chunk: Buffer) => (reply += chunk))
      socket.on("close", () => resolve(reply))
      socket.on("error", () => resolve(reply))
    })
    expect(plain).not.toContain("HTTP")

    const idleMs = await new Promise<number>((resolve) => {
      const started = Date.now()
      const socket = net.connect(target)
      socket.on("close", () => resolve(Date.now() - started))
      socket.on("error", () => {})
    })
    expect(idleMs).toBeLessThan(2_000 + idleSlackMs)

    const stranger = await loadIdentity(path.join(directory.path, "stranger"), "stranger")
    const untrusted = await new Promise<string>((resolve) => {
      const socket = tls.connect({ ...target, ...stranger.tlsOptions(), rejectUnauthorized: false })
      socket.on("secureConnect", () => socket.write("GET /health HTTP/1.0\r\n\r\n"))
      let reply = ""
      socket.on("data", (chunk: Buffer) => (reply += chunk))
      socket.on("close", () => resolve(reply))
      socket.on("error", () => resolve(reply))
    })
    expect(untrusted).not.toContain("HTTP")
  })

  test("a second node cannot bind either port the first one listens on", async () => {
    using directory = temporaryDirectory()
    await using mesh = await Mesh.create(directory.path, addresses)
    const a = await mesh.start("a")
    const attempt = (name: string, fields: Parameters<typeof config>[1]) =>
      MeshService.open(config(path.join(directory.path, name), fields)).then(
        async (service) => {
          await service.stop()
          return `${name} bound a port in use`
        },
        () => `${name} refused`,
      )
    expect(await attempt("peer", { peerPort: mesh.peerPort, bind: addresses.a, tls: "mutual", quiet: true })).toBe("peer refused")
    expect(await attempt("loopback", { port: a.loopback.port })).toBe("loopback refused")
  })

  test("finds a peer through the neighbour table", async () => {
    using directory = temporaryDirectory()
    await using mesh = await Mesh.create(directory.path, addresses)
    await mesh.start("a")
    const c = await mesh.start("c", { neighbours: [neighbour(addresses.a), neighbour(missing)] })
    await waitFor(() => peerUp(c, mesh.address("a")), "c to follow a")
    const found = await waitFor(async () => {
      const current = await checks(c)
      return current.has(`${missing} ${mac(missing)}`) ? current : undefined
    }, "c to check .9")
    expect(found.get(`${addresses.a} ${mac(addresses.a)}`)?.outcome).toBe("peer")
    expect(found.get(`${missing} ${mac(missing)}`)?.outcome).toBe("closed")
  })

  test("a newcomer inherits peers and the checked list, and nodes that disagree about a MAC settle", async () => {
    using directory = temporaryDirectory()
    await using mesh = await Mesh.create(directory.path, addresses)
    const neighbours = [neighbour(addresses.d), neighbour(missing)]
    await mesh.start("d")
    const a = await mesh.start("a", { neighbours })
    await waitFor(() => peerUp(a, mesh.address("d")), "a to find d")
    await waitFor(async () => (await checks(a)).has(`${missing} ${mac(missing)}`), "a to check .9")

    const c = await mesh.start("c", { neighbours, peers: [mesh.address("a")] })
    await waitFor(() => peerUp(c, mesh.address("d")), "c to follow d, which only a knew")
    await Bun.sleep(quietPassesMs)
    expect(Object.fromEntries([...(await checks(c))].map(([key, check]) => [key, check.checked_by]))).toEqual({
      [`${addresses.d} ${mac(addresses.d)}`]: a.node.nodeID,
      [`${missing} ${mac(missing)}`]: a.node.nodeID,
    })

    const newMac = "02:00:00:00:00:99"
    c.watcher!.reader = async () => [{ address: missing, mac: newMac }]
    await waitFor(async () => (await checks(a)).has(`${missing} ${newMac}`), "c's check of .9 with its new MAC to reach a")
    expect((await checks(a)).get(`${missing} ${newMac}`)?.checked_by).toBe(c.node.nodeID)
    const settled = await checks(a)
    await Bun.sleep(quietPassesMs)
    expect(await checks(a)).toEqual(settled)
  })

  test("a failure on this machine's side records nothing", async () => {
    using directory = temporaryDirectory()
    await using mesh = await Mesh.create(directory.path, addresses)
    const a = await mesh.start("a")
    const watcher = new NeighbourWatcher(a.node, a.peers!, mesh.peerPort)
    watcher.reader = async () => [neighbour(addresses.d)]
    const connect = spyOn(tls, "connect").mockImplementation(() => {
      const socket = Object.assign(new EventEmitter(), { destroy: () => {}, getPeerCertificate: () => undefined })
      queueMicrotask(() => socket.emit("error", Object.assign(new Error("No route to host"), { code: "EHOSTUNREACH" })))
      return socket as unknown as tls.TLSSocket
    })
    try {
      await expect(watcher.checkOnce()).rejects.toThrow(NeighbourError)
    } finally {
      connect.mockRestore()
    }
    expect((await checks(a)).size).toBe(0)
  })

  test("a restarted node follows its stored peers again", async () => {
    using directory = temporaryDirectory()
    await using mesh = await Mesh.create(directory.path, addresses)
    const d = await mesh.start("d")
    const a = await mesh.start("a", { neighbours: [neighbour(addresses.d)] })
    await waitFor(() => peerUp(a, mesh.address("d")), "a to find d")
    // d must not follow a back, or a would learn d again from d's connection instead of its store.
    await d.peers!.stop()
    await a.stop()
    const restarted = await mesh.start("a")
    await waitFor(
      async () => (await peerUp(restarted, mesh.address("d"))) && restarted.peers!.addresses().includes(mesh.address("d")),
      "a to follow d again after a restart",
    )
  })

  test("a node that cannot connect out still learns by push", async () => {
    using directory = temporaryDirectory()
    await using mesh = await Mesh.create(directory.path, addresses)
    const a = await mesh.start("a")
    await a.peers!.stop()
    const c = await mesh.start("c", { peers: [mesh.address("a")] })
    await call(c.loopback.port, "POST", "/v1/sessions", record("ses_before", { title: "before" }))
    await waitFor(() => peerUp(c, mesh.address("a")), "c to follow a")
    const titles = async () => Object.fromEntries((await sessions(a)).map((item) => [item.session_id, item.title]))
    await waitFor(async () => (await titles()).ses_before === "before", "a to get c's earlier session")
    const stored = await call<{ origin_host: string }>(c.loopback.port, "POST", "/v1/sessions", record("ses_after"))
    await waitFor(async () => "ses_after" in (await titles()), "a to get c's later session")
    await call(c.loopback.port, "DELETE", `/v1/sessions/${stored.body.origin_host}/ses_after`)
    await waitFor(async () => !("ses_after" in (await titles())), "a to get c's revocation")
    expect(a.peers!.addresses()).toEqual([])
  })
})
