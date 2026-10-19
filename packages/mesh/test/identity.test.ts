import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fingerprintPEM, loadIdentity, randomSerial } from "../src/identity"
import { temporaryDirectory } from "./fixture"

// A certificate Python's ocmesh made, with the id it computed for it.
const pythonCertificate = `-----BEGIN CERTIFICATE-----
MIIBPTCB5KADAgECAhQ5bagCzCWBwnR1TmTkAbGX12bPoTAKBggqhkjOPQQDAjAT
MREwDwYDVQQDDAhvY21lc2ggYTAeFw0yNjEwMTcyMzQ3NTdaFw0zNjEwMTUyMzQ3
NTdaMBMxETAPBgNVBAMMCG9jbWVzaCBhMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcD
QgAEOAnQNJQxpgUnZ70guW5iXJ/CzVfQ2nBkBoCgMZe6Qnnym0fHGGPH1rEToW6X
HkQ/2zj36NFczJ+NqbTNpE5ayKMWMBQwEgYDVR0TAQH/BAgwBgEB/wIBADAKBggq
hkjOPQQDAgNIADBFAiANGxmQ51dFW90dhBF9hRxymUaVtM+1MNyfMLMgTEC8JAIh
ALBox+vcDWZvL9NOqGg1RF1CUzodhMIutEgE8fzWzzhX
-----END CERTIFICATE-----
`
const pythonNodeID = "38c3c9cb52b0e5601b46094c8dae518e"

describe("identity", () => {
  test("ids match the Python ocmesh's", () => {
    expect(fingerprintPEM(pythonCertificate)).toBe(pythonNodeID)
  })

  test("a node keeps its identity across loads and admits each certificate once", async () => {
    using directory = temporaryDirectory()
    const first = await loadIdentity(directory.path, "first")
    expect((await loadIdentity(directory.path, "first")).nodeID).toBe(first.nodeID)
    expect(first.admit(pythonCertificate)).toBe(pythonNodeID)
    expect(first.admit(pythonCertificate)).toBeUndefined()
    expect(first.admit(first.certPEM)).toBeUndefined()
    expect(readFileSync(first.bundlePath, "utf8")).toBe(first.certPEM + pythonCertificate)
  })

  test("serials are positive, minimal DER integers", () => {
    const firstBytes = Array.from({ length: 10_000 }, () => randomSerial()[0])
    expect(firstBytes.every((byte) => byte >= 0x01 && byte <= 0x7f)).toBe(true)
  })

  test("admission refuses what is not a certificate", async () => {
    using directory = temporaryDirectory()
    const identity = await loadIdentity(directory.path, "node")
    expect(() => identity.admit("not a certificate")).toThrow("expected a PEM certificate")
  })
})
