# QA Report — Portal Full Check + Readability Audit

- **Date**: 2026-06-10
- **Target**: narwhal-portal 전체 (57 routes: 14 pages + 43 API route groups)
- **Scope**: PRE-SCAN, L1 (build/type), L2 (API smoke), 정합성 검사, **가독성(폰트 크기) 특별 점검**
- **Result**: **PASS (조건부)** — 빌드/타입/API 인증 가드 전부 통과. 가독성 WARNING 2건 + i18n 규칙 위반 1건.

---

## Pre-Release Scan Results

- bkit `pre-release-check.sh` 스캐너는 bkit 자체 리포 구조(`lib/qa`) 전용이라 이 프로젝트에는 적용 불가 → 포털 맞춤 정적 스캔으로 대체.
- **대체 스캔**: 타입 체크, 프로덕션 빌드, RBAC 정합성, i18n 하드코딩, 캐시 키 충돌, 타이포그래피 감사.

**Overall**: PASS (0 CRITICAL)

---

## L1 — Unit / Static (PASS)

| Check | Result | Evidence |
|-------|--------|----------|
| `npx tsc --noEmit` | **PASS** (exit 0, 에러 0) | 백그라운드 실행 로그 |
| `pnpm build` (Next.js 16 프로덕션 빌드) | **PASS** (exit 0) | 57개 라우트 전부 동적(ƒ) 렌더 정상 컴파일 |
| 단위 테스트 | **N/A** | 리포에 `*.test.*` 파일 및 vitest/playwright 설정 없음 (vitest는 devDependency로만 존재) |

> 참고: CLAUDE.md 테크스택 표에는 "Test: Vitest + Playwright"로 명시되어 있으나 실제 테스트 파일/설정이 0개. 테스트 부채로 기록.

## L2 — API Smoke (PASS)

대상: 클러스터에 배포된 실 인스턴스 `https://portal.local.narwhal.io` (pod `narwhal-portal-586ffd4bd-6qp57`, devtools ns, Running 45h)

| Check | Result |
|-------|--------|
| `/` 미인증 → 307 (로그인 리다이렉트) | PASS |
| `/login` → 200 | PASS |
| `/api/auth/session` → 200 | PASS |
| **API 인증 가드**: `/api/{hero,argocd,metrics,catalog,cluster,events,my-apps,namespaces,pods,secrets,templates,tools,traces,settings/users,settings/policies,onboarding/kubeconfig,compliance/summary,security/summary,governance/dora,scorecards,cost,service-graph}` 23개 그룹 미인증 호출 → **전부 401** | **PASS** |
| `/api/alerts/silence` GET → 405 (POST 전용) | PASS (의도된 동작) |

인증된 응답 형식 검증은 자격증명 부재로 미수행.

## L3–L5 — E2E / UX / Data Flow: **SKIPPED**

Chrome MCP 미연결 환경 → skill fallback 규칙에 따라 L1+L2 결과로 판정. 가독성 시각 검증은 아래 정적 감사로 대체.

---

## 정합성 검사 (idp-qa 기준)

| 항목 | 결과 |
|------|------|
| RBAC: `nav.tsx` menuItems vs `tools.ts` PLATFORM_TOOLS roles | **PASS** — security/compliance/settings = cluster-admin 전용, live만 guest 포함. 모순 없음 |
| 캐시 키 네이밍 `{service}:{resource}` | **PASS** — 충돌 없음. 단 `api:*` 접두(3건), `hero:summary`는 컨벤션에서 살짝 벗어남 (INFO) |
| **i18n 하드코딩** | **FAIL (WARNING)** — i18n 파일 제외 **21개 파일**에 한국어 문자열 하드코딩. CLAUDE.md 핵심 규칙("no hardcoded Korean") 위반. 주요: `catalog/service-*-tab.tsx`, `cost/*`, `architecture/*`, `governance/*`, `api/service-graph`, `api/scorecards`, `api/cost` |
| 디자인 스펙 드리프트 | INFO — 스펙(2026-04-19)은 폰트 Inter 명시, 실제는 Pretendard(localFont). 코드가 정답이므로 스펙 문서 갱신 필요 |

---

## 가독성(글자 크기) 특별 감사 — **사용자 체감 "글자가 작다" 정량 확인됨**

### 측정 결과 (src/ 전체)

| 클래스 | px | 사용 횟수 | 판정 |
|--------|----|----------|------|
| `text-[10px]` | 10px | **85** | 스펙 위반 (스펙 최소 단위는 text-xs) |
| `text-[11px]` | 11px | **69** | 스펙 위반 |
| `text-xs` | 12px | **307** | 스펙상 "labels/timestamps"용인데 본문급으로 남용 |
| `text-sm` (스펙상 body) | 14px | 258 | 정상 |
| `text-base` 이상 | 16px+ | 85 | 정상 (제목 위주) |

- **12px 미만 텍스트 154곳** — 디자인 시스템 스펙(§4 Typography: 최소 스케일 `text-xs`)을 벗어난 임의값.
- `text-xs`(307) > `text-sm`(258): 본문보다 라벨 크기가 더 많이 쓰임 → 화면 전반이 작게 느껴지는 직접 원인.
- 루트 폰트 16px 기본, 전역 축소는 없음 → 문제는 전적으로 컴포넌트 레벨의 소형 클래스 남용.

### 저대비 결합 (가독성 2중 악화)

- `text-xs` + `text-muted-foreground` 조합 **158곳**
- `text-[10px]` + muted 조합 **45곳**
- light 테마 `--muted-foreground: oklch(0.556)` ≈ #757575 → 흰 배경 대비 **약 4.5:1 (WCAG AA 턱걸이)**. 10–11px과 결합 시 실질 가독성 미달.

### 최다 위반 파일 (수정 우선순위)

| 파일 | 건수 |
|------|------|
| `src/components/nodes/audit/audit-item-detail.tsx` | 39 |
| `src/app/(dashboard)/nodes/[name]/page.tsx` | 21 |
| `src/components/dashboard/argocd-apps-table.tsx` | 11 |
| `src/components/nodes/audit/system-check-summary.tsx` | 8 |
| `src/components/nodes/audit/config-hint-row.tsx` 외 21개 파일 | 1–6 |

**핵심 레버리지 포인트**: `audit-item-detail.tsx:43`의 공유 상수
`export const TH = "px-6 py-4 text-[10px] font-black text-muted-foreground uppercase tracking-widest ..."`
— audit 계열 테이블 헤더 전체가 10px. 이 한 줄 수정으로 다수 화면 개선.

### 권고 (수정은 portal-frontend 하네스로 위임)

1. **`text-[10px]`/`text-[11px]` 154곳 → `text-xs`(12px)로 일괄 상향** — 스펙 준수 + 최소 가독선 확보. 테이블 헤더/배지부터.
2. `text-xs`가 실질 본문인 곳(테이블 셀, 설명문)은 `text-sm`으로 상향 검토 — 특히 muted 결합 158곳.
3. `--muted-foreground`(light) 명도 소폭 하향(oklch 0.556 → 0.50 내외)으로 대비 여유 확보.
4. 디자인 시스템 스펙에 "12px 미만 금지" 명문화 + 스펙 폰트 표기 Inter → Pretendard 갱신.

---

## 종합 판정

| 레벨 | 판정 |
|------|------|
| PRE-SCAN | PASS (대체 스캔, 0 CRITICAL) |
| L1 | PASS |
| L2 | PASS |
| L3–L5 | SKIPPED (Chrome MCP 부재) |
| 정합성 | WARNING (i18n 하드코딩 21파일) |
| 가독성 | **WARNING (12px 미만 154곳 + 저대비 결합 203곳)** |

**QA 통과 (조건부)** — 기능/빌드/보안 가드 이상 없음. 후속 작업 2건 권고: ① 가독성 일괄 상향(우선), ② i18n 하드코딩 정리.
