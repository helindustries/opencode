// Node identity and the trust inventory. Every node holds a self-signed certificate; peers are
// admitted by placing their certificate in trust/, authorized_keys style. ca.pem is the generated
// bundle (own certificate plus trust/) both TLS directions verify against. The layout and the
// formats (PKCS#8 key, PEM certificate, id = first 32 hex digits of the certificate's SHA-256) are
// the Python ocmesh's, so an existing node keeps its id.
//
// Traps: a self-signed leaf is only accepted as its own trust anchor when it carries
// BasicConstraints ca=true. Peers are dialled by IP, so hostname checks are off and the bundle
// pins them by certificate instead.

import { createHash, randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Integer, Utf8String } from "asn1js"
import { AttributeTypeAndValue, BasicConstraints, Certificate, Extension } from "pkijs"

const validityDays = 3650
const dayMs = 86_400_000
const commonNameOID = "2.5.4.3"
const basicConstraintsOID = "2.5.29.19"

export function fingerprintDER(der: Uint8Array) {
  return createHash("sha256").update(der).digest("hex").slice(0, 32)
}

// Throws on anything that is not a single PEM certificate, which is what admission relies on.
export function fingerprintPEM(pem: string) {
  const der = pemToDER(pem)
  Certificate.fromBER(der)
  return fingerprintDER(der)
}

export class Identity {
  readonly nodeID: string

  constructor(
    readonly storageDir: string,
    readonly certPEM: string,
  ) {
    this.nodeID = fingerprintPEM(certPEM)
  }

  get keyPath() {
    return path.join(this.storageDir, "node.key")
  }

  get certPath() {
    return path.join(this.storageDir, "node.pem")
  }

  get trustDir() {
    return path.join(this.storageDir, "trust")
  }

  get bundlePath() {
    return path.join(this.storageDir, "ca.pem")
  }

  trusted() {
    return readdirSync(this.trustDir)
      .filter((name) => name.endsWith(".pem"))
      .sort()
      .map((name) => ({ nodeID: name.slice(0, -4), pem: readFileSync(path.join(this.trustDir, name), "utf8") }))
  }

  // Adds a peer certificate; returns its id when it was new.
  admit(pem: string) {
    const nodeID = fingerprintPEM(pem)
    if (nodeID === this.nodeID) return undefined
    const target = path.join(this.trustDir, `${nodeID}.pem`)
    if (this.trusted().some((entry) => entry.nodeID === nodeID)) return undefined
    writeFileSync(target, pem)
    this.writeBundle()
    return nodeID
  }

  bundle() {
    return [this.certPEM, ...this.trusted().map((entry) => entry.pem)]
  }

  writeBundle() {
    writeFileSync(this.bundlePath, this.bundle().join(""))
  }

  // Read fresh on every call, so certificates admitted since start are trusted on the next connection.
  tlsOptions() {
    return {
      key: readFileSync(this.keyPath),
      cert: this.certPEM,
      ca: this.bundle(),
      minVersion: "TLSv1.2" as const,
    }
  }
}

export async function loadIdentity(storageDir: string, nodeName: string) {
  mkdirSync(path.join(storageDir, "trust"), { recursive: true })
  const keyPath = path.join(storageDir, "node.key")
  const certPath = path.join(storageDir, "node.pem")
  if (!(await Bun.file(keyPath).exists()) || !(await Bun.file(certPath).exists()))
    await createIdentity(keyPath, certPath, nodeName)
  const identity = new Identity(storageDir, readFileSync(certPath, "utf8"))
  identity.writeBundle()
  return identity
}

async function createIdentity(keyPath: string, certPath: string, nodeName: string) {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const certificate = new Certificate()
  const now = Date.now()
  certificate.version = 2
  certificate.serialNumber = new Integer({ valueHex: randomSerial() })
  certificate.subject.typesAndValues.push(commonName(nodeName))
  certificate.issuer.typesAndValues.push(commonName(nodeName))
  certificate.notBefore.value = new Date(now - dayMs)
  certificate.notAfter.value = new Date(now + validityDays * dayMs)
  const constraints = new BasicConstraints({ cA: true, pathLenConstraint: 0 })
  certificate.extensions = [
    new Extension({
      extnID: basicConstraintsOID,
      critical: true,
      extnValue: constraints.toSchema().toBER(false),
      parsedValue: constraints,
    }),
  ]
  await certificate.subjectPublicKeyInfo.importKey(keys.publicKey)
  await certificate.sign(keys.privateKey, "SHA-256")
  writeFileSync(keyPath, toPEM("PRIVATE KEY", new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey))))
  if (process.platform !== "win32") chmodSync(keyPath, 0o600)
  writeFileSync(certPath, toPEM("CERTIFICATE", new Uint8Array(certificate.toSchema(true).toBER(false))))
}

// DER integers are signed and minimal: a first byte of 0x01..0x7f keeps the serial positive and
// free of a leading zero, which OpenSSL rejects (INVALID_INTEGER) for about 1 in 256 serials.
export function randomSerial() {
  const serial = randomBytes(16)
  serial[0] = (serial[0] & 0x7f) | 0x01
  return serial
}

function commonName(nodeName: string) {
  return new AttributeTypeAndValue({ type: commonNameOID, value: new Utf8String({ value: `ocmesh ${nodeName}` }) })
}

function toPEM(label: string, der: Uint8Array) {
  const lines = Buffer.from(der).toString("base64").match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
}

function pemToDER(pem: string) {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem)
  if (!match) throw new Error("expected a PEM certificate (-----BEGIN CERTIFICATE-----)")
  return new Uint8Array(Buffer.from(match[1].replace(/\s+/g, ""), "base64"))
}
