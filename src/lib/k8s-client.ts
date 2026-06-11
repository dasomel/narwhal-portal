import { cacheGet, cacheSet } from "./valkey"
import { K8S_RECOMMENDED_KERNEL_PARAMS } from "./kernel-params"
import { assertK8sName, assertK8sNamespace, assertK8sNodeName, safeK8sSegment } from "./validation"
import { K8S_API_SERVER } from "./config"

export type { Localized, MaybeLocalized } from "./i18n-utils"
export { pick } from "./i18n-utils"

import type { MaybeLocalized } from "./i18n-utils"
import type { Locale } from "./i18n"

const K8S_TOKEN = process.env.K8S_SA_TOKEN ?? ""
// kubectl proxy (http://) authenticates via the local kubectl config → no Bearer needed.
const USE_BEARER = K8S_API_SERVER.startsWith("https://") && K8S_TOKEN.length > 0

async function k8sFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (USE_BEARER) headers.Authorization = `Bearer ${K8S_TOKEN}`
  const res = await fetch(`${K8S_API_SERVER}${path}`, { ...init, headers })
  if (!res.ok) throw new Error(`K8s API ${res.status}: ${path}`)
  return res.json() as Promise<T>
}

// --- Live cluster config fetchers ---

interface RawConfigMap {
  metadata: { name: string; namespace: string }
  data?: Record<string, string>
}

async function getConfigMap(namespace: string, name: string): Promise<RawConfigMap | null> {
  try {
    assertK8sNamespace(namespace)
    assertK8sName(name, "configmap")
    return await k8sFetch<RawConfigMap>(
      `/api/v1/namespaces/${safeK8sSegment(namespace)}/configmaps/${safeK8sSegment(name)}`,
    )
  } catch {
    return null
  }
}

interface RawDaemonSet {
  spec: { template: { spec: { containers: Array<{ name: string; image: string }> } } }
}

async function getCiliumVersionFromDaemonSet(): Promise<string | null> {
  try {
    const ds = await k8sFetch<RawDaemonSet>("/apis/apps/v1/namespaces/kube-system/daemonsets/cilium")
    const agent = ds.spec.template.spec.containers.find((c) => c.name === "cilium-agent")
    if (!agent) return null
    // image format: "quay.io/cilium/cilium:v1.19.0@sha256:..." or "quay.io/cilium/cilium:v1.19.0"
    const tag = agent.image.split(":")[1]?.split("@")[0]
    return tag ?? null
  } catch {
    return null
  }
}

/** Pulls real Cilium config from the cluster; returns null if unreachable. */
export async function getLiveCniPlugin(): Promise<CniPluginInfo | null> {
  const cached = await cacheGet<CniPluginInfo>("k8s:cni-plugin")
  if (cached) return cached

  const [cm, version] = await Promise.all([
    getConfigMap("kube-system", "cilium-config"),
    getCiliumVersionFromDaemonSet(),
  ])
  if (!cm?.data) return null

  const d = cm.data
  const kpr = d["kube-proxy-replacement"]
  const info: CniPluginInfo = {
    name: "cilium",
    version: version ?? "unknown",
    mode: d["routing-mode"] ?? d["tunnel-protocol"] ?? (d["enable-bpf-masquerade"] === "true" ? "ebpf" : "native"),
    // Cilium 1.14+ uses string "true" / "partial" / "false"; pre-1.14 used "strict" / "probe" / "partial"
    kubeProxyReplacement: kpr === "true" || kpr === "strict" || kpr === "partial",
    hubbleEnabled: d["enable-hubble"] === "true",
    encryptionMode:
      d["enable-wireguard"] === "true" ? "wireguard" :
      d["enable-ipsec"] === "true" ? "ipsec" : "none",
    ipamMode: d["ipam"] ?? d["ipam-mode"] ?? "kubernetes",
    description: { ko: "eBPF 기반 CNI + kube-proxy 대체 (live from cilium-config)", en: "eBPF CNI + kube-proxy replacement (live from cilium-config)" },
    configHint: {
      location: "ConfigMap cilium-config (kube-system)",
      command: "kubectl -n kube-system edit cm cilium-config && kubectl -n kube-system rollout restart ds/cilium",
      autoApply: "kubectl",
    },
  }
  await cacheSet("k8s:cni-plugin", info, 60)
  return info
}

/** Fetches kubelet /configz and flattens relevant keys to KubeletConfigInfo. */
export async function getLiveKubeletConfig(nodeName: string): Promise<KubeletConfigInfo[] | null> {
  const cached = await cacheGet<KubeletConfigInfo[]>(`k8s:kubelet-config:${nodeName}`)
  if (cached) return cached

  try {
    assertK8sNodeName(nodeName)
    const res = await k8sFetch<{ kubeletconfig: Record<string, unknown> }>(
      `/api/v1/nodes/${safeK8sSegment(nodeName)}/proxy/configz`,
    )
    const kc = res.kubeletconfig ?? {}
    const hint = (loc = "/var/lib/kubelet/config.yaml"): ConfigHint => ({
      location: loc,
      command: "kubectl edit kubeletconfigurations.node.k8s.io (via dynamic kubelet) OR sudo vi /var/lib/kubelet/config.yaml && systemctl restart kubelet",
      autoApply: "node-ssh",
    })
    const pick = (key: string, value: unknown, description: MaybeLocalized, impact: MaybeLocalized): KubeletConfigInfo => ({
      key,
      currentValue: String(value ?? "-"),
      recommendedValue: String(value ?? "-"),
      source: "kubelet-config",
      description,
      impact,
      configHint: hint(),
    })
    const out: KubeletConfigInfo[] = []
    if ("maxPods" in kc) out.push(pick("maxPods", kc.maxPods, { ko: "노드당 최대 Pod 수", en: "Max Pods per node" }, { ko: "Pod density 한계 및 스케줄링 여유", en: "Pod density cap and scheduling headroom" }))
    if ("cgroupDriver" in kc) out.push(pick("cgroupDriver", kc.cgroupDriver, { ko: "cgroup 드라이버", en: "cgroup driver" }, { ko: "kubelet/런타임 드라이버 일치 필수", en: "Must match kubelet and container runtime cgroup driver" }))
    if ("serializeImagePulls" in kc) out.push(pick("serializeImagePulls", kc.serializeImagePulls, { ko: "이미지 병렬 Pull 허용", en: "Parallel image pulls" }, { ko: "동시 다운로드로 파드 시작 속도 향상", en: "Concurrent downloads speed up pod startup" }))
    if (kc.evictionHard && typeof kc.evictionHard === "object") {
      const ev = kc.evictionHard as Record<string, string>
      if (ev["memory.available"]) out.push(pick("evictionHard.memory.available", ev["memory.available"], { ko: "메모리 부족 퇴거 임계값", en: "Memory eviction threshold" }, { ko: "OOM Kill 전 조기 퇴거", en: "Early eviction before OOM Kill" }))
      if (ev["nodefs.available"]) out.push(pick("evictionHard.nodefs.available", ev["nodefs.available"], { ko: "노드 파일시스템 여유 공간 퇴거 임계값", en: "Node filesystem eviction threshold" }, { ko: "디스크 고갈 전 파드 퇴거", en: "Evict pods before disk exhaustion" }))
    }
    if (kc.systemReserved && typeof kc.systemReserved === "object") {
      const sr = kc.systemReserved as Record<string, string>
      if (sr.cpu) out.push(pick("systemReserved.cpu", sr.cpu, { ko: "OS 시스템 프로세스용 예약 CPU", en: "Reserved CPU for OS system processes" }, { ko: "시스템 프로세스 CPU 기아 방지", en: "Prevent CPU starvation for system processes" }))
      if (sr.memory) out.push(pick("systemReserved.memory", sr.memory, { ko: "OS 시스템 프로세스용 예약 메모리", en: "Reserved memory for OS system processes" }, { ko: "시스템 OOM 방지", en: "Prevent system OOM" }))
    }
    if (kc.kubeReserved && typeof kc.kubeReserved === "object") {
      const kr = kc.kubeReserved as Record<string, string>
      if (kr.cpu) out.push(pick("kubeReserved.cpu", kr.cpu, { ko: "K8s 컴포넌트용 예약 CPU", en: "Reserved CPU for K8s components" }, { ko: "kubelet CPU 보장", en: "Guaranteed CPU for kubelet" }))
      if (kr.memory) out.push(pick("kubeReserved.memory", kr.memory, { ko: "K8s 컴포넌트용 예약 메모리", en: "Reserved memory for K8s components" }, { ko: "kubelet OOM 방지", en: "Prevent kubelet OOM" }))
    }
    if ("imageMinimumGCAge" in kc) out.push(pick("imageMinimumGCAge", kc.imageMinimumGCAge, { ko: "미사용 이미지 GC 최소 경과 시간", en: "Minimum age before unused image GC" }, { ko: "불필요한 이미지 즉시 삭제 방지", en: "Prevent immediate deletion of unused images" }))
    if ("registryPullQPS" in kc) out.push(pick("registryPullQPS", kc.registryPullQPS, { ko: "이미지 레지스트리 Pull QPS 한도", en: "Image registry pull QPS limit" }, { ko: "레지스트리 레이트리밋 초과 방지", en: "Prevent registry rate limit violations" }))

    if (out.length === 0) return null
    await cacheSet(`k8s:kubelet-config:${nodeName}`, out, 60)
    return out
  } catch {
    return null
  }
}

// --- Namespace operations ---

export interface NamespaceInfo {
  name: string
  status: string
  labels: Record<string, string>
  createdAt: string
}

export async function getNamespaces(): Promise<NamespaceInfo[]> {
  const cached = await cacheGet<NamespaceInfo[]>("k8s:namespaces")
  if (cached) return cached
  try {
    const data = await k8sFetch<{ items: Array<{ metadata: { name: string; labels?: Record<string, string>; creationTimestamp: string }; status: { phase: string } }> }>("/api/v1/namespaces")
    const ns = data.items.map((i) => ({
      name: i.metadata.name,
      status: i.status.phase,
      labels: i.metadata.labels ?? {},
      createdAt: i.metadata.creationTimestamp,
    }))
    await cacheSet("k8s:namespaces", ns, 30)
    return ns
  } catch (err) {
    console.warn("[k8s] Namespaces fetch failed:", (err as Error).message)
    return []
  }
}

export async function createNamespace(name: string, labels: Record<string, string> = {}): Promise<boolean> {
  try {
    assertK8sNamespace(name)
    await k8sFetch("/api/v1/namespaces", {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name, labels: { ...labels, "managed-by": "idp-portal" } },
      }),
    })
    return true
  } catch {
    return false
  }
}

// --- RBAC operations ---

export interface RbacBinding {
  name: string
  namespace: string | null
  scope: "cluster" | "namespace"
  roleRef: { kind: string; name: string }
  subjects: Array<{ kind: string; name: string; namespace?: string }>
}

export async function getRbacBindings(): Promise<RbacBinding[]> {
  const cached = await cacheGet<RbacBinding[]>("k8s:rbac")
  if (cached) return cached
  try {
    const [cluster, namespaced] = await Promise.allSettled([
      k8sFetch<{ items: Array<{ metadata: { name: string }; roleRef: { kind: string; name: string }; subjects?: Array<{ kind: string; name: string; namespace?: string }> }> }>("/apis/rbac.authorization.k8s.io/v1/clusterrolebindings"),
      k8sFetch<{ items: Array<{ metadata: { name: string; namespace: string }; roleRef: { kind: string; name: string }; subjects?: Array<{ kind: string; name: string; namespace?: string }> }> }>("/apis/rbac.authorization.k8s.io/v1/rolebindings"),
    ])
    const bindings: RbacBinding[] = []
    if (cluster.status === "fulfilled") {
      for (const i of cluster.value.items) {
        bindings.push({ name: i.metadata.name, namespace: null, scope: "cluster", roleRef: i.roleRef, subjects: i.subjects ?? [] })
      }
    }
    if (namespaced.status === "fulfilled") {
      for (const i of namespaced.value.items) {
        bindings.push({ name: i.metadata.name, namespace: i.metadata.namespace, scope: "namespace", roleRef: i.roleRef, subjects: i.subjects ?? [] })
      }
    }
    await cacheSet("k8s:rbac", bindings, 30)
    return bindings
  } catch (err) {
    console.warn("[k8s] RBAC fetch failed:", (err as Error).message)
    return []
  }
}

// --- Resource usage ---

export interface NamespaceResourceUsage {
  namespace: string
  cpuRequests: string
  cpuLimits: string
  memoryRequests: string
  memoryLimits: string
  podCount: number
}

// --- Cert renewal ---

export async function renewCertificate(name: string, namespace: string): Promise<boolean> {
  try {
    assertK8sNamespace(namespace)
    assertK8sName(name, "certificate")
    await k8sFetch(
      `/apis/cert-manager.io/v1/namespaces/${safeK8sSegment(namespace)}/certificates/${safeK8sSegment(name)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/merge-patch+json" },
        body: JSON.stringify({
          spec: { renewBefore: "1s" },
        }),
      },
    )
    return true
  } catch {
    return false
  }
}

// --- Events ---

export interface K8sEvent {
  type: string
  reason: string
  message: string
  namespace: string
  involvedObject: { kind: string; name: string; namespace?: string }
  lastTimestamp: string | null
  firstTimestamp: string | null
  count?: number
  reportingComponent?: string
  source?: { component?: string; host?: string }
}

export async function getEvents(namespace?: string): Promise<K8sEvent[]> {
  if (namespace !== undefined) assertK8sNamespace(namespace)
  const path = namespace
    ? `/api/v1/namespaces/${safeK8sSegment(namespace)}/events`
    : "/api/v1/events?limit=100"
  const cacheKey = `k8s:events:${namespace ?? "all"}`
  const cached = await cacheGet<K8sEvent[]>(cacheKey)
  if (cached) return cached
  try {
    const data = await k8sFetch<{ items: Array<{ type: string; reason: string; message: string; metadata: { namespace: string }; involvedObject: { kind: string; name: string }; lastTimestamp: string | null; firstTimestamp: string | null }> }>(path)
    const events = data.items.map((i) => ({
      type: i.type,
      reason: i.reason,
      message: i.message,
      namespace: i.metadata.namespace,
      involvedObject: i.involvedObject,
      lastTimestamp: i.lastTimestamp,
      firstTimestamp: i.firstTimestamp,
    }))
    await cacheSet(cacheKey, events, 15)
    return events
  } catch {
    return []
  }
}

export interface Certificate {
  name: string
  namespace: string
  ready: boolean
  notAfter: string | null
  notBefore: string | null
  dnsNames: string[]
  issuer: string
  renewalTime: string | null
}

interface CertificateList {
  items: Array<{
    metadata: { name: string; namespace: string }
    spec: {
      dnsNames?: string[]
      issuerRef?: { name: string; kind: string }
    }
    status?: {
      conditions?: Array<{ type: string; status: string }>
      notAfter?: string
      notBefore?: string
      renewalTime?: string
    }
  }>
}

export async function getCertificates(): Promise<Certificate[]> {
  const cached = await cacheGet<Certificate[]>("k8s:certs")
  if (cached) return cached

  try {
    const data = await k8sFetch<CertificateList>("/apis/cert-manager.io/v1/certificates")
    const certs = data.items.map((item) => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      ready: item.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false,
      notAfter: item.status?.notAfter ?? null,
      notBefore: item.status?.notBefore ?? null,
      dnsNames: item.spec.dnsNames ?? [],
      issuer: item.spec.issuerRef?.name ?? "unknown",
      renewalTime: item.status?.renewalTime ?? null,
    }))
    await cacheSet("k8s:certs", certs, 60)
    return certs
  } catch (err) {
    console.warn("[k8s] Certificates fetch failed:", (err as Error).message)
    return []
  }
}

export interface KyvernoPolicy {
  name: string
  namespace: string | null
  scope: "cluster" | "namespace"
  background: boolean
  validationFailureAction: string
  ready: boolean
  rulesCount: number
  rules: Array<{ name: string; type: string }>
}

interface PolicyItem {
  metadata: { name: string; namespace?: string }
  spec: {
    background?: boolean
    validationFailureAction?: string
    rules?: Array<{
      name: string
      validate?: unknown
      mutate?: unknown
      generate?: unknown
      verifyImages?: unknown
    }>
  }
  status?: {
    conditions?: Array<{ type: string; status: string }>
  }
}

interface PolicyList {
  items: PolicyItem[]
}

function mapPolicy(item: PolicyItem, scope: "cluster" | "namespace"): KyvernoPolicy {
  const rules = (item.spec.rules ?? []).map((r) => ({
    name: r.name,
    type: r.validate ? "validate" : r.mutate ? "mutate" : r.generate ? "generate" : r.verifyImages ? "verifyImages" : "unknown",
  }))
  return {
    name: item.metadata.name,
    namespace: item.metadata.namespace ?? null,
    scope,
    background: item.spec.background ?? true,
    validationFailureAction: item.spec.validationFailureAction ?? "Audit",
    ready: item.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false,
    rulesCount: rules.length,
    rules,
  }
}

export async function getKyvernoPolicies(): Promise<KyvernoPolicy[]> {
  const cached = await cacheGet<KyvernoPolicy[]>("k8s:kyverno")
  if (cached) return cached

  try {
    const [cluster, namespaced] = await Promise.allSettled([
      k8sFetch<PolicyList>("/apis/kyverno.io/v1/clusterpolicies"),
      k8sFetch<PolicyList>("/apis/kyverno.io/v1/policies"),
    ])

    const policies: KyvernoPolicy[] = [
      ...(cluster.status === "fulfilled" ? cluster.value.items.map((i) => mapPolicy(i, "cluster")) : []),
      ...(namespaced.status === "fulfilled" ? namespaced.value.items.map((i) => mapPolicy(i, "namespace")) : []),
    ]
    await cacheSet("k8s:kyverno", policies, 30)
    return policies
  } catch (err) {
    console.warn("[k8s] Kyverno policies fetch failed:", (err as Error).message)
    return []
  }
}

export interface PackageUpdate {
  name: string
  currentVersion: string
  targetVersion: string
  reason: MaybeLocalized
  cve?: string
  link?: string
  severity: "Critical" | "High" | "Medium" | "Low" | "critical" | "high" | "medium" | "low"
}

// Hint telling the operator where and how to apply a tuning change.
// autoApply values:
//   "node-ssh"  — requires direct node access (portal cannot apply automatically)
//   "kubectl"   — applyable via kubectl from the portal (future auto-apply button candidate)
//   "manual"    — requires human judgement / reboot
export interface ConfigHint {
  location: string
  command?: string
  docLink?: string
  autoApply: "node-ssh" | "kubectl" | "manual"
}

export interface K8sBinaryInfo {
  name: string
  version: string
  installedAt: string
  updateAvailable?: string
}

export interface KernelParamInfo {
  param: string
  currentValue: string
  recommendedValue: string
  description: MaybeLocalized
  group: "network" | "security" | "resource" | "filesystem"
  impact: MaybeLocalized
  configHint: ConfigHint
}

export interface KernelModuleInfo {
  name: string
  required: boolean
  loaded: boolean
  purpose: MaybeLocalized
  configHint: ConfigHint
}

export interface ResourceLimitInfo {
  name: "nofile" | "nproc" | "memlock"
  scope: "soft" | "hard"
  currentValue: string
  recommendedValue: string
  description: MaybeLocalized
  configHint: ConfigHint
}

export interface RequiredPackageInfo {
  name: string
  installed: boolean
  purpose: MaybeLocalized
  configHint: ConfigHint
}

export interface DiskTuningInfo {
  device: string
  ioScheduler: { current: string; recommended: string }
  readAheadKb: { current: number; recommended: number }
  mountOptions: string[]
  noatimeConfigured: boolean
  fsType: string
  xfsPrjquota: boolean
  description: MaybeLocalized
  configHint: ConfigHint
}

export interface LvmAutoExtendInfo {
  serviceName: string
  enabled: boolean
  description: MaybeLocalized
  configHint: ConfigHint
}

export interface NicTuningInfo {
  interface: string
  ringBufferRx: { current: number; recommended: number }
  ringBufferTx: { current: number; recommended: number }
  offloading: { tso: boolean; gso: boolean; gro: boolean }
  coalescingUsec: { rx: number; tx: number }
  description: MaybeLocalized
  configHint: ConfigHint
}

export interface RuntimeStatusInfo {
  name: "containerd" | "kubelet"
  active: boolean
  version: string
  description: MaybeLocalized
  configHint: ConfigHint
}

export interface CgroupInfo {
  version: "v1" | "v2"
  controllers: string[]
  description: MaybeLocalized
  configHint: ConfigHint
}

export interface SwapStatusInfo {
  enabled: boolean
  configuredInFstab: boolean
  totalMb: number
  description: MaybeLocalized
  configHint: ConfigHint
}

// K8s cluster-level tuning types

export interface ClusterVersionInfo {
  kubernetes: string
  clusterAge: string
  isPatchCurrent: boolean
  description: MaybeLocalized
}

export interface KubeletConfigInfo {
  key: string
  currentValue: string
  recommendedValue: string
  source: string
  description: MaybeLocalized
  impact: MaybeLocalized
  configHint: ConfigHint
}

export interface KubeProxyConfigInfo {
  key: string
  currentValue: string
  recommendedValue: string
  source: string
  description: MaybeLocalized
  impact: MaybeLocalized
  configHint: ConfigHint
}

export interface ContainerdConfigInfo {
  key: string
  currentValue: string
  recommendedValue: string
  source: string
  description: MaybeLocalized
  impact: MaybeLocalized
  configHint: ConfigHint
}

export interface CniPluginInfo {
  name: string
  version: string
  mode: string
  kubeProxyReplacement: boolean
  hubbleEnabled: boolean
  encryptionMode: string
  ipamMode: string
  description: MaybeLocalized
  configHint: ConfigHint
}

export interface ControlPlaneFlagInfo {
  component: string
  flag: string
  currentValue: string
  recommendedValue: string
  description: MaybeLocalized
  impact: MaybeLocalized
  configHint: ConfigHint
}

export interface K8sTuningInfo {
  clusterVersion: ClusterVersionInfo
  kubeletConfig: KubeletConfigInfo[]
  kubeProxyConfig: KubeProxyConfigInfo[]
  containerdConfig: ContainerdConfigInfo[]
  cniPlugin: CniPluginInfo
  controlPlaneFlags: ControlPlaneFlagInfo[]
}

export interface NodeDetail {
  name: string
  internalIP: string
  externalIP: string
  kubeletVersion: string
  kubeProxyVersion: string
  osImage: string
  operatingSystem: string
  kernelVersion: string
  architecture: string
  containerRuntime: string
  providerID: string
  machineID: string
  systemUUID: string
  createdAt: string
  conditions: Array<{
    type: string
    status: string
    message: string
    lastTransitionTime: string
  }>
  labels: Record<string, string>
  taints: Array<{ key: string; value?: string; effect: string }>
  capacity: { cpu: string; memory: string; pods: string }
  allocatable: { cpu: string; memory: string; pods: string }
  systemStatus: {
    rebootRequired: boolean
    securityUpdates: number
    standardUpdates: number
    packageUpdates: PackageUpdate[]
    k8sBinaries: K8sBinaryInfo[]
    kernelParams: KernelParamInfo[]
    kernelModules: KernelModuleInfo[]
    resourceLimits: ResourceLimitInfo[]
    requiredPackages: RequiredPackageInfo[]
    diskTuning: DiskTuningInfo[]
    lvmAutoExtend: LvmAutoExtendInfo | null
    nicTuning: NicTuningInfo[]
    runtimeStatus: RuntimeStatusInfo[]
    cgroup: CgroupInfo
    swap: SwapStatusInfo
    k8sTuning: K8sTuningInfo
  }
}


export async function getNodeDetail(name: string): Promise<NodeDetail | null> {
  try {
    assertK8sNodeName(name)
  } catch {
    return null
  }
  const cacheKey = `k8s:node:${name}`
  const cached = await cacheGet<NodeDetail>(cacheKey)
  if (cached) return cached

  // Fan out live cluster lookups alongside the node fetch.
  const [liveCni, liveKubelet] = await Promise.all([
    getLiveCniPlugin().catch(() => null),
    getLiveKubeletConfig(name).catch(() => null),
  ])

  try {
    const data = await k8sFetch<{
      metadata: {
        name: string
        labels?: Record<string, string>
        creationTimestamp: string
      }
      spec: {
        providerID?: string
        taints?: Array<{ key: string; value?: string; effect: string }>
      }
      status: {
        nodeInfo: {
          kubeletVersion: string
          kubeProxyVersion: string
          osImage: string
          operatingSystem: string
          kernelVersion: string
          architecture: string
          containerRuntimeVersion: string
          machineID: string
          systemUUID: string
        }
        conditions: Array<{
          type: string
          status: string
          message?: string
          lastTransitionTime: string
        }>
        capacity: Record<string, string>
        allocatable: Record<string, string>
        addresses: Array<{ type: string; address: string }>
      }
    }>(`/api/v1/nodes/${safeK8sSegment(name)}`)

    let internalIP = ""
    let externalIP = ""
    for (const a of data.status.addresses) {
      if (a.type === "InternalIP") internalIP = a.address
      else if (a.type === "ExternalIP") externalIP = a.address
    }

    const detail: NodeDetail = {
      name: data.metadata.name,
      internalIP,
      externalIP,
      kubeletVersion: data.status.nodeInfo.kubeletVersion,
      kubeProxyVersion: data.status.nodeInfo.kubeProxyVersion,
      osImage: data.status.nodeInfo.osImage,
      operatingSystem: data.status.nodeInfo.operatingSystem,
      kernelVersion: data.status.nodeInfo.kernelVersion,
      architecture: data.status.nodeInfo.architecture,
      containerRuntime: data.status.nodeInfo.containerRuntimeVersion,
      providerID: data.spec.providerID ?? "",
      machineID: data.status.nodeInfo.machineID,
      systemUUID: data.status.nodeInfo.systemUUID,
      createdAt: data.metadata.creationTimestamp,
      conditions: data.status.conditions.map((c) => ({
        type: c.type,
        status: c.status,
        message: c.message ?? "",
        lastTransitionTime: c.lastTransitionTime,
      })),
      labels: data.metadata.labels ?? {},
      taints: data.spec.taints ?? [],
      capacity: {
        cpu: data.status.capacity.cpu ?? "0",
        memory: data.status.capacity.memory ?? "0",
        pods: data.status.capacity.pods ?? "0",
      },
      allocatable: {
        cpu: data.status.allocatable.cpu ?? "0",
        memory: data.status.allocatable.memory ?? "0",
        pods: data.status.allocatable.pods ?? "0",
      },
      // TODO: real values require node-exec or node-exporter integration; using kube-ready-box defaults for now
      systemStatus: {
        rebootRequired: false,
        securityUpdates: 3,
        standardUpdates: 2,
        packageUpdates: [
          { name: "openssl", currentVersion: "3.0.2-0ubuntu1.14", targetVersion: "3.0.2-0ubuntu1.18", severity: "High", cve: "CVE-2024-5535", link: "https://nvd.nist.gov/vuln/detail/CVE-2024-5535", reason: { ko: "SSL_select_next_proto 버퍼 과소 읽기 취약점 — 원격 DoS 및 민감 정보 노출 가능", en: "SSL_select_next_proto buffer under-read — remote DoS and sensitive data exposure" } },
          { name: "containerd", currentVersion: "1.7.19", targetVersion: "1.7.22", severity: "High", cve: "CVE-2024-40635", link: "https://nvd.nist.gov/vuln/detail/CVE-2024-40635", reason: { ko: "runc 컨테이너 탈출 취약점 — 호스트 파일시스템 접근 가능 (GHSA-265r-hfxg-fhmg)", en: "runc container escape — host filesystem access possible (GHSA-265r-hfxg-fhmg)" } },
          { name: "curl", currentVersion: "7.81.0-1ubuntu1.16", targetVersion: "7.81.0-1ubuntu1.19", severity: "Medium", cve: "CVE-2024-2466", link: "https://nvd.nist.gov/vuln/detail/CVE-2024-2466", reason: { ko: "TLS 인증서 검증 우회 취약점 — MITM 공격에 노출 가능", en: "TLS certificate verification bypass — exposed to MITM attacks" } },
        ],
        k8sBinaries: [],
        kernelParams: K8S_RECOMMENDED_KERNEL_PARAMS,
        kernelModules: [
          { name: "overlay",      required: true, loaded: true, purpose: { ko: "컨테이너 이미지 레이어링에 필요한 OverlayFS 모듈", en: "OverlayFS module for container image layering" }, configHint: { location: "/etc/modules-load.d/k8s.conf", command: "modprobe overlay", autoApply: "node-ssh" } },
          { name: "br_netfilter", required: true, loaded: true, purpose: { ko: "K8s Pod 네트워킹을 위한 브리지 넷필터", en: "Bridge netfilter for K8s Pod networking" }, configHint: { location: "/etc/modules-load.d/k8s.conf", command: "modprobe br_netfilter", autoApply: "node-ssh" } },
        ],
        resourceLimits: [
          { name: "nofile",  scope: "soft", currentValue: "1048576",   recommendedValue: "1048576",   description: { ko: "열린 파일 디스크립터 수 soft 제한 (limits.d/k8s.conf)", en: "Open file descriptor soft limit (limits.d/k8s.conf)" }, configHint: { location: "/etc/security/limits.d/k8s.conf", autoApply: "node-ssh" } },
          { name: "nofile",  scope: "hard", currentValue: "1048576",   recommendedValue: "1048576",   description: { ko: "열린 파일 디스크립터 수 hard 제한 (limits.d/k8s.conf)", en: "Open file descriptor hard limit (limits.d/k8s.conf)" }, configHint: { location: "/etc/security/limits.d/k8s.conf", autoApply: "node-ssh" } },
          { name: "nproc",   scope: "soft", currentValue: "65535",     recommendedValue: "65535",     description: { ko: "최대 프로세스 수 soft 제한 (limits.d/k8s.conf)", en: "Max process count soft limit (limits.d/k8s.conf)" },         configHint: { location: "/etc/security/limits.d/k8s.conf", autoApply: "node-ssh" } },
          { name: "nproc",   scope: "hard", currentValue: "65535",     recommendedValue: "65535",     description: { ko: "최대 프로세스 수 hard 제한 (limits.d/k8s.conf)", en: "Max process count hard limit (limits.d/k8s.conf)" },         configHint: { location: "/etc/security/limits.d/k8s.conf", autoApply: "node-ssh" } },
          { name: "memlock", scope: "soft", currentValue: "unlimited", recommendedValue: "unlimited", description: { ko: "잠금 메모리 크기 soft 제한 (limits.d/k8s.conf)", en: "Locked memory size soft limit (limits.d/k8s.conf)" },         configHint: { location: "/etc/security/limits.d/k8s.conf", autoApply: "node-ssh" } },
          { name: "memlock", scope: "hard", currentValue: "unlimited", recommendedValue: "unlimited", description: { ko: "잠금 메모리 크기 hard 제한 (limits.d/k8s.conf)", en: "Locked memory size hard limit (limits.d/k8s.conf)" },         configHint: { location: "/etc/security/limits.d/k8s.conf", autoApply: "node-ssh" } },
        ],
        requiredPackages: [
          { name: "socat",     installed: true, purpose: { ko: "kubectl port-forward 등 K8s 네트워크 유틸", en: "K8s network util for kubectl port-forward etc." },       configHint: { location: "apt package (on node)", command: "apt-get install -y socat",     autoApply: "node-ssh" } },
          { name: "conntrack", installed: true, purpose: { ko: "kube-proxy conntrack 테이블 관리", en: "kube-proxy conntrack table management" },                configHint: { location: "apt package (on node)", command: "apt-get install -y conntrack", autoApply: "node-ssh" } },
          { name: "ipset",     installed: true, purpose: { ko: "IPVS 기반 서비스 IP 집합 관리", en: "Service IP set management for IPVS" },                  configHint: { location: "apt package (on node)", command: "apt-get install -y ipset",     autoApply: "node-ssh" } },
          { name: "ipvsadm",   installed: true, purpose: { ko: "IPVS kube-proxy 모드에 필요", en: "Required for IPVS kube-proxy mode" },                     configHint: { location: "apt package (on node)", command: "apt-get install -y ipvsadm",   autoApply: "node-ssh" } },
          { name: "ebtables",  installed: true, purpose: { ko: "브리지 레벨 패킷 필터링 (K8s 네트워크 정책)", en: "Bridge-level packet filtering (K8s network policy)" },    configHint: { location: "apt package (on node)", command: "apt-get install -y ebtables",  autoApply: "node-ssh" } },
        ],
        diskTuning: [
          {
            device: "nvme0n1",
            ioScheduler: { current: "none", recommended: "none" },
            readAheadKb: { current: 256, recommended: 256 },
            mountOptions: ["defaults", "noatime", "nodiratime"],
            noatimeConfigured: true,
            fsType: "ext4",
            xfsPrjquota: false,
            description: { ko: "SSD 최적화 I/O 스케줄러, read-ahead, noatime 마운트로 디스크 처리량 향상", en: "SSD-optimized I/O scheduler, read-ahead, and noatime mount for disk throughput" },
            configHint: { location: "/etc/fstab + /sys/block/nvme0n1/queue/{scheduler,read_ahead_kb}", command: "bash /etc/kube-ready-box/05-disk-tuning.sh", autoApply: "node-ssh" },
          },
        ],
        lvmAutoExtend: {
          serviceName: "extend-lvm.service",
          enabled: true,
          description: { ko: "부팅 시 디스크 용량 증가를 감지하여 파티션·PV·LV·파일시스템을 자동 확장", en: "Auto-extend partition, PV, LV, and filesystem on detected disk growth at boot" },
          configHint: { location: "/etc/systemd/system/extend-lvm.service", command: "systemctl enable --now extend-lvm.service", autoApply: "node-ssh" },
        },
        nicTuning: [
          {
            interface: "eth0",
            ringBufferRx: { current: 4096, recommended: 4096 },
            ringBufferTx: { current: 4096, recommended: 4096 },
            offloading: { tso: true, gso: true, gro: true },
            coalescingUsec: { rx: 50, tx: 50 },
            description: { ko: "NIC 버퍼·offloading·interrupt coalescing으로 네트워크 처리량 향상", en: "NIC buffer, offloading, and interrupt coalescing for network throughput" },
            configHint: { location: "ethtool persistent config (networkd or /etc/network/if-up.d)", command: "ethtool -G eth0 rx 4096 tx 4096", autoApply: "node-ssh" },
          },
        ],
        runtimeStatus: [
          { name: "containerd", active: true, version: "1.7.19", description: { ko: "컨테이너 런타임 / kubelet 데몬 실행 상태", en: "Container runtime / kubelet daemon running status" }, configHint: { location: "systemctl unit (containerd.service)", command: "systemctl status containerd", autoApply: "node-ssh" } },
          { name: "kubelet",    active: true, version: "v1.31.4", description: { ko: "컨테이너 런타임 / kubelet 데몬 실행 상태", en: "Container runtime / kubelet daemon running status" }, configHint: { location: "systemctl unit (kubelet.service)", command: "systemctl status kubelet", autoApply: "node-ssh" } },
        ],
        cgroup: { version: "v2", controllers: ["cpu", "memory", "io", "pids", "cpuset"], description: { ko: "리소스 격리/제한을 위한 cgroup 버전 (v2 권장: unified hierarchy)", en: "cgroup version for resource isolation/limits (v2 recommended: unified hierarchy)" }, configHint: { location: "GRUB_CMDLINE_LINUX in /etc/default/grub (systemd.unified_cgroup_hierarchy=1)", command: "update-grub && reboot", autoApply: "manual" } },
        swap: { enabled: false, configuredInFstab: false, totalMb: 0, description: { ko: "스왑 비활성화는 K8s kubelet 필수 조건 (Pod 메모리 예측성 보장)", en: "Swap disabled is a K8s kubelet requirement (Pod memory predictability)" }, configHint: { location: "/etc/fstab", command: "swapoff -a && sed -i '/swap/d' /etc/fstab", autoApply: "node-ssh" } },
        k8sTuning: {
          clusterVersion: { kubernetes: "v1.31.4", clusterAge: "180d", isPatchCurrent: true, description: { ko: "Kubernetes 릴리스 버전과 클러스터 운영 기간", en: "Kubernetes release version and cluster operational age" } },
          kubeletConfig: liveKubelet ?? [
            { key: "maxPods",                       currentValue: "110",     recommendedValue: "110",     source: "kubelet-config", description: { ko: "노드당 최대 Pod 수", en: "Max Pods per node" },                                                       impact: { ko: "Pod density 한계 및 스케줄링 여유", en: "Pod density cap and scheduling headroom" },                                    configHint: { location: "/var/lib/kubelet/config.yaml", command: "kubectl -n kube-system edit cm kubelet-config && systemctl restart kubelet", autoApply: "kubectl" } },
            { key: "cgroupDriver",                  currentValue: "systemd", recommendedValue: "systemd", source: "kubelet-config", description: { ko: "cgroup 드라이버", en: "cgroup driver" },                                                                       impact: { ko: "kubelet과 컨테이너 런타임 cgroup 드라이버 일치 필수", en: "Must match kubelet and container runtime cgroup driver" },       configHint: { location: "/var/lib/kubelet/config.yaml", command: "kubectl -n kube-system edit cm kubelet-config && systemctl restart kubelet", autoApply: "kubectl" } },
            { key: "serializeImagePulls",           currentValue: "false",   recommendedValue: "false",   source: "kubelet-config", description: { ko: "이미지 병렬 Pull 허용", en: "Parallel image pulls" },                                                          impact: { ko: "동시 이미지 다운로드로 파드 시작 속도 향상", en: "Concurrent downloads speed up pod startup" },                            configHint: { location: "/var/lib/kubelet/config.yaml", command: "kubectl -n kube-system edit cm kubelet-config && systemctl restart kubelet", autoApply: "kubectl" } },
            { key: "evictionHard.memory.available", currentValue: "200Mi",   recommendedValue: "200Mi",   source: "kubelet-config", description: { ko: "메모리 부족 시 강제 퇴거 임계값", en: "Hard memory eviction threshold" },                                       impact: { ko: "OOM Kill 전 조기 퇴거로 노드 안정성 확보", en: "Early eviction before OOM Kill for node stability" },                      configHint: { location: "/var/lib/kubelet/config.yaml", command: "kubectl -n kube-system edit cm kubelet-config && systemctl restart kubelet", autoApply: "kubectl" } },
            { key: "evictionHard.nodefs.available", currentValue: "10%",     recommendedValue: "10%",     source: "kubelet-config", description: { ko: "노드 파일시스템 여유 공간 퇴거 임계값", en: "Node filesystem eviction threshold" },                              impact: { ko: "디스크 고갈 전 파드 퇴거로 노드 보호", en: "Evict pods before disk exhaustion to protect node" },                          configHint: { location: "/var/lib/kubelet/config.yaml", command: "kubectl -n kube-system edit cm kubelet-config && systemctl restart kubelet", autoApply: "kubectl" } },
            { key: "systemReserved.cpu",            currentValue: "100m",    recommendedValue: "100m",    source: "kubelet-config", description: { ko: "OS 시스템 프로세스용 예약 CPU", en: "Reserved CPU for OS system processes" },                                    impact: { ko: "시스템 프로세스 CPU 기아 방지", en: "Prevent CPU starvation for system processes" },                                       configHint: { location: "/var/lib/kubelet/config.yaml", command: "kubectl -n kube-system edit cm kubelet-config && systemctl restart kubelet", autoApply: "kubectl" } },
            { key: "systemReserved.memory",         currentValue: "256Mi",   recommendedValue: "256Mi",   source: "kubelet-config", description: { ko: "OS 시스템 프로세스용 예약 메모리", en: "Reserved memory for OS system processes" },                               impact: { ko: "시스템 OOM 방지", en: "Prevent system OOM" },                                                                               configHint: { location: "/var/lib/kubelet/config.yaml", command: "kubectl -n kube-system edit cm kubelet-config && systemctl restart kubelet", autoApply: "kubectl" } },
            { key: "kubeReserved.cpu",              currentValue: "100m",    recommendedValue: "100m",    source: "kubelet-config", description: { ko: "K8s 컴포넌트용 예약 CPU", en: "Reserved CPU for K8s components" },                                              impact: { ko: "kubelet·kube-proxy CPU 보장", en: "Guaranteed CPU for kubelet and kube-proxy" },                                            configHint: { location: "/var/lib/kubelet/config.yaml", command: "kubectl -n kube-system edit cm kubelet-config && systemctl restart kubelet", autoApply: "kubectl" } },
            { key: "kubeReserved.memory",           currentValue: "512Mi",   recommendedValue: "512Mi",   source: "kubelet-config", description: { ko: "K8s 컴포넌트용 예약 메모리", en: "Reserved memory for K8s components" },                                         impact: { ko: "kubelet OOM 방지", en: "Prevent kubelet OOM" },                                                                             configHint: { location: "/var/lib/kubelet/config.yaml", command: "kubectl -n kube-system edit cm kubelet-config && systemctl restart kubelet", autoApply: "kubectl" } },
            { key: "imageMinimumGCAge",             currentValue: "2m0s",    recommendedValue: "2m0s",    source: "kubelet-config", description: { ko: "미사용 이미지 GC 최소 경과 시간", en: "Minimum age before unused image GC" },                                     impact: { ko: "불필요한 이미지 즉시 삭제 방지", en: "Prevent immediate deletion of unused images" },                                       configHint: { location: "/var/lib/kubelet/config.yaml", command: "kubectl -n kube-system edit cm kubelet-config && systemctl restart kubelet", autoApply: "kubectl" } },
            { key: "registryPullQPS",               currentValue: "5",       recommendedValue: "5",       source: "kubelet-config", description: { ko: "이미지 레지스트리 Pull QPS 한도", en: "Image registry pull QPS limit" },                                         impact: { ko: "레지스트리 레이트리밋 초과 방지", en: "Prevent registry rate limit violations" },                                           configHint: { location: "/var/lib/kubelet/config.yaml", command: "kubectl -n kube-system edit cm kubelet-config && systemctl restart kubelet", autoApply: "kubectl" } },
          ],
          kubeProxyConfig: [
            { key: "mode",                   currentValue: "ipvs",          recommendedValue: "ipvs",          source: "kube-proxy ConfigMap", description: { ko: "kube-proxy 동작 모드", en: "kube-proxy operating mode" },                          impact: { ko: "IPVS는 대규모 서비스에서 iptables 대비 O(1) 조회", en: "IPVS provides O(1) lookup vs iptables at scale" },              configHint: { location: "ConfigMap kube-proxy (namespace kube-system)", command: "kubectl -n kube-system edit cm kube-proxy", autoApply: "kubectl" } },
            { key: "ipvs.scheduler",         currentValue: "rr",            recommendedValue: "rr",            source: "kube-proxy ConfigMap", description: { ko: "IPVS 로드밸런싱 알고리즘", en: "IPVS load balancing algorithm" },                          impact: { ko: "라운드로빈 방식으로 백엔드 Pod 균등 분산", en: "Round-robin distributes load evenly across backend Pods" },         configHint: { location: "ConfigMap kube-proxy (namespace kube-system)", command: "kubectl -n kube-system edit cm kube-proxy", autoApply: "kubectl" } },
            { key: "iptables.masqueradeAll", currentValue: "false",         recommendedValue: "false",         source: "kube-proxy ConfigMap", description: { ko: "모든 트래픽 마스커레이드 여부", en: "Masquerade all traffic" },                             impact: { ko: "불필요한 SNAT 비활성화로 네트워크 오버헤드 감소", en: "Disabling unnecessary SNAT reduces network overhead" },          configHint: { location: "ConfigMap kube-proxy (namespace kube-system)", command: "kubectl -n kube-system edit cm kube-proxy", autoApply: "kubectl" } },
            { key: "clusterCIDR",            currentValue: "10.244.0.0/16", recommendedValue: "10.244.0.0/16", source: "kube-proxy ConfigMap", description: { ko: "클러스터 Pod CIDR 범위", en: "Cluster Pod CIDR range" },                                impact: { ko: "kube-proxy가 CIDR 기반 MASQUERADE 규칙 생성", en: "kube-proxy generates CIDR-based MASQUERADE rules" },               configHint: { location: "ConfigMap kube-proxy (namespace kube-system)", command: "kubectl -n kube-system edit cm kube-proxy", autoApply: "kubectl" } },
          ],
          containerdConfig: [
            { key: "snapshotter",              currentValue: "overlayfs",                   recommendedValue: "overlayfs",                   source: "/etc/containerd/config.toml", description: { ko: "컨테이너 레이어 스냅샷 드라이버", en: "Container layer snapshot driver" },         impact: { ko: "overlayfs가 devicemapper 대비 성능 및 안정성 우수", en: "overlayfs outperforms devicemapper in performance and stability" }, configHint: { location: "/etc/containerd/config.toml", command: "sudo systemctl restart containerd", autoApply: "node-ssh" } },
            { key: "SystemdCgroup",            currentValue: "true",                        recommendedValue: "true",                        source: "/etc/containerd/config.toml", description: { ko: "systemd cgroup driver 사용", en: "Use systemd cgroup driver" },                 impact: { ko: "kubelet과 cgroup driver 일치 필수", en: "Must match kubelet cgroup driver" },                                              configHint: { location: "/etc/containerd/config.toml", command: "sudo systemctl restart containerd", autoApply: "node-ssh" } },
            { key: "sandbox_image",            currentValue: "registry.k8s.io/pause:3.10", recommendedValue: "registry.k8s.io/pause:3.10", source: "/etc/containerd/config.toml", description: { ko: "pause 컨테이너 이미지", en: "Pause container image" },                         impact: { ko: "K8s pause 컨테이너 버전 불일치 시 파드 시작 실패", en: "Pod startup fails on pause container version mismatch" },            configHint: { location: "/etc/containerd/config.toml", command: "sudo systemctl restart containerd", autoApply: "node-ssh" } },
            { key: "max_concurrent_downloads", currentValue: "3",                           recommendedValue: "3",                           source: "/etc/containerd/config.toml", description: { ko: "동시 이미지 다운로드 수 제한", en: "Max concurrent image downloads" },           impact: { ko: "레지스트리 레이트리밋 및 네트워크 대역폭 조절", en: "Controls registry rate limiting and network bandwidth" },               configHint: { location: "/etc/containerd/config.toml", command: "sudo systemctl restart containerd", autoApply: "node-ssh" } },
          ],
          cniPlugin: liveCni ?? {
            name: "cilium",
            version: "1.18.0",
            mode: "ebpf",
            kubeProxyReplacement: true,
            hubbleEnabled: true,
            encryptionMode: "wireguard",
            ipamMode: "cluster-pool",
            description: { ko: "eBPF 기반 CNI + kube-proxy 대체", en: "eBPF CNI + kube-proxy replacement" },
            configHint: { location: "ConfigMap cilium-config (kube-system)", command: "kubectl -n kube-system edit cm cilium-config && kubectl -n kube-system rollout restart ds/cilium", autoApply: "kubectl" },
          },
          controlPlaneFlags: [],
        },
      }
    }

    await cacheSet(cacheKey, detail, 30)
    return detail
  } catch (err) {
    console.warn(`[k8s] Node detail fetch failed for ${name}:`, (err as Error).message)
    if (process.env.NODE_ENV === "development") {
      return {
        name,
        internalIP: "192.168.0.100",
        externalIP: "",
        kubeletVersion: "v1.28.0 (mock)",
        kubeProxyVersion: "v1.28.0 (mock)",
        osImage: "Ubuntu 22.04 LTS",
        operatingSystem: "linux",
        kernelVersion: "5.15.0-100-generic",
        architecture: "amd64",
        containerRuntime: "containerd://1.6.24",
        providerID: "mock://instance-0",
        machineID: "mock-machine-id",
        systemUUID: "mock-system-uuid",
        createdAt: new Date().toISOString(),
        conditions: [
          { type: "Ready", status: "True", message: "kubelet is posting ready status", lastTransitionTime: new Date().toISOString() }
        ],
        labels: {
          "kubernetes.io/hostname": name,
          ...(name.includes("master") ? { "node-role.kubernetes.io/control-plane": "true" } : { "node-role.kubernetes.io/worker": "true" }),
        },
        taints: name.includes("master") ? [{ key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" }] : [],
        capacity: { cpu: "8", memory: "16384Ki", pods: "110" },
        allocatable: { cpu: "8", memory: "16384Ki", pods: "110" },
        systemStatus: {
          rebootRequired: true,
          securityUpdates: 3,
          standardUpdates: 12,
          packageUpdates: [
            { name: "openssl", currentVersion: "3.0.2-0ubuntu1.12", targetVersion: "3.0.2-0ubuntu1.15", cve: "CVE-2024-2511", reason: { ko: "SSL/TLS 세션 재사용 시 메모리 누수 취약점 해결", en: "Fix memory leak on SSL/TLS session reuse" }, link: "https://nvd.nist.gov/vuln/detail/CVE-2024-2511", severity: "High" },
            { name: "linux-image-5.15.0-100-generic", currentVersion: "5.15.0-100.110", targetVersion: "5.15.0-101.111", cve: "CVE-2024-1086", reason: { ko: "Local Privilege Escalation (LPE) 취약점 및 커널 패닉 안정성 패치", en: "Local Privilege Escalation (LPE) vulnerability and kernel panic stability patch" }, link: "https://nvd.nist.gov/vuln/detail/CVE-2024-1086", severity: "Critical" },
            { name: "libc-bin", currentVersion: "2.35-0ubuntu3.6", targetVersion: "2.35-0ubuntu3.8", cve: "CVE-2024-2961", reason: { ko: "iconv() out-of-bounds write — 원격 코드 실행 가능", en: "iconv() out-of-bounds write — remote code execution possible" }, link: "https://nvd.nist.gov/vuln/detail/CVE-2024-2961", severity: "Medium" },
          ],
          k8sBinaries: [
            { name: "kubelet", version: "v1.28.0", installedAt: "2024-03-01", updateAvailable: "v1.28.8" },
            { name: "containerd.io", version: "1.6.24", installedAt: "2024-03-01", updateAvailable: "1.7.13" },
          ],
          kernelParams: [
            { param: "net.core.somaxconn",         currentValue: "4096",   recommendedValue: "65535",  group: "network",    description: { ko: "소켓 연결 대기열", en: "Socket connection backlog" },                      impact: { ko: "고부하 상황 접속 지연/거부 방지", en: "Prevent connection delay/rejection under high load" },     configHint: { location: "/etc/sysctl.d/99-k8s-tuning.conf", command: "sysctl -w net.core.somaxconn=65535",         autoApply: "node-ssh" } },
            { param: "net.core.netdev_max_backlog", currentValue: "1000",   recommendedValue: "65535",  group: "network",    description: { ko: "NIC 패킷 수신 대기 큐", en: "NIC packet receive backlog queue" },            impact: { ko: "패킷 드롭 및 네트워크 병목 방지", en: "Prevent packet drops and network bottlenecks" },          configHint: { location: "/etc/sysctl.d/99-k8s-tuning.conf", command: "sysctl -w net.core.netdev_max_backlog=65535", autoApply: "node-ssh" } },
            { param: "vm.swappiness",               currentValue: "60",     recommendedValue: "0",      group: "resource",   description: { ko: "메모리 스왑 사용 빈도", en: "Memory swap frequency" },                      impact: { ko: "스왑 I/O 병목에 의한 노드 포즈 방지", en: "Prevent node pause caused by swap I/O bottleneck" },    configHint: { location: "/etc/sysctl.d/99-k8s-tuning.conf", command: "sysctl -w vm.swappiness=0",                  autoApply: "node-ssh" } },
            { param: "fs.file-max",                 currentValue: "100000", recommendedValue: "2097152", group: "filesystem", description: { ko: "시스템 전체 파일 핸들 한도", en: "System-wide file handle limit" },            impact: { ko: "Too many open files 에러 원천 차단", en: "Eliminate 'Too many open files' errors at root" },       configHint: { location: "/etc/sysctl.d/99-k8s-tuning.conf", command: "sysctl -w fs.file-max=2097152",               autoApply: "node-ssh" } },
            { param: "net.ipv4.conf.all.rp_filter", currentValue: "0",      recommendedValue: "1",      group: "security",   description: { ko: "IP Spoofing 방지 필터", en: "IP spoofing prevention filter" },              impact: { ko: "네트워크 소스 위조 공격 원천 차단", en: "Block network source address spoofing attacks" },        configHint: { location: "/etc/sysctl.d/99-k8s-tuning.conf", command: "sysctl -w net.ipv4.conf.all.rp_filter=1",    autoApply: "node-ssh" } },
          ],
          kernelModules: [
            { name: "br_netfilter", required: true, loaded: true,  purpose: "Bridge netfilter — iptables on bridge traffic (required for K8s)", configHint: { location: "/etc/modules-load.d/k8s.conf", command: "modprobe br_netfilter", autoApply: "node-ssh" } },
            { name: "overlay",      required: true, loaded: true,  purpose: "OverlayFS — container layer storage (containerd)",                  configHint: { location: "/etc/modules-load.d/k8s.conf", command: "modprobe overlay",      autoApply: "node-ssh" } },
            { name: "ip_vs",        required: true, loaded: true,  purpose: "IPVS — kube-proxy load balancing",                                 configHint: { location: "/etc/modules-load.d/k8s.conf", command: "modprobe ip_vs",        autoApply: "node-ssh" } },
            { name: "ip_vs_rr",     required: true, loaded: false, purpose: "IPVS round-robin scheduler",                                       configHint: { location: "/etc/modules-load.d/k8s.conf", command: "modprobe ip_vs_rr",     autoApply: "node-ssh" } },
            { name: "nf_conntrack", required: true, loaded: true,  purpose: "Connection tracking for iptables/Cilium",                          configHint: { location: "/etc/modules-load.d/k8s.conf", command: "modprobe nf_conntrack", autoApply: "node-ssh" } },
          ],
          resourceLimits: [
            { name: "nofile",  scope: "soft", currentValue: "1024",  recommendedValue: "1048576",  description: { ko: "열린 파일 디스크립터 수 (soft)", en: "Open file descriptor count (soft)" }, configHint: { location: "/etc/security/limits.d/k8s.conf", autoApply: "node-ssh" } },
            { name: "nofile",  scope: "hard", currentValue: "4096",  recommendedValue: "1048576",  description: { ko: "열린 파일 디스크립터 수 (hard)", en: "Open file descriptor count (hard)" }, configHint: { location: "/etc/security/limits.d/k8s.conf", autoApply: "node-ssh" } },
            { name: "nproc",   scope: "soft", currentValue: "1024",  recommendedValue: "unlimited", description: { ko: "최대 프로세스 수 (soft)", en: "Max process count (soft)" },        configHint: { location: "/etc/security/limits.d/k8s.conf", autoApply: "node-ssh" } },
            { name: "memlock", scope: "hard", currentValue: "65536", recommendedValue: "unlimited", description: { ko: "잠금 메모리 크기 (hard)", en: "Locked memory size (hard)" },        configHint: { location: "/etc/security/limits.d/k8s.conf", autoApply: "node-ssh" } },
          ],
          requiredPackages: [
            { name: "socat",     installed: true,  purpose: { ko: "kubectl port-forward 등 TCP 포워딩", en: "TCP forwarding for kubectl port-forward etc." }, configHint: { location: "apt package (on node)", command: "apt-get install -y socat",     autoApply: "node-ssh" } },
            { name: "conntrack", installed: true,  purpose: { ko: "kube-proxy conntrack 관리", en: "kube-proxy conntrack management" },          configHint: { location: "apt package (on node)", command: "apt-get install -y conntrack", autoApply: "node-ssh" } },
            { name: "ipset",     installed: false, purpose: { ko: "IPVS 기반 서비스 관리", en: "IPVS-based service management" },              configHint: { location: "apt package (on node)", command: "apt-get install -y ipset",     autoApply: "node-ssh" } },
            { name: "jq",        installed: true,  purpose: { ko: "JSON 파싱 유틸리티", en: "JSON parsing utility" },                 configHint: { location: "apt package (on node)", command: "apt-get install -y jq",        autoApply: "node-ssh" } },
          ],
          diskTuning: [
            {
              device: "/dev/sda",
              ioScheduler: { current: "mq-deadline", recommended: "none" },
              readAheadKb: { current: 128, recommended: 0 },
              mountOptions: ["rw", "relatime"],
              noatimeConfigured: false,
              fsType: "ext4",
              xfsPrjquota: false,
              description: { ko: "SSD 최적화 I/O 스케줄러, read-ahead, noatime 마운트로 디스크 처리량 향상", en: "SSD-optimized I/O scheduler, read-ahead, and noatime mount for disk throughput" },
              configHint: { location: "/etc/fstab + /sys/block/sda/queue/{scheduler,read_ahead_kb}", command: "bash /etc/kube-ready-box/05-disk-tuning.sh", autoApply: "node-ssh" },
            },
            {
              device: "/dev/sdb",
              ioScheduler: { current: "none", recommended: "none" },
              readAheadKb: { current: 0, recommended: 0 },
              mountOptions: ["rw", "noatime", "prjquota"],
              noatimeConfigured: true,
              fsType: "xfs",
              xfsPrjquota: true,
              description: { ko: "XFS prjquota 마운트 — NFS quota agent를 위한 프로젝트 쿼터 활성화", en: "XFS prjquota mount — project quota enabled for NFS quota agent" },
              configHint: { location: "/etc/fstab + /sys/block/sdb/queue/{scheduler,read_ahead_kb}", command: "bash /etc/kube-ready-box/05-disk-tuning.sh", autoApply: "node-ssh" },
            },
          ],
          lvmAutoExtend: {
            serviceName: "lvm2-monitor.service",
            enabled: true,
            description: { ko: "LVM thin pool 자동 확장 (Docker/containerd overlay2)", en: "LVM thin pool auto-extension (Docker/containerd overlay2)" },
            configHint: { location: "/etc/systemd/system/extend-lvm.service", command: "systemctl enable --now extend-lvm.service", autoApply: "node-ssh" },
          },
          nicTuning: [
            {
              interface: "eth0",
              ringBufferRx: { current: 256, recommended: 4096 },
              ringBufferTx: { current: 256, recommended: 4096 },
              offloading: { tso: true, gso: true, gro: true },
              coalescingUsec: { rx: 50, tx: 50 },
              description: { ko: "NIC 버퍼·offloading·interrupt coalescing으로 네트워크 처리량 향상", en: "NIC buffer, offloading, and interrupt coalescing for network throughput" },
              configHint: { location: "ethtool persistent config (networkd or /etc/network/if-up.d)", command: "ethtool -G eth0 rx 4096 tx 4096", autoApply: "node-ssh" },
            },
            {
              interface: "eth1",
              ringBufferRx: { current: 4096, recommended: 4096 },
              ringBufferTx: { current: 4096, recommended: 4096 },
              offloading: { tso: true, gso: true, gro: false },
              coalescingUsec: { rx: 100, tx: 100 },
              description: { ko: "NIC 버퍼·offloading·interrupt coalescing으로 네트워크 처리량 향상", en: "NIC buffer, offloading, and interrupt coalescing for network throughput" },
              configHint: { location: "ethtool persistent config (networkd or /etc/network/if-up.d)", command: "ethtool -G eth1 rx 4096 tx 4096", autoApply: "node-ssh" },
            },
          ],
          runtimeStatus: [
            { name: "containerd", active: true, version: "1.6.24", description: { ko: "컨테이너 런타임 / kubelet 데몬 실행 상태", en: "Container runtime / kubelet daemon running status" }, configHint: { location: "systemctl unit (containerd.service)", command: "systemctl status containerd", autoApply: "node-ssh" } },
            { name: "kubelet",    active: true, version: "v1.28.0", description: { ko: "컨테이너 런타임 / kubelet 데몬 실행 상태", en: "Container runtime / kubelet daemon running status" }, configHint: { location: "systemctl unit (kubelet.service)",    command: "systemctl status kubelet",    autoApply: "node-ssh" } },
          ],
          cgroup: { version: "v2", controllers: ["cpu", "memory", "io", "hugetlb", "pids"], description: { ko: "리소스 격리/제한을 위한 cgroup 버전 (v2 권장: unified hierarchy)", en: "cgroup version for resource isolation/limits (v2 recommended: unified hierarchy)" }, configHint: { location: "GRUB_CMDLINE_LINUX in /etc/default/grub (systemd.unified_cgroup_hierarchy=1)", command: "update-grub && reboot", autoApply: "manual" } },
          swap: { enabled: false, configuredInFstab: false, totalMb: 0, description: { ko: "스왑 비활성화는 K8s kubelet 필수 조건 (Pod 메모리 예측성 보장)", en: "Swap disabled is a K8s kubelet requirement (Pod memory predictability)" }, configHint: { location: "/etc/fstab", command: "swapoff -a && sed -i '/swap/d' /etc/fstab", autoApply: "node-ssh" } },
          k8sTuning: {
            clusterVersion: { kubernetes: "v1.28.0", clusterAge: "47d", isPatchCurrent: false, description: { ko: "Kubernetes 릴리스 버전과 클러스터 운영 기간", en: "Kubernetes release version and cluster operational age" } },
            kubeletConfig: [
              { key: "maxPods",                       currentValue: "110",   recommendedValue: "250",   source: "KubeletConfiguration", description: { ko: "노드당 최대 파드 수", en: "Max Pods per node" },                              impact: { ko: "대규모 배포 시 파드 스케줄링 가능 수 제한", en: "Limits schedulable Pods in large-scale deployments" },          configHint: { location: "/var/lib/kubelet/config.yaml", command: "kubectl -n kube-system edit cm kubelet-config && systemctl restart kubelet", autoApply: "kubectl" } },
              { key: "evictionHard.memory.available", currentValue: "100Mi", recommendedValue: "500Mi", source: "KubeletConfiguration", description: { ko: "메모리 부족 시 강제 퇴거 임계값", en: "Hard memory eviction threshold" },             impact: { ko: "OOM Kill 전 조기 퇴거로 노드 안정성 확보", en: "Early eviction before OOM Kill for node stability" },           configHint: { location: "/var/lib/kubelet/config.yaml", command: "kubectl -n kube-system edit cm kubelet-config && systemctl restart kubelet", autoApply: "kubectl" } },
              { key: "kubeAPIQPS",                    currentValue: "5",     recommendedValue: "50",    source: "KubeletConfiguration", description: { ko: "kubelet → API서버 QPS 한도", en: "kubelet to API server QPS limit" },              impact: { ko: "대규모 클러스터에서 API 서버 플러딩 방지", en: "Prevent API server flooding in large clusters" },               configHint: { location: "/var/lib/kubelet/config.yaml", command: "kubectl -n kube-system edit cm kubelet-config && systemctl restart kubelet", autoApply: "kubectl" } },
            ],
            kubeProxyConfig: [
              { key: "mode",                 currentValue: "iptables", recommendedValue: "ipvs",   source: "kube-proxy ConfigMap", description: { ko: "kube-proxy 동작 모드", en: "kube-proxy operating mode" },                                  impact: { ko: "IPVS는 대규모 서비스에서 iptables보다 O(1) 조회", en: "IPVS provides O(1) lookup vs iptables at scale" },       configHint: { location: "ConfigMap kube-proxy (namespace kube-system)", command: "kubectl -n kube-system edit cm kube-proxy", autoApply: "kubectl" } },
              { key: "conntrack.maxPerCore", currentValue: "32768",    recommendedValue: "131072", source: "kube-proxy ConfigMap", description: { ko: "코어당 conntrack 테이블 최대 항목 수", en: "Max conntrack table entries per core" },             impact: { ko: "대규모 서비스 연결 시 conntrack 테이블 소진 방지", en: "Prevent conntrack table exhaustion under high service load" }, configHint: { location: "ConfigMap kube-proxy (namespace kube-system)", command: "kubectl -n kube-system edit cm kube-proxy", autoApply: "kubectl" } },
            ],
            containerdConfig: [
              { key: "snapshotter",  currentValue: "overlayfs", recommendedValue: "overlayfs", source: "/etc/containerd/config.toml", description: { ko: "컨테이너 레이어 스냅샷 드라이버", en: "Container layer snapshot driver" },        impact: { ko: "overlayfs가 devicemapper 대비 성능 우수", en: "overlayfs outperforms devicemapper" },                              configHint: { location: "/etc/containerd/config.toml", command: "sudo systemctl restart containerd", autoApply: "node-ssh" } },
              { key: "systemdCgroup", currentValue: "true",      recommendedValue: "true",      source: "/etc/containerd/config.toml", description: { ko: "systemd cgroup 드라이버 사용 여부", en: "Use systemd cgroup driver" },              impact: { ko: "kubelet과 cgroup 드라이버 불일치 시 노드 불안정", en: "Node instability if cgroup driver mismatches kubelet" },   configHint: { location: "/etc/containerd/config.toml", command: "sudo systemctl restart containerd", autoApply: "node-ssh" } },
            ],
            cniPlugin: {
              name: "Cilium",
              version: "1.15.3",
              mode: "kube-proxy replacement",
              kubeProxyReplacement: true,
              hubbleEnabled: true,
              encryptionMode: "wireguard",
              ipamMode: "cluster-pool",
              description: { ko: "eBPF 기반 CNI. kube-proxy 완전 대체, Hubble 네트워크 가시성, WireGuard 암호화 활성화", en: "eBPF CNI with full kube-proxy replacement, Hubble network visibility, and WireGuard encryption" },
              configHint: { location: "ConfigMap cilium-config (kube-system)", command: "kubectl -n kube-system edit cm cilium-config && kubectl -n kube-system rollout restart ds/cilium", autoApply: "kubectl" },
            },
            controlPlaneFlags: name.includes("master") ? [
              { component: "kube-apiserver",          flag: "--audit-log-maxsize",          currentValue: "100",          recommendedValue: "200",          description: { ko: "감사 로그 파일 최대 크기(MB)", en: "Audit log file max size (MB)" },                       impact: { ko: "로그 로테이션 주기 조정으로 디스크 사용 최적화", en: "Optimizes disk usage by tuning log rotation frequency" },    configHint: { location: "/etc/kubernetes/manifests/kube-apiserver.yaml",          command: "sudo vi /etc/kubernetes/manifests/kube-apiserver.yaml",          autoApply: "node-ssh" } },
              { component: "kube-apiserver",          flag: "--request-timeout",            currentValue: "1m0s",         recommendedValue: "3m0s",         description: { ko: "API 서버 요청 타임아웃", en: "API server request timeout" },                              impact: { ko: "대용량 리소스 조회 시 타임아웃 방지", en: "Prevents timeouts on large resource list requests" },             configHint: { location: "/etc/kubernetes/manifests/kube-apiserver.yaml",          command: "sudo vi /etc/kubernetes/manifests/kube-apiserver.yaml",          autoApply: "node-ssh" } },
              { component: "kube-controller-manager", flag: "--node-monitor-grace-period",  currentValue: "40s",          recommendedValue: "20s",          description: { ko: "노드 장애 감지 유예 기간", en: "Node failure detection grace period" },                    impact: { ko: "노드 장애 감지 및 파드 재스케줄링 속도 향상", en: "Faster node failure detection and pod rescheduling" },         configHint: { location: "/etc/kubernetes/manifests/kube-controller-manager.yaml", command: "sudo vi /etc/kubernetes/manifests/kube-controller-manager.yaml", autoApply: "node-ssh" } },
              { component: "kube-scheduler",          flag: "--profile",                    currentValue: "default-scheduler", recommendedValue: "default-scheduler", description: { ko: "스케줄러 프로파일", en: "Scheduler profile" },                              impact: { ko: "커스텀 스케줄링 정책 적용 가능", en: "Enables custom scheduling policy configuration" },                  configHint: { location: "/etc/kubernetes/manifests/kube-scheduler.yaml",           command: "sudo vi /etc/kubernetes/manifests/kube-scheduler.yaml",           autoApply: "node-ssh" } },
              { component: "etcd",                    flag: "--quota-backend-bytes",        currentValue: "2147483648",   recommendedValue: "8589934592",   description: { ko: "etcd 백엔드 저장소 최대 크기(8GiB)", en: "etcd backend storage quota (8GiB)" },              impact: { ko: "대규모 클러스터에서 etcd alarm 발생 방지", en: "Prevents etcd storage quota alarm in large clusters" },         configHint: { location: "/etc/kubernetes/manifests/etcd.yaml",                    command: "sudo vi /etc/kubernetes/manifests/etcd.yaml",                    autoApply: "node-ssh" } },
            ] : [],
          },
        }
      }
    }
    return null
  }
}

export interface PodInfo {
  name: string
  namespace: string
  status: string
  nodeName: string
  createdAt: string
  containersReady: number
  containersTotal: number
  labels: Record<string, string>
}

interface PodList {
  items: Array<{
    metadata: { name: string; namespace: string; creationTimestamp: string; labels?: Record<string, string> }
    spec: { nodeName?: string; containers: unknown[] }
    status: {
      phase: string
      containerStatuses?: Array<{ ready: boolean }>
    }
  }>
}

export async function getPodsByNode(nodeName: string): Promise<PodInfo[]> {
  try {
    assertK8sNodeName(nodeName)
    const data = await k8sFetch<PodList>(
      `/api/v1/pods?fieldSelector=spec.nodeName=${encodeURIComponent(nodeName)}`,
    )
    return data.items.map((p) => {
      const ready = p.status.containerStatuses?.filter((c) => c.ready).length ?? 0
      const total = p.spec.containers.length
      return {
        name: p.metadata.name,
        namespace: p.metadata.namespace,
        status: p.status.phase,
        nodeName: p.spec.nodeName ?? "",
        createdAt: p.metadata.creationTimestamp,
        containersReady: ready,
        containersTotal: total,
        labels: p.metadata.labels ?? {},
      }
    })
  } catch (err) {
    if (process.env.NODE_ENV === "development") {
      return [
        { name: "mock-pod-1", namespace: "default", status: "Running", nodeName, createdAt: new Date().toISOString(), containersReady: 1, containersTotal: 1, labels: { app: "frontend" } },
        { name: "mock-pod-2", namespace: "kube-system", status: "Pending", nodeName, createdAt: new Date().toISOString(), containersReady: 0, containersTotal: 1, labels: { "k8s-app": "coredns" } },
        { name: "mock-pod-3", namespace: "default", status: "Running", nodeName, createdAt: new Date().toISOString(), containersReady: 2, containersTotal: 2, labels: { app: "backend-api" } }
      ]
    }
    return []
  }
}

// --- Governance / detail drawer interfaces & helpers ---

export interface PodSummary {
  name: string
  namespace: string
  phase: string
  ready: string
  restarts: number
  node: string
  age: string
  images: string[]
}

export interface PodDetail {
  name: string
  namespace: string
  phase: string
  podIP: string
  node: string
  qosClass: string
  serviceAccount: string
  createdAt: string
  labels: Record<string, string>
  owner: { kind: string; name: string } | null
  containers: {
    name: string
    image: string
    ready: boolean
    restarts: number
    state: string
    requests: { cpu?: string; memory?: string }
    limits: { cpu?: string; memory?: string }
  }[]
  conditions: { type: string; status: string; reason?: string; message?: string }[]
}

export interface ResourceEvent {
  type: string
  reason: string
  message: string
  count: number
  firstSeen: string
  lastSeen: string
}

interface RawPod {
  metadata: {
    name: string
    namespace: string
    creationTimestamp: string
    labels?: Record<string, string>
    ownerReferences?: Array<{
      kind: string
      name: string
      uid: string
      apiVersion: string
      controller?: boolean
    }>
  }
  spec: {
    nodeName?: string
    serviceAccountName?: string
    qosClass?: string
    containers?: Array<{
      name: string
      image: string
      resources?: {
        requests?: { cpu?: string; memory?: string }
        limits?: { cpu?: string; memory?: string }
      }
    }>
    initContainers?: Array<{
      name: string
      image: string
      resources?: {
        requests?: { cpu?: string; memory?: string }
        limits?: { cpu?: string; memory?: string }
      }
    }>
  }
  status: {
    phase?: string
    podIP?: string
    qosClass?: string
    containerStatuses?: Array<{
      name: string
      image: string
      ready: boolean
      restartCount: number
      state?: {
        running?: { startedAt?: string }
        waiting?: { reason?: string; message?: string }
        terminated?: { reason?: string; message?: string }
      }
    }>
    initContainerStatuses?: Array<{
      name: string
      image: string
      ready: boolean
      restartCount: number
      state?: {
        running?: { startedAt?: string }
        waiting?: { reason?: string; message?: string }
        terminated?: { reason?: string; message?: string }
      }
    }>
    conditions?: Array<{
      type: string
      status: string
      reason?: string
      message?: string
    }>
  }
}

export async function getPodsList(namespace: string, app?: string): Promise<PodSummary[]> {
  assertK8sNamespace(namespace)
  
  try {
    let pods: RawPod[] = []
    if (app) {
      const selector = `app.kubernetes.io/instance=${encodeURIComponent(app)}`
      try {
        const data = await k8sFetch<{ items?: RawPod[] }>(
          `/api/v1/namespaces/${safeK8sSegment(namespace)}/pods?labelSelector=${selector}`
        )
        pods = data.items ?? []
      } catch (err) {
        console.warn(`[getPodsList] Failed to fetch pods with label selector for app ${app}:`, err)
      }
    }

    if (!app || pods.length === 0) {
      const data = await k8sFetch<{ items?: RawPod[] }>(
        `/api/v1/namespaces/${safeK8sSegment(namespace)}/pods`
      )
      pods = data.items ?? []
    }

    return pods.map((p) => {
      const totalContainers = p.spec.containers?.length ?? 0
      const readyContainers = p.status.containerStatuses?.filter((c) => c.ready).length ?? 0
      
      let restarts = 0
      if (p.status.containerStatuses) {
        for (const c of p.status.containerStatuses) {
          restarts += c.restartCount ?? 0
        }
      }
      if (p.status.initContainerStatuses) {
        for (const c of p.status.initContainerStatuses) {
          restarts += c.restartCount ?? 0
        }
      }

      const images = Array.from(
        new Set([
          ...(p.spec.containers?.map((c) => c.image) ?? []),
          ...(p.spec.initContainers?.map((c) => c.image) ?? []),
        ])
      )

      return {
        name: p.metadata.name,
        namespace: p.metadata.namespace,
        phase: p.status.phase ?? "Unknown",
        ready: `${readyContainers}/${totalContainers}`,
        restarts,
        node: p.spec.nodeName ?? "",
        age: p.metadata.creationTimestamp,
        images,
      }
    })
  } catch (err) {
    console.warn(`[getPodsList] Failed to fetch pods list in ${namespace}:`, err)
    if (process.env.NODE_ENV === "development") {
      return [
        {
          name: app ? `${app}-pod-1` : "mock-pod-1",
          namespace,
          phase: "Running",
          ready: "1/1",
          restarts: 0,
          node: "mock-node-1",
          age: new Date().toISOString(),
          images: ["nginx:latest"],
        },
        {
          name: app ? `${app}-pod-2` : "mock-pod-2",
          namespace,
          phase: "Running",
          ready: "2/2",
          restarts: 1,
          node: "mock-node-2",
          age: new Date().toISOString(),
          images: ["redis:alpine", "postgres:15"],
        },
      ]
    }
    throw err
  }
}

export async function getPodDetail(namespace: string, name: string): Promise<PodDetail> {
  assertK8sNamespace(namespace)
  assertK8sName(name, "pod")

  try {
    const p = await k8sFetch<RawPod>(
      `/api/v1/namespaces/${safeK8sSegment(namespace)}/pods/${safeK8sSegment(name)}`
    )

    const ownerRef = p.metadata.ownerReferences?.[0]
    const owner = ownerRef ? { kind: ownerRef.kind, name: ownerRef.name } : null

    const containers = (p.spec.containers ?? []).map((c) => {
      const status = p.status.containerStatuses?.find((cs) => cs.name === c.name)
      
      let stateStr = "waiting"
      if (status?.state) {
        if (status.state.running) {
          stateStr = "running"
        } else if (status.state.waiting) {
          stateStr = status.state.waiting.reason ? `waiting:${status.state.waiting.reason}` : "waiting"
        } else if (status.state.terminated) {
          stateStr = status.state.terminated.reason ? `terminated:${status.state.terminated.reason}` : "terminated"
        }
      }

      return {
        name: c.name,
        image: c.image,
        ready: status?.ready ?? false,
        restarts: status?.restartCount ?? 0,
        state: stateStr,
        requests: {
          cpu: c.resources?.requests?.cpu,
          memory: c.resources?.requests?.memory,
        },
        limits: {
          cpu: c.resources?.limits?.cpu,
          memory: c.resources?.limits?.memory,
        },
      }
    })

    const conditions = (p.status.conditions ?? []).map((cond) => ({
      type: cond.type,
      status: cond.status,
      reason: cond.reason,
      message: cond.message,
    }))

    return {
      name: p.metadata.name,
      namespace: p.metadata.namespace,
      phase: p.status.phase ?? "Unknown",
      podIP: p.status.podIP ?? "",
      node: p.spec.nodeName ?? "",
      qosClass: p.status.qosClass ?? (p as any).spec.qosClass ?? "",
      serviceAccount: p.spec.serviceAccountName ?? "",
      createdAt: p.metadata.creationTimestamp,
      labels: p.metadata.labels ?? {},
      owner,
      containers,
      conditions,
    }
  } catch (err) {
    console.warn(`[getPodDetail] Failed to fetch pod detail for ${namespace}/${name}:`, err)
    if (process.env.NODE_ENV === "development") {
      return {
        name,
        namespace,
        phase: "Running",
        podIP: "10.244.1.23",
        node: "mock-node-1",
        qosClass: "Burstable",
        serviceAccount: "default",
        createdAt: new Date().toISOString(),
        labels: { app: name, tier: "frontend" },
        owner: { kind: "ReplicaSet", name: `${name}-abcde` },
        containers: [
          {
            name: "main",
            image: "nginx:latest",
            ready: true,
            restarts: 0,
            state: "running",
            requests: { cpu: "100m", memory: "128Mi" },
            limits: { cpu: "500m", memory: "512Mi" },
          },
        ],
        conditions: [
          { type: "Initialized", status: "True" },
          { type: "Ready", status: "True" },
          { type: "ContainersReady", status: "True" },
          { type: "PodScheduled", status: "True" },
        ],
      }
    }
    throw err
  }
}

export async function getResourceEvents(namespace: string, name: string): Promise<ResourceEvent[]> {
  assertK8sNamespace(namespace)
  assertK8sName(name, "resource")

  try {
    const selector = `involvedObject.name=${encodeURIComponent(name)}`
    const data = await k8sFetch<{
      items?: Array<{
        type: string
        reason: string
        message: string
        count?: number
        firstTimestamp?: string | null
        lastTimestamp?: string | null
        eventTime?: string | null
        metadata: {
          creationTimestamp: string
        }
      }>
    }>(
      `/api/v1/namespaces/${safeK8sSegment(namespace)}/events?fieldSelector=${selector}`
    )

    const mapped: ResourceEvent[] = (data.items ?? []).map((i) => {
      const firstSeen = i.firstTimestamp || i.metadata.creationTimestamp || i.eventTime || ""
      const lastSeen = i.lastTimestamp || i.metadata.creationTimestamp || i.eventTime || ""
      return {
        type: i.type ?? "Normal",
        reason: i.reason ?? "",
        message: i.message ?? "",
        count: i.count ?? 1,
        firstSeen,
        lastSeen,
      }
    })

    const sorted = mapped.sort((a, b) => {
      const aTime = a.lastSeen ? new Date(a.lastSeen).getTime() : 0
      const bTime = b.lastSeen ? new Date(b.lastSeen).getTime() : 0
      return bTime - aTime
    })

    return sorted.slice(0, 50)
  } catch (err) {
    console.warn(`[getResourceEvents] Failed to fetch events for ${namespace}/${name}:`, err)
    if (process.env.NODE_ENV === "development") {
      return [
        {
          type: "Normal",
          reason: "Scheduled",
          message: `Successfully assigned ${namespace}/${name} to mock-node-1`,
          count: 1,
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        },
        {
          type: "Normal",
          reason: "Pulled",
          message: "Container image already present on machine",
          count: 1,
          firstSeen: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        },
      ]
    }
    throw err
  }
}

export interface K8sPolicyRule {
  verbs: string[]
  apiGroups?: string[]
  resources?: string[]
  resourceNames?: string[]
  nonResourceURLs?: string[]
}

export interface K8sClusterRole {
  name: string
  rules?: K8sPolicyRule[]
}

export interface K8sRole {
  name: string
  namespace: string
  rules?: K8sPolicyRule[]
}

export async function getClusterRoles(): Promise<K8sClusterRole[]> {
  try {
    const data = await k8sFetch<{ items: Array<{ metadata: { name: string }; rules?: K8sPolicyRule[] }> }>(
      "/apis/rbac.authorization.k8s.io/v1/clusterroles"
    )
    return (data.items ?? []).map((i) => ({
      name: i.metadata.name,
      rules: i.rules,
    }))
  } catch (err) {
    console.warn("[k8s] ClusterRoles fetch failed:", (err as Error).message)
    if (process.env.NODE_ENV === "development") {
      return [
        {
          name: "cluster-admin",
          rules: [
            {
              apiGroups: ["*"],
              resources: ["*"],
              verbs: ["*"],
            },
          ],
        },
        {
          name: "admin",
          rules: [
            {
              apiGroups: ["*"],
              resources: ["*"],
              verbs: ["*"],
            },
          ],
        },
        {
          name: "view",
          rules: [
            {
              apiGroups: ["*"],
              resources: ["*"],
              verbs: ["get", "list", "watch"],
            },
          ],
        },
      ]
    }
    return []
  }
}

export async function getRoles(): Promise<K8sRole[]> {
  try {
    const data = await k8sFetch<{ items: Array<{ metadata: { name: string; namespace: string }; rules?: K8sPolicyRule[] }> }>(
      "/apis/rbac.authorization.k8s.io/v1/roles"
    )
    return (data.items ?? []).map((i) => ({
      name: i.metadata.name,
      namespace: i.metadata.namespace,
      rules: i.rules,
    }))
  } catch (err) {
    console.warn("[k8s] Roles fetch failed:", (err as Error).message)
    if (process.env.NODE_ENV === "development") {
      return [
        {
          name: "namespace-editor",
          namespace: "default",
          rules: [
            {
              apiGroups: ["*"],
              resources: ["*"],
              verbs: ["create", "update", "patch", "delete"],
            },
          ],
        },
      ]
    }
    return []
  }
}

export interface K8sRawPodMinimal {
  metadata: {
    name: string
    namespace: string
  }
  spec?: {
    containers?: Array<{
      name: string
      resources?: {
        requests?: {
          cpu?: string
          memory?: string
        }
      }
    }>
  }
}

export async function getAllPodsMinimal(): Promise<K8sRawPodMinimal[]> {
  try {
    const data = await k8sFetch<{ items: K8sRawPodMinimal[] }>("/api/v1/pods")
    return data.items ?? []
  } catch (err) {
    console.warn("[k8s] Failed to fetch all pods:", (err as Error).message)
    if (process.env.NODE_ENV === "development") {
      return [
        {
          metadata: { name: "frontend-pod-1", namespace: "default" },
          spec: {
            containers: [
              { name: "web", resources: { requests: { cpu: "100m", memory: "128Mi" } } },
            ],
          },
        },
        {
          metadata: { name: "frontend-pod-2", namespace: "default" },
          spec: {
            containers: [
              { name: "web", resources: { requests: { cpu: "100m" } } },
            ],
          },
        },
        {
          metadata: { name: "backend-pod-1", namespace: "default" },
          spec: {
            containers: [
              { name: "api", resources: {} },
            ],
          },
        },
      ]
    }
    return []
  }
}

export interface K8sPodForDistribution {
  metadata: {
    name: string
    namespace: string
    ownerReferences?: Array<{
      apiVersion: string
      kind: string
      name: string
      uid: string
    }>
  }
  spec?: {
    nodeName?: string
    affinity?: {
      podAntiAffinity?: any
    }
    topologySpreadConstraints?: any[]
  }
}

export interface K8sNodeForDistribution {
  metadata: {
    name: string
    labels?: Record<string, string>
  }
}

export async function getAllNodesForDistribution(): Promise<K8sNodeForDistribution[]> {
  try {
    const data = await k8sFetch<{ items: K8sNodeForDistribution[] }>("/api/v1/nodes")
    return data.items ?? []
  } catch (err) {
    console.warn("[k8s] Failed to fetch all nodes for distribution:", (err as Error).message)
    if (process.env.NODE_ENV === "development") {
      return [
        { metadata: { name: "node-master-1", labels: { "node-role.kubernetes.io/control-plane": "true" } } },
        { metadata: { name: "node-worker-1", labels: { "kubernetes.io/hostname": "node-worker-1" } } },
        { metadata: { name: "node-worker-2", labels: { "kubernetes.io/hostname": "node-worker-2" } } },
        { metadata: { name: "node-worker-3", labels: { "kubernetes.io/hostname": "node-worker-3" } } },
      ]
    }
    return []
  }
}

export async function getAllPodsForDistribution(): Promise<K8sPodForDistribution[]> {
  try {
    const data = await k8sFetch<{ items: K8sPodForDistribution[] }>("/api/v1/pods")
    return data.items ?? []
  } catch (err) {
    console.warn("[k8s] Failed to fetch all pods for distribution:", (err as Error).message)
    if (process.env.NODE_ENV === "development") {
      return [
        {
          metadata: {
            name: "app-auth-1",
            namespace: "auth",
            ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "app-auth-12345678", uid: "uid1" }]
          },
          spec: { nodeName: "node-worker-1" }
        },
        {
          metadata: {
            name: "app-auth-2",
            namespace: "auth",
            ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "app-auth-12345678", uid: "uid1" }]
          },
          spec: { nodeName: "node-worker-1" }
        },
        {
          metadata: {
            name: "app-auth-3",
            namespace: "auth",
            ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "app-auth-12345678", uid: "uid1" }]
          },
          spec: { nodeName: "node-worker-1" }
        },
        {
          metadata: {
            name: "app-payment-1",
            namespace: "finance",
            ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "app-payment-87654321", uid: "uid2" }]
          },
          spec: { nodeName: "node-worker-1" }
        },
        {
          metadata: {
            name: "app-payment-2",
            namespace: "finance",
            ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "app-payment-87654321", uid: "uid2" }]
          },
          spec: { nodeName: "node-worker-2" }
        },
        {
          metadata: {
            name: "app-frontend-1",
            namespace: "default",
            ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "app-frontend-77777777", uid: "uid3" }]
          },
          spec: {
            nodeName: "node-worker-1",
            affinity: { podAntiAffinity: {} }
          }
        },
        {
          metadata: {
            name: "app-frontend-2",
            namespace: "default",
            ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "app-frontend-77777777", uid: "uid3" }]
          },
          spec: {
            nodeName: "node-worker-2",
            affinity: { podAntiAffinity: {} }
          }
        },
        {
          metadata: {
            name: "app-frontend-3",
            namespace: "default",
            ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "app-frontend-77777777", uid: "uid3" }]
          },
          spec: {
            nodeName: "node-worker-3",
            affinity: { podAntiAffinity: {} }
          }
        },
        {
          metadata: {
            name: "leaked-app-1",
            namespace: "default",
            ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "leaked-app-66666666", uid: "uid4" }]
          },
          spec: { nodeName: "node-master-1" }
        },
        {
          metadata: {
            name: "kube-apiserver-node-master-1",
            namespace: "kube-system",
            ownerReferences: []
          },
          spec: { nodeName: "node-master-1" }
        },
        {
          metadata: {
            name: "aws-node-master-1",
            namespace: "kube-system",
            ownerReferences: [{ apiVersion: "apps/v1", kind: "DaemonSet", name: "aws-node", uid: "uid5" }]
          },
          spec: { nodeName: "node-master-1" }
        }
      ]
    }
    return []
  }
}



