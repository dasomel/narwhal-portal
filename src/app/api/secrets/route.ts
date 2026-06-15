import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { listSecrets } from "@/lib/openbao"

export const dynamic = "force-dynamic"

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "cluster-admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  try {
    const entries = await listSecrets()
    return NextResponse.json(entries)
  } catch (err) {
    console.warn("[openbao]", (err as Error).message)
    return NextResponse.json([])
  }
}
