/**
 * Hubble Relay gRPC 스트림 클라이언트 — 흐름(flow) 단위 실시간 트래픽.
 *
 * hubble-relay는 클러스터 기본 설정상 클라이언트 방향 TLS가 꺼져 있어
 * (disable-server-tls: true) insecure 채널로 접속한다. proto는 cilium
 * v1.19.3의 api/v1을 protos/ 아래에 벤더링했다 (observer/flow/relay).
 */
import path from "node:path"
import * as grpc from "@grpc/grpc-js"
import * as protoLoader from "@grpc/proto-loader"

const RELAY_ADDR = process.env.HUBBLE_RELAY_ADDR ?? "hubble-relay.kube-system.svc.cluster.local:80"

// GetFlows 응답에서 우리가 읽는 최소 필드 (keepCase: snake_case 유지)
export interface HubbleFlow {
  flow?: {
    verdict?: string
    is_reply?: { value?: boolean } | null
    source?: { namespace?: string; workloads?: Array<{ name?: string }> } | null
    destination?: { namespace?: string; workloads?: Array<{ name?: string }> } | null
  } | null
}

interface ObserverClient extends grpc.Client {
  GetFlows(request: Record<string, unknown>): grpc.ClientReadableStream<HubbleFlow>
}

let clientSingleton: ObserverClient | null = null

function getObserverClient(): ObserverClient {
  if (clientSingleton) return clientSingleton
  const protoDir = path.join(process.cwd(), "protos")
  const def = protoLoader.loadSync(path.join(protoDir, "observer", "observer.proto"), {
    includeDirs: [protoDir],
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  })
  const pkg = grpc.loadPackageDefinition(def) as unknown as {
    observer: { Observer: new (addr: string, creds: grpc.ChannelCredentials) => ObserverClient }
  }
  clientSingleton = new pkg.observer.Observer(RELAY_ADDR, grpc.credentials.createInsecure())
  return clientSingleton
}

export interface FlowStreamHandle {
  cancel: () => void
}

/**
 * FORWARDED 흐름을 follow 모드로 구독한다.
 * onFlow는 흐름마다, onError는 스트림 종료/오류 시 1회 호출.
 */
export function startFlowStream(
  onFlow: (flow: HubbleFlow) => void,
  onError: (err: Error) => void,
): FlowStreamHandle {
  const client = getObserverClient()
  const call = client.GetFlows({
    follow: true,
    whitelist: [{ verdict: ["FORWARDED"] }],
  })
  call.on("data", (msg: HubbleFlow) => {
    try {
      onFlow(msg)
    } catch {
      // 개별 흐름 처리 오류는 스트림을 끊지 않는다
    }
  })
  call.on("error", (err: Error) => {
    // 클라이언트 cancel 시에도 CANCELLED 에러가 오므로 호출부에서 무시 처리
    onError(err)
  })
  call.on("end", () => onError(new Error("hubble stream ended")))
  return { cancel: () => call.cancel() }
}
