import { NextRequest, NextResponse } from "next/server"
import { getUsers, createUser, getGroups, addUserToGroup } from "@/lib/keycloak-client"
import type { KeycloakUser } from "@/lib/keycloak-client"
import { requireAdmin, getActorId, ALLOWED_GROUPS, type UserRole } from "@/lib/auth"
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
  // portal#35: only these fields are ever read out of the request body —
  // createUser() used to be handed the raw body object, so any extra field an
  // attacker smuggled in rode along.
  const raw = body as {
    username?: unknown
    email?: unknown
    name?: unknown
    password?: unknown
    groups?: unknown
  }

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

  if (raw.groups !== undefined) {
    if (!Array.isArray(raw.groups) || !raw.groups.every((g) => typeof g === "string")) {
      return validationError("groups must be an array of strings", "groups")
    }
    if (raw.groups.length > ALLOWED_GROUPS.size) {
      return validationError(`groups cannot contain more than ${ALLOWED_GROUPS.size} roles`, "groups")
    }
    const seen = new Set<string>()
    for (const g of raw.groups) {
      if (!ALLOWED_GROUPS.has(g as UserRole)) {
        return validationError(`unsupported group: ${g}`, "groups")
      }
      if (seen.has(g)) {
        return validationError(`duplicate group: ${g}`, "groups")
      }
      seen.add(g)
    }
  }

  const requestedGroups: UserRole[] = raw.groups ? (raw.groups as UserRole[]) : []
  const payload = { username: raw.username, email: raw.email, name: raw.name, password: raw.password }

  // portal#35: dedupe a retried create (double-click, client retry on a
  // timeout) for the same actor + username/email/groups — same claim-then-fulfill
  // shape as POST /api/alerts/silence, since Keycloak (not us) mints the new
  // user's id.
  const actorId = getActorId(session)
  const idempotencyKey = req.headers.get("Idempotency-Key")?.trim()
  const idempotencyStoreKey = idempotencyKey ? `user-create:${idempotencyKey}` : null
  const sortedGroups = [...requestedGroups].sort()
  const fingerprint = JSON.stringify({
    actorId,
    username: payload.username,
    email: payload.email,
    groups: sortedGroups,
  })

  if (idempotencyStoreKey) {
    const claimed = await claimIdempotencyKey(getIdempotencyStore(), idempotencyStoreKey, `pending:${fingerprint}`)
    if (claimed !== null) {
      if (claimed.startsWith("pending:")) {
        if (claimed.slice("pending:".length) !== fingerprint) {
          return validationError("Idempotency-Key reused with a different request body", "Idempotency-Key")
        }
        // portal#35 review: a matching pending claim means an earlier request with
        // this same key is still in flight -- falling through would call
        // createUser() a second time. Keycloak's username uniqueness contains most
        // damage, but reject explicitly rather than relying on that as the guard.
        return NextResponse.json(
          { error: "Conflict", message: "A user creation with this Idempotency-Key is already in progress", field: "Idempotency-Key" },
          { status: 409 },
        )
      } else {
        const parsed = JSON.parse(claimed)
        if (parsed._fingerprint && parsed._fingerprint !== fingerprint) {
          return validationError("Idempotency-Key reused with a different request body", "Idempotency-Key")
        }
        delete parsed._fingerprint
        return NextResponse.json({ ...parsed, duplicate: true }, { status: 201 })
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
    description: requestedGroups.length > 0 ? `email=${payload.email}; groups=${sortedGroups.join(",")}` : `email=${payload.email}`,
  })

  let created: KeycloakUser
  try {
    // createUser() (src/lib/keycloak-client.ts) invalidates the "keycloak:users"
    // cache on success — no separate invalidation needed here now that GET
    // reads from that same cache.
    created = await createUser(payload)
  } catch (err) {
    await failOperation(ctx, `User create failed: ${payload.username}`, (err as Error).message)
    console.error("POST /api/settings/users error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }

  if (requestedGroups.length > 0) {
    try {
      const allGroups = await getGroups()
      const groupMap = new Map(allGroups.map((g) => [g.name, g.pk]))
      const missing = requestedGroups.filter((g) => !groupMap.has(g))
      if (missing.length > 0) {
        const errorMsg = `User created (id=${created.pk}) but group(s) not found in Keycloak: ${missing.join(", ")}`
        await failOperation(ctx, `User created with partial state: ${payload.username}`, errorMsg)
        return NextResponse.json(
          { error: "PartialStateError", message: errorMsg, user: created },
          { status: 500 },
        )
      }

      for (const groupName of requestedGroups) {
        const groupPk = groupMap.get(groupName)!
        await addUserToGroup(groupPk, created.pk)
      }
    } catch (err) {
      // The upstream error text stays in the operation record and server log only —
      // the response names the partial state without echoing Keycloak internals.
      await failOperation(
        ctx,
        `User created with partial state: ${payload.username}`,
        `User created (id=${created.pk}) but group assignment failed: ${(err as Error).message}`,
      )
      console.error("POST /api/settings/users group assignment error:", err)
      return NextResponse.json(
        {
          error: "PartialStateError",
          message: `User created (id=${created.pk}) but group assignment failed`,
          user: created,
        },
        { status: 500 },
      )
    }
  }

  await completeOperation(
    ctx,
    `User created: ${payload.username}`,
    `id=${created.pk}; email=${payload.email}${requestedGroups.length > 0 ? `; groups=${sortedGroups.join(",")}` : ""}`,
  )
  if (idempotencyStoreKey) {
    await fulfillIdempotencyKey(
      getIdempotencyStore(),
      idempotencyStoreKey,
      JSON.stringify({ ...created, _fingerprint: fingerprint }),
    )
  }
  return NextResponse.json(created, { status: 201 })
}
