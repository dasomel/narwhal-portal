/**
 * Operation-context helper for mutation routes (portal#11).
 *
 * Mints operation_id/correlation_id (reusing an inbound X-Correlation-Id /
 * X-Request-Id header for causation chaining when present), captures the actor
 * from the session, and emits operation.started / operation.completed /
 * operation.failed through the existing live-event pipeline (src/lib/live-stream.ts)
 * — replacing the ad-hoc `console.info("[audit] ...")` calls that mutation routes
 * used to make.
 */
import { randomUUID } from "crypto"
import type { Session } from "next-auth"
import { pushEvent } from "./live-stream"
import { getActorId } from "./auth"
import type { LiveSeverity, LiveSource } from "@/types/live"
import type { EventActor, EventResource } from "@/types/event-envelope"

export interface OperationContext {
  operationId: string
  correlationId: string
  causationId: string | null
  requestId: string | null
  actor: EventActor
  resource: EventResource
  operationType: string
  source: LiveSource
}

export interface BeginOperationInput {
  request: Request
  session: Session
  /** Dotted operation name, e.g. "argocd.sync", "alert.silence.create". */
  operationType: string
  source: LiveSource
  resource: EventResource
  title: string
  description?: string
}

function readHeader(request: Request, name: string): string | null {
  const v = request.headers.get(name)
  return v && v.trim().length > 0 ? v.trim() : null
}

export async function beginOperation(input: BeginOperationInput): Promise<OperationContext> {
  const inboundCorrelationId = readHeader(input.request, "x-correlation-id")
  const requestId = readHeader(input.request, "x-request-id")
  const operationId = randomUUID()
  // A caller-supplied correlation id is adopted as this operation's correlation id
  // (it joins that causal chain) and recorded as the causation parent; otherwise
  // the new operation_id seeds a fresh chain with no causation parent.
  const correlationId = inboundCorrelationId ?? operationId
  const causationId = inboundCorrelationId ?? null

  const ctx: OperationContext = {
    operationId,
    correlationId,
    causationId,
    requestId,
    actor: {
      id: getActorId(input.session),
      type: "user",
      displayName: input.session.user?.name ?? undefined,
    },
    resource: input.resource,
    operationType: input.operationType,
    source: input.source,
  }

  await emitLifecycle(ctx, "operation.started", "info", input.title, input.description)
  return ctx
}

export async function completeOperation(
  ctx: OperationContext,
  title: string,
  description?: string,
): Promise<void> {
  await emitLifecycle(ctx, "operation.completed", "success", title, description)
}

export async function failOperation(
  ctx: OperationContext,
  title: string,
  description?: string,
): Promise<void> {
  await emitLifecycle(ctx, "operation.failed", "error", title, description)
}

async function emitLifecycle(
  ctx: OperationContext,
  eventType: "operation.started" | "operation.completed" | "operation.failed",
  severity: LiveSeverity,
  title: string,
  description?: string,
): Promise<void> {
  try {
    await pushEvent({
      type: "operation",
      severity,
      title,
      description: description ?? "",
      source: ctx.source,
      event_type: eventType,
      resource: ctx.resource,
      actor: ctx.actor,
      operation_id: ctx.operationId,
      correlation_id: ctx.correlationId,
      causation_id: ctx.causationId,
    })
  } catch (err) {
    // Lifecycle emission is best-effort — never let an event-pipeline hiccup fail
    // the mutation it's describing.
    console.error(`[operation-context] failed to emit ${eventType}`, err)
  }
}
