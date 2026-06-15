// TODO(wrap-up): i18n keys for ko/en — see spec §5.7
import yaml from "js-yaml"
import { K8S_API_SERVER } from "./config"
import { cacheGet, cacheSet } from "./valkey"
import { getArgoApps, getArgoApp } from "./argocd"
const K8S_TOKEN = process.env.K8S_SA_TOKEN ?? ""
const USE_BEARER = K8S_API_SERVER.startsWith("https://") && K8S_TOKEN.length > 0

const SCORECARD_CM_NAME = process.env.SCORECARD_CONFIGMAP_NAME ?? "narwhal-scorecard-rules"
const SCORECARD_CM_NS = process.env.SCORECARD_CONFIGMAP_NAMESPACE ?? "devtools"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScoreTier = "gold" | "silver" | "bronze" | "none"

export interface ScorecardRule {
  id: string
  name: string
  weight: number
  check: ScorecardCheck
}

export type ScorecardCheck =
  | { type: "annotation"; key: string; present: boolean }
  | { type: "k8s-resource"; kind: string; minCount: number; scope?: string }
  | { type: "pod-spec"; jsonPath: string; required: boolean }
  | { type: "image-source"; allowedPrefixes: string[] }
  | { type: "argocd-status"; requireSynced: boolean; requireHealthy: boolean }
  | { type: "argocd-history"; maxDaysSinceLastSync: number }

export interface ScorecardRulesDoc {
  version: number
  rules: ScorecardRule[]
  tiers: { gold: number; silver: number; bronze: number }
}

export interface ScorecardEvaluation {
  serviceId: string
  score: number
  tier: ScoreTier
  passed: { ruleId: string; weight: number }[]
  failed: { ruleId: string; weight: number; reason: string }[]
  evaluatedAt: string
}

// ---------------------------------------------------------------------------
// ConfigMap loading
// ---------------------------------------------------------------------------

interface RawConfigMap {
  metadata: { name: string; namespace: string }
  data?: Record<string, string>
}

async function k8sGet<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (USE_BEARER) headers.Authorization = `Bearer ${K8S_TOKEN}`
  const res = await fetch(`${K8S_API_SERVER}${path}`, { headers })
  if (res.status === 404) {
    const err = new Error(`K8s 404: ${path}`)
    ;(err as NodeJS.ErrnoException).code = "NOT_FOUND"
    throw err
  }
  if (!res.ok) throw new Error(`K8s API ${res.status}: ${path}`)
  return res.json() as Promise<T>
}

const FALLBACK_RULES: ScorecardRulesDoc = {
  version: 0,
  rules: [],
  tiers: { gold: 90, silver: 70, bronze: 50 },
}

export async function loadRules(): Promise<ScorecardRulesDoc> {
  const cacheKey = "scorecard:rules"
  const cached = await cacheGet<ScorecardRulesDoc>(cacheKey)
  if (cached) return cached

  const cm = await k8sGet<RawConfigMap>(
    `/api/v1/namespaces/${SCORECARD_CM_NS}/configmaps/${SCORECARD_CM_NAME}`,
  )
  const rawYaml = cm.data?.["rules.yaml"]
  if (!rawYaml) throw new Error("ConfigMap missing rules.yaml key")

  const doc = yaml.load(rawYaml) as ScorecardRulesDoc
  await cacheSet(cacheKey, doc, 300) // 5 min
  return doc
}

export async function getRulesRaw(): Promise<{ raw: string; loadedAt: string }> {
  const cm = await k8sGet<RawConfigMap>(
    `/api/v1/namespaces/${SCORECARD_CM_NS}/configmaps/${SCORECARD_CM_NAME}`,
  )
  return {
    raw: cm.data?.["rules.yaml"] ?? "",
    loadedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// K8s resource helpers for check evaluation
// ---------------------------------------------------------------------------

interface K8sResourceList {
  items: Array<{ metadata: { name: string; namespace?: string } }>
}

interface K8sPodList {
  items: Array<{
    metadata: { name: string }
    spec: {
      containers: Array<{
        name: string
        image: string
        livenessProbe?: unknown
        readinessProbe?: unknown
        resources?: {
          limits?: { memory?: string; cpu?: string }
          requests?: { memory?: string; cpu?: string }
        }
      }>
    }
  }>
}

async function listK8sResources(namespace: string, kind: string): Promise<number> {
  try {
    const kindMap: Record<string, string> = {
      PodDisruptionBudget: `/apis/policy/v1/namespaces/${namespace}/poddisruptionbudgets`,
      NetworkPolicy: `/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies`,
      HorizontalPodAutoscaler: `/apis/autoscaling/v2/namespaces/${namespace}/horizontalpodautoscalers`,
    }
    const path = kindMap[kind]
    if (!path) return 0
    const list = await k8sGet<K8sResourceList>(path)
    return list.items?.length ?? 0
  } catch {
    return 0
  }
}

async function getPodsForService(namespace: string, appName: string): Promise<K8sPodList["items"]> {
  try {
    const list = await k8sGet<K8sPodList>(
      `/api/v1/namespaces/${namespace}/pods?labelSelector=app.kubernetes.io%2Finstance%3D${encodeURIComponent(appName)}`,
    )
    if (list.items?.length > 0) return list.items
    // fallback: app.kubernetes.io/name
    const list2 = await k8sGet<K8sPodList>(
      `/api/v1/namespaces/${namespace}/pods?labelSelector=app.kubernetes.io%2Fname%3D${encodeURIComponent(appName)}`,
    )
    return list2.items ?? []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Check evaluators
// ---------------------------------------------------------------------------

interface CheckResult {
  pass: boolean
  reason: string
}

function evalAnnotation(
  check: Extract<ScorecardCheck, { type: "annotation" }>,
  annotations: Record<string, string>,
): CheckResult {
  const val = annotations[check.key]
  const pass = check.present ? !!val && val.trim() !== "" : !val || val.trim() === ""
  return {
    pass,
    reason: pass
      ? ""
      : check.present
        ? `Annotation '${check.key}' is missing or empty`
        : `Annotation '${check.key}' should not be present`,
  }
}

async function evalK8sResource(
  check: Extract<ScorecardCheck, { type: "k8s-resource" }>,
  namespace: string,
): Promise<CheckResult> {
  const count = await listK8sResources(namespace, check.kind)
  const pass = count >= check.minCount
  return {
    pass,
    reason: pass ? "" : `Found ${count} ${check.kind}(s), need at least ${check.minCount}`,
  }
}

async function evalPodSpec(
  check: Extract<ScorecardCheck, { type: "pod-spec" }>,
  namespace: string,
  appName: string,
): Promise<CheckResult> {
  const pods = await getPodsForService(namespace, appName)
  if (pods.length === 0) {
    return { pass: false, reason: "No pods found for service" }
  }

  // Support specific jsonPath patterns we need
  const allContainers = pods.flatMap((p) => p.spec.containers ?? [])
  if (allContainers.length === 0) {
    return { pass: false, reason: "No containers found" }
  }

  let pass = false
  if (check.jsonPath.includes("livenessProbe")) {
    pass = allContainers.every((c) => c.livenessProbe != null)
  } else if (check.jsonPath.includes("resources.limits.memory")) {
    pass = allContainers.every((c) => c.resources?.limits?.memory != null)
  } else if (check.jsonPath.includes("resources.limits.cpu")) {
    pass = allContainers.every((c) => c.resources?.limits?.cpu != null)
  } else if (check.jsonPath.includes("readinessProbe")) {
    pass = allContainers.every((c) => c.readinessProbe != null)
  } else {
    // Generic: if we can't interpret, treat as not applicable
    pass = false
  }

  if (check.required && !pass) {
    return { pass: false, reason: `pod-spec check '${check.jsonPath}' not satisfied for all containers` }
  }
  return { pass: check.required ? pass : true, reason: "" }
}

function evalImageSource(
  check: Extract<ScorecardCheck, { type: "image-source" }>,
  pods: K8sPodList["items"],
): CheckResult {
  if (pods.length === 0) {
    return { pass: false, reason: "No pods found — cannot verify image source" }
  }
  const allContainers = pods.flatMap((p) => p.spec.containers ?? [])
  const badImages = allContainers
    .map((c) => c.image)
    .filter((img) => !check.allowedPrefixes.some((prefix) => img.startsWith(prefix)))
  if (badImages.length > 0) {
    return {
      pass: false,
      reason: `Non-trusted images: ${badImages.slice(0, 3).join(", ")}`,
    }
  }
  return { pass: true, reason: "" }
}

function evalArgoCDStatus(
  check: Extract<ScorecardCheck, { type: "argocd-status" }>,
  syncStatus: string,
  healthStatus: string,
): CheckResult {
  const syncOk = !check.requireSynced || syncStatus === "Synced"
  const healthOk = !check.requireHealthy || healthStatus === "Healthy"
  const pass = syncOk && healthOk
  const reasons: string[] = []
  if (!syncOk) reasons.push(`sync=${syncStatus}`)
  if (!healthOk) reasons.push(`health=${healthStatus}`)
  return { pass, reason: pass ? "" : `ArgoCD not ready: ${reasons.join(", ")}` }
}

function evalArgoCDHistory(
  check: Extract<ScorecardCheck, { type: "argocd-history" }>,
  history: Array<{ deployedAt: string }>,
): CheckResult {
  if (!history || history.length === 0) {
    return { pass: false, reason: "No deployment history found" }
  }
  const lastDeploy = history[history.length - 1]
  const daysSince =
    (Date.now() - new Date(lastDeploy.deployedAt).getTime()) / (1000 * 60 * 60 * 24)
  const pass = daysSince <= check.maxDaysSinceLastSync
  return {
    pass,
    reason: pass
      ? ""
      : `Last deploy was ${Math.floor(daysSince)} days ago (max ${check.maxDaysSinceLastSync})`,
  }
}

// ---------------------------------------------------------------------------
// Main evaluator
// ---------------------------------------------------------------------------

export async function evaluateService(serviceId: string): Promise<ScorecardEvaluation> {
  const cacheKey = `scorecard:detail:${serviceId}`
  const cached = await cacheGet<ScorecardEvaluation>(cacheKey)
  if (cached) return cached

  const [rules, app] = await Promise.all([loadRules(), getArgoApp(serviceId)])
  if (!app) throw new Error(`ArgoCD application not found: ${serviceId}`)

  const namespace = app.spec.destination?.namespace ?? "default"
  const annotations = app.metadata.annotations ?? {}
  const syncStatus = app.status.sync.status
  const healthStatus = app.status.health.status
  const history = app.status.history ?? []

  // Pre-fetch pods once for image-source + pod-spec checks
  const pods = await getPodsForService(namespace, serviceId)

  const passed: ScorecardEvaluation["passed"] = []
  const failed: ScorecardEvaluation["failed"] = []

  for (const rule of rules.rules) {
    let result: CheckResult
    const check = rule.check

    switch (check.type) {
      case "annotation":
        result = evalAnnotation(check, annotations)
        break
      case "k8s-resource":
        result = await evalK8sResource(check, namespace)
        break
      case "pod-spec":
        result = await evalPodSpec(check, namespace, serviceId)
        break
      case "image-source":
        result = evalImageSource(check, pods)
        break
      case "argocd-status":
        result = evalArgoCDStatus(check, syncStatus, healthStatus)
        break
      case "argocd-history":
        result = evalArgoCDHistory(check, history)
        break
      default:
        result = { pass: false, reason: "Unknown check type" }
    }

    if (result.pass) {
      passed.push({ ruleId: rule.id, weight: rule.weight })
    } else {
      failed.push({ ruleId: rule.id, weight: rule.weight, reason: result.reason })
    }
  }

  const score = passed.reduce((sum, r) => sum + r.weight, 0)
  const tiers = rules.tiers
  let tier: ScoreTier
  if (score >= tiers.gold) tier = "gold"
  else if (score >= tiers.silver) tier = "silver"
  else if (score >= tiers.bronze) tier = "bronze"
  else tier = "none"

  const evaluation: ScorecardEvaluation = {
    serviceId,
    score,
    tier,
    passed,
    failed,
    evaluatedAt: new Date().toISOString(),
  }

  await cacheSet(cacheKey, evaluation, 300) // 5 min
  return evaluation
}

export async function evaluateAll(
  ownerFilter?: string,
  tierFilter?: string,
): Promise<ScorecardEvaluation[]> {
  const cacheKey = `scorecard:all:${ownerFilter ?? ""}:${tierFilter ?? ""}`
  const cached = await cacheGet<ScorecardEvaluation[]>(cacheKey)
  if (cached) return cached

  const apps = await getArgoApps()
  const results = await Promise.allSettled(
    apps.map((app) => evaluateService(app.metadata.name)),
  )

  let evals = results
    .filter((r): r is PromiseFulfilledResult<ScorecardEvaluation> => r.status === "fulfilled")
    .map((r) => r.value)

  if (tierFilter && tierFilter !== "all") {
    evals = evals.filter((e) => e.tier === tierFilter)
  }

  await cacheSet(cacheKey, evals, 60) // 1 min
  return evals
}
