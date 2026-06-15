// Privileged 일회성 Job으로 노드 위에서 셸 스크립트 실행.
// nsenter를 통해 host PID/mount/network 네임스페이스로 진입 → host의 sysctl/modprobe/apt-get을 그대로 사용.

import "server-only"
import { K8S_API_SERVER } from "./config"
import { assertK8sNamespace, assertK8sNodeName, safeK8sSegment } from "./validation"
const K8S_TOKEN = process.env.K8S_SA_TOKEN ?? ""
const USE_BEARER = K8S_API_SERVER.startsWith("https://") && K8S_TOKEN.length > 0

const TUNING_NAMESPACE = process.env.TUNING_JOB_NAMESPACE ?? "devtools"
assertK8sNamespace(TUNING_NAMESPACE)

const DIGEST_IMAGE_RE = /^[^\s@:]+(?::[0-9]+)?\/[a-z0-9._\-/]+@sha256:[0-9a-f]{64}$/i

function getTuningImage(): string {
  const image = process.env.TUNING_JOB_IMAGE ?? ""
  if (!image || !DIGEST_IMAGE_RE.test(image)) {
    throw new Error(
      "TUNING_JOB_IMAGE env must be set to a digest-pinned image " +
        "(e.g. registry.example.com/narwhal/tuning@sha256:<64-hex>). " +
        "Tag-only references are rejected to prevent supply-chain tampering.",
    )
  }
  return image
}

async function k8sFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (USE_BEARER) headers.Authorization = `Bearer ${K8S_TOKEN}`
  const res = await fetch(`${K8S_API_SERVER}${path}`, { ...init, headers })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`K8s API ${res.status} ${path}: ${body.slice(0, 400)}`)
  }
  return res.json() as Promise<T>
}

async function k8sFetchText(path: string): Promise<string> {
  const headers: Record<string, string> = { Accept: "text/plain" }
  if (USE_BEARER) headers.Authorization = `Bearer ${K8S_TOKEN}`
  const res = await fetch(`${K8S_API_SERVER}${path}`, { headers })
  if (!res.ok) throw new Error(`K8s API ${res.status} ${path}`)
  return res.text()
}

async function deleteJob(namespace: string, name: string): Promise<void> {
  // propagationPolicy=Background로 Job + Pod 모두 정리.
  await fetch(
    `${K8S_API_SERVER}/apis/batch/v1/namespaces/${safeK8sSegment(namespace)}/jobs/${safeK8sSegment(name)}?propagationPolicy=Background`,
    {
      method: "DELETE",
      headers: USE_BEARER ? { Authorization: `Bearer ${K8S_TOKEN}` } : {},
    },
  ).catch(() => {})
}

interface JobStatus {
  status?: {
    succeeded?: number
    failed?: number
    conditions?: Array<{ type: string; status: string; message?: string }>
  }
}

interface PodList {
  items: Array<{ metadata: { name: string }; status: { phase: string } }>
}

export interface RunJobResult {
  ok: boolean
  logs: string
  jobName: string
}

export interface RunJobOptions {
  nodeName: string
  /** 셸 스크립트 본문. set -euo pipefail은 호출 측에서 포함시킬 것. */
  script: string
  /** 식별 라벨용 (예: "tuning"). 영문/숫자/하이픈만. */
  label?: string
  timeoutMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 지정 노드에서 셸 스크립트를 1회 실행.
 *  - hostPID + hostNetwork + privileged
 *  - nsenter로 host 네임스페이스 진입
 *  - 완료 시 로그 반환, Job 삭제
 *
 * 호출자는 RBAC 검증을 마친 후에만 호출할 것.
 */
export async function runHostJob(opts: RunJobOptions): Promise<RunJobResult> {
  assertK8sNodeName(opts.nodeName)
  const label = (opts.label ?? "tuning").replace(/[^a-z0-9-]/gi, "").toLowerCase() || "tuning"
  const jobName = `narwhal-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000

  // nsenter -t 1 -m -u -i -n -p sh -c "<script>"
  const wrapped = ["set -euo pipefail", opts.script].join("\n")

  const job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName,
      namespace: TUNING_NAMESPACE,
      labels: {
        "app.kubernetes.io/name": "narwhal-tuning",
        "app.kubernetes.io/component": label,
        "narwhal.io/node": opts.nodeName,
      },
    },
    spec: {
      ttlSecondsAfterFinished: 60,
      backoffLimit: 0,
      activeDeadlineSeconds: Math.ceil(timeoutMs / 1000),
      template: {
        metadata: {
          labels: {
            "app.kubernetes.io/name": "narwhal-tuning",
            "narwhal.io/job": jobName,
            "istio.io/dataplane-mode": "none",
          },
        },
        spec: {
          restartPolicy: "Never",
          hostPID: true,
          hostNetwork: true,
          nodeName: opts.nodeName,
          tolerations: [
            { operator: "Exists" },
          ],
          containers: [
            {
              name: "tuning",
              image: getTuningImage(),
              securityContext: { privileged: true },
              command: ["/bin/sh", "-c"],
              // /host/usr/bin/nsenter 마운트가 안 되니 alpine의 nsenter 사용 (util-linux 포함).
              // alpine 기본 이미지에는 nsenter가 없으므로 apk add 후 실행.
              args: [
                [
                  "apk add --no-cache util-linux >/dev/null 2>&1 || true",
                  `nsenter -t 1 -m -u -i -n -p -- sh -c ${JSON.stringify(wrapped)}`,
                ].join(" && "),
              ],
              resources: {
                requests: { cpu: "50m", memory: "64Mi" },
                limits: { cpu: "200m", memory: "128Mi" },
              },
            },
          ],
        },
      },
    },
  }

  // 1. Job 생성
  await k8sFetch(`/apis/batch/v1/namespaces/${safeK8sSegment(TUNING_NAMESPACE)}/jobs`, {
    method: "POST",
    body: JSON.stringify(job),
  })

  try {
    // 2. 완료 대기 (간단 폴링)
    const deadline = Date.now() + timeoutMs
    let succeeded = false
    let failed = false
    while (Date.now() < deadline) {
      await sleep(1500)
      const status = await k8sFetch<JobStatus>(
        `/apis/batch/v1/namespaces/${safeK8sSegment(TUNING_NAMESPACE)}/jobs/${safeK8sSegment(jobName)}`,
      )
      if (status.status?.succeeded && status.status.succeeded >= 1) { succeeded = true; break }
      if (status.status?.failed && status.status.failed >= 1) { failed = true; break }
    }

    // 3. Pod 로그 수집
    const pods = await k8sFetch<PodList>(
      `/api/v1/namespaces/${safeK8sSegment(TUNING_NAMESPACE)}/pods?labelSelector=narwhal.io/job%3D${encodeURIComponent(jobName)}`,
    )
    let logs = ""
    if (pods.items.length > 0) {
      try {
        logs = await k8sFetchText(
          `/api/v1/namespaces/${safeK8sSegment(TUNING_NAMESPACE)}/pods/${safeK8sSegment(pods.items[0].metadata.name)}/log`,
        )
      } catch (e) {
        logs = `(log fetch failed: ${(e as Error).message})`
      }
    } else {
      logs = "(no pod produced)"
    }

    if (succeeded) return { ok: true, logs, jobName }
    if (failed) return { ok: false, logs, jobName }
    return { ok: false, logs: `${logs}\n(timeout after ${timeoutMs}ms)`, jobName }
  } finally {
    await deleteJob(TUNING_NAMESPACE, jobName)
  }
}
