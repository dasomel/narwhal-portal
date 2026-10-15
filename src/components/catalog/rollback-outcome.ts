/** Server text for a rollback the user must act on (outcome "unknown" / "rejected"). */
export class RollbackOutcomeError extends Error {}

/**
 * #47: reads a non-OK rollback response defensively (never throws) and returns the server's
 * `error` text only for outcome "unknown"/"rejected"; otherwise null (caller shows generic). Render as text.
 */
export async function rollbackErrorMessage(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json()
    const { outcome, error } = (body ?? {}) as { outcome?: unknown; error?: unknown }
    if ((outcome === "unknown" || outcome === "rejected") && typeof error === "string" && error) return error
  } catch {
    // unreadable body -> generic
  }
  return null
}
