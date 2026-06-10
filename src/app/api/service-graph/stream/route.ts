import { NextRequest } from "next/server"
import { requireRole } from "@/lib/auth"
import { buildWorkloadToServiceMap, resolveWorkload } from "@/lib/service-graph"
import { startFlowStream } from "@/lib/hubble-stream"

export const dynamic = "force-dynamic"

// SSE: hubble-relay GetFlows(follow)를 구독해 2초 버킷으로 집계한
// {source, destination, flowsPerSec} 목록을 흘려보낸다.
// 서비스 ID는 그래프 API와 동일하게 resolveWorkload로 정규화한다.
const TICK_MS = 2_000

export async function GET(req: NextRequest) {
  const gate = await requireRole("cluster-admin", "developer", "viewer")
  if ("error" in gate) {
    return new Response(JSON.stringify({ error: gate.error === "unauthorized" ? "Unauthorized" : "Forbidden" }), {
      status: gate.error === "unauthorized" ? 401 : 403,
      headers: { "Content-Type": "application/json" },
    })
  }

  const serviceMap = await buildWorkloadToServiceMap()
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      const buckets = new Map<string, number>()
      let closed = false

      const safeClose = () => {
        if (closed) return
        closed = true
        clearInterval(tick)
        handle.cancel()
        try {
          controller.close()
        } catch {
          // 이미 닫힘
        }
      }

      const handle = startFlowStream(
        (msg) => {
          const flow = msg.flow
          if (!flow) return
          // 요청 방향만 집계 (응답 패킷 중복 제거)
          if (flow.is_reply?.value) return
          const srcW = flow.source?.workloads?.[0]?.name ?? ""
          const dstW = flow.destination?.workloads?.[0]?.name ?? ""
          if (!srcW || !dstW) return
          // waypoint Envoy 경유 구간은 원 흐름과 이중 집계되므로 제외
          if (srcW === "waypoint" || dstW === "waypoint") return
          const srcId = resolveWorkload(srcW, serviceMap)
          const dstId = resolveWorkload(dstW, serviceMap)
          if (!srcId || !dstId || srcId === dstId) return
          const key = `${srcId}|${dstId}`
          buckets.set(key, (buckets.get(key) ?? 0) + 1)
        },
        () => {
          // 스트림 오류/종료 — 클라이언트(EventSource)가 자동 재연결한다
          safeClose()
        },
      )

      const tick = setInterval(() => {
        if (closed) return
        const edges = Array.from(buckets.entries()).map(([key, count]) => {
          const [source, destination] = key.split("|")
          return { source, destination, flowsPerSec: Math.round((count / (TICK_MS / 1000)) * 10) / 10 }
        })
        buckets.clear()
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ts: Date.now(), edges })}\n\n`))
        } catch {
          safeClose()
        }
      }, TICK_MS)

      req.signal.addEventListener("abort", safeClose)
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx/APISIX 계열 버퍼링 방지 (SSE 즉시 전달)
      "X-Accel-Buffering": "no",
    },
  })
}
