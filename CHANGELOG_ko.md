# Changelog

이 프로젝트의 주요 변경 사항은 이 파일에 기록됩니다.

이 형식은 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)를 따르며,
이 프로젝트는 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 준수합니다.

[English](CHANGELOG.md) | 한국어

## [Unreleased]

## [1.0.17] - 2026-08-09

플랫폼 도구 헬스 체크, 노드 역할 감지, 컴플라이언스 리포팅 지표 및 노드 인프라 감사 쿼리를 수정하고
버전 태그에 대한 자동화된 릴리스 노트 워크플로를 도입함.

### 추가
- **자동화된 GitHub Release 워크플로**: `v*` 태그 푸시 시 `CHANGELOG.md`에서 릴리스 노트를 추출하여
  게시하고, 버전 섹션이 누락되면 작업을 실패 처리하는 `.github/workflows/release.yml` 워크플로 추가.

### 수정
- **구성 가능한 플랫폼 도구 기본 도메인**: 인팟(in-pod) 헬스 체크의 NXDOMAIN 실패를 방지하고 커스텀
  클러스터 도메인을 지원하기 위해 `CLUSTER_BASE_DOMAIN`(및 `NEXT_PUBLIC_CLUSTER_BASE_DOMAIN`) 환경 변수 지원
  추가(기본값 `local.narwhal.internal`).
- **Prometheus 및 K8s 라벨 기반 노드 역할 도출**: Prometheus 쿼리에서 노드 라벨에 조인된 `kube_node_role`
  메트릭을 사용하고, K8s API 응답에서 `control-plane` 및 기존 `master` 라벨/테인트 키를 모두 인식하여 노드가
  'worker'로 잘못 표시되던 문제 수정.
- **컴플라이언스 프레임워크 통과율 스케일링**: 평균 프레임워크 통과율 비율(0-1)에 100을 곱한 뒤 반올림하도록
  수정하여 0.77과 같은 비율이 1%로 표시되던 오류 해결.
- **클러스터 범위 노드 인프라 감사 리포트 쿼리**: trivy-operator의 노드 보안 감사 발견 사항이 올바르게
  반영되도록 네임스페이스 범위의 `infraassessmentreports`와 함께 클러스터 범위의
  `clusterinfraassessmentreports`를 조회하여 병합.

## [1.0.16] - 2026-07-25

실시간 컴포넌트 상태 추적을 위한 종속성 인지 플랫폼 상태(Platform Status) 페이지를 도입하고
네이티브 멀티 아키텍처 빌드로 컨테이너 릴리스 워크플로를 최적화함.

### 추가
- **종속성 인지 플랫폼 상태 페이지**: 클러스터 컴포넌트 및 하위 인프라 종속성 전반의 실시간
  상태 지표를 표시하는 `/status` 뷰 추가.
- **디자인 시스템 토큰 계약**: 프론트엔드 스타일링 일관성을 위한 디자인 토큰 가이드라인 및 CI
  린트 규칙을 정의하는 `DESIGN.md` 도입.

### 변경
- **각 아키텍처가 네이티브 러너에서 빌드됨** — 단일 작업이 두 플랫폼을 모두 빌드하고 arm64
  단계가 QEMU 환경에서 `next build`를 실행했기 때문에 1.0.16 이미지가 게시되지 않았음: amd64는
  약 90초 만에 완료된 반면 arm64는 5분이 지난 후에도 계속 컴파일 중이었으며, 이전 실행은
  취소되기 전까지 2시간 38분에 달했음. 이제 아키텍처당 하나의 작업(`ubuntu-24.04-arm`, 공개
  리포지토리 무료)이 다이제스트별로 푸시하고 최종 작업이 이를 하나의 멀티 아키텍처 매니페스트로
  병합함. 어디에서도 QEMU를 사용하지 않음.

## [1.0.15] - 2026-07-13

*패키지 버전을 클러스터 GitOps 이미지 핀과 맞추기 위해 버전이 1.0.4에서 1.0.15로 건너뜀.*

Keycloak OIDC 세션 유지(keep-alive), 단일 실행(single-flight) 토큰 갱신 및 분할(chunked) 세션
쿠키 처리를 통해 인증 안정성을 향상시키고, 플랫폼 도구를 확장하며 보안 컴플라이언스 리포팅을
개선함.

### 추가
- **Kubernetes Dashboard 및 NFS Quota 도구 타일**: Kubernetes Dashboard 3.0 및 NFS Quota 관리를
  위한 제로클릭 게이트웨이 SSO 대시보드 타일 통합.
- **Keycloak SSO 세션 유지(keep-alive)**: 사용자 중단 없이 활성 OIDC 세션을 유지하기 위해 단일
  실행(single-flight) 요청 실행을 사용하는 백그라운드 토큰 갱신 구현.
- **상위 도메인 테마 동기화**: Keycloak 로그인 화면과 다크/라이트 테마 기본 설정을 동기화
  상태로 유지하기 위해 상위 도메인 전체에 `narwhal-theme` 쿠키 공유.
- **컴플라이언스의 위생 심각도 계층**: 조치가 필요한 위협과 별개로 마이너한 보안 위생 발견
  사항을 추적하기 위해 config-audit 요약에 `LOW` 심각도 계층 추가.

### 수정
- **분할 세션 쿠키로 인한 로그인 리다이렉트 루프**: 브라우저 헤더 크기 제한을 초과하는 분할
  세션 쿠키를 올바르게 재구성하도록 공유 서술어(`isSessionCookie`)를 통해 NextAuth 세션 쿠키
  처리 업데이트.
- **컴플라이언스 주요 지표 노이즈 감소**: 컴플라이언스 대시보드의 조치가 필요한 주요 지표에서
  내장/업스트림 RBAC 역할 및 시스템 네임스페이스 발견 사항을 필터링하여 제외.

## [1.0.4] - 2026-07-10

핵심 KISA 보안 컴플라이언스 통제 항목을 실시간 Kubernetes 리소스 검사로 전환하고 실시간 이벤트
스트림 분류를 강화함.

### 추가
- **실시간 KISA 보안 컴플라이언스 검사**: `KISA-CP-01`, `KISA-ETCD-01`, `KISA-POD-01`,
  `KISA-NET-01`에 대한 정적 컴플라이언스 규칙을 실시간 클러스터 검사로 전환하고 `KISA-RBAC-01`
  / `KISA-RBAC-02`에 대한 내장 인지 평가 구현.

### 변경
- **직접 Gitea 리포지토리 링크**: Gitea 플랫폼 도구 타일 링크가 `narwhal-gitops` 리포지토리로
  직접 이동하도록 업데이트.
- **Valkey TLS 우회 구성**: 비프로덕션 환경에서 엄격한 TLS 검증을 우회하기 위해
  `VALKEY_INSECURE_PRODUCTION` 환경 변수 지원 추가.

### 수정
- **실시간 이벤트 스트림 분류**: 스트리밍된 K8s 이벤트를 분류하여 UI 카테고리 필터링을 가능하게
  하고 심각한 뷰 아래에 경고 이벤트를 노출.

## [1.0.3] - 2026-07-09

실시간 스트리밍 게시/구독(pub/sub) 작업을 전용 Valkey 연결 풀로 분리함.

### 수정
- **실시간 스트리밍을 위한 전용 Valkey 클라이언트**: 일반 캐시 작업에서 구독자 블로킹을
  방지하기 위해 SSE(Server-Sent Events) 게시/구독(pub/sub) 채널 및 파이프라인 전용 Valkey
  클라이언트 인스턴스 생성.

## [1.0.2] - 2026-07-09

실시간 이벤트 스트림을 대시보드에 공급하기 위한 실시간 Kubernetes Events 인포머 백엔드를
구축함.

### 추가
- **Kubernetes Events 인포머** — `/live`에 이벤트 소스가 전혀 없었음: `live-k8s-informer.ts`는
  호출된 적이 없는 TODO 스터브였으며 `/api/events/ingest`로 아무것도 게시되지 않아 페이지가
  비어 있을 수밖에 없었음. 이제 클러스터 범위의 core/v1 Events watch(`resourceVersion` + 백오프
  재연결, 모든 `Warning` 이벤트 및 정선된 `Normal` 사유 세트)를 실행하고, 각 이벤트를
  `LiveEvent`로 매핑하여 Valkey pub/sub 채널로 게시하는 `pushEvent()`를 호출함. Node.js
  런타임의 `instrumentation.ts`에서 한 번 시작됨.

### 변경
- **릴리스 CI 빌드 트리거**: 중간 커밋에서 불필요한 태그 없는 이미지 빌드를 방지하기 위해 GHCR
  컨테이너 빌드 워크플로를 태그 푸시(`v*`)로 제한.

## [1.0.1] - 2026-07-09

실시간 SSE 스트림 연결을 안정화하고, 컴플라이언스 리포트 파싱을 개선하며, 알림 스코어카드
지표를 정리함.

### 추가
- **노드 검사를 위한 조치 항목 전용 토글**: 노드 상세 뷰에서 정상 상태의 CNI 및 컨트롤 플레인
  정보 패널을 숨기고 조치가 필요한 항목에 집중할 수 있는 필터 토글 추가.

### 수정
- **SSE 재연결 스톰**: 클라이언트 재연결 루프를 방지하기 위해 pub/sub 구독자 실패 중에도
  SSE(Server-Sent Events) 스트림을 유지.
- **Trivy 컴플라이언스 리포트 파싱**: `detailReport.results`를 읽고 통제 항목별 통과/실패
  상태를 정확하게 평가하도록 리포트 파싱 로직 업데이트.
- **거버넌스 스코어카드 노이즈**: 거버넌스 스코어카드 지표 집계에서 Prometheus의 합성 메타
  알림인 `Watchdog` 및 `InfoInhibitor` 제외.

## [1.0.0] - 2026-07-07

Next.js 16 및 React 19로 구축된 Kubernetes 내부 개발자 플랫폼(IDP) 관리 대시보드인 Narwhal IDP
Portal의 첫 번째 공개 릴리스.

### 추가
- **핵심 대시보드 및 서비스 맵**:
  - 실시간 클러스터 이벤트 타임라인, 활동 피드 및 리소스 요약을 제공하는 라이브 대시보드.
  - Hubble 릴레이 L4/L7 eBPF 네트워크 흐름, 실시간 트래픽 비율, 네임스페이스 필터링, 노드 상세
    드로어 및 시각적 범례를 통합한 대화형 서비스 종속성 그래프.
  - 대화형 조치 필요 아코디언 필터, 시스템 감사 패널 및 용량 지표를 포함한 노드 검사 뷰.
- **애플리케이션 카탈로그 및 워크로드**:
  - `app.kubernetes.io/instance` 범위의 스트리밍 컨테이너 로그를 지원하는 애플리케이션 카탈로그
    및 파드 관리 뷰.
  - 팀 재정의 기능을 갖춘 역할 기본 애플리케이션 가시성 범위(`my-apps`).
- **보안 컴플라이언스 및 거버넌스**:
  - 정렬 가능한 테이블 및 Trivy 취약점 리포트 통합을 포함한 KISA 보안 통제 프레임워크
    체크리스트(`/compliance`).
  - 워크로드 분배 분석, 리소스 요청(requests)이 누락된 파드, RBAC 위험 분석 및 DORA 지표를
    제공하는 거버넌스 대시보드.
  - 온프레미스 실제 비용 기준 계산 방법론.
- **단일 로그인(SSO) 및 접근 제어**:
  - 자동 로그인 프록시 리다이렉트 및 상대 경로 `callbackUrl` 처리를 포함한 Keycloak OIDC 인증.
  - 보안 쿠키(`__Secure-`, `__Host-`)를 정리하면서 APISIX 게이트웨이(`/apisix/logout`)를 통해
    라우팅되는 RP 개시 연합 로그아웃(SLO 체인).
  - 탐색 및 플랫폼 도구 전반에서 `cluster-admin`, `developer`, `viewer`, `guest` 역할을
    지원하는 4계층 역할 기반 접근 제어(RBAC).
- **플랫폼 도구 연동**:
  - ArgoCD, Grafana, Harbor, Gitea, OpenBao, Velero UI 및 Headlamp를 위한 딥링크 및 제로클릭
    SSO 부트스트랩을 지원하는 플랫폼 도구 그리드.
- **국제화 및 디자인 시스템**:
  - 쿠키 기반 로캘 전환 및 한국어 타이포그래피를 위한 자체 호스팅 Pretendard 폰트를 갖춘 이중
    언어 i18n 지원(영어 및 한국어).
  - Next.js 16, React 19 및 Tailwind CSS로 구축된 현대적인 반응형 UI.
- **컨테이너 빌드 및 로컬 개발**:
  - GHCR에 게시되는 멀티 아키텍처 Docker 빌드를 지원하는 컨테이너화
    설정(`ghcr.io/dasomel/narwhal-portal:1.0.0`).
  - 오프라인 클린 설치를 위한 클러스터 내 Kaniko 빌드 Job
    매니페스트(`deploy/kaniko-build-job.yaml`).
  - 실시간 핫 모듈 교체(HMR) 및 컨테이너 파일 동기화를 위해 구성된 Skaffold 개발 프로필.

[Unreleased]: https://github.com/dasomel/narwhal-portal/compare/v1.0.17...HEAD
[1.0.17]: https://github.com/dasomel/narwhal-portal/compare/v1.0.16...v1.0.17
[1.0.16]: https://github.com/dasomel/narwhal-portal/compare/v1.0.15...v1.0.16
[1.0.15]: https://github.com/dasomel/narwhal-portal/compare/v1.0.4...v1.0.15
[1.0.4]: https://github.com/dasomel/narwhal-portal/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/dasomel/narwhal-portal/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/dasomel/narwhal-portal/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/dasomel/narwhal-portal/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/dasomel/narwhal-portal/releases/tag/v1.0.0
