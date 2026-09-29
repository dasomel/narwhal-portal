# 서비스 템플릿 요청 검증 및 부분 실패 계약

## 상태와 범위

- **Status**: Proposed contract for service-template provisioning.
- **범위**: 입력 검증, 단계별 결과, 재시도 및 보상 동작.
- 이 문서는 구현 상태를 주장하지 않는다. 현재 `POST /api/templates`는 실제 리소스를 만들지 않고 `success: true`와 `preview`를 반환한다 (`src/app/api/templates/route.ts`). UI도 동일 POST를 미리보기로 사용한다 (`src/components/templates/template-list.tsx`). 아래 `PROPOSED` 항목은 이 동작을 대체할 계약이다.
- 네임스페이스 관련 기존 정책은 보존한다. `src/app/api/namespaces/route.ts`는 `dev-` 접두사와 DNS label 형태를 요구하고, `resolveNamespaceOwner`로 소유 팀을 확인한 뒤 Kubernetes에 직접 쓰지 않고 GitOps PR을 연다. 주석상 포털 ServiceAccount는 namespace `get/list/watch`만 가진다. 따라서 이 문서의 namespace 단계는 **PR 요청**이지 직접 생성이 아니다.

## 요청 및 검증

### 작업 구분 (PROPOSED)

미리보기와 적용은 명시적으로 구분한다. 기존 UI의 `{ templateId, values }` 요청은 미리보기 동작과 호환되어야 한다.

| 작업 | 요청 | 부작용 |
|---|---|---|
| Preview | `{"mode":"preview","templateId":"…","values":{…}}` | 없음. 계획과 검증 결과만 반환 |
| Apply | `{"mode":"apply","templateId":"…","values":{…},"team":"…","idempotencyKey":"…"}` | 검증 완료 후 작업 단계 실행 |

`mode` 생략은 기존 클라이언트 호환을 위해 `preview`로 해석한다. 알 수 없는 `mode`는 `400 INVALID_MODE`. JSON 파싱 실패, body가 객체가 아님, `templateId`/`values` 형식 오류는 `400 INVALID_REQUEST`. 두 모드 모두 로그인 및 현재 라우트의 `cluster-admin`/`developer` 역할 제한을 적용한다 (`src/app/api/templates/route.ts`). 권한 거부는 기존 패턴대로 `401`/`403`이다.

### 템플릿 스키마 (현재 코드 기준)

템플릿 정의의 유일한 서버 측 카탈로그는 `src/app/api/templates/route.ts`의 `TEMPLATES`다. 템플릿 ID는 아래 세 값 중 하나와 정확히 일치해야 한다.

| ID | 필드 | 허용 값 |
|---|---|---|
| `nextjs-web` | `serviceName` | 필수 text |
| | `namespace` | 필수 text |
| | `replicas` | 필수 select: `1`, `2`, `3` |
| `api-service` | `serviceName` | 필수 text |
| | `namespace` | 필수 text |
| | `runtime` | 필수 select: `go`, `node` |
| | `database` | 선택 select: `none`, `postgresql` |
| `cronjob` | `serviceName` | 필수 text |
| | `namespace` | 필수 text |
| | `schedule` | 필수 text |

검증 규칙 (PROPOSED):

1. `templateId`는 비어 있지 않은 문자열이며 카탈로그에 존재해야 한다. 미등록 ID는 `422 UNKNOWN_TEMPLATE`.
2. `values`는 평범한 객체이며 값은 모두 문자열이어야 한다. 템플릿에 없는 키는 `422 UNKNOWN_FIELD`; 필수 키 누락 또는 빈 문자열(공백 제거 후)은 `422 REQUIRED_FIELD`; 비문자열 값은 `422 INVALID_FIELD_TYPE`.
3. `select` 값은 카탈로그 `options`의 정확한 원소여야 한다. 그 외 값은 `422 VALUE_NOT_ALLOWED`. optional 필드는 누락을 허용하며 빈 문자열은 값으로 취급하지 않는다.
4. `namespace`는 `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` 및 `dev-` 접두사 조건을 모두 만족해야 한다. 이는 현재 `src/app/api/namespaces/route.ts`의 명명 정책을 따른다. 형식 오류는 `422 INVALID_NAMESPACE`.
5. `serviceName`과 `schedule`의 더 구체적인 형식/길이 제한은 현재 템플릿 코드에 정의되어 있지 않다. **ASSUMPTION**: 템플릿 저장소와 Cron parser 계약이 승인되기 전까지는 빈 값 검증 외에 추가 제약을 만들지 않는다. 템플릿 치환 시 파일 경로, YAML 구조 또는 셸 구문을 깨지 않도록 하는 escaping 검증은 적용 구현의 보안 필수조건이며, 안전한 렌더링을 보장할 수 없으면 `422 INVALID_FIELD_VALUE`로 거부한다.
6. Apply의 `team`은 문자열일 때만 받으며 생략 가능하다. 생략 시 세션의 첫 팀을 사용하고, 지정 시 `resolveNamespaceOwner(role, teams, requestedTeam)`와 같은 규칙을 적용한다: 비관리자는 소속 팀만 요청할 수 있고 `cluster-admin`은 교차 팀을 지정할 수 있다. 팀이 없으면 `400 NO_TEAM`; 타 팀 요청은 `403 TEAM_FORBIDDEN`. 이 동작은 `src/lib/namespace-ownership.ts` 기준이다. **ASSUMPTION**: preview는 실제 소유권 할당을 하지 않으므로 team을 생략해도 된다.
7. 소유 namespace의 요청자는 기존 `dev-` 정책을 따른다. 기존 namespace에 적용할 권한 판정은 `getEffectiveScope`/`namespaceVisible` (`src/lib/scope.ts`)과 namespace team label 기반 소유권 규칙을 사용한다. namespace 생성을 요청하는 경우에도 team 검증을 통과해야 한다. 승인·생성된 namespace가 아직 없을 때 존재 검증만으로 요청을 거부하지 않는다.

검증 오류 응답 형식 (PROPOSED): `{"error":{"code":"…","message":"…","fields":[{"name":"…","code":"…"}]}}`. 검증 실패는 단계 실행 전에 반환하고 operation을 생성하지 않는다.

## 단계와 상태 응답 (PROPOSED)

Apply는 동일 `operationId`로 다음 순서의 단계를 기록한다.

| 단계 ID | 의미 | 성공 판정 |
|---|---|---|
| `repository` | 승인된 템플릿 소스로 Gitea 저장소 생성 또는 기존 요청과 대조 | 요청된 템플릿/입력 지문과 동일한 저장소 상태 |
| `namespace` | tenant namespace GitOps PR 생성 또는 기존 동일 PR 확인 | 소유 팀이 일치하는 요청 PR이 열려 있음. Kubernetes 반영 완료를 뜻하지 않음 |
| `argocd` | 제어 평면 계약으로 Application 생성/조정 | 원하는 spec이 기록됨 |
| `convergence` | ArgoCD 및 배포 상태 확인 | 앱이 `Synced` 및 `Healthy`로 관측됨 |

Namespace 단계가 PR을 기다리는 동안 Application 생성을 먼저 허용하는지는 아직 저장소에 정책이 없다. **ASSUMPTION**: 대상 namespace가 아직 없으면 `argocd`는 `blocked`이며, namespace PR이 승인·반영된 후 재개한다. PR 생성 성공만으로 작업 전체를 성공 처리하지 않는다.

Apply 응답은 HTTP `202`와 다음 모양을 사용한다. 완료 시 조회/동기 응답은 `200`이며 동일 필드를 반환한다.

```json
{
  "operationId": "<stable operation id>",
  "status": "running|partial|failed|succeeded",
  "retryable": true,
  "steps": [
    { "id": "repository", "status": "succeeded|running|failed|blocked|skipped", "resource": "…", "error": null },
    { "id": "namespace", "status": "…", "resource": "…", "error": null },
    { "id": "argocd", "status": "…", "resource": "…", "error": null },
    { "id": "convergence", "status": "…", "resource": "…", "error": null }
  ],
  "error": null
}
```

`error`는 실패 시 `{ "code": "…", "message": "…", "retryable": true|false }`다. 응답에서 비밀, 자격 증명 또는 공급자 응답 전문을 노출하지 않는다. `succeeded`는 모든 필수 단계 성공을 뜻하며, 특히 convergence 단계 전에는 반환할 수 없다. `partial`은 적어도 한 단계가 성공했고 다른 단계가 실패/blocked인 상태다. 실패 전 성공 단계가 없는 종료 작업은 `failed`다.

단계 오류 분류 (PROPOSED):

| 상황 | 단계 상태 / 코드 | 재시도 |
|---|---|---|
| 같은 이름의 저장소가 동일 operation 입력 지문과 일치 | `succeeded` (기존 리소스 확인) | 불필요 |
| 같은 이름의 저장소가 다른 소유자/지문 | `failed`, `RESOURCE_CONFLICT` | 자동 재시도 금지, 운영자 조정 필요 |
| Gitea/제어 평면 일시 오류 또는 timeout | `failed`, `UPSTREAM_UNAVAILABLE` | 가능 |
| namespace PR이 아직 승인/반영되지 않음 | `blocked`, `NAMESPACE_PENDING` | 조건 충족 후 가능 |
| RBAC/팀 권한 거부 또는 잘못된 템플릿 소스 | `failed`, `POLICY_DENIED` / `INVALID_TEMPLATE_SOURCE` | 입력/정책 수정 전 금지 |
| ArgoCD가 동기화/healthy 기준을 제한 시간 내 만족하지 못함 | `failed`, `CONVERGENCE_TIMEOUT` | 가능; 마지막 단계부터 관측 재개 |

HTTP `409`는 idempotency key가 동일하지만 정규화 입력 지문이 다른 경우에만 사용한다. 동시 진행 중인 같은 key/지문 요청은 새 작업을 만들지 않고 같은 `operationId`를 반환한다. 사용자 입력/권한 오류는 `400`/`403`/`422`, upstream을 시작 전에 사용할 수 없음은 `503`, 부분 실행 후의 실패도 결과 본문을 보존하는 `202`로 반환한다.

## 재시도 및 보상

- `idempotencyKey`는 Apply마다 필수이며, 같은 요청 재전송은 같은 operation과 단계 결과를 반환한다. **PROPOSED** 저장 키 범위는 actor + idempotency key이며, 저장 기간은 구현 전 운영 정책으로 확정해야 한다.
- 정규화 입력 지문은 `templateId`, 검증된 `values`, 확정된 `team`, 템플릿 소스 revision을 포함한다. 같은 키에 다른 지문을 제출하면 기존 작업은 변경하지 않고 `409 IDEMPOTENCY_CONFLICT`를 반환한다.
- 단계는 멱등 upsert여야 한다. 재시도는 `failed`/`blocked` 단계와 그 이후 단계를 재조정하고, 이미 확인된 성공 단계를 중복 생성하지 않는다. `running` 중 timeout은 결과를 알 수 없는 것으로 취급해 먼저 외부 상태를 조회한 뒤 재실행한다.
- 네임스페이스 요청 PR은 사용자 승인 전 자동으로 닫거나 되돌리지 않는다. Application이 해당 namespace보다 먼저 생성되어 실패했으면 namespace 확인 후 재시도한다. 저장소 생성 후 후속 단계 실패 시 저장소를 자동 삭제하지 않는다.
- 보상은 기본적으로 삭제가 아니라 안전한 조정이다. **PROPOSED**: 생성된 ArgoCD Application은 provisioner가 만들었고 아직 배포 리소스가 없는 것이 확인될 때만 제거 가능하나, 이 확인/삭제 API는 현재 repo에서 확인되지 않아 초기 계약에서는 자동 compensation을 금지한다. 어떤 삭제도 작업자가 명시적으로 실행하는 별도 승인 작업이어야 한다.
- 일시 오류는 exponential backoff 및 상한을 두어 재시도한다. 구체적인 횟수/간격은 **ASSUMPTION** 운영값이며 여기에 고정하지 않는다. 비재시도 오류는 명시적 입력/정책 수정 전 자동 재시도하지 않는다.

## 이벤트와 기록

Mutation 이벤트는 `src/lib/operation-context.ts`가 정한 `operation.started`, `operation.completed`, `operation.failed`와 `operation_id`, `correlation_id`, `causation_id`, `request_id`, actor/resource/visibility 필드를 따른다. 이벤트 파이프라인 장애는 현재 helper에서 best-effort로 처리되므로, 이를 provisioning 성공 판정으로 사용하지 않는다. 시작/완료/실패 lifecycle의 구체 식별자와 필드 현황은 [`event-envelope-compatibility.md`](./event-envelope-compatibility.md)의 Operation Lifecycle 행을 참조한다.

**PROPOSED** 각 이벤트 설명/리소스 기록에는 operation ID, 현재 단계 ID, 안전한 단계 상태 및 실패 코드만 포함한다. 민감한 값과 전체 렌더링 파일은 이벤트에 넣지 않는다. 최종 operation 상태는 단계 결과 저장소의 authoritative 상태이며 이벤트 누락으로 바뀌지 않는다. 현재 `beginOperation`은 시작 이벤트, `completeOperation` 또는 `failOperation`은 terminal 이벤트를 제공하지만 단계 상태 저장/부분 실패 resume API는 이 문서 작성 시 확인되지 않았다.

## 근거 파일

- `src/app/api/templates/route.ts` — 현재 템플릿 ID/필드 카탈로그와 미리보기 전용 POST.
- `src/components/templates/template-list.tsx` — 현재 UI 요청은 `{ templateId, values }`이며 preview 표시를 성공으로 표시하는 현 상태.
- `src/app/api/namespaces/route.ts` — 역할 guard, namespace 이름/`dev-` 검증, namespace PR 처리.
- `src/lib/namespace-ownership.ts` — admin 및 팀 소유권 판정.
- `src/lib/scope.ts` — namespace visibility / 소유 범위 계약.
- `src/lib/operation-context.ts` — lifecycle 이벤트 필드와 best-effort emission.
- `docs/event-envelope-compatibility.md` — operation event producer가 현재 내보내는 envelope 필드.
