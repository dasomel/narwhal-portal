import { NextResponse } from "next/server"
import { auth, getActorId } from "@/lib/auth"
import { getCertificate, invalidateCertificatesCache, renewCertificate } from "@/lib/k8s-client"
import { ValidationError, toValidationErrorBody } from "@/lib/validation"
import { beginOperation, completeOperation, failOperation } from "@/lib/operation-context"
import { claimIdempotencyKey, fulfillIdempotencyKey, getIdempotencyStore } from "@/lib/idempotency"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "cluster-admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "ValidationError", message: "body must be a JSON object", field: "body" }, { status: 400 })
  }
  const { name, namespace } = body as { name?: unknown; namespace?: unknown }

  let target: { name: string; namespace: string }
  try {
    if (typeof name !== "string" || name.length === 0) {
      throw new ValidationError("invalid name: must be a non-empty string", "name")
    }
    if (typeof namespace !== "string" || namespace.length === 0) {
      throw new ValidationError("invalid namespace: must be a non-empty string", "namespace")
    }
    target = { name, namespace }
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(toValidationErrorBody(err), { status: 400 })
    }
    throw err
  }

  // portal#35: eligibility check — the certificate must actually exist before
  // we trigger a renewal against it. Also validates name/namespace against
  // K8s naming rules (getCertificate asserts), catching malformed identifiers
  // that pass the basic string check above with a 400 instead of a 500 from
  // a rejected API call.
  let before: Awaited<ReturnType<typeof getCertificate>>
  try {
    before = await getCertificate(target.name, target.namespace)
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(toValidationErrorBody(err), { status: 400 })
    }
    throw err
  }
  if (!before) {
    return NextResponse.json(
      { error: "NotFound", message: `Certificate ${target.name} not found in namespace ${target.namespace}`, field: "name" },
      { status: 404 },
    )
  }

  // portal#35: dedupe a retried renewal (client timeout/double-click) against
  // the same target for the same actor — same claim-then-fulfill shape as
  // POST /api/alerts/silence.
  const actorId = getActorId(session)
  const idempotencyKey = req.headers.get("Idempotency-Key")?.trim()
  const idempotencyStoreKey = idempotencyKey ? `cert-renew:${idempotencyKey}` : null
  if (idempotencyStoreKey) {
    const fingerprint = JSON.stringify({ actorId, name: target.name, namespace: target.namespace })
    const claimed = await claimIdempotencyKey(getIdempotencyStore(), idempotencyStoreKey, `pending:${fingerprint}`)
    if (claimed !== null) {
      if (claimed.startsWith("pending:")) {
        if (claimed.slice("pending:".length) !== fingerprint) {
          return NextResponse.json(
            { error: "ValidationError", message: "Idempotency-Key reused with a different request body", field: "Idempotency-Key" },
            { status: 400 },
          )
        }
      } else {
        return NextResponse.json({ success: true, message: claimed, duplicate: true })
      }
    }
  }

  const ctx = await beginOperation({
    request: req,
    session,
    operationType: "pki.certificate.renew",
    source: "kubernetes",
    resource: { kind: "Certificate", namespace: target.namespace, name: target.name },
    title: `Certificate renewal started: ${target.name}`,
    description: `namespace=${target.namespace}; issuer=${before.issuer}; notAfter=${before.notAfter ?? "unknown"}`,
  })

  let ok: boolean
  try {
    ok = await renewCertificate(target.name, target.namespace)
  } catch (err) {
    await failOperation(ctx, `Certificate renewal failed: ${target.name}`, (err as Error).message)
    throw err
  }
  if (!ok) {
    await failOperation(ctx, `Certificate renewal failed: ${target.name}`, "renewCertificate returned false")
    return NextResponse.json({ error: "Renewal failed" }, { status: 500 })
  }

  await invalidateCertificatesCache()

  // portal#35: post-renewal read-back — a 2xx PATCH only means cert-manager
  // accepted the request, not that renewal actually happened. Re-read the
  // object and confirm its renewal marker actually advanced past what it was
  // before the trigger; if the API can't be read back, don't claim success.
  let after: Awaited<ReturnType<typeof getCertificate>>
  try {
    after = await getCertificate(target.name, target.namespace)
  } catch (err) {
    await failOperation(ctx, `Certificate renewal verification failed: ${target.name}`, (err as Error).message)
    return NextResponse.json({ error: "Renewal triggered but post-renewal verification failed" }, { status: 502 })
  }
  if (!after) {
    await failOperation(ctx, `Certificate renewal verification failed: ${target.name}`, "certificate disappeared after renewal trigger")
    return NextResponse.json({ error: "Renewal triggered but certificate no longer found" }, { status: 502 })
  }
  const converged = after.renewalTime !== before.renewalTime || after.notBefore !== before.notBefore
  if (!converged) {
    // Not necessarily a failure — cert-manager reconciliation can lag behind
    // the PATCH response — but "success" must not be claimed until convergence
    // is observed, so this is reported as an in-flight state, not a hard error.
    await completeOperation(
      ctx,
      `Certificate renewal triggered (pending convergence): ${target.name}`,
      "renewal request accepted; status not yet updated by cert-manager",
    )
    const message = `Certificate ${target.name} renewal triggered; awaiting convergence`
    if (idempotencyStoreKey) await fulfillIdempotencyKey(getIdempotencyStore(), idempotencyStoreKey, message)
    return NextResponse.json({ success: true, pending: true, message })
  }

  const message = `Certificate ${target.name} renewal triggered and verified`
  await completeOperation(ctx, `Certificate renewal verified: ${target.name}`, `renewalTime=${after.renewalTime ?? "unknown"}`)
  if (idempotencyStoreKey) await fulfillIdempotencyKey(getIdempotencyStore(), idempotencyStoreKey, message)
  return NextResponse.json({ success: true, message })
}
