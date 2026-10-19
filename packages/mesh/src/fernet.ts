// Fernet (https://github.com/fernet/spec), the format Python's cryptography package writes:
// base64url(0x80 | timestamp | iv | AES-128-CBC ciphertext | HMAC-SHA256). Implemented here so
// the auth_blob values a Python ocmesh stored decrypt unchanged, and stay readable by it.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

const version = 0x80
const headerLength = 1 + 8 + 16
const macLength = 32

export class Fernet {
  private readonly signing: Buffer
  private readonly encryption: Buffer

  constructor(key: string) {
    const raw = Buffer.from(key, "base64url")
    if (raw.length !== 32) throw new Error(`Fernet key: expected 32 bytes of url-safe base64, got ${raw.length}`)
    this.signing = raw.subarray(0, 16)
    this.encryption = raw.subarray(16)
  }

  static generateKey() {
    return toBase64Url(randomBytes(32))
  }

  encrypt(plain: string) {
    const iv = randomBytes(16)
    const cipher = createCipheriv("aes-128-cbc", this.encryption, iv)
    const timestamp = Buffer.alloc(8)
    timestamp.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)))
    const body = Buffer.concat([Buffer.of(version), timestamp, iv, cipher.update(plain, "utf8"), cipher.final()])
    const mac = createHmac("sha256", this.signing).update(body).digest()
    return Buffer.from(toBase64Url(Buffer.concat([body, mac])), "ascii")
  }

  decrypt(token: Uint8Array | string) {
    const raw = Buffer.from(typeof token === "string" ? token : Buffer.from(token).toString("ascii"), "base64url")
    if (raw.length < headerLength + macLength || raw[0] !== version)
      throw new Error("Fernet token: expected version 0x80 and a full header")
    const body = raw.subarray(0, raw.length - macLength)
    const expected = createHmac("sha256", this.signing).update(body).digest()
    if (!timingSafeEqual(expected, raw.subarray(raw.length - macLength)))
      throw new Error("Fernet token: signature does not match this node's blob.key")
    const decipher = createDecipheriv("aes-128-cbc", this.encryption, body.subarray(9, headerLength))
    return Buffer.concat([decipher.update(body.subarray(headerLength)), decipher.final()]).toString("utf8")
  }
}

// Python's urlsafe_b64encode keeps the "=" padding, and its decoder requires it.
function toBase64Url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_")
}
