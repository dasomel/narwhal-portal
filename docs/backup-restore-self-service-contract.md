# Backup restore self-service — preflight 및 승인 계약 (초안)

- **상태**: 제안 (구현 전)
- **범위**: restore 사전 점검 항목과 승인 요청/결정 데이터 계약만 정의한다.
- **근거**: 이 저장소에는 Velero/CNPG 백업·복원 API 라우트가 없다. `src/app/api/`의 현재 라우트 목록과 코드에서 확인되는 operation 및 namespace-scope 패턴을 토대로 Portal 경계를 제안한다. Velero/CNPG 자체 API와 Narwhal Management API는 이 문서에서 규정하지 않는다.

## 1. 기존 계약과 한계

`src/lib/operation-context.ts`는 `operation_id`, `correlation_id`, `causation_id`, `request_id`, actor 및 `resource`를 만들고 `operation.started/completed/failed` 이벤트를 best-effort로 발행한다. `src/types/event-envelope.ts`는 `EventResource.cluster`, `namespace`, `kind`, `name`, `workload`를 정의한다. 따라서 복원 요청은 이 식별자를 사용해야 하지만, lifecycle 이벤트 발행만으로 durable operation 저장소나 승인 기록이 생기는 것은 아니다.

`src/lib/scope.ts`의 `getEffectiveScope`는 cluster ID와 namespace 소유/가시성 범위를 결합한다. `src/app/api/namespaces/route.ts`의 GET은 세션의 유효 scope에 포함된 namespace만 반환한다. restore 권한은 요청 body의 `team`/tenant 문자열을 신뢰하지 않고, 서버가 다시 계산한 scope로 검사해야 한다.

`src/lib/agent-execution-security.ts`의 `ApprovalRecord`는 `approved | denied | expired | revoked`, approver, 만료시각, `resolutionId`, `invocationDigest`를 사용하며 승인 후 입력의 digest를 재검증한다. 이 agent 실행 전용 타입은 restore에 그대로 적용되는 공통 API가 아니다. 아래 restore 승인 필드는 **PROPOSED**이며, 승인 대상의 변조 방지 원칙만 그 구현에서 참고한다.

## 2. Restore preflight 체크리스트

Preflight 결과는 항목별 `check_id`, `status`, `checked_at`, `evidence_ref`(있을 때), `message`를 가진다. `status`는 `pass | fail | warning | unknown`이다. 누락/오래된/접속 불가 증거는 `unknown`이며 `pass`로 승격하지 않는다.

| 점검 | `pass` 조건 | `fail` / `unknown` 처리 |
|---|---|---|
| 요청 범위 | `cluster_id`, backup ID, source namespace, target namespace가 명시됨. target은 요청자의 현재 `getEffectiveScope(session, cluster_id)`에 포함됨 | 누락·형식 오류는 거부. cluster 불일치 또는 namespace scope 밖은 `403`; tenant 간 우회 금지 |
| 백업 식별/상태 | 백업 backend가 해당 cluster에서 응답하고 선택한 backup의 완료 상태·시각을 반환 | backend 미응답은 `503`; 백업 없음/실패/삭제는 거부. stale cache 결과는 건강 또는 승인 근거로 사용 금지 |
| 대상 namespace 및 리소스 충돌 | target namespace가 존재/생성 정책상 유효하고, 충돌 리소스 목록 및 적용 전략이 계산됨 | 충돌이 미해결이면 `fail`; 목록 조회 불능이면 `unknown`으로 실행 차단 |
| 스토리지 | 필요한 StorageClass/PVC 용량 및 attach 가능성에 대한 backend/cluster 증거가 확인됨 | 미충족은 `fail`; 증거를 얻을 수 없으면 `unknown`으로 실행 차단 |
| secret·identity 의존성 | workload가 필요로 하는 Secret/ServiceAccount/외부 identity 참조가 대상에서 해결 가능함 | 누락은 `fail`; 확인 불능은 `unknown`으로 실행 차단. secret 값은 응답/증거에 싣지 않고 참조 식별자만 기록 |
| 버전 호환성 | backup workload/API 버전과 target cluster의 지원 범위가 비교됨 | 비호환은 `fail`; 버전 정보 부재/비교기 미지원은 `unknown`으로 실행 차단 |
| 용량 | 복원 workload의 요청량과 target의 allocatable 용량을 비교한 결과가 충분함 | 부족은 `fail`; 최신 용량 관측 불가면 `unknown`으로 실행 차단 |
| RPO/RTO 증거 | §4의 필수 필드가 모두 계산 가능하며 정책 기준과 비교됨 | 누락된 입력은 `unknown`; RPO/RTO 비준수는 `fail`. 숫자 미상은 0으로 취급 금지 |
| 무결성 | backend가 제공하면 검증 결과와 검증 시각/대상을 연결함 | backend 미지원은 `unknown/not-supported`; 변조 또는 검증 실패는 `fail`. unknown은 verified로 표시 금지 |

Preflight 전체 verdict는 결정적이다: 하나라도 `fail`이면 `blocked`; `fail`은 없고 `unknown`이 하나라도 있으면 `needs-evidence`; 전부 `pass` 또는 명시된 비차단 `warning`이면 `ready`. `needs-evidence`와 `blocked` 요청은 승인 불가하다. Preflight는 실행 직전에 다시 수행하며, 결과가 달라지면 기존 승인과 연결된 요청은 무효화한다.

## 3. 제안 승인 API 계약

아래 경로와 payload는 **PROPOSED**이며 현재 구현된 endpoint가 아니다. 의미상 요청 생성은 비동기 operation을 만들고, backup backend 복원은 별도 승인 결정 후에만 시작한다.

### 3.1 승인 요청

`POST /api/dr/restore-approvals` (**PROPOSED**)

```json
{
  "cluster_id": "<registered-cluster-id>",
  "backup_id": "<backend-backup-id>",
  "source_namespace": "<namespace>",
  "target_namespace": "<namespace>",
  "target_plan": { "conflict_policy": "fail" },
  "preflight_id": "<immutable-preflight-result-id>",
  "evidence": {
    "rpo": { "policy_id": "<id>", "target_seconds": 3600, "observed_seconds": 900, "as_of": "<RFC3339>", "result": "compliant" },
    "rto": { "policy_id": "<id>", "target_seconds": 14400, "estimate_seconds": 7200, "basis": "<method-and-inputs>", "result": "compliant" }
  },
  "reason": "<operator justification>"
}
```

서버는 인증 세션 actor, `cluster_id` 등록 여부, `source_namespace`와 `target_namespace` scope, backup 접근권, preflight verdict/신선도, RPO/RTO 입력을 다시 검증한다. Caller가 보낸 actor, tenant/team, approver, approval state, `operation_id`는 무시하고 서버가 설정한다. 요청 범위 및 evidence의 정규화된 digest를 승인 대상에 고정한다. scope를 계산할 수 없거나 backup/backend 조회가 불가능하면 fail-closed 한다.

성공 응답은 `202 Accepted`와 `{ approval_id, state, operation_id, correlation_id, cluster_id, tenant_scope, requested_by, requested_at, expires_at, preflight_id, request_digest }`를 반환한다. `tenant_scope`는 서버가 해석한 `{ namespace, owner_team }`이며, 현재 namespace owner는 `src/lib/namespace-ownership.ts` 및 `narwhal.io/team` label 해석 규칙과 일치해야 한다. owner를 확정할 수 없으면 요청 거부. `operation_id/correlation_id` 생성 및 이벤트 의미는 `src/lib/operation-context.ts`를 따른다.

### 3.2 상태 및 전이

승인 리소스 `state` (**PROPOSED**)는 `pending | approved | denied | expired | revoked | invalidated | executing | succeeded | failed` 중 하나다.

| 현재 상태 | 허용 전이 | 조건 |
|---|---|---|
| `pending` | `approved`, `denied`, `expired`, `revoked`, `invalidated` | 승인자 결정, TTL 만료, 취소, 또는 preflight/대상 digest 변경 |
| `approved` | `executing`, `expired`, `revoked`, `invalidated` | 실행 직전 승인자/TTL/digest/scope/preflight 재검증 성공 시에만 `executing`; 전이는 아래 terminal decision 규칙과 동일한 CAS로 확정 |
| `executing` | `reconciling` | worker 시작 또는 lease 만료 후 재조정 수행. 동일한 idempotency key로 backend operation을 조회/재개하며 새 restore 제출은 금지 |
| `executing`, `reconciling` | `succeeded`, `failed`, `reconciling` | backend operation의 확정 결과 및 사후검증 완료 시 종료. timeout, crash, 응답 모호성은 `reconciling`에 남기고 조회 재시도; 영구 종료 판단 전 새 restore를 시작하지 않음 |
| `reconciling` | `executing` | 조회로 기존 backend operation이 실행 중임을 확인한 경우 같은 operation 추적을 재개 |
| terminal (`denied`, `expired`, `revoked`, `invalidated`, `succeeded`, `failed`) | 없음 | 재사용 금지. 재시도는 새 approval/operation 생성 |

`reconciling`은 backend가 완료/실패를 확정하지 못한 동안의 비종료 상태다. worker lease와 주기적 reconcile은 이 상태를 영구히 방치하지 않고 계속 조회해야 한다. 최초 실행 전에 서버는 approval별 안정적인 `idempotency_key`를 생성해 durable하게 저장하고, 모든 제출/재시도에 같은 키를 사용한다. Backend 계약은 **PROPOSED**: `cluster_id`와 idempotency key(그리고 필요 시 backend operation ID)로 기존 restore operation을 조회하고 상태(`running | succeeded | failed | not_found`) 및 결과를 반환하는 조회 기능을 제공해야 한다. timeout/crash 후에는 먼저 이 조회를 수행한다. `running`이면 추적을 계속하고, `succeeded`/`failed`이면 그 결과를 반영한다. `not_found`도 제출 결과가 모호했던 시도와 키가 backend의 조회 보장 범위 안에 있음을 확인한 뒤 같은 키로만 재제출한다. 이 조회/멱등 보장이 없으면 자동 재제출하지 않고 `reconciling`으로 유지해 운영자 조사를 요구한다.

Approve/deny/요청자 취소(revoke)/TTL 만료 전이는 request의 현재 `state`와 `version`을 조건으로 하는 원자적 compare-and-set (CAS)으로 확정한다 (**PROPOSED**). 조건에 맞는 첫 terminal 결정만 승리하고, 이후 결정은 상태를 덮어쓰지 않는다. CAS 패자는 HTTP `409 decision_conflict`를 받는다. 승인 전 `pending`에서 approve와 cancel(revoke)와 TTL 만료가 동시에 발생해도 하나만 `approved`, `revoked`, `expired`로 전이하며 나머지는 모두 같은 conflict다. 이미 `approved`된 뒤 실행 전에 발생한 revoke/TTL 만료와 `executing` 전이도 동일하게 CAS로 경합을 직렬화한다. Approve/deny 행위는 요청자와 다른 승인 권한 actor가 수행한다 (**ASSUMPTION**: 현재 저장소에는 DR 승인자 role 또는 quorum 정책이 정의되어 있지 않다). production target 또는 기존 리소스 덮어쓰기 가능성이 있는 복원은 반드시 승인 대상으로 한다. 승인 결정을 요청자 자신이 내리거나, 결정 당시 scope가 바뀌었거나, TTL이 만료됐거나, 요청 digest가 달라졌으면 실행을 거부한다.

### 3.3 오류 응답

오류 본문은 `{ "error": { "code": "<stable-code>", "message": "<safe-summary>", "correlation_id": "<id>" } }` (**PROPOSED**)로 통일한다.

| HTTP | code 예시 | 조건 |
|---:|---|---|
| 400 | `invalid_request`, `invalid_evidence` | 필수 필드/형식 오류, 음수 시간 또는 정책/관측 단위 불일치 |
| 401 / 403 | `unauthorized` / `scope_denied` | 세션 없음 / cluster·namespace·backup 대상 scope 밖 |
| 404 | `backup_not_found`, `approval_not_found` | 요청 cluster 내 식별자가 없음. 타 scope 존재 여부 노출 금지 |
| 409 | `preflight_blocked`, `approval_stale`, `invalid_transition`, `digest_mismatch`, `decision_conflict` | 실행 불가 preflight, 승인 후 대상/증거 변경, 허용되지 않은 전이, 또는 CAS에서 다른 terminal 결정이 먼저 확정됨 |
| 410 | `approval_expired` | 만료된 승인 사용 |
| 503 | `backend_unavailable`, `cluster_unavailable`, `evidence_unavailable` | 의존성 응답 불가. cached 상태를 성공으로 대체하지 않음 |

## 4. RPO/RTO 및 감사 증거 필드

각 evidence 기록은 다음을 보존한다. `target_seconds`는 policy 목표, `observed_seconds`는 RPO의 관측값(backup 기준시각 대비 현재/복구 시점 차이), `estimate_seconds`는 RTO 사전 추정, 최종 복원 후에는 `actual_seconds`로 기록한다. 각각의 출처와 시간 기준이 없으면 값 대신 `null`과 `result: "unknown"`을 쓴다.

| 필드 | 필수성/의미 |
|---|---|
| `cluster_id`, `operation_id`, `correlation_id` | 필수. Portal operation context의 cluster/resource 및 연결 식별 |
| `actor.id`, `actor.type`, `requested_at` | 필수 요청자 식별/시각. 승인 이벤트에는 별도 `approver.id`, `decided_at`, `decision`, `decision_reason` |
| `approval_id`, `request_digest`, `preflight_id` | 승인 대상과 사용한 체크 결과의 불변 연결 |
| `backup_id`, `backup_created_at`, `backup_completed_at`, `restore_started_at`, `restore_completed_at` | 원본 및 실행 구간 식별/시간. backend가 제공하지 않은 시각은 null + 사유 |
| `tenant_scope.namespace`, `tenant_scope.owner_team` | 필수로 해석되어야 함. 원시 요청의 team 값을 신뢰하지 않음 |
| `rpo.policy_id`, `rpo.policy_version`, `target_seconds`, `observed_seconds`, `as_of`, `result` | 승인 시 필수. `result`: `compliant | non_compliant | unknown` |
| `rto.policy_id`, `rto.policy_version`, `target_seconds`, `estimate_seconds`, `actual_seconds`, `basis`, `result` | 승인 시 `estimate_seconds/basis` 필수, 종료 시 actual/result 갱신. 계산 근거 식별 가능해야 함 |
| `verification[]` | 종료 시 workload readiness, service health, storage attachment, application smoke test 각각의 `status`, `checked_at`, `evidence_ref` |
| `integrity` | `{ status: verified|failed|unknown|not_supported, checked_at, evidence_ref }`; 지원되지 않거나 확인 불가면 verified 아님 |

`result: non_compliant`는 승인 정책이 별도로 허용하지 않는 한 요청을 차단한다 (**ASSUMPTION**: 기존 Portal에는 RPO/RTO 허용오차 정책이 없음). operation은 backend가 복원을 끝냈다고 보고해도 `verification[]`에 필수 항목 누락, `fail` 또는 `unknown`이 있으면 `succeeded`가 될 수 없다. 이는 이 문서에서 제안하는 상태 계약이며 현재 `completeOperation()`의 이벤트만으로 강제되지는 않는다.

## 5. 범위 및 명시적 비목표

- **PROPOSED**: `/api/dr/restore-approvals` 및 이에 상응하는 durable approval/restore 상태 저장소, backend 어댑터, 승인 role 정책.
- 이 slice는 backup inventory API/UI, 정책 편집, 실제 Velero/CNPG 호출, ITSM export, immutable/WORM 구현, 운영용 RPO/RTO 계산식/기준값, 승인자 그룹 설정을 정의하지 않는다.
- 이 저장소에서 확인한 backup/restore 표면은 부재한다. `src/lib/kisa-controls.ts`의 Velero 언급은 보안/클러스터 설명이며, Portal backup API나 성공한 backup 증거의 근거로 해석하지 않는다.
