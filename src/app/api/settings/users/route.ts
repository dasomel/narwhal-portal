import { NextRequest, NextResponse } from "next/server"
import { getUsers, createUser } from "@/lib/keycloak-client"
import { requireAdmin, getActorId } from "@/lib/auth"
import { beginOperation, completeOperation, failOperation } from "@/lib/operation-context"
import { claimIdempotencyKey, fulfillIdempotencyKey, getIdempotencyStore } from "@/lib/idempotency"

export const dynamic = "force-dynamic"

// portal#35: RFC-1123-ish username (matches the character set Keycloak accepts
// without normalization surprises) and a conservative email shape check — not
// full RFC 5322, just enough to reject obvious garbage before it reaches Keycloak.
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,64}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_NAME_LEN = 128
const MIN_PASSWORD_LEN = 8
const MAX_PASSWORD_LEN = 256

function validationError(message: string, field: string) {
  return NextResponse.json({ error: "ValidationError", message, field }, { status: 400 })
}

export async function GET() {
  const result = await requireAdmin()
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 403
    return NextResponse.json({ error: result.error === "unauthorized" ? "Unauthorized" : "Forbidden" }, { status })
  }
  try {
    // getUsers() (src/lib/keycloak-client.ts) owns the "keycloak:users" cache
    // and its own invalidation on create/update — this route used to layer a
    // second, differently-keyed cache ("api:users-list") on top with no
    // invalidation path of its own, so a create/update could leave stale data
    // visible here for up to its TTL. Reading straight from getUsers() means
    // there is exactly one cache to keep coherent.
    return NextResponse.json(await getUsers())
  } catch (err) {
    console.error("GET /api/settings/users error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const result = await requireAdmin()
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 403
    return NextResponse.json({ error: result.error === "unauthorized" ? "Unauthorized" : "Forbidden" }, { status })
  }
  const session = result.session

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return validationError("body must be a JSON object", "body")
  }
  // portal#35: only these four fields are ever read out of the request body —
  // createUser() used to be handed the raw body object, so any extra field an
  // attacker smuggled in rode along (unused today, but a latent trust bug for
  // the next person who wires role/group fields into createUser's payload).
  const raw = body as { username?: unknown; email?: unknown; name?: unknown; password?: unknown }

  if (typeof raw.username !== "string" || !USERNAME_RE.test(raw.username)) {
    return validationError("invalid username: 3-64 chars, letters/digits/._- only", "username")
  }
  if (typeof raw.email !== "string" || raw.email.length > 254 || !EMAIL_RE.test(raw.email)) {
    return validationError("invalid email", "email")
  }
  if (typeof raw.name !== "string" || raw.name.trim().length === 0 || raw.name.length > MAX_NAME_LEN) {
    return validationError(`invalid name: must be a non-empty string (≤${MAX_NAME_LEN} chars)`, "name")
  }
  if (
    typeof raw.password !== "string" ||
    raw.password.length < MIN_PASSWORD_LEN ||
    raw.password.length > MAX_PASSWORD_LEN
  ) {
    return validationError(`invalid password: must be ${MIN_PASSWORD_LEN}-${MAX_PASSWORD_LEN} chars`, "password")
  }

  const payload = { username: raw.username, email: raw.email, name: raw.name, password: raw.password }

  // portal#35: dedupe a retried create (double-click, client retry on a
  // timeout) for the same actor + username/email — same claim-then-fulfill
  // shape as POST /api/alerts/silence, since Keycloak (not us) mints the new
  // user's id.
  const actorId = getActorId(session)
  const idempotencyKey = req.headers.get("Idempotency-Key")?.trim()
  const idempotencyStoreKey = idempotencyKey ? `user-create:${idempotencyKey}` : null
  if (idempotencyStoreKey) {
    const fingerprint = JSON.stringify({ actorId, username: payload.username, email: payload.email })
    const claimed = await claimIdempotencyKey(getIdempotencyStore(), idempotencyStoreKey, `pending:${fingerprint}`)
    if (claimed !== null) {
      if (claimed.startsWith("pending:")) {
        if (claimed.slice("pending:".length) !== fingerprint) {
          return validationError("Idempotency-Key reused with a different request body", "Idempotency-Key")
        }
      } else {
        return NextResponse.json({ ...JSON.parse(claimed), duplicate: true }, { status: 201 })
      }
    }
  }

  const ctx = await beginOperation({
    request: req,
    session,
    operationType: "identity.user.create",
    source: "manual",
    resource: { kind: "User", name: payload.username },
    title: `User create started: ${payload.username}`,
    description: `email=${payload.email}`,
  })

  try {
    // createUser() (src/lib/keycloak-client.ts) invalidates the "keycloak:users"
    // cache on success — no separate invalidation needed here now that GET
    // reads from that same cache.
    const created = await createUser(payload)
    await completeOperation(ctx, `User created: ${payload.username}`, `id=${created.pk}; email=${payload.email}`)
    if (idempotencyStoreKey) {
      await fulfillIdempotencyKey(getIdempotencyStore(), idempotencyStoreKey, JSON.stringify(created))
    }
    return NextResponse.json(created, { status: 201 })
  } catch (err) {
    await failOperation(ctx, `User create failed: ${payload.username}`, (err as Error).message)
    console.error("POST /api/settings/users error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
