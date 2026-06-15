// 보안/컴플라이언스 검사 식별자 → 한글 매핑 사전.
// 매칭되지 않으면 업스트림 영문 fallback. 분기별 추가 권장.

import type { Locale } from "./i18n"

export interface CheckTranslation {
  title: { ko: string; en?: string }
  description?: { ko: string; en?: string }
  remediation?: { ko: string; en?: string }
}

// Trivy AVD-KSV (Kubernetes Security) — https://avd.aquasec.com/misconfig/kubernetes/
export const KSV_TRANSLATIONS: Record<string, CheckTranslation> = {
  KSV001: { title: { ko: "프로세스 권한 상승 차단" }, description: { ko: "컨테이너가 SecurityContext.allowPrivilegeEscalation=false 로 실행되어야 합니다." }, remediation: { ko: "Pod spec에 securityContext.allowPrivilegeEscalation: false 추가" } },
  KSV002: { title: { ko: "AppArmor 프로필 미설정" }, description: { ko: "기본 AppArmor 프로필 대신 명시적 프로필을 설정해 호스트 격리를 강화하세요." }, remediation: { ko: "annotation: container.apparmor.security.beta.kubernetes.io/<container>=runtime/default" } },
  KSV003: { title: { ko: "기본 capability 모두 제거" }, description: { ko: "컨테이너는 모든 Linux capability를 drop하고 필요한 것만 add 해야 합니다." }, remediation: { ko: "securityContext.capabilities.drop: [\"ALL\"], add는 최소화" } },
  KSV005: { title: { ko: "SYS_ADMIN capability 금지" }, description: { ko: "SYS_ADMIN은 root 동등 권한으로 사용을 금지합니다." }, remediation: { ko: "capabilities.add 에서 SYS_ADMIN 제거" } },
  KSV006: { title: { ko: "Docker socket 마운트 금지" }, description: { ko: "/var/run/docker.sock 마운트는 호스트 컨테이너 제어 권한을 노출합니다." }, remediation: { ko: "volumes에서 hostPath /var/run/docker.sock 제거" } },
  KSV008: { title: { ko: "host IPC 네임스페이스 공유 금지" }, description: { ko: "hostIPC: true 는 호스트 IPC 자원에 접근 가능하게 합니다." }, remediation: { ko: "spec.hostIPC: false (기본값) 유지" } },
  KSV009: { title: { ko: "host network 공유 금지" }, description: { ko: "hostNetwork: true 는 컨테이너가 호스트 네트워크 스택을 직접 사용합니다." }, remediation: { ko: "spec.hostNetwork: false 유지" } },
  KSV010: { title: { ko: "host PID 네임스페이스 공유 금지" }, description: { ko: "hostPID: true 는 호스트 프로세스 가시성을 부여합니다." }, remediation: { ko: "spec.hostPID: false 유지" } },
  KSV011: { title: { ko: "CPU 제한 미설정" }, description: { ko: "컨테이너에 CPU limit이 없으면 노드 자원 고갈을 유발할 수 있습니다." }, remediation: { ko: "resources.limits.cpu 명시" } },
  KSV012: { title: { ko: "비-root 사용자로 실행" }, description: { ko: "runAsNonRoot=true 로 root 권한 컨테이너 실행을 방지하세요." }, remediation: { ko: "securityContext.runAsNonRoot: true + runAsUser: <비-root UID>" } },
  KSV013: { title: { ko: "이미지 태그 latest 금지" }, description: { ko: "예측 가능한 배포를 위해 latest 대신 고정 태그/digest 사용." }, remediation: { ko: "image: repo:vX.Y.Z 또는 repo@sha256:..." } },
  KSV014: { title: { ko: "읽기 전용 root 파일시스템" }, description: { ko: "readOnlyRootFilesystem=true 로 컨테이너 임의 쓰기 방어." }, remediation: { ko: "securityContext.readOnlyRootFilesystem: true (필요 시 emptyDir 마운트)" } },
  KSV015: { title: { ko: "CPU 요청 미설정" }, description: { ko: "CPU request가 없으면 스케줄러가 적정 노드를 선택하기 어렵습니다." }, remediation: { ko: "resources.requests.cpu 명시" } },
  KSV016: { title: { ko: "메모리 요청 미설정" }, description: { ko: "메모리 request 없이 동작 시 OOM 위험." }, remediation: { ko: "resources.requests.memory 명시" } },
  KSV017: { title: { ko: "privileged 컨테이너 금지" }, description: { ko: "privileged=true 는 모든 capability + 호스트 디바이스 접근을 부여합니다." }, remediation: { ko: "securityContext.privileged: false (기본값) 유지" } },
  KSV018: { title: { ko: "메모리 제한 미설정" }, description: { ko: "메모리 limit 없으면 노드 OOM 캐스케이드 위험." }, remediation: { ko: "resources.limits.memory 명시" } },
  KSV020: { title: { ko: "호스트 사용자 ID 사용 금지" }, description: { ko: "runAsUser=0 (root) 사용을 금지합니다." }, remediation: { ko: "runAsUser는 1000 이상 비-root UID로" } },
  KSV021: { title: { ko: "호스트 그룹 ID 사용 금지" }, description: { ko: "runAsGroup=0 (root group) 사용을 금지합니다." }, remediation: { ko: "runAsGroup은 1000 이상" } },
  KSV022: { title: { ko: "민감 capability 추가 금지" }, description: { ko: "AUDIT_WRITE, CHOWN 등 민감 capability를 add 하지 마세요." }, remediation: { ko: "capabilities.add 검토 + 최소화" } },
  KSV023: { title: { ko: "호스트 경로 마운트 금지" }, description: { ko: "hostPath 마운트는 호스트 파일시스템을 노출합니다." }, remediation: { ko: "PVC/emptyDir/configMap 등 사용" } },
  KSV024: { title: { ko: "호스트 포트 사용 금지" }, description: { ko: "hostPort 노출은 호스트 네트워크에 직접 바인딩합니다." }, remediation: { ko: "Service(NodePort/LoadBalancer) 사용" } },
  KSV025: { title: { ko: "SELinux 옵션 명시" }, description: { ko: "SELinux 컨텍스트를 컨테이너별 명시해 격리를 강화하세요." }, remediation: { ko: "securityContext.seLinuxOptions 설정" } },
  KSV027: { title: { ko: "프로세스 마운트 옵션 명시" }, description: { ko: "procMount=Default 외 사용 시 호스트 정보 노출 위험." }, remediation: { ko: "procMount: Default (기본값) 유지" } },
  KSV028: { title: { ko: "기본 deny capability 정책" }, description: { ko: "기본 NET_RAW 등 capability 사용을 명시 차단합니다." }, remediation: { ko: "capabilities.drop: [\"NET_RAW\", \"ALL\"]" } },
  KSV029: { title: { ko: "외부 IP 가진 Service 차단" }, description: { ko: "Service.spec.externalIPs는 트래픽 가로채기 가능성." }, remediation: { ko: "Ingress/Gateway API로 외부 노출 관리" } },
  KSV030: { title: { ko: "Seccomp 프로필 RuntimeDefault" }, description: { ko: "Seccomp 프로필을 RuntimeDefault 이상으로 설정하세요." }, remediation: { ko: "securityContext.seccompProfile.type: RuntimeDefault" } },
  KSV032: { title: { ko: "신뢰 레지스트리 이미지" }, description: { ko: "사내 신뢰 레지스트리(예: Harbor)에서만 이미지를 pull 하세요." }, remediation: { ko: "ImagePolicyWebhook 또는 Kyverno로 레지스트리 화이트리스트" } },
  KSV033: { title: { ko: "Helm 차트 배포자 신뢰" }, description: { ko: "신뢰할 수 없는 Helm 차트 사용 금지." }, remediation: { ko: "ArgoCD repoURL 화이트리스트" } },
  KSV034: { title: { ko: "특정 capability add 차단" }, description: { ko: "AUDIT_CONTROL, BLOCK_SUSPEND 등 특수 capability 차단." }, remediation: { ko: "capabilities.add 빈 배열 또는 명시적 안전 목록만" } },
  KSV035: { title: { ko: "wildcard 호스트 네임 차단" }, description: { ko: "Ingress/Route hosts에 wildcard 사용을 제한합니다." }, remediation: { ko: "정확한 도메인 명시" } },
  KSV036: { title: { ko: "기본 ServiceAccount 사용 금지" }, description: { ko: "default SA 사용은 권한 명시성을 떨어뜨립니다." }, remediation: { ko: "전용 ServiceAccount 생성 + spec.serviceAccountName 지정" } },
  KSV037: { title: { ko: "kube-system Pod 차단" }, description: { ko: "kube-system 네임스페이스에 사용자 워크로드 배포 금지." }, remediation: { ko: "전용 네임스페이스 사용" } },
  KSV038: { title: { ko: "namespace 제한" }, description: { ko: "허용된 namespace에서만 Pod 생성." }, remediation: { ko: "RBAC 또는 Kyverno 정책으로 제한" } },
  KSV039: { title: { ko: "Pod 리소스 limit 강제" }, description: { ko: "LimitRange 미설정 시 Pod가 노드 자원을 점유." }, remediation: { ko: "LimitRange/ResourceQuota 적용" } },
  KSV040: { title: { ko: "Pod 리소스 request 강제" }, description: { ko: "request 없는 Pod는 BestEffort QoS로 분류되어 우선 eviction." }, remediation: { ko: "resources.requests 모든 컨테이너에 설정" } },
  KSV041: { title: { ko: "Secret get 권한 광범위" }, description: { ko: "Role/ClusterRole의 secrets get 권한을 최소화하세요." }, remediation: { ko: "verbs는 list/watch만, get은 특정 resourceNames에만 부여" } },
  KSV042: { title: { ko: "ConfigMap 광범위 접근" }, description: { ko: "configmaps에 대한 광범위 권한은 민감 데이터 노출 위험." }, remediation: { ko: "특정 configmap 이름에 대해서만 권한 부여" } },
  KSV050: { title: { ko: "비표준 컨테이너 런타임 클래스" }, description: { ko: "검증되지 않은 RuntimeClass 사용을 금지합니다." }, remediation: { ko: "RuntimeClass 화이트리스트 + Kyverno 검증" } },
  KSV104: { title: { ko: "Seccomp Localhost 프로필 권장" }, description: { ko: "RuntimeDefault 외 Localhost 커스텀 프로필 사용 가능." }, remediation: { ko: "seccompProfile.type: Localhost + localhostProfile 경로 지정" } },
  KSV106: { title: { ko: "ServiceAccount 토큰 자동 마운트 금지" }, description: { ko: "필요 없는 Pod에 SA 토큰 자동 마운트는 권한 노출." }, remediation: { ko: "automountServiceAccountToken: false (Pod 또는 SA 레벨)" } },
}

// CIS Kubernetes Benchmark v1.23 — 116 controls. Title only (description은 양 절약).
export const CIS_TRANSLATIONS: Record<string, CheckTranslation> = {
  // 1.1 제어 평면 노드 — 파일 권한 및 소유권
  "1.1.1": { title: { ko: "API 서버 Pod 매니페스트 파일 권한 600 이하" } },
  "1.1.2": { title: { ko: "API 서버 Pod 매니페스트 파일 소유자 root:root" } },
  "1.1.3": { title: { ko: "controller-manager Pod 매니페스트 파일 권한 600 이하" } },
  "1.1.4": { title: { ko: "controller-manager Pod 매니페스트 파일 소유자 root:root" } },
  "1.1.5": { title: { ko: "scheduler Pod 매니페스트 파일 권한 600 이하" } },
  "1.1.6": { title: { ko: "scheduler Pod 매니페스트 파일 소유자 root:root" } },
  "1.1.7": { title: { ko: "etcd Pod 매니페스트 파일 권한 600 이하" } },
  "1.1.8": { title: { ko: "etcd Pod 매니페스트 파일 소유자 root:root" } },
  "1.1.9": { title: { ko: "CNI 설정 파일 권한 600 이하" } },
  "1.1.10": { title: { ko: "CNI 설정 파일 소유자 root:root" } },
  "1.1.11": { title: { ko: "etcd 데이터 디렉토리 권한 700 이하" } },
  "1.1.12": { title: { ko: "etcd 데이터 디렉토리 소유자 etcd:etcd" } },
  "1.1.13": { title: { ko: "admin.conf 파일 권한 600" } },
  "1.1.14": { title: { ko: "admin.conf 파일 소유자 root:root" } },
  "1.1.15": { title: { ko: "scheduler.conf 파일 권한 600 이하" } },
  "1.1.16": { title: { ko: "scheduler.conf 파일 소유자 root:root" } },
  "1.1.17": { title: { ko: "controller-manager.conf 파일 권한 600 이하" } },
  "1.1.18": { title: { ko: "controller-manager.conf 파일 소유자 root:root" } },
  "1.1.19": { title: { ko: "Kubernetes PKI 디렉토리/파일 소유자 root:root" } },
  "1.1.20": { title: { ko: "Kubernetes PKI 인증서 파일 권한 600 이하" } },
  "1.1.21": { title: { ko: "Kubernetes PKI 키 파일 권한 600" } },

  // 1.2 API 서버
  "1.2.1": { title: { ko: "--anonymous-auth false 설정" } },
  "1.2.2": { title: { ko: "--token-auth-file 미설정" } },
  "1.2.3": { title: { ko: "--DenyServiceExternalIPs 미설정" } },
  "1.2.4": { title: { ko: "--kubelet-https true 설정" } },
  "1.2.5": { title: { ko: "--kubelet-client-certificate / --kubelet-client-key 적절히 설정" } },
  "1.2.6": { title: { ko: "--kubelet-certificate-authority 적절히 설정" } },
  "1.2.7": { title: { ko: "--authorization-mode 가 AlwaysAllow 아님" } },
  "1.2.8": { title: { ko: "--authorization-mode 에 Node 포함" } },
  "1.2.9": { title: { ko: "--authorization-mode 에 RBAC 포함" } },
  "1.2.10": { title: { ko: "EventRateLimit admission plugin 활성" } },
  "1.2.11": { title: { ko: "AlwaysAdmit admission plugin 비활성" } },
  "1.2.12": { title: { ko: "AlwaysPullImages admission plugin 활성" } },
  "1.2.13": { title: { ko: "PSP 미사용 시 SecurityContextDeny admission plugin 활성" } },
  "1.2.14": { title: { ko: "ServiceAccount admission plugin 활성" } },
  "1.2.15": { title: { ko: "NamespaceLifecycle admission plugin 활성" } },
  "1.2.16": { title: { ko: "NodeRestriction admission plugin 활성" } },
  "1.2.17": { title: { ko: "--secure-port 가 0 아님" } },
  "1.2.18": { title: { ko: "--profiling false 설정" } },
  "1.2.19": { title: { ko: "--audit-log-path 설정" } },
  "1.2.20": { title: { ko: "--audit-log-maxage 30 이상 설정" } },
  "1.2.21": { title: { ko: "--audit-log-maxbackup 10 이상 설정" } },
  "1.2.22": { title: { ko: "--audit-log-maxsize 100 이상 설정" } },
  "1.2.24": { title: { ko: "--service-account-lookup true 설정" } },
  "1.2.25": { title: { ko: "--service-account-key-file 적절히 설정" } },
  "1.2.26": { title: { ko: "--etcd-certfile / --etcd-keyfile 적절히 설정" } },
  "1.2.27": { title: { ko: "--tls-cert-file / --tls-private-key-file 적절히 설정" } },
  "1.2.28": { title: { ko: "--client-ca-file 적절히 설정" } },
  "1.2.29": { title: { ko: "--etcd-cafile 적절히 설정" } },
  "1.2.30": { title: { ko: "--encryption-provider-config 적절히 설정" } },

  // 1.3 controller-manager
  "1.3.1": { title: { ko: "--terminated-pod-gc-threshold 적절히 설정" } },
  "1.3.3": { title: { ko: "--use-service-account-credentials true 설정" } },
  "1.3.4": { title: { ko: "--service-account-private-key-file 적절히 설정" } },
  "1.3.5": { title: { ko: "--root-ca-file 적절히 설정" } },
  "1.3.6": { title: { ko: "RotateKubeletServerCertificate true 설정" } },
  "1.3.7": { title: { ko: "--bind-address 127.0.0.1 설정" } },

  // 1.4 scheduler
  "1.4.1": { title: { ko: "--profiling false 설정 (scheduler)" } },
  "1.4.2": { title: { ko: "--bind-address 127.0.0.1 설정 (scheduler)" } },

  // 2 etcd
  "2.1": { title: { ko: "--cert-file / --key-file 적절히 설정" } },
  "2.2": { title: { ko: "--client-cert-auth true 설정" } },
  "2.3": { title: { ko: "--auto-tls true 미설정" } },
  "2.4": { title: { ko: "--peer-cert-file / --peer-key-file 적절히 설정" } },
  "2.5": { title: { ko: "--peer-client-cert-auth true 설정" } },
  "2.6": { title: { ko: "--peer-auto-tls true 미설정" } },

  // 3 제어 평면 설정
  "3.1.1": { title: { ko: "사용자에게 클라이언트 인증서 사용 금지 (Manual)" } },
  "3.2.1": { title: { ko: "최소 audit policy 생성 (Manual)" } },
  "3.2.2": { title: { ko: "audit policy가 핵심 보안 사항 포함 (Manual)" } },

  // 4.1 워커 노드 — kubelet 파일
  "4.1.1": { title: { ko: "kubelet 서비스 파일 권한 600 이하" } },
  "4.1.2": { title: { ko: "kubelet 서비스 파일 소유자 root:root" } },
  "4.1.3": { title: { ko: "kube-proxy kubeconfig 파일 권한 600 이하" } },
  "4.1.4": { title: { ko: "kube-proxy kubeconfig 파일 소유자 root:root" } },
  "4.1.5": { title: { ko: "kubelet.conf 파일 권한 600 이하" } },
  "4.1.6": { title: { ko: "kubelet.conf 파일 소유자 root:root" } },
  "4.1.7": { title: { ko: "CA 인증서 파일 권한 600 이하" } },
  "4.1.8": { title: { ko: "CA 인증서 파일 소유자 root:root" } },
  "4.1.9": { title: { ko: "kubelet config.yaml 파일 권한 600 이하" } },
  "4.1.10": { title: { ko: "kubelet config.yaml 파일 소유자 root:root" } },

  // 4.2 워커 노드 — kubelet 인자
  "4.2.1": { title: { ko: "--anonymous-auth false 설정 (kubelet)" } },
  "4.2.2": { title: { ko: "--authorization-mode 가 AlwaysAllow 아님 (kubelet)" } },
  "4.2.3": { title: { ko: "--client-ca-file 적절히 설정 (kubelet)" } },
  "4.2.4": { title: { ko: "--read-only-port 0 설정" } },
  "4.2.5": { title: { ko: "--streaming-connection-idle-timeout 0 아님" } },
  "4.2.6": { title: { ko: "--protect-kernel-defaults true 설정" } },
  "4.2.7": { title: { ko: "--make-iptables-util-chains true 설정" } },
  "4.2.8": { title: { ko: "--hostname-override 미설정" } },
  "4.2.9": { title: { ko: "--event-qps 적절히 설정" } },
  "4.2.10": { title: { ko: "--tls-cert-file / --tls-private-key-file 적절히 설정 (kubelet)" } },
  "4.2.11": { title: { ko: "--rotate-certificates false 아님" } },
  "4.2.12": { title: { ko: "RotateKubeletServerCertificate true 설정 (kubelet)" } },
  "4.2.13": { title: { ko: "kubelet은 강력한 암호 cipher 만 사용" } },

  // 5.1 RBAC
  "5.1.1": { title: { ko: "cluster-admin 역할 사용 최소화" } },
  "5.1.2": { title: { ko: "secrets 접근 최소화" } },
  "5.1.3": { title: { ko: "Role/ClusterRole 의 wildcard 사용 최소화" } },
  "5.1.6": { title: { ko: "ServiceAccount 토큰 마운트 최소화" } },
  "5.1.8": { title: { ko: "Bind/Impersonate/Escalate 권한 사용 최소화" } },

  // 5.2 Pod Security Standards
  "5.2.2": { title: { ko: "privileged 컨테이너 admission 최소화" } },
  "5.2.3": { title: { ko: "host PID namespace 공유 컨테이너 admission 최소화" } },
  "5.2.4": { title: { ko: "host IPC namespace 공유 컨테이너 admission 최소화" } },
  "5.2.5": { title: { ko: "host network namespace 공유 컨테이너 admission 최소화" } },
  "5.2.6": { title: { ko: "allowPrivilegeEscalation 컨테이너 admission 최소화" } },
  "5.2.7": { title: { ko: "root 사용자 컨테이너 admission 최소화" } },
  "5.2.8": { title: { ko: "NET_RAW capability 컨테이너 admission 최소화" } },
  "5.2.9": { title: { ko: "추가 capability 컨테이너 admission 최소화" } },
  "5.2.10": { title: { ko: "capability 부여된 컨테이너 admission 최소화" } },
  "5.2.11": { title: { ko: "capability 부여된 컨테이너 admission 최소화 (재)" } },
  "5.2.12": { title: { ko: "HostPath 볼륨 admission 최소화" } },
  "5.2.13": { title: { ko: "HostPort 사용 컨테이너 admission 최소화" } },

  // 5.3 네트워크
  "5.3.1": { title: { ko: "CNI가 NetworkPolicy 지원 (Manual)" } },
  "5.3.2": { title: { ko: "모든 네임스페이스에 NetworkPolicy 정의" } },

  // 5.4 시크릿
  "5.4.1": { title: { ko: "환경변수보다 파일로 secret 마운트 선호 (Manual)" } },
  "5.4.2": { title: { ko: "외부 secret 저장소 고려 (Manual)" } },

  // 5.5 이미지 출처
  "5.5.1": { title: { ko: "ImagePolicyWebhook admission controller로 이미지 출처 검증 (Manual)" } },

  // 5.7 일반 정책
  "5.7.1": { title: { ko: "namespace로 자원 간 관리 경계 생성 (Manual)" } },
  "5.7.2": { title: { ko: "Pod에 docker/default seccomp 프로필 설정" } },
  "5.7.3": { title: { ko: "Pod와 컨테이너에 SecurityContext 적용" } },
  "5.7.4": { title: { ko: "default 네임스페이스 사용 금지" } },
}

export const FALCO_TRANSLATIONS: Record<string, CheckTranslation> = {
  "Terminal shell in container": { title: { ko: "컨테이너에서 터미널 셸 실행" }, description: { ko: "컨테이너 내부에서 인터랙티브 셸이 실행되었습니다. 침투 또는 디버깅 시도 가능성." } },
  "Run shell untrusted": { title: { ko: "신뢰할 수 없는 셸 실행" }, description: { ko: "비표준 위치에서 셸이 실행되었습니다. 악성 행위 가능성." } },
  "Contact K8S API Server From Container": { title: { ko: "컨테이너에서 K8s API 서버 직접 호출" }, description: { ko: "컨테이너가 kube-apiserver에 직접 접근했습니다. 권한 상승 시도 가능성." } },
  "Packet socket created in container": { title: { ko: "컨테이너에서 패킷 소켓 생성" }, description: { ko: "raw 네트워크 패킷 소켓 생성. 패킷 스니핑/주입 가능성." } },
  "Read sensitive file untrusted": { title: { ko: "민감 파일 읽기 (비신뢰)" }, description: { ko: "/etc/shadow 등 민감 파일을 신뢰할 수 없는 프로세스가 읽었습니다." } },
  "Read sensitive file trusted after startup": { title: { ko: "시작 후 민감 파일 읽기 (신뢰)" }, description: { ko: "신뢰 프로세스라도 시작 후 민감 파일 접근은 비정상 패턴." } },
  "Write below etc": { title: { ko: "/etc 하위 쓰기" }, description: { ko: "/etc 하위에 파일 쓰기. 시스템 설정 변조 시도 가능성." } },
  "Write below root": { title: { ko: "/root 하위 쓰기" }, description: { ko: "/root 디렉토리 하위에 파일 쓰기. 권한 상승 페이로드 의심." } },
  "Write below binary dir": { title: { ko: "바이너리 디렉토리 쓰기" }, description: { ko: "/usr/bin, /usr/sbin 등 바이너리 경로에 쓰기. 백도어 설치 의심." } },
  "Modify shell configuration file": { title: { ko: "셸 설정 파일 변조" }, description: { ko: ".bashrc, .profile 등 셸 설정 파일 수정. 지속성 확보 시도." } },
  "Mount on local file system": { title: { ko: "로컬 파일시스템 마운트" }, description: { ko: "컨테이너 내부에서 mount 호출. 호스트 자원 접근 시도." } },
  "Schedule cron jobs": { title: { ko: "cron 작업 등록" }, description: { ko: "/etc/cron.* 또는 crontab 수정. 지속성 확보 시도." } },
  "Outbound or inbound traffic not to authorized server": { title: { ko: "비인가 서버와의 트래픽" }, description: { ko: "허용 목록에 없는 외부 IP/도메인과 통신." } },
  "Unexpected K8s NodePort connection": { title: { ko: "예상치 못한 NodePort 연결" }, description: { ko: "비표준 NodePort 트래픽 감지. 익스포즈 우회 가능성." } },
  "K8s deployment created": { title: { ko: "K8s Deployment 생성" }, description: { ko: "audit 추적용. 의도된 배포가 아니면 권한 검토 필요." } },
  "K8s deployment deleted": { title: { ko: "K8s Deployment 삭제" }, description: { ko: "audit 추적용. 의도되지 않은 삭제는 즉시 조사." } },
  "K8s namespace created": { title: { ko: "K8s 네임스페이스 생성" }, description: { ko: "audit 추적용." } },
  "Detect crypto miners using stratum protocol": { title: { ko: "암호화폐 채굴(Stratum) 탐지" }, description: { ko: "stratum+tcp:// 프로토콜 통신 감지. 채굴 멀웨어 강력 의심." } },
  "Disallowed K8s User": { title: { ko: "비인가 K8s 사용자 액션" }, description: { ko: "허용되지 않은 사용자가 클러스터 자원에 접근/변경." } },
  "Update package repository": { title: { ko: "패키지 저장소 업데이트" }, description: { ko: "apt-get update 등 컨테이너 내 저장소 갱신. 멀웨어 다운로드 준비 의심." } },
  "Launch ingress remote file copy tools in container": { title: { ko: "원격 파일 복사 도구 실행" }, description: { ko: "wget, curl, scp 등 외부 다운로드 도구 실행." } },
  "Suspicious Cron Modification": { title: { ko: "의심스러운 cron 변조" }, description: { ko: "비정상 패턴의 cron 항목 추가/변경." } },
  "Drop and execute new binary in container": { title: { ko: "신규 바이너리 드롭 + 실행" }, description: { ko: "컨테이너 시작 후 새 실행 파일을 떨어뜨려 실행. RCE 후속 행위 의심." } },
  "Search Private Keys or Passwords": { title: { ko: "비밀 키/비밀번호 검색" }, description: { ko: "id_rsa, .ssh, password 등 키워드로 파일 시스템 검색." } },
  "DB program spawned process": { title: { ko: "DB 프로세스의 자식 프로세스 생성" }, description: { ko: "MySQL/Postgres 등이 비정상적으로 자식 프로세스를 생성." } },
  "Java Process Class File Download": { title: { ko: "Java 프로세스의 클래스 파일 다운로드" }, description: { ko: "JVM이 외부에서 .class 파일 다운로드. Log4Shell 류 익스플로잇 의심." } },
  "User mgmt binaries": { title: { ko: "사용자 관리 바이너리 실행" }, description: { ko: "useradd, usermod 등 사용자 관리 명령 실행. 백도어 사용자 생성 의심." } },
  "Create Hidden Files or Directories": { title: { ko: "숨김 파일/디렉토리 생성" }, description: { ko: "닷(.)으로 시작하는 비표준 경로 생성. 은닉 시도 의심." } },
  "The docker client is executed in a container": { title: { ko: "컨테이너 내 docker 클라이언트 실행" }, description: { ko: "docker socket 마운트 + 컨테이너 탈출 시도 가능성." } },
  "Launch Privileged Container": { title: { ko: "privileged 컨테이너 실행" }, description: { ko: "privileged=true 컨테이너 시작. 호스트 동등 권한 부여." } },
}

export function translateTitle(domain: "ksv" | "cis" | "falco", id: string, fallback: string, locale: Locale): string {
  const dict = domain === "ksv" ? KSV_TRANSLATIONS : domain === "cis" ? CIS_TRANSLATIONS : FALCO_TRANSLATIONS
  const entry = dict[id]
  if (!entry) return fallback
  return entry.title[locale] ?? entry.title.en ?? fallback
}

export function translateDescription(domain: "ksv" | "cis" | "falco", id: string, fallback: string | undefined, locale: Locale): string | undefined {
  const dict = domain === "ksv" ? KSV_TRANSLATIONS : domain === "cis" ? CIS_TRANSLATIONS : FALCO_TRANSLATIONS
  const entry = dict[id]?.description
  if (!entry) return fallback
  return entry[locale] ?? entry.en ?? fallback
}

export function translateRemediation(domain: "ksv" | "cis" | "falco", id: string, fallback: string | undefined, locale: Locale): string | undefined {
  const dict = domain === "ksv" ? KSV_TRANSLATIONS : domain === "cis" ? CIS_TRANSLATIONS : FALCO_TRANSLATIONS
  const entry = dict[id]?.remediation
  if (!entry) return fallback
  return entry[locale] ?? entry.en ?? fallback
}
