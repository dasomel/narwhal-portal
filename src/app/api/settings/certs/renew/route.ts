import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { renewCertificate } from "@/lib/k8s-client"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "cluster-admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = await req.json()
  const { name, namespace } = body
  if (!name || !namespace) return NextResponse.json({ error: "Missing name or namespace" }, { status: 400 })

  const ok = await renewCertificate(name, namespace)
  if (!ok) return NextResponse.json({ error: "Renewal failed" }, { status: 500 })
  return NextResponse.json({ success: true, message: `Certificate ${name} renewal triggered` })
}
