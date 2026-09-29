# EventEnvelope 버전 지원 매트릭스 및 롤링 업그레이드 규약

- **문서 상태**: Proposed / Normative Specification (portal#38)
- **작성 일자**: 2026-09-29
- **대상 컴포넌트**: [`src/types/event-envelope.ts`](../src/types/event-envelope.ts), [`src/types/live.ts`](../src/types/live.ts), [`src/app/api/events/ingest/route.ts`](../src/app/api/events/ingest/route.ts), [`src/lib/live-stream.ts`](../src/lib/live-stream.ts), [`src/app/api/events/stream/route.ts`](../src/app/api/events/stream/route.ts), [`src/lib/operation-context.ts`](../src/lib/operation-context.ts)
- **관련 이슈 및 문서**: portal#38, portal#11, portal#12, narwhal#42, narwhal#140, [`docs/event-envelope-compatibility.md`](./event-envelope-compatibility.md), [`src/types/event-envelope.compat.test.ts`](../src/types/event-envelope.compat.test.ts)

---

## 1. 개요 및 배경 (Context & Gap Analysis)

Narwhal IDP 포탈은 외부 웹훅 인제스트(`POST /api/events/ingest`), Kubernetes 인포머([`src/lib/live-k8s-informer.ts`](../src/lib/live-k8s-informer.ts)), 내부 작업 수명주기([`src/lib/operation-context.ts`](../src/lib/operation-context.ts))로부터 이벤트를 수신하여 Valkey 링 버퍼에 저장하고, SSE 스트림([`src/app/api/events/stream/route.ts`](../src/app/api/events/stream/route.ts))을 통해 대시보드 UI에 실시간 전달합니다.

### 1.1 이슈 요구사항과 현재 코드베이스 간의 괴리 (Distrusted Claims)
이슈 #38 본문은 "Narwhal #140이 관리 API 및 정규 이벤트 호환성을 정의하고 있으며 포탈이 이를 직접 소비한다"고 서술하고 있으나, 실제 코드베이스 검증 결과 다음과 같은 차이가 존재합니다:

1. **클러스터 프로듀서 계약 미정의**: `narwhal#140`은 아직 착수되지 않았으며, 업스위트 Narwhal 클러스터 측 프로듀서(오퍼레이터, 에이전트 등)는 버전화된 봉투(`EventEnvelope`) 계약을 발행하고 있지 않습니다(`docs/event-envelope-compatibility.md:3`).
2. **현재 구현의 Fail-Open 동작**: 현재 프로덕션 인제스트 라우트([`src/app/api/events/ingest/route.ts:47-391`](../src/app/api/events/ingest/route.ts#L47))는 `schema_version` 필드를 검증하지 않으며, 미지원 버전(`schema_version: "2.0"` 또는 `"99.0"`)이 인입되어도 에러 없이 수용하는 Fail-Open 상태입니다([`src/types/event-envelope.compat.test.ts:441-490`](../src/types/event-envelope.compat.test.ts#L441)).
3. **`LiveEvent`와 `EventEnvelope` 분리**: 대시보드 지향 파이프라인의 [`LiveEvent`](../src/types/live.ts#L41) 및 [`LiveEventIngest`](../src/types/live.ts#L52)는 [`EventEnvelopeFields`](../src/types/live.ts#L22-L39)의 선택적 하위 집합만 포함하며, 현재 `schema_version`과 `event_version`을 저장·방출하지 않습니다.

본 문서는 이러한 동작 특성 분석([`docs/event-envelope-compatibility.md`](./event-envelope-compatibility.md))을 바탕으로, 포탈 롤링 배포 시 안전한 버전 공존과 향후 Fail-Closed 전환을 위한 규범적 버전 지원 매트릭스, 폐기 정책, 미확인 필드/버전 처리 규칙, 그리고 추가해야 할 호환성 테스트 케이스를 정의합니다.

---

## 2. EventEnvelope 버전 지원 매트릭스 (Version Support Matrix)

현재 포탈 계약에서 식별되는 봉투 버전은 다음과 같이 분류됩니다:

- **`unversioned` (Legacy v0)**: `schema_version` 필드가 누락되었거나 `null`/`undefined`인 페이로드 (portal#11 이전 레거시 웹훅 및 과거 링 버퍼 레코드).
- **`"1.0"` (Current Canonical)**: [`src/types/event-envelope.ts:17, 19`](../src/types/event-envelope.ts#L17)에 선언된 `EVENT_ENVELOPE_SCHEMA_VERSION = "1.0"`.
- **`"1.x"` (Forward Minor / Additive)**: 기존 필수 필드를 유지한 채 비파괴적(additive) 필드만 추가된 마이너 확장 버전.
- **`"2.0"` (Future Major / Breaking)**: 기존 필수 필드 삭제, 타입 변경, 검증 규칙 강화 등 하위 호환성을 깨는 메이저 버전.
- **`unknown / unsupported`**: 허용 목록에 없는 임의의 문자열(예: `"99.0"`) 또는 잘못된 타입.

### 2.1 컴포넌트별 버전 수용 및 방출 매트릭스

| 서브시스템 / 컴포넌트 | 경로 / 식별자 | `unversioned` (Legacy v0) | `"1.0"` (Current Canonical) | `"1.x"` (Minor Additive) | `"2.0"` / Unknown (Breaking) |
|---|---|---|---|---|---|
| **HTTP 인제스트 라우트** | `POST /api/events/ingest` | **수용 (Deprecated)**<br>- 필수 4필드 검증 후 통과<br>- 응답에 `Deprecation` 헤더 부여 | **수용 (Active / GA)**<br>- 정규 v1 봉투 검증<br>- HTTP 200 반환 | **수용 (Forward-Compat)**<br>- 기지 필드 추출, 미확인 필드 허용<br>- HTTP 200 반환 | **거부 (Fail-Closed [PROPOSED])**<br>- HTTP 400 반환<br>- 구조화된 진단 JSON 반환 |
| **작업 수명주기 방출** | `src/lib/operation-context.ts:105-123` | **방출 중단** | **방출 (Canonical [PROPOSED])**<br>- `schema_version: "1.0"` 명시 방출 | 미방출 | 미방출 |
| **K8s 인포머** | `src/lib/live-k8s-informer.ts:87-134` | **방출 (현재)**<br>- `schema_version` 미포함 | **방출 (목표 [PROPOSED])**<br>- `schema_version: "1.0"` 명시 방출 | 미방출 | 미방출 |
| **스트림 정규화 엔진** | `pushEvent` (`src/lib/live-stream.ts:88-123`) | **수용 및 정규화**<br>- `LiveEvent` 선택적 필드 중 일부를 `null` 기본값으로 생성. `schema_version`은 추가하지 않음 | **수용 및 정규화**<br>- `LiveEvent`로 매핑하고 일부 선택적 필드는 `null` 기본값 사용 | **수용 및 정규화**<br>- 명시적으로 매핑하지 않는 입력 필드는 저장 이벤트에 포함하지 않음 | **유입 차단** (인제스트 계층에서 사전 차단 [PROPOSED]) |
| **Valkey 링 버퍼 저장소** | `RING_KEY = "live:events"` (`src/lib/live-stream.ts:4`) | **기존 레코드 보존**<br>- 단일 링 키에 공존 저장 | **표준 직렬화 저장**<br>- JSON 문자열로 저장 | **표준 직렬화 저장** | **저장 금지** |
| **이벤트 재생 계층** | `replayAfter`, `getRecentEvents` (`src/lib/live-stream.ts:125-170`) | **직접 역직렬화 (현재)**<br>- `JSON.parse(item) as LiveEvent`; `schema_version` 합성 또는 업캐스팅 없음. 누락 필드는 없는 채로 남음 | **직접 역직렬화 (현재)**<br>- `JSON.parse(item) as LiveEvent` | **직접 역직렬화 (현재)**<br>- JSON 속성은 파싱 객체에 유지됨 | **격리 및 건너뛰기 [PROPOSED]**<br>- `replayUnknown` 카운터 증가<br>- 진단 로깅 후 워커 비정상 종료 방지 |
| **SSE 스트림 배포** | `GET /api/events/stream` (`src/app/api/events/stream/route.ts`) | **필터링 후 브로드캐스트**<br>- `visibility` 누락 시 default-deny | **필터링 후 브로드캐스트**<br>- 네임스페이스/권한 필터 적용 | **필터링 후 브로드캐스트** | 해당 없음 |
| **대시보드 UI** | `src/hooks/use-live-stream.ts`, `src/components/live/live-stream.tsx` | **렌더링 지원**<br>- 기본 뱃지 및 neutral 폴백 | **정규 렌더링**<br>- 심각도, 액터, 리소스 링크 표시 | **정규 렌더링**<br>- 미확인 필드 무시 | 파싱 에러 방지 (에러 토스트 또는 안전 폴백) |

---

## 3. 롤링 업그레이드 공존 및 폐기 윈도우 규약 (Rolling Upgrade & Deprecation)

### 3.1 롤링 배포 시 Pod 간 Skew Window 규약
Kubernetes Deployment 환경에서 포탈 신규 버전 롤링 업데이트 시 구버전 Pod($N-1$)와 신버전 Pod($N$)가 일시적으로 동시 실행됩니다.

1. **최소 공존 윈도우**: 배포 진행 중(최소 10분~최대 1시간) $N$ 버전과 $N-1$ 버전 Pod 간의 양방향 호환성이 보장되어야 합니다.
2. **단일 링 버퍼 공유 불변식**: Valkey 링 버퍼 키 `live:events`는 스키마 버전별로 분할(partition)되지 않으므로, $N$ Pod가 발행한 최신 형식 이벤트와 $N-1$ Pod가 발행한 구형 이벤트가 동일한 Valkey List에 인터리빙(interleaving)되어 저장됩니다.
3. **양방향 안전성 요구조건**:
   - **순방향 호환성 ($N-1$ Pod의 동작)**: $N$ 버전 Pod가 링에 기록한 `"1.x"` 이벤트를 $N-1$ Pod가 `replayAfter()`로 읽을 때, 추가된 미확인 필드로 인해 파싱 예외가 발생하거나 프로세스가 중단되지 않아야 합니다. JavaScript의 `JSON.parse`는 추가 필드를 객체 속성으로 보존하므로 런타임 충돌 없이 통과합니다([`src/types/event-envelope.compat.test.ts:413-435`](../src/types/event-envelope.compat.test.ts#L413)).
   - **역방향 호환성 ($N$ Pod의 동작)**: $N-1$ 버전 Pod가 기록한 필드가 누락된 이벤트를 $N$ 버전 Pod가 읽을 때, 누락된 필드가 안전하게 `null` 또는 `undefined`로 평가되어야 하며 널 참조 에러(TypeError)를 유발하지 않아야 합니다([`src/types/event-envelope.compat.test.ts:357-411`](../src/types/event-envelope.compat.test.ts#L357)).

### 3.2 버전 폐기 주기 (Deprecation Lifecycle)
`unversioned` 페이로드 및 구형 스키마 버전의 폐기는 다음 단계를 따릅니다:

1. **폐기 유예 기간**: 폐기 선언 후 최소 **2개 마이너 릴리스($N-2$)** 또는 **90일** 동안 수용 호환성을 유지합니다.
2. **HTTP 폐기 고지 (RFC 9745 준수)**:
   `unversioned` 요청이 `POST /api/events/ingest`로 인입될 경우, 요청을 거부하지 않고 수용하되 응답 헤더에 폐기 일정과 대체 문서 링크를 명시합니다 (기존 거버넌스 API 폐기 패턴과 일치; [`src/app/api/governance/audit/route.ts:10-15`](../src/app/api/governance/audit/route.ts#L10)):
   ```http
   HTTP/1.1 200 OK
   Content-Type: application/json
   Deprecation: @1800000000
   Link: <https://<portal-docs>/event-envelope-support-matrix>; rel="deprecation"
   ```
   > 주의: 기존 `src/app/api/governance/audit/route.ts`는 `/api/governance/events`를 `rel="successor-version"`으로 가리키지만, 그것은 audit→events 이름 변경에 대한 후속 엔드포인트이다. `POST /api/events/ingest`에는 대응하는 후속 엔드포인트가 없으므로 `successor-version`을 쓰지 않고 이 문서를 가리키는 `rel="deprecation"` 링크를 쓴다 [PROPOSED].
3. **하드 컷오프 (Hard Cutover)**:
   유예 기간 만료 릴리스(예: Portal v2.0 또는 지정 릴리스)부터는 `schema_version` 누락 요청을 Fail-Closed 정책에 따라 HTTP 400으로 즉각 거부합니다.

---

## 4. 미확인 필드 및 미확인 버전 처리 정책 (Field & Version Handling)

### 4.1 미확인 필드 처리 (Forward Compatibility)
1. **최상위 미확인 필드**:
   - `POST /api/events/ingest`에서 인입된 JSON의 최상위 필드 중 기지 필드(`type`, `severity`, `title`, `source`, `actor`, `resource`, `correlation_id` 등)만 명시적으로 구조화 추출하며, 알 수 없는 필드는 밸리데이션 에러 없이 안전하게 무시합니다([`src/app/api/events/ingest/route.ts:356-374`](../src/app/api/events/ingest/route.ts#L356)).
2. **중첩 객체 미확인 속성**:
   - 액터 검증기 [`isValidEventActor`](../src/types/event-envelope.ts#L65)는 `id`, `type`, `displayName` 외의 추가 속성(예: `tier`, `mfa_verified`)을 허용합니다.
   - 리소스 검증기는 정의된 5개 키 외의 추가 속성을 허용하는 것으로 보이지만, 인제스트 코드가 `resource`를 검증 후 객체째 저장하는지 여부와 추가 속성 보존은 여기서 확인한 코드만으로 검증되지 않았습니다. 추가 속성 보존은 **[PROPOSED / UNVERIFIED]** 계약입니다.
3. **스토리지 및 재생 시 처리**:
   - `JSON.parse`는 저장된 JSON 속성을 파싱 결과에 유지하지만, 인제스트 경로가 중첩 `resource` 추가 속성을 보존하는지는 **[UNVERIFIED]**입니다. 이 속성의 저장 및 재생 보존은 **[PROPOSED]** 계약입니다.

### 4.2 미확인 및 미지원 버전 처리 (Fail-Closed Policy [PROPOSED])
현재 코드베이스의 Fail-Open 수용 특성을 종식하고, 계약 위반 및 데이터 무결성 훼손을 방지하기 위해 Fail-Closed 정책을 적용합니다.

1. **인제스트 경계 차단**:
   - `schema_version`이 제공되었으나 허용 목록(`"1.0"`, 하위 호환 `"1.x"`)에 포함되지 않은 경우(예: `"2.0"`, `"99.0"`), HTTP 400 Bad Request로 즉시 거절합니다.
2. **구조화된 진단 오류 응답 스키마 (Actionable Diagnostics)**:
   단순 텍스트 에러 대신 클라이언트 및 오퍼레이터가 즉각 대응할 수 있는 기계 판독형 진단 정보를 반환합니다:
   ```json
   {
     "error": "UNSUPPORTED_SCHEMA_VERSION",
     "message": "Envelope schema version '99.0' is not supported by this portal release.",
     "received_version": "99.0",
     "supported_versions": ["1.0"],
     "deprecated_versions": ["unversioned"],
     "remediation": "Update producer to emit supported schema_version '1.0', or upgrade Portal.",
     "documentation_url": "/docs/event-envelope-support-matrix.md"
   }
   ```
3. **저장소 내 미지원 버전 이벤트 재생 처리**:
   - 링 버퍼에 비정상 주입된 미지원 메이저 버전 이벤트가 존재할 경우, `replayAfter`는 예외를 던져 재생 루프를 중단시키는 대신 해당 이벤트를 안전하게 격리하고 건너뜁니다.
   - 메트릭 `liveStreamMetrics.replayUnknown` 카운터를 증가시키고 구조화된 에러 로그를 남깁니다.

---

## 5. 과거 이벤트 재생 및 인메모리 변환 계층 (Replay Translation Layer)

Valkey 링 버퍼에 이미 적재된 과거 `unversioned` 레코드에 대한 읽기 시점 인메모리 업캐스팅은 **제안된 향후 동작 [PROPOSED]**입니다. 현재 `getRecentEvents()`와 `replayAfter()`는 JSON 문자열을 `JSON.parse(item) as LiveEvent`로 파싱할 뿐이며, `schema_version`을 합성하거나 누락 필드를 업캐스팅하지 않습니다.

### 5.1 변환 불변식 (Invariants)
1. **[PROPOSED] 스토리지 불변 원칙**: Valkey `live:events` 리스트에 저장된 기존 JSON 문자열을 직접 수정(rewrite)하지 않습니다. 제안하는 변환은 `replayAfter()` 및 `getRecentEvents()` 실행 시 메모리 상에서만 일어납니다.
2. **[PROPOSED] 결정론적 기본값 매핑 규칙**:
   - `schema_version`: 필드가 누락되었을 경우 가상으로 `"1.0"`으로 승격(up-cast)하여 컨슈머에 제공.
   - `actor`: 누락 시 `null`로 매핑.
   - `resource`: 누락 시 `null`로 매핑.
   - `correlation_id`: 누락 시 `null` (또는 추적을 위해 `id`와 동일값으로 보정).
   - `visibility`: 누락 시 `null` (SSE 스트림 필터링 단계에서 default-deny로 안전 처리).

---

## 6. 향후 추가할 호환성 검증 테스트 케이스 (Future Test Cases)

[`src/types/event-envelope.compat.test.ts`](../src/types/event-envelope.compat.test.ts)에 현재 구현되어 있는 특성화(characterization) 테스트를 향후 규범적(normative) 계약 검증으로 전환할 때 추가해야 하는 구체적인 테스트 케이스 명세입니다:

### Test Case 1: 미지원 메이저 스키마 버전 Fail-Closed 거부
- **목적**: 지원되지 않는 메이저 버전 인입 시 HTTP 400 및 진단 에러 반환 검증.
- **입력**: `POST /api/events/ingest`, 본문에 `schema_version: "2.0"` 또는 `"99.0"` 포함.
- **기대 결과**:
  - HTTP 상태 코드: `400 Bad Request`.
  - 응답 본문: `error === "UNSUPPORTED_SCHEMA_VERSION"`, `supported_versions` 배열에 `"1.0"` 포함, `received_version` 정확히 반사.
  - Valkey 링 버퍼에 이벤트가 추가되지 않음(`valkeyState.ring.length === 0`).

### Test Case 2: 레거시 unversioned 페이로드 수용 및 Deprecation 헤더 반환
- **목적**: 유예 기간 동안 `schema_version`이 없는 레거시 요청 수용 및 경고 헤더 검증.
- **입력**: `POST /api/events/ingest`, [`FIXTURE_OLDER_MINIMAL_INGEST`](../src/types/event-envelope.compat.test.ts#L134) 전송.
- **기대 결과**:
  - HTTP 상태 코드: `200 OK`.
  - 응답 헤더: `Deprecation` 헤더 및 `Link` 헤더 존재 확인.
  - 링 버퍼에 정상 적재되며 누락된 봉투 필드는 `null`로 정규화됨.

### Test Case 3: 마이너 순방향 호환 스키마 버전 수용
- **목적**: 비파괴적 확장 버전 `schema_version: "1.1"` 및 신규 부가 필드 수용 검증.
- **입력**: `schema_version: "1.1"`과 임의의 확장 필드(`annotations: { team: "infra" }`)를 포함한 유효 페이로드.
- **기대 결과**:
  - HTTP 상태 코드: `200 OK`.
  - 이벤트 정상 수용 및 링 버퍼 적재.

### Test Case 4: 스토리지 내 unversioned 과거 레코드의 안전한 인메모리 승격
- **목적**: 봉투 필드가 전혀 없는 과거 문자열이 링에 적재되어 있을 때 `replayAfter()`가 에러 없이 안전한 v1 규격 객체를 반환하는지 검증.
- **입력**: 링 버퍼에 `{"id":"90","type":"alert","severity":"error","title":"Old Alert","source":"alertmanager"}` 삽입 후 `replayAfter("89")` 호출.
- **기대 결과**:
  - 예외 발생 없음.
  - 반환된 이벤트 객체의 `actor === undefined || actor === null`, `resource === undefined || resource === null`.
  - 현재 구현 기준: `schema_version`은 합성되지 않고 `undefined`로 남는다 (`JSON.parse` 결과 그대로 반환).
  - §5의 승격 제안 [PROPOSED] 적용 시: 반환 객체의 `schema_version === "1.0"`이 되어야 한다 (제안 구현 후 이 기대값으로 전환).

### Test Case 5: 롤링 업그레이드 혼합 버전 링 버퍼 순회
- **목적**: `"1.0"`, `unversioned`, `"1.1"` 이벤트가 섞여 있는 단일 링 버퍼를 단일 컨슈머가 단조 순서대로 누락 없이 재생할 수 있는지 검증.
- **입력**: 링 버퍼에 3개 버전의 이벤트 연속 적재.
- **기대 결과**:
  - `replayAfter()` 호출 시 3개 이벤트가 모두 누락 없이 반환됨 (`gap === false`, `unknown === false`).

### Test Case 6: 잘못된 스키마 버전 데이터 타입 검증
- **목적**: 문자열이 아닌 타입의 `schema_version` 인입 시 사전 차단 검증.
- **입력**: `schema_version: 1.0` (숫자), `schema_version: true` (불리언), `schema_version: ""` (빈 문자열).
- **기대 결과**:
  - HTTP 상태 코드: `400 Bad Request`.
  - 진단 메시지: `"INVALID_SCHEMA_VERSION_FORMAT"`.

### Test Case 7: CI 스키마 파괴적 변경 감지 게이트 [PROPOSED]
- **목적**: PR 또는 커밋 단계에서 `src/types/event-envelope.ts`의 기존 필수 필드가 제거되거나 변경되는 것을 자동 감지.
- **기대 결과**: Git diff 또는 TypeScript AST 검사기를 통해 정규 인터페이스 필드 축소가 발생한 경우 CI 빌드 실패 처리.

---

## 7. 주요 설계 결정 (Architectural Decisions: D1..D5)

- **D1: 미지원 메이저 버전 Fail-Closed 거부 및 마이너 비파괴적 확장 허용**
  - *이유*: 스키마 버전 불일치로 인한 조용한 필드 유실 및 대시보드 런타임 크래시를 원천 차단하고 계약 신뢰성을 확보함.
  - *비용*: 호환되지 않는 프로듀서의 요청이 HTTP 400으로 거부되므로 프로듀서 업그레이드가 선행되어야 함.
  - *탈출구*: 장애 비상 상황 시 환경 변수 `EVENT_SCHEMA_FAIL_OPEN=true` [PROPOSED]를 설정하여 임시로 이전 Fail-Open 검증으로 롤백 가능.

- **D2: 레거시 unversioned 페이로드에 대한 N-2 릴리스 폐기 유예 윈도우 보장**
  - *이유*: 기존 웹훅 및 클러스터 프로듀서가 한순간에 차단되어 모니터링 공백이 발생하는 것을 방지.
  - *비용*: 인제스트 라우트가 이중 경로(dual-path)를 유지해야 하며 폐기 모니터링 부하가 발생함.
  - *탈출구*: RFC 9745 `Deprecation` 헤더 고지 후 명시된 릴리스에서 하드 컷오프로 단일 경로 전환.

- **D3: 저장소 수정 없는 인메모리 읽기 시점 승격(In-Memory Upcasting)**
  - *이유*: Valkey 링 버퍼의 과거 문자열을 일괄 재작성(rewrite)하는 작업은 롤링 배포 중 동시성 경합 및 오버헤드를 유발함.
  - *비용*: 제안된 `replayAfter` 업캐스팅 구현 시 인메모리 프로퍼티 기본값 보정 연산이 발생.
  - *탈출구*: 링 버퍼 보존 한도(`LIVE_EVENT_RETENTION = 1000`)에 따라 일정 이벤트 유입 후 과거 레코드는 자동 만료되어 자연 소멸됨.

- **D4: 롤링 배포 간 단일 공유 링 버퍼(`live:events`) 및 순방향 수용성 유지**
  - *이유*: 버전별 링 키 분할은 실시간 대시보드 스트림의 이벤트 시퀀스 연속성과 단조성을 파괴함.
  - *비용*: 구버전 Pod와 신버전 Pod가 동일 링 버퍼 내의 이종 페이로드를 안전하게 처리할 수 있도록 방어적 코딩이 요구됨.
  - *탈출구*: `JSON.parse` 기반 파싱과 필수 필드 널 안정성 규칙을 준수하여 런타임 충돌 방지.

- **D5: 구조화된 기계 판독형 진단 에러 스키마 도입**
  - *이유*: 단순 에러 문자열은 자동화된 에이전트 및 연동 시스템이 버전 불일치 원인을 파악하기 어려움.
  - *비용*: 에러 페이로드 크기가 소폭 증가함.
  - *탈출구*: 기존 단순 파서를 위해 최상위 `error` 문자열 필드를 유지하면서 부가 필드를 확장 제공.

---

## 8. 가정 및 범위 외 사항 (Assumptions & Out of Scope)

### 8.1 가정 (ASSUMPTIONS)
1. **[ASSUMPTION-1]**: 향후 `narwhal#140` 구현 시 Narwhal 클러스터 측 이벤트 프로듀서는 시맨틱 버전 체계(`"1.0"`)를 채택하여 `EventEnvelope` 계약과 일치시킬 것으로 가정합니다.
2. **[ASSUMPTION-2]**: Valkey 링 버퍼 크기는 고정 상한(`LIVE_EVENT_RETENTION = 1000`, [`src/lib/live-stream.ts:7`](../src/lib/live-stream.ts#L7))을 가지므로, 레거시 `unversioned` 과거 이벤트는 신규 이벤트 유입에 따라 자연스럽게 회전되어 축출됩니다.
3. **[ASSUMPTION-3]**: 포탈의 롤링 업데이트는 일반적인 Kubernetes 배포 전략에 따라 10분 이내에 완료되므로, Pod 버전 간 skew 공존 상태는 일시적입니다.

### 8.2 범위 외 사항 (Out of Scope)
1. **런타임 소스 코드 변경**: `src/app/api/events/ingest/route.ts` 등의 Fail-Closed 로직 구현은 별도 구현 PR에서 다루며 본 문서의 범위가 아닙니다.
2. **Narwhal 클러스터 리포지토리 변경**: `../narwhal` 리포지토리의 프로듀서 계약 및 RBAC/배포 수정은 Companion Narwhal 계약에 따라 포탈 작업 범위에서 제외됩니다.
3. **CI 워크플로우 도구 구현**: 스키마 차이 자동 감지 linter/tooling 구현은 추후 CI 파이프라인 과제로 위임합니다.
