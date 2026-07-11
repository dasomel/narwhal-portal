import "server-only"
import { cacheGet, cacheSet } from "./valkey"
import { KISA_CATALOG } from "./kisa-controls"
import type { KisaControl, KisaResponse, KisaStatus } from "@/types/kisa"

// Static status map for non-LIVE controls.
//
// These 6 remain static because they are node/host-level or process-level facts that are
// NOT observable via the K8s API the portal has access to (SSH-only config, external service
// config outside the cluster API, or signing/registry infra state). Their statuses reflect the
// last manual security audit and must be updated by hand whenever the underlying cluster
// configuration changes:
//   - KISA-SEC-01  (OpenBao unseal key isolation)     — Secret *contents* need a value read,
//                                                        not just existence; out of API scope.
//   - KISA-ETCD-02 (APISIX etcd access protection)     — etcd transport security is a
//                                                        host/process-level fact (TLS+auth on
//                                                        the APISIX-internal etcd endpoint).
//   - KISA-IMG-01  (Registry TLS certificate verify)   — containerd skip_verify is a per-node
//                                                        config file setting, not a K8s object.
//   - KISA-TLS-01  (Service mesh mTLS coverage)        — mesh dataplane-mode opt-out is a pod
//                                                        annotation audit across many services;
//                                                        kept manual pending a dedicated scan.
//   - KISA-OBS-01  (Security event real-time alerting) — Alertmanager receiver wiring lives in
//                                                        its own config, not a simple K8s read.
//   - KISA-IMG-02  (Image tag/signature management)    — Cosign signature verification state
//                                                        isn't exposed via any K8s API object.
const STATIC_STATUS: Record<string, KisaStatus> = {
  "KISA-SEC-01": "fail",
  "KISA-ETCD-02": "fail",
  "KISA-IMG-01": "fail",
  "KISA-TLS-01": "warn",
  "KISA-OBS-01": "warn",
  "KISA-IMG-02": "warn",
}

const LIVE_IDS = new Set([
  "KISA-CP-01",
  "KISA-ETCD-01",
  "KISA-POD-01",
  "KISA-NET-01",
  "KISA-RBAC-01",
  "KISA-RBAC-02",
  "KISA-IMG-03",
  "KISA-ADM-01",
  "KISA-TLS-02",
  "KISA-CFG-01",
])

const KISA_NET01_NAMESPACES = ["iam", "devtools", "monitoring", "storage", "database"]

// Bindings that are unavoidable K8s builtins — excluded from the RBAC-01/02 verdict because the
// cluster/operators cannot function without them (kubeadm bootstrap, control-plane component
// identities, the built-in cluster-admin binding to system:masters).
function isUnavoidableRbacBuiltin(b: { name: string; subjects: Array<{ kind: string; name: string }> }): boolean {
  if (b.name === "cluster-admin") return true
  if (b.name.startsWith("system:") || b.name.startsWith("kubeadm:")) return true
  if (
    b.subjects.length > 0 &&
    b.subjects.every((s) => s.kind === "Group" && (s.name === "system:masters" || s.name.startsWith("system:")))
  ) {
    return true
  }
  return false
}

// --- Live check helpers ---

async function checkImg03(): Promise<{ status: KisaStatus; detail: string }> {
  const { getSecuritySummary } = await import("./trivy")
  const summary = await getSecuritySummary()
  if (summary.totals.Critical > 0) {
    return { status: "fail", detail: `Critical CVE ${summary.totals.Critical}건` }
  }
  if (summary.totals.High > 0) {
    return { status: "warn", detail: `High CVE ${summary.totals.High}건` }
  }
  return { status: "pass", detail: "Critical/High CVE 없음" }
}

async function checkCfg01(): Promise<{ status: KisaStatus; detail: string }> {
  const { getComplianceFrameworks, getConfigAuditList } = await import("./compliance")
  const [frameworks, configAuditRows] = await Promise.all([getComplianceFrameworks(), getConfigAuditList()])
  if (frameworks.length === 0) {
    return { status: "manual", detail: "프레임워크 데이터 없음" }
  }

  // D: trivy-operator's ClusterComplianceReport (source of `frameworks`) aggregates pass/fail
  // per CONTROL across the whole cluster and does not carry per-check namespace/resource
  // attribution — unlike raw configauditreports, it cannot be split into actionable/accepted
  // findings at the API level (verified: RawComplianceReport.status.detailReport.results[].checks
  // only exposes `success`, no resource ref). So the framework passRate itself stays cluster-wide
  // (consistent with how CIS/NSA benchmarks are meant to be read). As a transparency aid, we
  // still surface the actionable-vs-accepted split of the underlying raw config-audit findings
  // (same Trivy scan, namespace-attributed) alongside the verdict so a low framework score isn't
  // read as "N actionable issues" when it's largely system-namespace noise.
  // Actionable excludes LOW severity too — KSV020/021 UID/GID and KSV011/015/016/018 resource
  // limit checks are risk-accepted hygiene per narwhal/docs/compliance-hardening.md, same tiering
  // as getComplianceSummary's totalConfigAuditFailures/lowSeverityConfigAuditFailures split.
  const actionableFailures = configAuditRows
    .filter((r) => !r.accepted)
    .reduce((sum, r) => sum + r.summary.Critical + r.summary.High + r.summary.Medium, 0)
  const lowSeverityFailures = configAuditRows
    .filter((r) => !r.accepted)
    .reduce((sum, r) => sum + r.summary.Low, 0)
  const acceptedFailures = configAuditRows
    .filter((r) => r.accepted)
    .reduce((sum, r) => sum + r.summary.Critical + r.summary.High + r.summary.Medium + r.summary.Low, 0)
  const breakdown = `(config-audit 조치가능 ${actionableFailures}건, 위생 ${lowSeverityFailures}건, 시스템 수용 ${acceptedFailures}건)`

  const failing = frameworks.filter((f) => f.passRate < 0.6)
  const warning = frameworks.filter((f) => f.passRate >= 0.6 && f.passRate < 0.9)
  if (failing.length > 0) {
    return {
      status: "fail",
      detail: `통과율 60% 미만 ${failing.length}건 (최저 ${Math.round(Math.min(...failing.map((f) => f.passRate)) * 100)}%) ${breakdown}`,
    }
  }
  if (warning.length > 0) {
    return {
      status: "warn",
      detail: `통과율 90% 미만 ${warning.length}건 ${breakdown}`,
    }
  }
  return { status: "pass", detail: `전 프레임워크 통과율 90% 이상 ${breakdown}` }
}

async function checkTls02(): Promise<{ status: KisaStatus; detail: string }> {
  const { getCertificates } = await import("./k8s-client")
  const certs = await getCertificates()
  if (certs.length === 0) {
    return { status: "manual", detail: "인증서 데이터 없음" }
  }
  const now = Date.now()
  const thirtyDays = 30 * 24 * 60 * 60 * 1000
  const notReady = certs.filter((c) => !c.ready)
  const expiring = certs.filter(
    (c) => c.notAfter && new Date(c.notAfter).getTime() - now < thirtyDays,
  )
  if (notReady.length > 0 || expiring.length > 0) {
    const parts: string[] = []
    if (notReady.length > 0) parts.push(`미준비 ${notReady.length}건`)
    if (expiring.length > 0) parts.push(`30일 내 만료 ${expiring.length}건`)
    return { status: "fail", detail: parts.join(", ") }
  }
  return { status: "pass", detail: `전체 ${certs.length}건 정상` }
}

async function checkAdm01(): Promise<{ status: KisaStatus; detail: string }> {
  const { getKyvernoPolicies } = await import("./k8s-client")
  const policies = await getKyvernoPolicies()
  if (policies.length === 0) {
    return { status: "manual", detail: "Kyverno 정책 없음" }
  }
  const notReady = policies.filter((p) => !p.ready)
  const allAudit = policies.every((p) => p.validationFailureAction === "Audit")
  if (notReady.length > 0 || allAudit) {
    const parts: string[] = []
    if (notReady.length > 0) parts.push(`미준비 ${notReady.length}건`)
    if (allAudit) parts.push("전 정책 Audit 모드")
    return { status: "warn", detail: parts.join(", ") }
  }
  return { status: "pass", detail: `Enforce 정책 ${policies.filter((p) => p.validationFailureAction === "Enforce").length}건 활성` }
}

async function checkCp01(): Promise<{ status: KisaStatus; detail: string }> {
  const { getApiServerPods } = await import("./k8s-client")
  const pods = await getApiServerPods()
  if (pods.length === 0) return { status: "manual", detail: "API 서버 파드 정보 없음" }

  const hasBoth = pods.filter(
    (p) =>
      p.containerArgs.some((a) => a.includes("--audit-log-path")) &&
      p.containerArgs.some((a) => a.includes("--audit-policy-file")),
  )
  if (hasBoth.length === pods.length) {
    return { status: "pass", detail: `apiserver ${pods.length}건 모두 감사 로그 설정 확인` }
  }
  if (hasBoth.length > 0) {
    return { status: "warn", detail: `apiserver ${hasBoth.length}/${pods.length}건만 감사 로그 설정` }
  }
  return { status: "fail", detail: `apiserver ${pods.length}건 모두 --audit-log-path/--audit-policy-file 미설정` }
}

async function checkEtcd01(): Promise<{ status: KisaStatus; detail: string }> {
  const { getApiServerPods } = await import("./k8s-client")
  const pods = await getApiServerPods()
  if (pods.length === 0) return { status: "manual", detail: "API 서버 파드 정보 없음" }

  const encrypted = pods.filter((p) => p.containerArgs.some((a) => a.includes("--encryption-provider-config")))
  if (encrypted.length === pods.length) {
    return { status: "pass", detail: `apiserver ${pods.length}건 모두 --encryption-provider-config 설정` }
  }
  return { status: "fail", detail: `apiserver ${pods.length - encrypted.length}/${pods.length}건 암호화 미설정` }
}

async function checkPod01(): Promise<{ status: KisaStatus; detail: string }> {
  const { getNamespaces } = await import("./k8s-client")
  const namespaces = await getNamespaces()
  const considered = namespaces.filter((n) => n.name !== "kube-node-lease" && n.name !== "kube-public")
  if (considered.length === 0) return { status: "manual", detail: "네임스페이스 정보 없음" }

  const psaKeys = [
    "pod-security.kubernetes.io/enforce",
    "pod-security.kubernetes.io/audit",
    "pod-security.kubernetes.io/warn",
  ]
  const labeled = considered.filter((n) => psaKeys.some((k) => k in n.labels))
  const ratio = labeled.length / considered.length
  if (ratio === 1) {
    return { status: "pass", detail: `대상 네임스페이스 ${considered.length}건 모두 PSA 라벨 적용` }
  }
  if (ratio >= 0.5) {
    return { status: "warn", detail: `PSA 라벨 적용 ${labeled.length}/${considered.length}건` }
  }
  return { status: "fail", detail: `PSA 라벨 적용 ${labeled.length}/${considered.length}건` }
}

async function checkNet01(): Promise<{ status: KisaStatus; detail: string }> {
  const { getNetworkPolicies } = await import("./k8s-client")
  const policies = await getNetworkPolicies()

  const hasDefaultDeny = (ns: string) =>
    policies.some((p) => p.namespace === ns && p.policyTypes.includes("Ingress") && p.podSelectorEmpty)
  const covered = KISA_NET01_NAMESPACES.filter(hasDefaultDeny)

  if (covered.length === KISA_NET01_NAMESPACES.length) {
    return { status: "pass", detail: `대상 네임스페이스 ${KISA_NET01_NAMESPACES.length}건 모두 default-deny 적용` }
  }
  if (covered.length > 0) {
    return { status: "warn", detail: `default-deny 적용 ${covered.length}/${KISA_NET01_NAMESPACES.length}건` }
  }
  return { status: "fail", detail: "대상 네임스페이스에 ingress default-deny NetworkPolicy 없음" }
}

async function checkRbac(id: "KISA-RBAC-01" | "KISA-RBAC-02"): Promise<{ status: KisaStatus; detail: string }> {
  const { getRbacBindings, getClusterRoles, getRoles } = await import("./k8s-client")
  const [bindings, clusterRoles, roles] = await Promise.all([
    getRbacBindings(),
    getClusterRoles(),
    getRoles(),
  ])

  // Build a quick risk counter matching the governance/rbac route logic
  const clusterRolesMap = new Map(clusterRoles.map((r) => [r.name, r]))
  const rolesMap = new Map<string, Map<string, typeof roles[0]>>()
  for (const r of roles) {
    if (!rolesMap.has(r.namespace)) rolesMap.set(r.namespace, new Map())
    rolesMap.get(r.namespace)!.set(r.name, r)
  }

  const writeVerbs = new Set(["create", "update", "patch", "delete", "deletecollection"])
  const escalationTokens = new Set(["bind", "escalate", "impersonate"])

  function classify(b: (typeof bindings)[number]) {
    let matchedRole: { rules?: unknown[] } | undefined
    if (b.roleRef.kind === "ClusterRole") {
      matchedRole = clusterRolesMap.get(b.roleRef.name)
    } else if (b.roleRef.kind === "Role" && b.namespace) {
      matchedRole = rolesMap.get(b.namespace)?.get(b.roleRef.name)
    }

    const rules = matchedRole?.rules ?? []
    let wildcardVerbs = false
    let wildcardResources = false
    let escalation = false
    let writeAccess = false
    let secretsAccess = false

    for (const r of rules as Array<{ verbs?: string[]; resources?: string[] }>) {
      const verbs = r.verbs ?? []
      const resources = r.resources ?? []
      if (verbs.includes("*")) wildcardVerbs = true
      if (resources.includes("*")) wildcardResources = true
      if (resources.includes("secrets")) secretsAccess = true
      if (verbs.some((v) => writeVerbs.has(v.toLowerCase()))) writeAccess = true
      if (
        verbs.some((v) => escalationTokens.has(v.toLowerCase())) ||
        resources.some((res) => escalationTokens.has(res.toLowerCase()))
      ) {
        escalation = true
      }
    }

    return { wildcardVerbs, wildcardResources, escalation, writeAccess, secretsAccess }
  }

  // Unavoidable K8s builtins (cluster-admin's own binding, system:*/kubeadm:* bindings, and
  // bindings whose only subjects are system:masters/system:* groups) are never actionable —
  // exclude them from both verdicts.
  const nonBuiltin = bindings.filter((b) => !isUnavoidableRbacBuiltin(b))

  if (id === "KISA-RBAC-01") {
    const clusterAdminBindings = nonBuiltin.filter((b) => b.roleRef.name === "cluster-admin")
    if (clusterAdminBindings.length > 0) {
      return {
        status: "fail",
        detail: `불필요한 cluster-admin 바인딩 ${clusterAdminBindings.length}건 (${clusterAdminBindings.map((b) => b.name).join(", ")})`,
      }
    }
    return { status: "pass", detail: "built-in 외 cluster-admin 바인딩 없음" }
  }

  // KISA-RBAC-02: risky bindings among the remaining non-builtin, non-cluster-admin bindings.
  const remaining = nonBuiltin.filter((b) => b.roleRef.name !== "cluster-admin")
  let criticalCount = 0
  let highCount = 0
  for (const b of remaining) {
    const { wildcardVerbs, wildcardResources, escalation, writeAccess, secretsAccess } = classify(b)
    if ((wildcardVerbs && wildcardResources) || escalation) {
      criticalCount++
    } else if (b.scope === "cluster" && (writeAccess || secretsAccess || wildcardVerbs || wildcardResources)) {
      highCount++
    }
  }

  if (criticalCount > 0) {
    return { status: "fail", detail: `위험 바인딩 Critical ${criticalCount}건` }
  }
  if (highCount > 0) {
    return { status: "warn", detail: `위험 바인딩 High ${highCount}건` }
  }
  return { status: "pass", detail: "위험 바인딩 없음" }
}

// --- Main export ---

export async function getKisaControls(): Promise<KisaResponse> {
  const cacheKey = "compliance:kisa:list"
  const cached = await cacheGet<KisaResponse>(cacheKey)
  if (cached) return cached

  const controls: KisaControl[] = []

  for (const entry of KISA_CATALOG) {
    if (!LIVE_IDS.has(entry.id)) {
      controls.push({
        ...entry,
        status: STATIC_STATUS[entry.id] ?? "manual",
        live: false,
      })
      continue
    }

    // Live checks — each wrapped in its own try/catch
    let status: KisaStatus = "manual"
    let detail: string | undefined

    try {
      if (entry.id === "KISA-CP-01") {
        const r = await checkCp01()
        status = r.status
        detail = r.detail
      } else if (entry.id === "KISA-ETCD-01") {
        const r = await checkEtcd01()
        status = r.status
        detail = r.detail
      } else if (entry.id === "KISA-POD-01") {
        const r = await checkPod01()
        status = r.status
        detail = r.detail
      } else if (entry.id === "KISA-NET-01") {
        const r = await checkNet01()
        status = r.status
        detail = r.detail
      } else if (entry.id === "KISA-IMG-03") {
        const r = await checkImg03()
        status = r.status
        detail = r.detail
      } else if (entry.id === "KISA-CFG-01") {
        const r = await checkCfg01()
        status = r.status
        detail = r.detail
      } else if (entry.id === "KISA-TLS-02") {
        const r = await checkTls02()
        status = r.status
        detail = r.detail
      } else if (entry.id === "KISA-ADM-01") {
        const r = await checkAdm01()
        status = r.status
        detail = r.detail
      } else if (entry.id === "KISA-RBAC-01" || entry.id === "KISA-RBAC-02") {
        const r = await checkRbac(entry.id)
        status = r.status
        detail = r.detail
      }
    } catch (err) {
      console.warn(`[kisa] Live check ${entry.id} failed (non-fatal):`, err instanceof Error ? err.message : err)
      status = "manual"
      detail = undefined
    }

    controls.push({
      ...entry,
      status,
      live: status !== "manual",
      detail,
    })
  }

  const summary = {
    total: controls.length,
    pass: controls.filter((c) => c.status === "pass").length,
    fail: controls.filter((c) => c.status === "fail").length,
    warn: controls.filter((c) => c.status === "warn").length,
    manual: controls.filter((c) => c.status === "manual").length,
    lastUpdated: new Date().toISOString(),
  }

  const result: KisaResponse = { controls, summary }
  await cacheSet(cacheKey, result, 60)
  return result
}
