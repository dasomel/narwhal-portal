import type { KisaControl } from "@/types/kisa"

export const KISA_CATALOG: Omit<KisaControl, "status" | "live" | "detail">[] = [
  {
    id: "KISA-CP-01",
    domain: "컨트롤플레인/API",
    title: "API 서버 감사 로그 활성화",
    severity: "Critical",
    standardRefs: ["CIS 1.2.x", "NSA/CISA §7", "ISMS-P 2.11"],
    evidence:
      "kube-apiserver 3/3에 --audit-log-path/--audit-policy-file 구성됨, /var/log/kubernetes/audit/audit.log 실기록+로테이션(maxage 30/backup 10/size 100). Falco는 2026-07-08 kernel 7.0 비호환으로 비활성화됨(감사 webhook 백엔드 없음은 유지되는 사실).",
    remediation: "감사 로그의 Loki 출하 연계(현재 파일 로컬 보관만)와 감사 정책 커버리지 점검.",
  },
  {
    id: "KISA-ETCD-01",
    domain: "etcd",
    title: "etcd 저장 데이터 암호화",
    severity: "Critical",
    standardRefs: ["CIS 2.x", "ISMS-P 2.7.1"],
    evidence:
      "EncryptionConfiguration aescbc 프로바이더 활성(identity 폴백 포함), apiserver --encryption-provider-config 적용됨.",
    remediation: "암호화 키 주기 로테이션 절차 수립 및 기존 시크릿 재암호화(kubectl replace) 주기화.",
  },
  {
    id: "KISA-SEC-01",
    domain: "시크릿",
    title: "OpenBao unseal 키 격리",
    severity: "Critical",
    standardRefs: ["NIST SP 800-190 §4.5", "ISMS-P 2.7"],
    evidence:
      "unseal Shamir 키가 OpenBao와 동일 네임스페이스 평문 K8s Secret(storage/openbao-init)에 저장.",
    remediation:
      "unseal 키를 클러스터 외부/KMS auto-unseal로 분리, 또는 별도 ns+RBAC 격리.",
  },
  {
    id: "KISA-ETCD-02",
    domain: "etcd",
    title: "APISIX etcd 접근 보호",
    severity: "High",
    standardRefs: ["CIS", "NSA/CISA"],
    evidence:
      "APISIX 설정 저장 etcd가 비인증 평문 HTTP(apisix-infra.yaml). OIDC client secret 경유.",
    remediation:
      "APISIX etcd에 TLS+인증, 또는 mesh 내부 한정+NetworkPolicy.",
  },
  {
    id: "KISA-IMG-01",
    domain: "이미지/공급망",
    title: "레지스트리 TLS 인증서 검증",
    severity: "High",
    standardRefs: ["NIST SP 800-190 §3.1", "KISA Docker #26"],
    evidence:
      "전 노드 containerd가 Harbor에 skip_verify=true(02-containerd.sh).",
    remediation: "Harbor CA를 노드 신뢰 스토어에 등록 후 skip_verify 제거.",
  },
  {
    id: "KISA-RBAC-01",
    domain: "RBAC/인증",
    title: "최소 권한·cluster-admin 통제",
    severity: "High",
    standardRefs: ["CIS 5.1", "NSA/CISA", "ISMS-P 2.6"],
    evidence:
      "이전에 지적된 온디맨드 kube-system cluster-admin SA는 제거됨 — headlamp(view), velero-ui(velero-ui-readonly+storage ns Role), platform-admin(와일드카드 없는 명시적 룰)로 최소권한 전환 완료. 남은 cluster-admin 바인딩은 velero-server(storage ns SA, Velero 업스트림 요구사항) 1건뿐(K8s 빌트인 제외).",
    remediation:
      "velero-server는 Velero 백업/복원 특성상 사실상 불가피 — 네임스페이스 스코프 Role 대체 가능 여부만 주기 검토, 신규 cluster-admin 직접부여 지양.",
  },
  {
    id: "KISA-TLS-01",
    domain: "TLS/mesh",
    title: "서비스 간 mTLS 적용 범위",
    severity: "High",
    standardRefs: ["NSA/CISA", "ISMS-P 2.7.1"],
    evidence:
      "메시 기본값은 STRICT(istio-system/default PeerAuthentication). 비-메시 클라이언트 연동을 위해 platform-system·database·devtools(harbor)·monitoring 4개 네임스페이스에 PERMISSIVE 예외 적용 중 — ArgoCD·Grafana·Harbor·OpenBao·APISIX 등 opt-out 서비스가 이 예외 범위에 포함됨.",
    remediation:
      "PERMISSIVE 네임스페이스별로 실제 비-메시 트래픽 경로를 재확인해 필요 최소 범위로 축소, 나머지는 STRICT 복귀 검토. 예외 구간은 NetworkPolicy+AuthorizationPolicy로 보완.",
  },
  {
    id: "KISA-POD-01",
    domain: "Pod 보안",
    title: "Pod Security Admission 적용",
    severity: "Medium",
    standardRefs: ["CIS 5.2", "Pod Security Standards"],
    evidence:
      "전 네임스페이스(14개)에 pod-security.kubernetes.io audit/warn 라벨 적용(앱 ns=baseline, 호스트 접근 ns=privileged). enforce 모드는 미적용.",
    remediation: "audit 위반 로그 관찰 후 단계적 enforce 승격.",
  },
  {
    id: "KISA-OBS-01",
    domain: "관측",
    title: "보안 이벤트 실시간 통지",
    severity: "Medium",
    standardRefs: ["ISMS-P 2.11.1", "KISA 운영관리"],
    evidence:
      "Alertmanager 수신자 미설정 — 알림 룰이 통지로 이어지지 않음.",
    remediation:
      "수신자(Slack/Email/webhook) 구성+보안 전용 룰(CVE, RBAC 이상탐지). Falco는 2026-07-08 kernel 7.0 비호환으로 비활성화 상태라 대체 시그널 필요.",
  },
  {
    id: "KISA-NET-01",
    domain: "네트워크",
    title: "Ingress default-deny",
    severity: "Medium",
    standardRefs: ["CIS 5.3", "NSA/CISA §4", "KISA 망분리"],
    evidence:
      "이전의 curated egress 허용목록 설계는 폐기되고(2026-07-09) iam·devtools·monitoring·storage·database 5개 네임스페이스에 egress 전체 허용(egress:[{}]) NetworkPolicy로 대체됨 — egress 통제는 사실상 무력화. ingress default-deny NetworkPolicy는 어느 네임스페이스에도 없어 pod 간 인바운드가 여전히 무제한.",
    remediation: "네임스페이스별 ingress default-deny + 명시적 허용 정책 추가. egress도 전체 허용 대신 대상별 최소 허용목록으로 재설계 검토.",
  },
  {
    id: "KISA-IMG-02",
    domain: "이미지/공급망",
    title: "이미지 태그·서명 관리",
    severity: "Low",
    standardRefs: ["NSA/CISA", "SLSA"],
    evidence:
      "클러스터 전체 실행 이미지(78종) 중 :latest 태그 0건 — Harbor(v2.15.1), 포털(1.0.4) 등 전량 불변 태그로 고정됨. 다만 Cosign 서명·검증은 여전히 부재하고, Kyverno disallow-latest-tag 정책도 Audit 모드라 재발 방지 기제는 없음.",
    remediation: "Kyverno disallow-latest-tag를 Audit→Enforce로 전환해 회귀 방지, Cosign 서명+verifyImages 도입.",
  },
  {
    id: "KISA-IMG-03",
    domain: "이미지/공급망",
    title: "이미지 취약점 점검·조치",
    severity: "High",
    standardRefs: ["NIST SP 800-190", "KISA 패치관리"],
    evidence: "Trivy Operator로 이미지 취약점 스캔 수행.",
    remediation: "Critical/High CVE 신속 패치.",
  },
  {
    id: "KISA-ADM-01",
    domain: "Admission/정책",
    title: "정책 강제(Policy-as-Code)",
    severity: "Medium",
    standardRefs: ["CIS", "KISA"],
    evidence: "Kyverno 정책 가동 중.",
    remediation: "fail-closed 전환·제외 ns 축소·Audit→Enforce.",
  },
  {
    id: "KISA-TLS-02",
    domain: "TLS/mesh",
    title: "인증서 수명·상태 관리",
    severity: "Medium",
    standardRefs: ["ISMS-P 2.7.1"],
    evidence: "cert-manager 인증서 발급/갱신.",
    remediation:
      "만료 임박 인증서 갱신, 10년 CA 수명 단축, 와일드카드 축소.",
  },
  {
    id: "KISA-RBAC-02",
    domain: "RBAC/인증",
    title: "RBAC 위험 바인딩 점검",
    severity: "Medium",
    standardRefs: ["CIS 5.1"],
    evidence: "라이브 RBAC 바인딩 위험도 평가.",
    remediation: "wildcard·권한상승 바인딩 제거.",
  },
  {
    id: "KISA-CFG-01",
    domain: "Admission/정책",
    title: "컴플라이언스 프레임워크 통과율",
    severity: "Medium",
    standardRefs: ["CIS", "NSA/CISA"],
    evidence: "Trivy ClusterComplianceReport(CIS/NSA) 평가.",
    remediation: "미통과 컨트롤 조치.",
  },
]
