import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getNamespaces, createNamespace } from "@/lib/k8s-client"

export const dynamic = "force-dynamic"

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const namespaces = await getNamespaces()
  return NextResponse.json(namespaces)
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "cluster-admin" && session.user.role !== "developer") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = await req.json()
  const name = body.name as string
  if (!name || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    return NextResponse.json({ error: "Invalid namespace name" }, { status: 400 })
  }
  if (!name.startsWith("dev-")) {
    return NextResponse.json({ error: "Self-service namespaces must start with 'dev-'" }, { status: 400 })
  }

  const ok = await createNamespace(name, { team: body.team ?? session.user.name ?? "unknown" })
  if (!ok) return NextResponse.json({ error: "Failed to create namespace" }, { status: 500 })
  return NextResponse.json({ success: true, namespace: name })
}
