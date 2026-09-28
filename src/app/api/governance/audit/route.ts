import { getOperationalEventsResponse } from "@/lib/governance-operational-events"

export const dynamic = "force-dynamic"

export async function GET() {
  const response = await getOperationalEventsResponse()
  if (!response.ok) return response

  const payload = await response.json()
  const headers = new Headers({
    "X-Truncated": String(payload.truncated),
    // RFC 9745: structured-field date of when this endpoint became deprecated (2026-09-28).
    Deprecation: "@1790553600",
    Link: "</api/governance/events>; rel=\"successor-version\"",
  })
  return Response.json(payload.items, { status: response.status, headers })
}
