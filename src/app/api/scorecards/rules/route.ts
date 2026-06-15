// TODO(wrap-up): i18n keys for ko/en — see spec §5.7
import { NextResponse } from "next/server"
import { requireRole } from "@/lib/auth"
import { loadRules, getRulesRaw } from "@/lib/scorecard"

export const dynamic = "force-dynamic"

export interface ScorecardRulesResponse {
  version: number
  source: "configmap" | "fallback"
  loadedAt: string
  rules: unknown[]
  tiers: { gold: number; silver: number; bronze: number }
  rawYaml?: string
}

export async function GET() {
  const gate = await requireRole("cluster-admin", "developer", "viewer")
  if ("error" in gate) {
    return NextResponse.json(
      { error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" },
      { status: gate.error === "unauthorized" ? 401 : 403 },
    )
  }

  try {
    const [rulesDoc, rawData] = await Promise.all([loadRules(), getRulesRaw()])

    const response: ScorecardRulesResponse = {
      version: rulesDoc.version,
      source: "configmap",
      loadedAt: rawData.loadedAt,
      rules: rulesDoc.rules,
      tiers: rulesDoc.tiers,
      rawYaml: rawData.raw,
    }

    return NextResponse.json(response)
  } catch (err) {
    const msg = (err as Error).message ?? ""
    const isNotFound =
      (err as NodeJS.ErrnoException).code === "NOT_FOUND" || msg.includes("404")
    if (isNotFound) {
      return NextResponse.json(
        {
          error: "Source unavailable",
          source: "configmap",
          message: "Scorecard rules ConfigMap not found. Create narwhal/gitops/resources/scorecard-rules.yaml in the cluster repo.",
        },
        { status: 503 },
      )
    }
    console.error("[api/scorecards/rules]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
