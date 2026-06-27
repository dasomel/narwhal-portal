import type { KisaControl } from "@/types/kisa"

export const KISA_CATALOG: Omit<KisaControl, "status" | "live" | "detail">[] = [
  {
    id: "KISA-CP-01",
    domain: "컨트롤플레인/API",
    title: "API 서버 감사 로그 활성화",
    severity: "Critical",
    standardRefs: ["CIS 1.2.x", "NSA/CISA §7", "ISMS-P 2.11"],
    evidence:
      "kube-apiserver --audit-log-path/--audit-policy-file 부재. Falco k8s_audit 룰이 로드되나 audit webhook 백엔드 없음.",
    remediation: "감사 정책+로그 경로 설정 후 Loki로 출하.",
  },
  {
    id: "KISA-ETCD-01",
    domain: "etcd",
    title: "etcd 저장 데이터 암호화",
    severity: "Critical",
    standardRefs: ["CIS 2.x", "ISMS-P 2.7.1"],
    evidence:
      "--encryption-provider-config 부재 — Secret·ConfigMap이 etcd에 평문 저장.",
    remediation: "EncryptionConfiguration 적용 후 기존 Secret 재암호화.",
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
      "온디맨드로 kube-system에 cluster-admin SA+8760h 토큰 생성(set-config.sh).",
    remediation:
      "단명 토큰(TokenRequest)·작업 후 바인딩 회수·cluster-admin 직접부여 지양.",
  },
  {
    id: "KISA-TLS-01",
    domain: "TLS/mesh",
    title: "서비스 간 mTLS 적용 범위",
    severity: "High",
    standardRefs: ["NSA/CISA", "ISMS-P 2.7.1"],
    evidence:
      "ArgoCD·Grafana·Harbor·OpenBao·APISIX 등 핵심 서비스가 mTLS opt-out(dataplane-mode:none).",
    remediation:
      "opt-out 최소화, 불가 구간 NetworkPolicy 보완, AuthorizationPolicy 추가.",
  },
  {
    id: "KISA-POD-01",
    domain: "Pod 보안",
    title: "Pod Security Admission 적용",
    severity: "Medium",
    standardRefs: ["CIS 5.2", "Pod Security Standards"],
    evidence:
      "네임스페이스 PSA enforce 라벨 부재 — 워크로드 보안이 Kyverno 가동에만 의존.",
    remediation:
      "네임스페이스별 pod-security.kubernetes.io/enforce 라벨 부여(이중 방어).",
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
      "수신자(Slack/Email/webhook) 구성+보안 전용 룰(Falco critical, CVE).",
  },
  {
    id: "KISA-NET-01",
    domain: "네트워크",
    title: "Ingress default-deny",
    severity: "Medium",
    standardRefs: ["CIS 5.3", "NSA/CISA §4", "KISA 망분리"],
    evidence:
      "ingress NetworkPolicy 부재 — 클러스터 내 pod 간 인바운드 무제한.",
    remediation: "네임스페이스별 default-deny ingress+명시적 허용.",
  },
  {
    id: "KISA-IMG-02",
    domain: "이미지/공급망",
    title: "이미지 태그·서명 관리",
    severity: "Low",
    standardRefs: ["NSA/CISA", "SLSA"],
    evidence:
      ":latest 태그 다수, Cosign 서명·검증 부재, Kyverno :latest 정책이 Audit.",
    remediation: "Enforce 전환+다이제스트 핀, Kyverno verifyImages.",
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
