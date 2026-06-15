# Narwhal IDP Portal — 개발 로드맵

> Kubernetes Internal Developer Platform Portal 개발 로드맵
> 작성일: 2026-04-02

---

## 현재 상태 (v0.1 — Scaffold Complete)

| 영역 | 구현 현황 |
|------|----------|
| **대시보드** | 클러스터 메트릭, 노드 메트릭, ArgoCD 상태, 알림 위젯 |
| **Settings** | 사용자/그룹/라우트/인증서/정책 CRUD (admin only) |
| **Onboarding** | kubeconfig 다운로드, 설정 가이드, 아키텍처 다이어그램 |
| **Tools** | 10개 플랫폼 도구 그리드 (헬스체크, 역할기반 필터링) |
| **인프라** | Keycloak SSO, Valkey 캐시, i18n(ko/en), RBAC 4역할 |

---

## 업계 벤치마크 대비 Gap 분석

IDP 포탈 시장 리더(Backstage, Port, Cortex, OpsLevel)와 비교한 Gap 분석.

### 주요 IDP 포탈 제품 현황

| 제품 | 타입 | 핵심 강점 |
|------|------|----------|
| **Backstage** (Spotify/CNCF) | 오픈소스 | Software Catalog + Templates + TechDocs + 수백 개 플러그인 |
| **Port** | SaaS | Blueprints(유연한 데이터 모델) + Self-Service Actions + Scorecards |
| **Cortex** | SaaS | 서비스 운영 성숙도 Scorecards + 멀티스텝 워크플로우 엔진 |
| **OpsLevel** | SaaS | 자동 서비스 카탈로그 수집 + AI 설명 생성 + 30~45일 배포 |
| **Roadie** | 관리형 Backstage | Backstage 기반 호스팅 + 플러그인 관리 대행 |
| **Configure8** | SaaS + 온프레미스 | 클라우드 비용 관리 내장 + 노코드 셀프서비스 |
| **Harness IDP** | Backstage SaaS | CI/CD 파이프라인 완전 통합 |

### Gap 분석

| 핵심 기능 | 업계 표준 | Narwhal 현황 | Gap |
|----------|----------|-------------|-----|
| 서비스 카탈로그 | 소유권·의존성·메트릭 통합 뷰 | ArgoCD 앱 목록만 표시 | **높음** |
| 셀프서비스 액션 | 동기화/롤백/환경생성 직접 실행 | 읽기 전용 | **높음** |
| 통합 검색 | 서비스·문서·알림 단일 검색 | 없음 | **높음** |
| 스코어카드 | 서비스 운영 성숙도 수치화 | 없음 | **중간** |
| 시크릿 관리 UI | 교체 워크플로우·만료 알림 | 없음 | **중간** |
| 메트릭 인라인 차트 | 서비스별 CPU/메모리/에러율 그래프 | 숫자만 표시 | **중간** |
| 비용 가시성 | 네임스페이스별 리소스 비용 | 없음 | **낮음** |
| 소프트웨어 템플릿 | 신규 서비스 스캐폴딩 | 없음 | **낮음** |
| RBAC 가시화 | 권한 현황 테이블·요청 워크플로우 | 그룹 관리만 | **중간** |

---

## 로드맵

### Phase 1 — 서비스 카탈로그 + 검색 (Core Value)

> 읽기 전용 포탈 → "모든 정보가 한곳에" 포탈

| # | 기능 | 설명 | 난이도 |
|---|------|------|--------|
| 1-1 | **서비스 카탈로그 페이지** | ArgoCD 앱을 서비스로 매핑, 소유팀·네임스페이스·상태·버전 표시 | M |
| 1-2 | **서비스 상세 페이지** | 개별 서비스의 ArgoCD 상태 + Prometheus 메트릭 + 관련 알림 통합 뷰 | L |
| 1-3 | **통합 검색 (Command Palette)** | `Cmd+K`로 서비스·도구·설정 검색. 자동완성 + 최근 검색 | M |
| 1-4 | **메트릭 인라인 차트** | 대시보드·서비스 상세에 Prometheus 시계열 그래프 (Recharts) | M |
| 1-5 | **이벤트 타임라인** | 클러스터 이벤트 + ArgoCD 동기화 이력 + 알림 이력 통합 타임라인 | S |

**기술 의사결정:**

| 결정 | 권장안 | 이유 |
|------|-------|------|
| 차트 라이브러리 | Recharts | React 네이티브, SSR 호환, shadcn/ui 스타일링 용이 |
| 검색 UI | cmdk (Command Menu) | `Cmd+K` 패턴, shadcn/ui dialog 기반 |
| 실시간 업데이트 | TanStack Query polling (30s) | SSE/WebSocket 대비 구현 단순, 충분한 freshness |
| 서비스 카탈로그 데이터 | ArgoCD API + K8s API 조합 | 추가 DB 불필요, 기존 인프라 활용 |

---

### Phase 2 — 셀프서비스 액션 (Developer Empowerment)

> 읽기 전용 → 안전한 셀프서비스 실행

| # | 기능 | 설명 | 난이도 |
|---|------|------|--------|
| 2-1 | **ArgoCD Sync/Rollback** | 포탈에서 앱 동기화·롤백 트리거 (RBAC + 확인 다이얼로그) | M |
| 2-2 | **시크릿 관리 UI** | OpenBao 시크릿 목록(값 마스킹) + 교체 요청 워크플로우 | L |
| 2-3 | **네임스페이스 셀프프로비저닝** | 개발자가 dev 네임스페이스 생성 요청 → Kyverno 정책으로 자동 리소스쿼터 | L |
| 2-4 | **인증서 갱신 액션** | cert-manager 인증서 수동 갱신 트리거 + 만료 30일 전 경고 | S |
| 2-5 | **알림 Silence/Acknowledge** | Alertmanager 알림 일시 음소거·확인 처리 | S |

**핵심 원칙: 자유도 + 가드레일**
- Policy-as-code(Kyverno)로 안전한 경계 설정
- 경계 내에서는 완전 자율화 (TicketOps 제거)
- 모든 변경 액션에 확인 다이얼로그 + 감사 로그

---

### Phase 3 — 거버넌스 & 인사이트 (Maturity)

> 운영 성숙도 측정 + 거버넌스 강화

| # | 기능 | 설명 | 난이도 |
|---|------|------|--------|
| 3-1 | **서비스 스코어카드** | 이미지 스캔, SLO 설정, 문서 존재, 의존성 최신성 등 점수화 | L |
| 3-2 | **RBAC 가시화** | ClusterRole/RoleBinding → 사용자 매핑 테이블 + 권한 요청 워크플로우 | M |
| 3-3 | **리소스 사용량 리포트** | 네임스페이스별 CPU/메모리 사용량 트렌드 + 쿼터 대비 사용률 | M |
| 3-4 | **감사 로그 뷰어** | Keycloak + K8s 감사 로그 통합 조회 (who/when/what) | M |
| 3-5 | **배포 분석** | 배포 빈도, 리드타임, 실패율 (DORA 메트릭 lite) | L |

**스코어카드 평가 항목 예시:**

| 카테고리 | 체크 항목 | 데이터 소스 |
|----------|----------|------------|
| 보안 | 이미지 취약점 스캔 통과 | Harbor/Trivy |
| 운영 | SLO/알림 규칙 설정됨 | Prometheus |
| 문서 | README 존재 | Gitea |
| 배포 | GitOps 자동 배포 활성 | ArgoCD |
| 의존성 | deprecated 버전 미사용 | K8s API |

---

### Phase 4 — 자동화 & 확장 (Platform Engineering)

> 프로덕션 수준 플랫폼 엔지니어링

| # | 기능 | 설명 | 난이도 |
|---|------|------|--------|
| 4-1 | **소프트웨어 템플릿** | 신규 서비스 스캐폴딩 (Gitea 레포 + ArgoCD 앱 + 네임스페이스 자동 생성) | XL |
| 4-2 | **분산 트레이싱 통합** | Tempo 트레이스 링크를 서비스 상세에 연결 | M |
| 4-3 | **알림 규칙 관리** | Prometheus AlertRule CRUD (Kyverno 검증 통과 후 GitOps PR 생성) | L |
| 4-4 | **MCP 서버 노출** | AI 에이전트가 카탈로그·메트릭·액션에 접근할 수 있는 MCP 엔드포인트 | M |
| 4-5 | **플러그인 시스템** | 커스텀 위젯·페이지를 동적으로 추가하는 플러그인 아키텍처 | XL |

---

## 우선순위 매트릭스

```
  Impact
  높음 │  1-1 서비스카탈로그   2-1 Sync/Rollback   4-1 템플릿
       │  1-3 통합검색         2-2 시크릿관리
       │  1-2 서비스상세       3-1 스코어카드
  중간 │  1-4 메트릭차트       2-5 알림Silence      3-2 RBAC가시화
       │  1-5 이벤트타임라인   2-4 인증서갱신       3-3 리소스리포트
  낮음 │                      2-3 NS프로비저닝     3-4 감사로그
       └───────────────────────────────────────────────────────
              낮음                중간                높음  → Effort
```

---

## UX 설계 가이드라인

### 대시보드 설계 원칙

- **3계층 정보 아키텍처**: 비즈니스 요약 → 기술 상세 → 심층 코드 레벨
- **액션 연동 메트릭**: 수치만 표시하지 않고 "CPU 90% → 여기 클릭하면 원인 분석" 형태
- **실시간 상태 배지**: 서비스 헬스를 색상 코딩된 배지로 즉시 파악
- **필터링 필수**: 날짜/팀/환경/상태별 슬라이싱

### 네비게이션 원칙

- 현재 위치 항상 명확히 표시 (active state)
- 브레드크럼 필수 (깊은 계층 탐색 시)
- 3단계 이상 중첩 금지
- 역할별 메뉴 차등 표시 (RBAC)

### 검색 및 발견

- `Cmd+K` 통합 검색 (서비스, API, 문서, 팀 단일 검색)
- 자동완성 + 최근 검색 + 즐겨찾기
- 개발자는 정보 탐색에 생산 시간의 30% 낭비 → 통합 검색이 핵심 ROI

### 온보딩 플로우

1. SSO 로그인 → 역할 자동 할당
2. 내 서비스 자동 매핑 (Git 계정 기반)
3. kubeconfig 자동 생성 + 다운로드
4. 필수 도구 목록 (팀별 표준 + 설치 가이드)
5. 첫 배포 가이드 (단계별 인터랙티브 워크플로우)

---

## Kubernetes 특화 기능 참고

### 클러스터 관리 대시보드

- 네임스페이스 브라우저: 네임스페이스별 리소스 사용량 + 파드 상태
- 워크로드 드릴다운: Deployment → ReplicaSet → Pod → 로그
- 이벤트 스트림: 클러스터 이벤트 실시간 피드 (Warning 강조)

### GitOps 통합

- ArgoCD 앱 상태: Synced/OutOfSync/Degraded + 마지막 동기화 시간
- 드리프트 감지 알림: Git ↔ 클러스터 불일치 시 즉시 알림
- 배포 이력 타임라인: Git 커밋 → ArgoCD 동기화 → 파드 롤링 업데이트
- 롤백 버튼: 특정 커밋으로 즉시 롤백 (RBAC 확인 후)

### 시크릿 관리 UI

- OpenBao 연동: 시크릿 존재 여부 확인 (값은 노출하지 않음)
- 시크릿 교체 워크플로우: 새 버전 등록 → 파드 재시작 자동화
- 만료 알림: 인증서/시크릿 만료 30일 전 경고
- 감사 로그: 누가 언제 시크릿을 접근/수정했는지 추적

---

## 참고 자료

- [Backstage - What is Backstage](https://backstage.io/docs/overview/what-is-backstage)
- [Port - Top Backstage Alternatives](https://www.port.io/blog/top-backstage-alternatives)
- [OpsLevel - 2025 Ultimate Guide to Developer Portal](https://www.opslevel.com/resources/2025-ultimate-guide-to-building-a-high-performance-developer-portal)
- [Plural - IDP for Kubernetes Guide 2025](https://www.plural.sh/blog/idp-for-kubernetes-guide/)
- [Infisical - Navigating IDPs in 2025](https://infisical.com/blog/navigating-internal-developer-platforms)
- [Atmosly - Backstage vs IDP Comparison 2025](https://atmosly.com/knowledge/backstage-vs-internal-developer-portals-comparison-guide-2025)
- [Atlassian - IDP Best Practices](https://www.atlassian.com/developer-experience/internal-developer-platform)
