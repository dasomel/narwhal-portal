import type { DistributionRecommendation, DistributionSummary } from "@/components/governance/types"

/** Maximum number of control-plane pods to collect for the drilldown list. */
export const CONTROL_PLANE_POD_LIST_CAP = 100

export function buildDistributionRecommendations(
  summary: Pick<
    DistributionSummary,
    "podImbalance" | "maxNode" | "minNode" | "controlPlaneWorkloadPods" | "concentratedWorkloads" | "unguardedWorkloads"
  >
): DistributionRecommendation[] {
  const { podImbalance, maxNode, minNode, controlPlaneWorkloadPods, concentratedWorkloads, unguardedWorkloads } = summary
  const recommendations: DistributionRecommendation[] = []

  if (podImbalance >= 10) {
    recommendations.push({
      severity: podImbalance >= 20 ? "high" : "medium",
      kind: "imbalance",
      title: "distribution.rec.imbalance.title",
      detail: "distribution.rec.imbalance.detail",
      params: {
        max: maxNode?.node ?? "",
        maxCount: maxNode?.podCount ?? 0,
        min: minNode?.node ?? "",
        minCount: minNode?.podCount ?? 0,
        diff: podImbalance,
      },
    })
  }

  if (controlPlaneWorkloadPods > 0) {
    recommendations.push({
      severity: "medium",
      kind: "control-plane-leak",
      title: "distribution.rec.controlPlaneLeak.title",
      detail: "distribution.rec.controlPlaneLeak.detail",
      params: {
        count: controlPlaneWorkloadPods,
      },
    })
  }

  if (concentratedWorkloads > 0) {
    recommendations.push({
      severity: "high",
      kind: "concentrated",
      title: "distribution.rec.concentrated.title",
      detail: "distribution.rec.concentrated.detail",
      params: {
        count: concentratedWorkloads,
      },
    })
  }

  if (unguardedWorkloads > 0) {
    recommendations.push({
      severity: "medium",
      kind: "unguarded",
      title: "distribution.rec.unguarded.title",
      detail: "distribution.rec.unguarded.detail",
      params: {
        count: unguardedWorkloads,
      },
    })
  }

  const severityOrder = { high: 0, medium: 1, low: 2 }
  recommendations.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])

  return recommendations
}
