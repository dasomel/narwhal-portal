import { getOperationalEventsResponse } from "@/lib/governance-operational-events"

export const dynamic = "force-dynamic"

export async function GET() {
  return getOperationalEventsResponse()
}
