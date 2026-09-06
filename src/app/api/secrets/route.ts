import { NextResponse } from "next/server"
import { auth, getActorId } from "@/lib/auth"
import { listSecrets, SecretMetadataError } from "@/lib/openbao"

export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "cluster-admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  // portal#11/portal#19: read access to the secret inventory is auditable —
  // actor + inbound correlation id, logged structurally. This intentionally does
  // NOT go through operation-context's beginOperation/dashboard event lifecycle:
  // that pipeline is for mutations and would surface every governance-view load
  // as an "operation" to other viewers, which is a bigger, separate call.
  const correlationId = req.headers.get("x-correlation-id") ?? undefined
  console.info(
    `[audit] secrets.list actor=${getActorId(session)}${correlationId ? ` correlation=${correlationId}` : ""}`
  )

  try {
    const entries = await listSecrets()
    return NextResponse.json(entries)
  } catch (err) {
    console.warn("[openbao]", (err as Error).message)
    // Fail explicitly degraded rather than silently returning [] — an empty list
    // here would read as "no secrets exist" instead of "metadata read failed".
    const message = err instanceof SecretMetadataError ? err.message : "Failed to list secrets"
    return NextResponse.json({ error: message, degraded: true }, { status: 502 })
  }
}
