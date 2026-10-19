import { homedir } from "node:os"
import { join } from "node:path"

export type Endpoint = { url: string; password?: string }

// Plugin contexts expose neither the server URL nor its credential. The managed service writes both
// to its registration file (same path as @opencode/client's service-probe `fallback()`); a pid match
// proves the file describes this very process rather than another server on the machine.
export async function own(override: string | undefined): Promise<Endpoint | undefined> {
  const password = process.env["OPENCODE_PASSWORD"] ?? process.env["OPENCODE_SERVER_PASSWORD"]
  if (override) return { url: override, password }
  const info = await Bun.file(registration())
    .json()
    .catch(() => undefined)
  if (!isRegistration(info) || info.pid !== process.pid) return undefined
  return { url: info.url, password: info.password }
}

export function authBlob(endpoint: Endpoint | undefined) {
  if (!endpoint?.password) return ""
  return Buffer.from(`opencode:${endpoint.password}`).toString("base64")
}

function registration() {
  return join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "opencode", "service.json")
}

function isRegistration(value: unknown): value is { url: string; pid: number; password?: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "url" in value &&
    typeof value.url === "string" &&
    "pid" in value &&
    typeof value.pid === "number"
  )
}
