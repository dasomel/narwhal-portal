# 아웃바운드 HTTP 전송 정책

[English](outbound-http-policy.md) | 한국어

본 문서는 공통 전송 클라이언트인 [`src/lib/http-client.ts`](../src/lib/http-client.ts) (portal#48)에서 구현된 아웃바운드 HTTP 정책을 명세합니다. 모든 오픈소스 프로바이더 어댑터(Argo CD, Gitea, Prometheus, Keycloak, APISIX, Kubernetes API, OpenBao, Alertmanager, Falco/Loki)는 직접 `fetch()`를 호출하는 대신 이 클라이언트를 사용해 타임아웃 관리, 제한된 재시도, 분산 상관관계 전파, 응답 본문 기한, 민감 자격증명 마스킹을 일관되게 적용합니다.

## 아키텍처 및 보장 사항

### 1. 에러 모델 및 분류
- **전송 에러 (`HttpClientError`)**: 전송 계층 장애 시 `HttpClientError`([`src/lib/http-client.ts:98-116`](../src/lib/http-client.ts#L98-L116))를 던집니다. `kind` 프로퍼티([`src/lib/http-client.ts:90`](../src/lib/http-client.ts#L90))는 다음과 같이 정규화됩니다:
  - `"timeout"`: 시도 시간이 `timeoutMs`를 초과했거나 본문 스트림 읽기가 남은 기한을 초과하여 중단됨.
  - `"network"`: 네트워크 또는 소켓 수준 오류(예: `TypeError: fetch failed`, `ECONNRESET`, DNS 해석 실패).
  - `"aborted"`: 인바운드 호출자가 전달한 `AbortSignal`에 의해 취소됨.
- **HTTP 상태 응답**: 재시도되지 않는 HTTP 상태 응답(401, 403, 500 및 재시도 소진된 429/502/503/504 포함)은 표준 `Response` 객체로 반환됩니다([`src/lib/http-client.ts:350-353, 413`](../src/lib/http-client.ts#L350-L353)). 도메인 어댑터가 HTTP 상태를 직접 처리합니다(예: `res.status === 401` 확인).
- **서킷 브레이커**: 프로바이더별 서킷 브레이커 및 헬스 메트릭은 본 슬라이스에서 구현되지 않았습니다([`src/lib/http-client.ts:27-28`](../src/lib/http-client.ts#L27-L28)).

### 2. URL 및 자격증명 마스킹 (Redaction)
- `HttpClientError.url`과 `HttpClientError.message`는 `redactUrl()`([`src/lib/http-client.ts:122-134`](../src/lib/http-client.ts#L122-L134))을 통해 쿼리 파라미터 및 사용자 인증 정보(`scheme://user:pass@`)를 항상 제거합니다.
- 요청 헤더(`Authorization: Bearer ...`, `X-Vault-Token` 등)는 `HttpClientError.message`에 절대 포함되지 않으며, 에러 메시지에는 HTTP 실패 종류와 마스킹된 URL만 포함됩니다([`src/lib/http-client.ts:93-115`](../src/lib/http-client.ts#L93-L115)). 다만 하위 런타임에서 전달된 원본 에러는 `HttpClientError.cause`에 그대로 보존됩니다([`src/lib/http-client.ts:114, 425`](../src/lib/http-client.ts#L114)). 따라서 하위 fetch나 환경 에러 객체에 민감 정보가 포함될 수 있는 경우 호출자가 `cause` 전체를 로그에 그대로 남기지 않도록 유의해야 합니다.

### 3. 헤더 및 본문 기한 (Deadlines)
- `fetchWithPolicy`는 연결 수립 및 헤더 수신까지 시도당 `timeoutMs`([`DEFAULT_TIMEOUT_MS = 10_000`](../src/lib/http-client.ts#L51)) 기한을 적용합니다.
- 헤더가 도착하면 남은 시간 `remainingMs = Math.max(0, timeoutMs - elapsed)`을 `bodyDeadlines`([`src/lib/http-client.ts:252, 412-413`](../src/lib/http-client.ts#L252))에 기록합니다.
- `readJsonWithPolicy`([`src/lib/http-client.ts:338`](../src/lib/http-client.ts#L338)) 또는 `readTextWithPolicy`([`src/lib/http-client.ts:343`](../src/lib/http-client.ts#L343))를 통한 본문 읽기는 스트림 리더를 획득하여 `remainingMs` 내에서만 페이로드를 읽습니다. 본문이 멈추면 리더를 취소하고 기본 스트림을 중단하며 `HttpClientError(kind: "timeout")`을 발생시킵니다.
- **응답 크기 상한**: 본문 읽기 *시간*은 엄격히 제한되지만, 바이트 크기 상한은 현재 전송 계층에서 제한되지 않습니다([`src/lib/http-client.ts:26-27`](../src/lib/http-client.ts#L26-L27)).

### 4. 상관관계 ID 전파
- 인바운드 요청/헤더에서 `correlationIdFrom()`([`src/lib/http-client.ts:168`](../src/lib/http-client.ts#L168))을 통해 `x-correlation-id`, `x-request-id` 순으로 ID를 추출합니다.
- 존재할 경우 `fetchWithPolicy`가 `X-Correlation-Id` 헤더로 자동 전파합니다([`src/lib/http-client.ts:48, 178-197`](../src/lib/http-client.ts#L48)). 없을 경우 임의 생성하지 않고 생략합니다.

---

## 타임아웃 클래스

`fetchWithPolicy`는 시도당 단일 `timeoutMs` 예산을 적용합니다. 아래 표는 `src/lib/` 도메인 프로바이더에서 사용되는 타임아웃 분류입니다:

| 타임아웃 클래스 | 연결 + 헤더 | 본문 읽기 | 시도당 총 예산 | 사용처 (`src/lib/` 호출부) | 상수 및 소스 인용 |
|---|---|---|---|---|---|
| **클러스터 프로브** | 최대 2초 | 2초 중 잔여 시간 | 2초 | 쿠버네티스 클러스터 버전 헬스 프로브 | [`src/lib/domain/cluster.ts:221`](../src/lib/domain/cluster.ts#L221) (`timeoutMs = 2000`) |
| **빠른 프로브 / 텔레메트리 조회** | 최대 5초 | 5초 중 잔여 시간 | 5초 | Argo CD 조회 (`argoFetch`)<br>Gitea 커밋 타임스탬프 (`getCommitTimestamp`)<br>Alertmanager 사일런스 목록 (`getAlertmanagerSilences`)<br>APISIX 라우트 조회 (`getRoutes`)<br>Prometheus 인스턴트 쿼리 (비용)<br>Prometheus 범위 쿼리 (비용)<br>Loki 로그 쿼리 (Falco 이벤트)<br>쿠버네티스 노드 상태 프로브 (Hero)<br>의존성 헬스 프로브 (`probeHttpDependency`) | [`src/lib/argocd.ts:81`](../src/lib/argocd.ts#L81) (`timeoutMs = 5000`)<br>[`src/lib/gitea.ts:270`](../src/lib/gitea.ts#L270) (`timeoutMs: 5000`)<br>[`src/lib/alertmanager.ts:96`](../src/lib/alertmanager.ts#L96) (`timeoutMs: 5000`)<br>[`src/lib/apisix-client.ts:65`](../src/lib/apisix-client.ts#L65) (`timeoutMs: 5000`)<br>[`src/lib/cost.ts:193, 195`](../src/lib/cost.ts#L193) (`PROM_TIMEOUT_MS = 5000`, `PROM_RANGE_TIMEOUT_MS = 5000`)<br>[`src/lib/falco.ts:99`](../src/lib/falco.ts#L99) (`timeoutMs: 5000`)<br>[`src/lib/hero.ts:202`](../src/lib/hero.ts#L202) (`timeoutMs: 5000`)<br>[`src/lib/dependency-health.ts:166`](../src/lib/dependency-health.ts#L166) (`DEFAULT_PROBE_TIMEOUT_MS = 5000`) |
| **표준 / 기본값** | 최대 10초 | 10초 중 잔여 시간 | 10초 | 클라이언트 기본 폴백<br>Argo CD 동기화 (`syncArgoApp`) 및 롤백 (`rollbackArgoApp`)<br>Gitea API 변이 작업 (`api`)<br>APISIX 라우트 플러그인 토글 (`toggleRoute`)<br>Prometheus 표준 쿼리 (`queryPrometheusVector`, range)<br>서비스 그래프 Prometheus 쿼리<br>Alertmanager 사일런스 생성 / 만료<br>Keycloak 관리자 토큰 및 작업<br>OpenBao 인증 로그인 및 KV 시크릿 읽기/쓰기<br>쿠버네티스 Job 삭제 | [`src/lib/http-client.ts:51`](../src/lib/http-client.ts#L51) (`DEFAULT_TIMEOUT_MS = 10_000`)<br>[`src/lib/argocd.ts:251, 286`](../src/lib/argocd.ts#L251)<br>[`src/lib/gitea.ts:93`](../src/lib/gitea.ts#L93)<br>[`src/lib/apisix-client.ts:85`](../src/lib/apisix-client.ts#L85)<br>[`src/lib/prometheus.ts:232, 361, 441`](../src/lib/prometheus.ts#L232)<br>[`src/lib/service-graph.ts:89`](../src/lib/service-graph.ts#L89)<br>[`src/lib/alertmanager.ts:38, 77`](../src/lib/alertmanager.ts#L38)<br>[`src/lib/keycloak-client.ts:93, 172`](../src/lib/keycloak-client.ts#L93)<br>[`src/lib/openbao.ts:136, 192, 202`](../src/lib/openbao.ts#L136)<br>[`src/lib/k8s-job-runner.ts:78`](../src/lib/k8s-job-runner.ts#L78) |
| **쿠버네티스 배치 / 긴 조회** | 최대 60초 | 60초 중 잔여 시간 | 60초 | 쿠버네티스 목록 페이징 (`listBounded`)<br>쿠버네티스 일반 리소스 조회 (`getNamespaces` 등)<br>쿠버네티스 잡 러너 API 호출 (`k8sFetch`)<br>컴플라이언스 프레임워크 평가<br>보안 스코어카드 검사<br>Trivy 취약점 리포트 수집 | [`src/lib/k8s-client.ts:48`](../src/lib/k8s-client.ts#L48) (`timeoutMs: 60_000`)<br>[`src/lib/k8s-job-runner.ts:52, 64`](../src/lib/k8s-job-runner.ts#L52)<br>[`src/lib/compliance.ts:33`](../src/lib/compliance.ts#L33)<br>[`src/lib/scorecard.ts:73`](../src/lib/scorecard.ts#L73)<br>[`src/lib/trivy.ts:22`](../src/lib/trivy.ts#L22) |
| **쿠버네티스 잡 실행 예산** | 폴링당 1~10초 클램프 | 잔여 예산 | 최대 300초 총량 | 쿠버네티스 비동기 튜닝/배치 잡 실행 | [`src/lib/k8s-job-runner.ts:133, 218`](../src/lib/k8s-job-runner.ts#L133) (`timeoutMs = 5 * 60_000`, `jobStatusPollTimeoutMs`) |

---

## 재시도 정책 매트릭스

### 파라미터 및 상수
- **최대 시도 횟수**: `DEFAULT_MAX_ATTEMPTS = 3` ([`src/lib/http-client.ts:52`](../src/lib/http-client.ts#L52))
- **기본 백오프 지연**: `DEFAULT_BASE_DELAY_MS = 200` ([`src/lib/http-client.ts:53`](../src/lib/http-client.ts#L53))
- **최대 백오프 지연**: `DEFAULT_MAX_DELAY_MS = 5_000` ([`src/lib/http-client.ts:54`](../src/lib/http-client.ts#L54))
- **백오프 알고리즘**: Full-jitter 지수 백오프 `Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))` ([`src/lib/http-client.ts:143-146`](../src/lib/http-client.ts#L143-L146))
- **Retry-After 헤더**: 429 응답의 경우 `Retry-After` 헤더(초 단위 또는 HTTP-date)를 반영하며, `maxDelayMs`로 상한이 제한됩니다([`src/lib/http-client.ts:151-159`](../src/lib/http-client.ts#L151-L159))
- **재시도 대상 HTTP 메서드**: `GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS` ([`IDEMPOTENT_METHODS`, src/lib/http-client.ts:32-38`](../src/lib/http-client.ts#L32-L38))
- **재시도 대상 HTTP 상태 코드**: `429`, `502`, `503`, `504` ([`RETRYABLE_STATUS`, src/lib/http-client.ts:46`](../src/lib/http-client.ts#L46))
- **재시도 시 커넥션 반환**: 재시도하기 전 응답 본문을 `cancelBody(response)`(`await response.body.cancel()`, [`src/lib/http-client.ts:238-245, 398`](../src/lib/http-client.ts#L238))로 취소하여 커넥션 누수를 방지합니다.

### 매트릭스

| 작업 분류 | 실패 종류 | 재시도 여부 | 시도 횟수 및 백오프 일정 | 근거 / 소스 인용 |
|---|---|---|---|---|
| **멱등성 작업** (`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`, 기본 재시도 활성화) | 네트워크 에러 / 연결 리셋 (`ECONNRESET`, `TypeError: fetch failed`, DNS 일시 장애) | **예** | 최대 3회 시도. Full-jitter: `0..min(5s, 200ms * 2^(attempt-1))`. | 일시적인 전송 단절 복구. [`src/lib/http-client.ts:421-424`](../src/lib/http-client.ts#L421-L424) |
| **멱등성 작업** (`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`, 기본 재시도 활성화) | HTTP 429 Too Many Requests | **예** | 최대 3회 시도. `Retry-After` 헤더 반영(최대 5초 상한); 부재 시 full-jitter. | 업스트림 서비스의 명시적 지연 요청 수용. [`src/lib/http-client.ts:400-405`](../src/lib/http-client.ts#L400-L405) |
| **멱등성 작업** (`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`, 기본 재시도 활성화) | HTTP 502 / 503 / 504 게이트웨이 / 서비스 오류 | **예** | 최대 3회 시도. 응답 본문 취소 후 full-jitter: `0..min(5s, 200ms * 2^(attempt-1))`. | 일시적 게이트웨이 또는 프록시 장애 복구. [`src/lib/http-client.ts:394-406`](../src/lib/http-client.ts#L394-L406) |
| **멱등성 작업** (`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`, 기본 재시도 활성화) | HTTP 500 Internal Server Error / 501 Not Implemented | **아니오** | 1회 시도. `Response(status: 500/501)` 반환. | D1: 500/501은 일시적 전송 결함보다 버그/잘못된 요청일 확률이 높음; 무차별 재시도는 업스트림 부하를 가중시킴. [`src/lib/http-client.ts:40-46`](../src/lib/http-client.ts#L40-L46) |
| **멱등성 작업** (`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`, 기본 재시도 활성화) | HTTP 401 Unauthorized / 403 Forbidden | **아니오** (전송 계층 기준) | 1회 시도. `Response(status: 401/403)` 반환. | 인증/인가 실패; 전송 계층의 맹목적 재시도는 무의미함. 해당되는 경우 도메인 호출부에서 재인증/토큰 갱신을 수행함(예: `k8s-client.ts:53`, `keycloak-client.ts:194`, `openbao.ts:201`). |
| **멱등성 작업** (`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`, 기본 재시도 활성화) | 요청 타임아웃 (`timeoutMs` 경과) | **아니오** | 1회 시도. `HttpClientError(kind: "timeout")` 발생. | 지연 시간 누적 및 큐 적체를 막기 위해 재시도하지 않음. [`src/lib/http-client.ts:420-425`](../src/lib/http-client.ts#L420-L425) |
| **멱등성 작업** (`GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`, 기본 재시도 활성화) | 본문 읽기 타임아웃 (스트림 중단) | **아니오** | 1회 시도. 리더 취소 및 `HttpClientError(kind: "timeout")` 발생. | 멈춘 본문 스트림으로 인해 호출부가 무한 대기하는 현상 방지. [`src/lib/http-client.ts:321-325`](../src/lib/http-client.ts#L321-L325) |
| **모든 작업** | 호출자 시그널 취소 (`signal.aborted === true`) | **아니오** | 1회 시도 (또는 진행 중인 백오프 지연 완료 후 종료). `HttpClientError(kind: "aborted")` 발생. | 호출자가 취소를 요청했으므로 재시도 없이 중단함. 제한 사항: 재시도 백오프 `delay()`는 중단 시그널을 감지하지 않으므로([`src/lib/http-client.ts:136-138, 404, 422`](../src/lib/http-client.ts#L136)), 백오프 대기 중에 취소된 경우 해당 대기가 끝난 뒤에 종료됨. [`src/lib/http-client.ts:416-425`](../src/lib/http-client.ts#L416-L425) |
| **비멱등성 변이 작업** (`POST`, `PATCH`, 비표준 메서드) | 모든 실패 (네트워크, 429, 5xx, 타임아웃) | **아니오** | 1회 시도 (`maxAttempts = 1`). HTTP 상태면 `Response` 반환 또는 `HttpClientError` 발생. | 상태 변경 중복 실행 방지 (예: 커밋 중복 생성, 중복 동기화 트리거). [`src/lib/http-client.ts:373-374`](../src/lib/http-client.ts#L373-L374) |
| **명시적 단발 호출자** (`retry: false`, 예: `K8S_POLICY`, `PROM_POLICY`, Keycloak 관리자 PUT/DELETE, OpenBao 로그인, Alertmanager 사일런스 삭제) | 모든 실패 (네트워크, 429, 5xx, 타임아웃) | **아니오** | 1회 시도 (`maxAttempts = 1`). | 쿠버네티스 APF 스로틀링 충돌 방지, Prometheus 과부하 곱셈 방지, 관리자 상태 변이 중복 방지. [`src/lib/k8s-client.ts:16`](../src/lib/k8s-client.ts#L16), [`src/lib/prometheus.ts:11`](../src/lib/prometheus.ts#L11), [`src/lib/keycloak-client.ts:182`](../src/lib/keycloak-client.ts#L182) |
