import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getRbacBindings, getClusterRoles, getRoles } from "@/lib/k8s-client"
import { cacheGet, cacheSet } from "@/lib/valkey"

export const dynamic = "force-dynamic"

export type RbacRisk = "critical" | "high" | "medium" | "low"

export interface RbacRuleSummary {
  ruleCount: number
  wildcardVerbs: boolean
  wildcardResources: boolean
  secretsAccess: boolean
  writeAccess: boolean
  escalation: boolean
}

export interface RbacBindingV2 {
  name: string
  namespace: string | null
  scope: "cluster" | "namespace"
  roleRef: { kind: string; name: string }
  subjects: { kind: string; name: string; namespace?: string }[]
  risk: RbacRisk
  riskReasons: string[]
  ruleSummary: RbacRuleSummary | null
}

export interface RbacSummary {
  total: number
  clusterScope: number
  namespaceScope: number
  bySubjectKind: { user: number; group: number; serviceAccount: number }
  byRisk: { critical: number; high: number; medium: number; low: number }
}

export interface RbacResponseV2 {
  bindings: RbacBindingV2[]
  summary: RbacSummary
}

export async function GET() {
  const session = await auth()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "cluster-admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const cacheKey = "governance:rbac:v2"
  try {
    const cached = await cacheGet<RbacResponseV2>(cacheKey)
    if (cached) return NextResponse.json(cached)
  } catch (err) {
    console.warn("[governance/rbac] Cache read failed (non-fatal):", err)
  }

  try {
    const [bindings, clusterRoles, roles] = await Promise.all([
      getRbacBindings(),
      getClusterRoles(),
      getRoles(),
    ])

    // Index roles for fast lookup
    const clusterRolesMap = new Map(clusterRoles.map((r) => [r.name, r]))
    const rolesMap = new Map<string, Map<string, typeof roles[0]>>() // namespace -> name -> role
    for (const r of roles) {
      if (!rolesMap.has(r.namespace)) {
        rolesMap.set(r.namespace, new Map())
      }
      rolesMap.get(r.namespace)!.set(r.name, r)
    }

    const writeVerbs = new Set(["create", "update", "patch", "delete", "deletecollection"])
    const escalationTokens = new Set(["bind", "escalate", "impersonate"])

    const bindingsV2: RbacBindingV2[] = bindings.map((b) => {
      let matchedRole: { rules?: any[] } | undefined

      if (b.roleRef.kind === "ClusterRole") {
        matchedRole = clusterRolesMap.get(b.roleRef.name)
      } else if (b.roleRef.kind === "Role" && b.namespace) {
        matchedRole = rolesMap.get(b.namespace)?.get(b.roleRef.name)
      }

      let ruleSummary: RbacRuleSummary | null = null
      const riskReasons: string[] = []

      if (matchedRole) {
        const rules = matchedRole.rules ?? []
        let wildcardVerbs = false
        let wildcardResources = false
        let secretsAccess = false
        let writeAccess = false
        let escalation = false

        for (const r of rules) {
          const verbs = r.verbs ?? []
          const resources = r.resources ?? []

          if (verbs.includes("*")) wildcardVerbs = true
          if (resources.includes("*")) wildcardResources = true
          if (resources.includes("secrets")) secretsAccess = true

          if (verbs.some((v: string) => writeVerbs.has(v.toLowerCase()))) {
            writeAccess = true
          }

          if (
            verbs.some((v: string) => escalationTokens.has(v.toLowerCase())) ||
            resources.some((res: string) => escalationTokens.has(res.toLowerCase()))
          ) {
            escalation = true
          }
        }

        ruleSummary = {
          ruleCount: rules.length,
          wildcardVerbs,
          wildcardResources,
          secretsAccess,
          writeAccess,
          escalation,
        }

        if (wildcardVerbs) riskReasons.push("wildcard-verbs")
        if (wildcardResources) riskReasons.push("wildcard-resources")
        if (secretsAccess) riskReasons.push("secrets-access")
        if (escalation) riskReasons.push("escalation")
        if (writeAccess) {
          if (b.scope === "cluster") {
            riskReasons.push("cluster-write")
          } else {
            riskReasons.push("namespace-write")
          }
        }
      } else {
        riskReasons.push("role-not-found")
      }

      if (b.roleRef.name === "cluster-admin") {
        // Ensure "cluster-admin" is always tracked in reasons
        if (!riskReasons.includes("cluster-admin")) {
          riskReasons.unshift("cluster-admin")
        }
      }

      // Risk classification (first match)
      let risk: RbacRisk = "low"
      if (
        b.roleRef.name === "cluster-admin" ||
        (ruleSummary && ruleSummary.wildcardVerbs && ruleSummary.wildcardResources) ||
        (ruleSummary && ruleSummary.escalation)
      ) {
        risk = "critical"
      } else if (
        b.scope === "cluster" &&
        ruleSummary &&
        (ruleSummary.writeAccess ||
          ruleSummary.secretsAccess ||
          ruleSummary.wildcardVerbs ||
          ruleSummary.wildcardResources)
      ) {
        risk = "high"
      } else if (
        (b.scope === "namespace" && ruleSummary && ruleSummary.writeAccess) ||
        (b.scope === "cluster" && !ruleSummary)
      ) {
        risk = "medium"
      } else {
        risk = "low"
      }

      if (riskReasons.length === 0) {
        riskReasons.push("read-only")
      }

      return {
        name: b.name,
        namespace: b.namespace,
        scope: b.scope,
        roleRef: b.roleRef,
        subjects: b.subjects,
        risk,
        riskReasons,
        ruleSummary,
      }
    })

    const summary: RbacSummary = {
      total: bindingsV2.length,
      clusterScope: bindingsV2.filter((b) => b.scope === "cluster").length,
      namespaceScope: bindingsV2.filter((b) => b.scope === "namespace").length,
      bySubjectKind: { user: 0, group: 0, serviceAccount: 0 },
      byRisk: { critical: 0, high: 0, medium: 0, low: 0 },
    }

    for (const b of bindingsV2) {
      summary.byRisk[b.risk]++
      for (const s of b.subjects) {
        const k = s.kind.toLowerCase()
        if (k === "user") {
          summary.bySubjectKind.user++
        } else if (k === "group") {
          summary.bySubjectKind.group++
        } else if (k === "serviceaccount") {
          summary.bySubjectKind.serviceAccount++
        }
      }
    }

    const response: RbacResponseV2 = { bindings: bindingsV2, summary }

    try {
      await cacheSet(cacheKey, response, 60)
    } catch (err) {
      console.warn("[governance/rbac] Cache write failed (non-fatal):", err)
    }

    return NextResponse.json(response)
  } catch (err) {
    console.error("[governance/rbac]", err)
    return NextResponse.json({ error: "Failed to fetch RBAC data" }, { status: 500 })
  }
}
