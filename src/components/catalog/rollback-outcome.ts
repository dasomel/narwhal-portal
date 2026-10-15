/** Server text for a rollback the user must act on (outcome "unknown" / "rejected"). */
export class RollbackOutcomeError extends Error {}

const MAX_BODY_CHARS = 16_384
const MAX_ERROR_CHARS = 300

/**
 * #47: reads a non-OK rollback response defensively (never throws) and returns the server's
 * `error` text only for outcome "unknown"/"rejected"; otherwise null (caller shows generic). Render as text.
 */
export async function rollbackErrorMessage(res: Response): Promise<string | null> {
  try {
    const text = await res.text()
    if (text.length > MAX_BODY_CHARS) return null // oversized body: never parse/render it
    const body: unknown = JSON.parse(text)
    const { outcome, error } = (body ?? {}) as { outcome?: unknown; error?: unknown }
    if ((outcome === "unknown" || outcome === "rejected") && typeof error === "string") {
      const msg = error.trim()
      if (msg) return msg.length > MAX_ERROR_CHARS ? `${msg.slice(0, MAX_ERROR_CHARS - 1)}…` : msg
    }
  } catch {
    // unreadable body -> generic
  }
  return null
}
