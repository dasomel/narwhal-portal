import { NextRequest, NextResponse } from "next/server"
import { setUserActive } from "@/lib/keycloak-client"
import { requireAdmin } from "@/lib/auth"
import { assertUuid, ValidationError, toValidationErrorBody } from "@/lib/validation"

export const dynamic = "force-dynamic"

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ pk: string }> }
) {
  const result = await requireAdmin()
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 403
    return NextResponse.json({ error: result.error === "unauthorized" ? "Unauthorized" : "Forbidden" }, { status })
  }
  try {
    const { pk } = await params
    try {
      assertUuid(pk, "pk")
    } catch (err) {
      if (err instanceof ValidationError) {
        return NextResponse.json(toValidationErrorBody(err), { status: 400 })
      }
      throw err
    }
    const body = await req.json().catch(() => ({}))
    const isActive = (body as { is_active?: unknown }).is_active
    if (typeof isActive !== "boolean") {
      return NextResponse.json(
        { error: "ValidationError", message: "is_active must be boolean", field: "is_active" },
        { status: 400 },
      )
    }
    await setUserActive(pk, isActive)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("PATCH /api/settings/users/[pk] error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
