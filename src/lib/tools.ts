import type { UserRole } from "./auth"

export interface PlatformTool {
  id: string
  name: string
  description: string
  url: string
  category: "gitops" | "source" | "registry" | "monitoring" | "infra" | "security" | "backup"
  icon: string
  roles: UserRole[]
}

function svgUri(svg: string): string {
  const b64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(svg).toString("base64")
      : btoa(svg)
  return `data:image/svg+xml;base64,${b64}`
}

const icons = {
  argocd: svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="50" fill="#EF7B4D"/>
      <circle cx="50" cy="42" r="21" fill="white"/>
      <circle cx="42" cy="38" r="5" fill="#EF7B4D"/>
      <circle cx="58" cy="38" r="5" fill="#EF7B4D"/>
      <path d="M50 63 Q50 58 50 63" stroke="white" stroke-width="1" fill="none"/>
      <path d="M32 74 C30 63 28 57 26 68" stroke="white" stroke-width="5" fill="none" stroke-linecap="round"/>
      <path d="M50 76 C50 64 50 58 50 70" stroke="white" stroke-width="5" fill="none" stroke-linecap="round"/>
      <path d="M68 74 C70 63 72 57 74 68" stroke="white" stroke-width="5" fill="none" stroke-linecap="round"/>
    </svg>`
  ),

  gitea: svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="20" fill="#609926"/>
      <path d="M27 42 L32 76 Q50 82 68 76 L73 42 Z" fill="white"/>
      <path d="M73 52 Q88 52 88 62 Q88 72 73 67" stroke="white" stroke-width="4" fill="none" stroke-linecap="round"/>
      <polygon points="34,42 26,24 46,36" fill="white"/>
      <polygon points="66,42 74,24 54,36" fill="white"/>
      <circle cx="41" cy="54" r="4" fill="#609926"/>
      <circle cx="59" cy="54" r="4" fill="#609926"/>
      <path d="M44 64 Q50 69 56 64" stroke="#609926" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    </svg>`
  ),

  harbor: svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="20" fill="#60B932"/>
      <rect x="44" y="18" width="12" height="46" fill="white"/>
      <rect x="36" y="18" width="28" height="10" rx="3" fill="#3A8A1A"/>
      <line x1="50" y1="23" x2="22" y2="10" stroke="white" stroke-width="2" opacity="0.9"/>
      <line x1="50" y1="23" x2="78" y2="10" stroke="white" stroke-width="2" opacity="0.9"/>
      <rect x="30" y="64" width="40" height="8" rx="3" fill="white"/>
      <path d="M18 80 Q28 74 38 80 Q48 86 58 80 Q68 74 78 80 Q84 84 88 81" stroke="white" stroke-width="3" fill="none" stroke-linecap="round"/>
    </svg>`
  ),

  grafana: svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="20" fill="#F46800"/>
      <circle cx="50" cy="50" r="30" fill="none" stroke="white" stroke-width="3"/>
      <circle cx="50" cy="50" r="6" fill="white"/>
      <line x1="50" y1="20" x2="50" y2="38" stroke="white" stroke-width="3"/>
      <line x1="50" y1="62" x2="50" y2="80" stroke="white" stroke-width="3"/>
      <line x1="20" y1="50" x2="38" y2="50" stroke="white" stroke-width="3"/>
      <line x1="62" y1="50" x2="80" y2="50" stroke="white" stroke-width="3"/>
      <line x1="29" y1="29" x2="42" y2="42" stroke="white" stroke-width="3"/>
      <line x1="58" y1="58" x2="71" y2="71" stroke="white" stroke-width="3"/>
      <line x1="71" y1="29" x2="58" y2="42" stroke="white" stroke-width="3"/>
      <line x1="29" y1="71" x2="42" y2="58" stroke="white" stroke-width="3"/>
    </svg>`
  ),

  prometheus: svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="20" fill="#E6522C"/>
      <path d="M50 12 C38 28 26 40 30 56 C33 66 42 72 50 72 C58 72 67 66 70 56 C74 40 62 28 50 12 Z" fill="white"/>
      <path d="M50 32 C44 42 40 50 43 58 C45 63 50 66 50 66 C50 66 55 63 57 58 C60 50 56 42 50 32 Z" fill="#E6522C"/>
      <rect x="34" y="76" width="32" height="6" rx="3" fill="white"/>
      <rect x="38" y="86" width="24" height="5" rx="2.5" fill="white"/>
    </svg>`
  ),

  alertmanager: svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="20" fill="#E6522C"/>
      <path d="M50 16 C33 16 22 30 22 46 L22 66 L78 66 L78 46 C78 30 67 16 50 16 Z" fill="white"/>
      <rect x="40" y="66" width="20" height="9" rx="3" fill="white"/>
      <circle cx="50" cy="82" r="7" fill="white"/>
      <rect x="47" y="30" width="6" height="22" rx="3" fill="#E6522C"/>
      <circle cx="50" cy="58" r="4" fill="#E6522C"/>
    </svg>`
  ),

  headlamp: svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="20" fill="#1B6AC9"/>
      <circle cx="50" cy="50" r="30" fill="none" stroke="white" stroke-width="4"/>
      <circle cx="50" cy="50" r="9" fill="white"/>
      <line x1="50" y1="20" x2="50" y2="34" stroke="white" stroke-width="4"/>
      <line x1="50" y1="66" x2="50" y2="80" stroke="white" stroke-width="4"/>
      <line x1="20" y1="50" x2="34" y2="50" stroke="white" stroke-width="4"/>
      <line x1="66" y1="50" x2="80" y2="50" stroke="white" stroke-width="4"/>
      <line x1="29" y1="29" x2="39" y2="39" stroke="white" stroke-width="4"/>
      <line x1="61" y1="61" x2="71" y2="71" stroke="white" stroke-width="4"/>
      <line x1="71" y1="29" x2="61" y2="39" stroke="white" stroke-width="4"/>
      <line x1="29" y1="71" x2="39" y2="61" stroke="white" stroke-width="4"/>
    </svg>`
  ),

  kubernetesDashboard: svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="20" fill="#326CE5"/>
      <path d="M50 22 L74 34 L74 58 L50 72 L26 58 L26 34 Z" fill="none" stroke="white" stroke-width="4" stroke-linejoin="round"/>
      <circle cx="50" cy="47" r="8" fill="white"/>
      <line x1="50" y1="47" x2="50" y2="26" stroke="white" stroke-width="3"/>
      <line x1="50" y1="47" x2="69" y2="55" stroke="white" stroke-width="3"/>
      <line x1="50" y1="47" x2="31" y2="55" stroke="white" stroke-width="3"/>
    </svg>`
  ),

  hubble: svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="20" fill="#1B1F23"/>
      <ellipse cx="50" cy="58" rx="15" ry="20" fill="#F5A623"/>
      <rect x="35" y="51" width="30" height="6" rx="2" fill="#1B1F23"/>
      <rect x="35" y="62" width="30" height="6" rx="2" fill="#1B1F23"/>
      <circle cx="50" cy="36" r="11" fill="#F5A623"/>
      <line x1="44" y1="26" x2="36" y2="16" stroke="#F5A623" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="35" cy="14" r="3.5" fill="#F5A623"/>
      <line x1="56" y1="26" x2="64" y2="16" stroke="#F5A623" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="65" cy="14" r="3.5" fill="#F5A623"/>
      <ellipse cx="31" cy="50" rx="13" ry="8" fill="white" opacity="0.55" transform="rotate(-25 31 50)"/>
      <ellipse cx="69" cy="50" rx="13" ry="8" fill="white" opacity="0.55" transform="rotate(25 69 50)"/>
    </svg>`
  ),

  openbao: svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="20" fill="#1D2630"/>
      <path d="M50 12 L82 26 L82 56 Q82 78 50 92 Q18 78 18 56 L18 26 Z" fill="none" stroke="#FFD700" stroke-width="3.5"/>
      <rect x="36" y="52" width="28" height="24" rx="5" fill="#FFD700"/>
      <path d="M42 52 L42 42 Q42 30 50 30 Q58 30 58 42 L58 52" fill="none" stroke="#FFD700" stroke-width="4.5" stroke-linecap="round"/>
      <circle cx="50" cy="62" r="5" fill="#1D2630"/>
      <rect x="47.5" y="62" width="5" height="8" fill="#1D2630"/>
    </svg>`
  ),

  velero: svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="20" fill="#0F1D3C"/>
      <line x1="50" y1="18" x2="50" y2="72" stroke="white" stroke-width="3.5"/>
      <polygon points="50,20 50,64 78,64" fill="white" opacity="0.92"/>
      <polygon points="50,26 50,58 26,58" fill="white" opacity="0.65"/>
      <path d="M22 72 Q36 80 50 76 Q64 80 78 72 L74 78 Q58 88 42 88 Q28 84 22 78 Z" fill="white"/>
      <path d="M12 86 Q24 80 36 86 Q48 92 60 86 Q72 80 88 86" stroke="#4A8FD4" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    </svg>`
  ),
}

// description field is kept as a fallback identifier; actual display text comes from i18n t(`tool.${id}`)
// SSO 직행 URL 정책: 클릭 즉시 Keycloak OIDC 플로우로 진입해 (포털 세션 보유 시)
// 자동 로그인되도록 각 도구의 OIDC 시작 엔드포인트를 직접 링크한다.
// - argocd: /auth/login (303 -> keycloak), gitea: /user/oauth2/keycloak,
//   grafana: /login/generic_oauth, harbor: /c/oidc/login (primary_auth_mode),
//   headlamp: /oidc?cluster=main (302 -> keycloak)
// - prometheus/alertmanager/hubble은 APISIX openid-connect 게이트가
//   루트에서 자동 SSO 처리하므로 기본 URL 유지.
// - openbao/velero-ui: 두 UI 모두 페이지 로드시 OIDC 자동 시작을 지원하지 않아
//   APISIX가 같은 오리진에 서빙하는 /sso 부트스트랩 페이지로 제로클릭 처리
//   (narwhal gitops/resources/apisix-routes.yaml openbao-sso / velero-ui-sso 참고).
//   velero-ui 백엔드 토큰 교환은 velero-ui.yaml의 NODE_EXTRA_CA_CERTS로 사설 CA 신뢰.
export const PLATFORM_TOOLS: PlatformTool[] = [
  { id: "argocd", name: "ArgoCD", description: "GitOps deployment management", url: "https://argocd.local.narwhal.internal/auth/login", category: "gitops", icon: icons.argocd, roles: ["cluster-admin", "developer"] },
  { id: "gitea", name: "Gitea", description: "Git source code repository", url: "https://gitea.local.narwhal.internal/gitea-admin/narwhal-gitops", category: "source", icon: icons.gitea, roles: ["cluster-admin", "developer"] },
  { id: "harbor", name: "Harbor", description: "Container image registry", url: "https://harbor.local.narwhal.internal/c/oidc/login", category: "registry", icon: icons.harbor, roles: ["cluster-admin", "developer"] },
  { id: "grafana", name: "Grafana", description: "Metrics dashboard", url: "https://grafana.local.narwhal.internal/login/generic_oauth", category: "monitoring", icon: icons.grafana, roles: ["cluster-admin", "developer", "viewer"] },
  { id: "prometheus", name: "Prometheus", description: "Metrics collection", url: "https://prometheus.local.narwhal.internal", category: "monitoring", icon: icons.prometheus, roles: ["cluster-admin"] },
  { id: "alertmanager", name: "Alertmanager", description: "Alert management", url: "https://alertmanager.local.narwhal.internal", category: "monitoring", icon: icons.alertmanager, roles: ["cluster-admin"] },
  { id: "headlamp", name: "Headlamp", description: "Kubernetes dashboard", url: "https://headlamp.local.narwhal.internal/oidc?cluster=main", category: "infra", icon: icons.headlamp, roles: ["cluster-admin", "developer"] },
  // 제로클릭 SSO: /sso 부트스트랩 페이지(APISIX serverless-pre-function)가 Keycloak
  // PKCE 로그인 → id_token(aud에 kubernetes) → Dashboard /api/v1/login → token 쿠키
  // 를 자동 처리 (narwhal gitops apisix-routes.yaml kubernetes-dashboard-sso 참고).
  { id: "kubernetes-dashboard", name: "Kubernetes Dashboard", description: "Official Kubernetes workloads dashboard", url: "https://dashboard.local.narwhal.internal/sso", category: "infra", icon: icons.kubernetesDashboard, roles: ["cluster-admin", "developer"] },
  { id: "hubble", name: "Hubble UI", description: "Cilium network visualization", url: "https://hubble.local.narwhal.internal", category: "infra", icon: icons.hubble, roles: ["cluster-admin"] },
  { id: "openbao", name: "OpenBao", description: "Secret management", url: "https://openbao.local.narwhal.internal/sso", category: "security", icon: icons.openbao, roles: ["cluster-admin"] },
  { id: "velero-ui", name: "Velero UI", description: "Backup/restore management", url: "https://velero-ui.local.narwhal.internal/sso", category: "backup", icon: icons.velero, roles: ["cluster-admin"] },
]

export function getToolsForRole(role: UserRole): PlatformTool[] {
  return PLATFORM_TOOLS.filter((t) => t.roles.includes(role))
}

export function getToolsByIds(ids: string[]): PlatformTool[] {
  return PLATFORM_TOOLS.filter((t) => ids.includes(t.id))
}
