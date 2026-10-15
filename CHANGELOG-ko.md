# Changelog

이 프로젝트의 주요 변경 사항은 이 파일에 기록됩니다.

이 형식은 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)를 따르며,
이 프로젝트는 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 준수합니다.

[English](CHANGELOG.md) | 한국어

## [Unreleased]

프로덕션 보안 기준을 강화하고(인증된 Valkey TLS, 명시적 OpenBao 인증 모드, 호출 시점 의존성 설정 검사,
네임스페이스 범위 읽기) provider 장애가 조용히 정상으로 보이지 않도록 수정함. 쓰기 라우트는 이제
거절·자격 증명·결과 미상을 구분하며, ArgoCD나 Alertmanager를 읽을 수 없을 때 플랫폼 상태가 더 이상
정상으로 표시되지 않음. 1.0.18과 1.0.19 태그는 푸시되었으나 cosign 서명 단계 실패로 GitHub Release로
게시되지 않았으므로, 이 섹션은 1.0.17 이후의 모든 변경을 다룸.

### 업그레이드 노트
- **프로덕션은 이제 인증된 Valkey TLS를 요구함 (#205, 63603d6, 1.0.19 이후)**: 프로덕션에서
  `getValkey()` / `getLiveValkey()`(`src/lib/valkey.ts`)는 `VALKEY_URL=rediss://…`(TLS 스킴),
  `VALKEY_TLS=true`, `VALKEY_USERNAME`(전용 ACL 사용자, 문서에서는 `portal`), `VALKEY_PASSWORD`가
  모두 설정되지 않으면 예외를 던짐. `VALKEY_INSECURE_PRODUCTION`은 더 이상 지원되지 않으며, 값이
  `false`여도 정의만 되어 있으면 클라이언트 초기화를 거부함. `docs/security-clean-install.md` 6절 참고.
  실패는 지연 발생(프로세스 시작 시가 아니라 첫 Valkey 사용 시)임. `VALKEY_URL` 또는
  `VALKEY_PASSWORD`가 설정된 경우 `/api/health/ready`가 503(`Critical cache dependency unavailable`)을
  반환하므로 롤아웃은 Ready가 되지 못함(`AUTH_MOCK=true`가 아닌 경우). 두 변수가 모두 없으면 프로브가
  Valkey를 건너뛰고 200을 반환하며 캐시는 조용히 비활성화됨: 캐시 헬퍼가 보안 설정 오류를 잡음(`cacheGet`과
  `cacheGetWithMeta`는 null을 반환하고, `cacheSet`과 `cacheDel`은 아무 동작도 하지 않음).
  `getValkey()` / `getLiveValkey()`를 직접 호출하는 코드는 예외를 그대로 받으며, 라이브 이벤트
  영속화와 멱등성 claim은 이를 잡아 프로세스 로컬 인메모리 경로로 저하됨: 멱등성 claim이 레플리카 간에
  공유되지 않고(레플리카 사이의 중복 수집이 더 이상 걸러지지 않음), 라이브 이벤트는 영속화되지도 다른
  레플리카로 게시되지도 않으며, 둘 다 재시작 시 사라짐. **작성 시점의 narwhal GitOps 차트는 여전히
  `VALKEY_INSECURE_PRODUCTION=true`와 평문 `redis://` URL을 TLS·ACL이 없는 Valkey에 대해 주입하므로,
  narwhal이 Valkey TLS + ACL과 대응하는 바인딩을 제공하기 전까지 이 포털 버전은 해당 차트와 함께
  배포할 수 없음.** 1.0.19까지의 이미지는 이 변경 이전임.
- **프로덕션에서 OpenBao 정적 토큰 모드는 명시해야 함 (#237, 5319ada)**: 프로덕션에서
  `OPENBAO_TOKEN`을 자격 증명으로 사용하는 경우 `OPENBAO_AUTH_METHOD`는 정확히 `token`이어야 하며,
  그렇지 않으면 첫 OpenBao 요청이 `Static credentials require explicit OPENBAO_AUTH_METHOD=token in
  production` 예외를 던짐. 검사는 지연 방식(시작 시가 아니라 첫 OpenBao 토큰 요청 시)이며 인증 방식이
  `token`으로 결정될 때만 도달함. 즉 `OPENBAO_AUTH_METHOD`가 미설정이고 Kubernetes 서비스 어카운트 JWT가
  마운트되지 않은 경우임. Kubernetes 인증(`OPENBAO_AUTH_METHOD=kubernetes`, 또는 변수 미설정 + JWT
  마운트)을 쓰는 배포는 영향 없음. 프로덕션에서 비어 있지 않은 그 밖의 `OPENBAO_AUTH_METHOD` 값(예:
  오타)은 이제 `OPENBAO_AUTH_METHOD must be kubernetes or token` 예외를 던짐.
- **OpenBao 주소는 모든 요청에서 HTTPS여야 함 (#236, 513a71a)**: `OPENBAO_ADDR`는 프로세스당 한 번이
  아니라 매 외부 요청과 Kubernetes 로그인 전에 검증되며, 프로덕션에서 HTTPS가 아닌 주소는 매번 거부됨.
- **의존성 URL은 프로덕션에서 더 이상 localhost로 대체되지 않음 (1.0.17 이후)**: `ARGOCD_URL`,
  `ALERTMANAGER_URL`, `PROMETHEUS_URL`, `TEMPO_URL`, `LOKI_URL`, `APISIX_ADMIN_URL`, `OPENBAO_ADDR`,
  `GITEA_URL`, `KEYCLOAK_INTERNAL_URL`은 더 이상 localhost나 클러스터 내부 기본값으로 대체되지
  않음(752273f, 451bec8). `getDependencyUrl()`(`src/lib/config.ts`)은 첫 사용 시
  `Missing required production configuration: <NAME>` 예외를 던지며(시작 시가 아님),
  `/api/health/ready`는 누락된 값을 표시하지 않음(`validateRuntimeConfig`는 `missingOptional`로만
  나열하며, https가 아닌 `GITEA_URL`은 표시함).
  `SLO_CHAIN_START`도 이제 프로덕션의 federated logout에 필수이며 없으면 예외를 던짐(451bec8).
  `KEYCLOAK_ISSUER`와 `GITEA_URL`은 `https://`여야 하며(#110), `APISIX_API_KEY_READONLY`는 더 이상
  관리자용 `APISIX_API_KEY`로 대체되지 않음(#112).
- **Kubernetes 토큰 출처 (1.0.17 이후)**: 포털은 `K8S_SA_TOKEN` 대신 projected 단기 서비스 어카운트
  토큰을 읽음(경로 변경은 `K8S_SA_TOKEN_FILE`). `K8S_SA_TOKEN`은 개발 전용임. `K8S_TOKEN_AUDIENCE`를
  설정하면 클라이언트 측 `aud` 검사가 활성화되며, 프로덕션에서 미설정이면 경고를 기록함(eeb5ef6,
  1a27584, 1e35aac).
- **`/api/events/ingest`가 기존 이벤트 생산자에게 더 엄격해짐 (3344e78)**: `idempotency_key`와
  `source_event_id`가 모두 없는 요청은 400을 반환하고(v1.0.17 라우트에는 이 요구사항이 없었음),
  `X-Producer-Id`(또는 `X-Ingest-Producer`) 헤더가 본문 `source`와 다르면 403을 반환하며, 64 KiB
  (65,536바이트, `MAX_INGEST_BODY_SIZE_BYTES`)를 넘는 본문은 413을 반환함.
- **라이브 이벤트 스트림은 기본 거부임 (3c4c36a)**: 네임스페이스가 없는 이벤트는 `visibility: "cluster"`를
  선언한 경우에만 관리자가 아닌 사용자에게 표시되며, 그 외에는 숨겨짐. 제목/설명의 네임스페이스
  정규식 대체 경로는 제거됨. 생산자는 `resource.namespace` 또는 `visibility: "cluster"`를 설정해야 함. 뷰어와 게스트는
  여전히 `node` 이벤트와 설명에 "secret"이 포함된 이벤트도 볼 수 없음.
- **`/api/secrets`는 실패를 드러내고 키 이름을 반환하지 않음 (0c715f5)**: 메타데이터 읽기 실패 시 `[]`
  대신 502 `{error, degraded: true}`를 반환하며, 응답에 시크릿 키 이름이 더 이상 포함되지 않음.
  인벤토리는 이제 KV v2 `secret/metadata/<path>`만 읽고 `secret/data/<path>`는 읽지 않으므로, 이
  라우트에는 포털의 OpenBao 정책에 메타데이터 목록 조회와 읽기가 필요하고 데이터 읽기는 필요하지 않음.
- **`/api/cluster`는 guest를 거부함 (de1edc7)**: 이제 `cluster-admin`, `developer`, `viewer`가
  필요하며 그 밖의 역할에는 403을 반환함. 이전에는 세션만 있으면 됐음.
- **프로덕션에서 kubeconfig 다운로드에는 `K8S_API_SERVER`가 필요함 (506c279)**: 다운로드되는
  kubeconfig는 `getExternalK8sApiServer()`를 사용하며, 프로덕션에서 `K8S_API_SERVER`가 없으면 예외를
  던짐. `KUBERNETES_SERVICE_HOST`만으로는 부족함. 이는 외부에서 도달할 수 없는 클러스터 내부 주소이기
  때문임.
- **네임스페이스 가시성은 `narwhal.io/team` 라벨을 따름 (b094fb7)**: 소유권의 기준은 라벨이며,
  `config/role-filter.json`의 네임스페이스 패턴은 라벨이 없는 네임스페이스를 위한 마이그레이션 경로로
  계속 해석됨. `POST /api/namespaces`는 더 이상 네임스페이스를 직접 만들지 않고, GitOps 저장소에 테넌트
  매니페스트를 커밋하여 풀 리퀘스트를 엶(058426e).
- **API 소비자**: `/api/governance/audit`는 새 `/api/governance/events`의 deprecated 별칭임(#161).
  `/api/health/status`는 이제 `cluster-admin`이 필요하며(a286598), federated logout은 POST 전용임
  (ab69c4f). 카탈로그 롤백, silence 생성/삭제, sync 라우트는 새 상태 코드와 고정 오류 문구를 반환함
  (변경 항목 참고).
- **릴리스 파이프라인**: 태그 빌드는 cosign으로 이미지를 서명하며 `COSIGN_PRIVATE_KEY` /
  `COSIGN_PASSWORD` 저장소 시크릿이 없으면 실패함(3026d23, `docs/cosign-signing-setup.md`).
  GitHub Release는 게시가 성공한 뒤에만 생성됨(#120).

### 추가
- **모든 사용자를 위한 의존성 상태 집계**: `GET /api/health/summary`는 모든 인증된 역할에 `{state,
  observedAt}`만 반환하고 내비게이션 표시기를 구동함(#155). 관리자 전용 `/api/health/dependencies`는
  informer 소유자 상태와 라이브 파이프라인 카운터를 포함한 통합 의존성 계약을 제공함(#148, #158, #162).
- **`/api/governance/events`**: `{items, truncated, evidenceKind, freshness}`를 반환함. 기존
  audit 이름의 라우트는 배열 응답을 유지하면서 `X-Truncated`, `Deprecation`, `Link` 헤더를 추가함(#161).
- **풀 리퀘스트 기반 네임스페이스 요청**: `narwhal.io/team` 라벨이 붙은 Namespace, RoleBinding,
  ResourceQuota를 담은 GitOps PR로 네임스페이스를 요청함(058426e).
- **정규 이벤트 envelope와 라이브 스트림 복원력**: producer별 자격 증명, 속도 제한(429 +
  `Retry-After`), 페이로드 상한을 갖춘 멱등 `/api/events/ingest`(3344e78), 결정적 `Last-Event-ID`
  재생(#154), Valkey lease 기반 단일 소유 Kubernetes informer(#158).
- **Preflight 라우트**: `/api/dr/restore-preflight`(#215), `/api/storage/pvc-expansion-preflight`
  (#221, #222, #223), 고아 네임스페이스 패턴을 찾는 `/api/settings/role-mappings/preflight`(2d44836).
  DR과 PVC 판정은 호출자 입력이 아니라 서버가 관찰한 사실에서만 도출됨.
- **클러스터 레지스트리 기반**: `config/clusters.json`, `cluster_id` 스코프 차원, `/api/settings/clusters`
  관리자 CRUD(681f845), `/api/domain/clusters` 파일럿(e36a68d).
- **공통 외부 HTTP 클라이언트**: Kubernetes apiserver를 포함한 모든 provider 클라이언트에 타임아웃,
  제한된 재시도, 상관 ID를 적용함(#143, #149, #151, #152).
- **운영자 UX**: 재시도와 최신성 표시를 갖춘 공용 로딩/오류/빈 상태/부분/오래됨 `DataState`(#156,
  #159), 캐시 캡처 시각(#157), 취약점 DB 최신성(584b797), 내비게이션의 포털 버전·커밋 표시(#150),
  넘치는 내비게이션 항목을 위한 "More" 메뉴(#167).
- **사용자 생성 시 역할 그룹 지정**: `POST /api/settings/users`가 포털 역할 허용 목록으로 제한된 선택적
  `groups` 배열을 받음(#132).
- **공급망**: cosign 이미지 서명(3026d23), OSS 고지와 의존성 SBOM(2e3ffc5), 신규 의존성에 대한 7일
  lockfile 숙성 게이트(69a4be5).

### 변경
- **카탈로그 롤백이 결과를 분류함 (#245, b0c304e)**: ArgoCD의 4xx는 해당 상태와 `outcome: "rejected"`로
  반환됨. ArgoCD 토큰이 없거나 거부되면 503, 403은 403을 반환함. 타임아웃, 네트워크 오류, 5xx, 408,
  읽을 수 없는 2xx는 502와 `outcome: "unknown"`("재시도 전에 애플리케이션 상태를 확인")으로 반환됨.
  ArgoCD POST는 한 번만 전송되며 자동 재시도되지 않음. 2xx는 요청한 Application을 담고 있어야 함.
- **Silence 생성/삭제가 결과를 분류함 (#247, 486ac21)**: 존재하지 않는 silence 삭제는 404, 그 밖의
  4xx는 해당 상태와 `outcome: "rejected"`, 401은 503, 403은 403, 타임아웃·네트워크 오류·408·5xx·깨진
  2xx는 502와 `outcome: "unknown"`을 반환함. 생성된 `silenceID`는 `[A-Za-z0-9_-]{1,128}`에 맞을 때만
  수락되며 trim 없이 반환된 값 그대로 사용됨.
- **Silence DELETE 소유권 조회 (#244, 3b4d320)**: 명시적인 Alertmanager 404만 "없음"으로 취급함. 401은
  503, 403은 403, 그 밖의 실패나 깨진 조회 응답은 DELETE를 보내지 않고 502를 반환함.
- **ArgoCD 쓰기 전제 조건 (#243, 7f7dc1c)**: 애플리케이션 확인 중 provider 장애가 더 이상
  `Application not found`로 보고되지 않으며, 자격 증명 오류가 503 매핑에 도달함.
- **sync 라우트의 고정 오류 문구 (#246, 1b9984d)**: `argocd/sync`와 `catalog/[name]/sync`는 상류 원문
  오류 대신 `ArgoCD sync failed`(502)를 반환하고, `operation.failed` 이벤트 description도 고정
  문구임. 롤백 이벤트도 같은 규칙을 따름(#245).
- **`/api/status`는 ArgoCD 또는 Alertmanager를 읽을 수 없으면 `degraded`를 보고함 (#242, 2d38cbb)**:
  실패한 provider는 `unknown` 컴포넌트(요약 접미사 `status incomplete: … unreachable`)로 표시되며
  결과는 캐시되지 않음. 로컬 개발처럼 ArgoCD나 Alertmanager가 미구성이거나 접근 불가한 환경은 이제
  `healthy` 대신 `degraded`로 표시됨.
- **의존성 상태가 fail closed로 동작함**: 의존성 상태가 0건인 집계는 `ok`가 아니라 `unavailable`이며
  (#240), 캐시된 스냅샷은 형태 검증을 통과한 경우에만 신뢰함(#241).
- **Kubernetes 목록 계약 (#239, 70bc7ce)**: `items` 배열이 없는 200 응답은 오류이며, `limit` /
  `maxPages`는 양의 안전 정수여야 하고 아니면 요청 전에 거부됨. 클러스터 전체 인벤토리 목록은 상한이
  있고 `truncated`를 보고함(4c146b7).
- **외부 HTTP 본문과 취소**: 디코딩된 응답 본문이 8 MiB를 넘으면 호출자가 한도를 올리지 않은 이상
  `response-too-large` 오류로 실패함(#225). 재시도 백오프와 네이티브 `RequestInit` 취소는 호출자의
  abort를 따름(#228, #238).
- **라이브 이벤트**: Kubernetes watch 만료 후 복구는 상한이 있는 페이지네이션 스냅샷을 적용하고(#226),
  informer는 각 이벤트가 수락될 때까지 기다려 제출이 한 번에 하나만 진행됨(#229).
- **ArgoCD sync와 rollback이 수렴을 검증함**: 2xx는 수락만 의미하므로 라우트는 애플리케이션을 다시
  읽고 `operationState`가 수렴할 때까지 `pending: true`를 반환함(#121).
- **필수 CI 체크**: `Portal critical regression gate`는 항상 보고되는 필수 체크이며(#227), SHA에 묶인
  `independent-review` 커밋 상태가 머지를 막음(#213).
- **의존성**: Next.js 16.3.5와 React 19.3.0(#170), `@base-ui/react` 1.8.0(#212), `@grpc/grpc-js`
  1.14.5(#211), `upload-artifact`, `download-artifact`, `setup-node`, `harden-runner` GitHub Actions
  묶음 업데이트(#230, #233, #232, #231).
- **Kaniko 빌드 증거 (#169, 5df84c5)**: `kaniko-build.sh`가 빌드 성공 후 `build-evidence/<tag>.json`을
  기록하며, 이미지 digest 형식이 잘못되면 실패함.
- **타입이 있는 Kubernetes 자격 증명 오류 (#176, d34cc54)**: 토큰 갱신 후에도 401이 남거나 403이면
  `K8sCredentialError`가 발생함.

### 수정
- **읽기 범위 누락 해소**: `/api/cost`(2ba8fc5)와 상세·추세 라우트(#123), `/api/governance/resources`
  (#147), `/api/k8s/events`(#145), `/api/catalog`, `/api/events`, `/api/k8s/pods`,
  `/api/k8s/resource`(1e48371)가 캐시나 상류 읽기 이전에 호출자의 가시 네임스페이스로 필터링하며,
  캐시 키에 스코프 지문이 포함됨.
- **Silence 생성에 범위 적용**: 관리자가 아닌 호출자는 자신의 범위 안의 정확 일치 `namespace` matcher가
  필요하고, 모든 역할에서 전체 일치 정규식 matcher는 거부되며, 선택적 `Idempotency-Key`를 지원함
  (5ce9516).
- **ArgoCD 쓰기가 프로젝트뿐 아니라 대상 네임스페이스도 검사함** (d00eff1).
- **미상은 정상이 아님**: 스코어카드는 `unavailable` 증거와 `fail`을 구분하고(#118), DORA는 알 수 없는
  배포 결과와 `null` 변경 실패율을 거짓 0 대신 보고하며(#117), 비용은 가격 미구성 시 fail closed로
  동작하고(e2ad866), 부분적인 Keycloak 그룹 조회를 완전한 것처럼 표시하지 않음(#113).
- **만료된 목록 continue 토큰**: 상한이 있는 Kubernetes 목록은 410에서 한 번 재시작함(#141).
- **Kubeconfig 서버**: 다운로드한 kubeconfig는 클러스터 내부가 아닌 외부 API 서버 주소를 사용함
  (506c279).
- **이미지 빌드**: Kaniko 경로는 `latest` 대신 digest 파일과 함께 SHA 이름의 소스 태그를 푸시하고
  (a874ac7), 독립 실행형 이미지는 `@swc/helpers`를 포함하며 CI에서 smoke boot 됨(#164).
- **라이브 이벤트 장애 복구 (#183, 1b8f5ca)**: 장애 이전의 숫자형 `Last-Event-ID` 커서가 이제 프로세스
  로컬 링에서 재생되고, Valkey 장애 중에 이뤄진 멱등성 claim이 같은 프로세스 안에서 Valkey 복구 후에도 유지되며, 410 재조회는
  이미 가져온 페이지를 수집함(전체 백로그가 아니라 가장 최근 이벤트 하나만).

### 보안
- **프로덕션 인증된 Valkey TLS** (#205, 업그레이드 노트 참고).
- **로그아웃 강화**: federated logout은 POST 전용이며 CSRF 보호가 적용되고(ab69c4f), 검증할 수 없는
  요청은 fail closed로 처리하며(a6fc4ec), 리디렉션 호스트 허용 목록이 고정(anchor)되어
  `maliciouslocalhost`가 더 이상 통과하지 않음(25381e1).
- **자격 증명 처리**: ArgoCD와 Gitea 토큰은 호출마다 읽고 401에서 fail closed로 처리하며(#134),
  APISIX는 조용한 관리자 대체가 없고(#112), Keycloak 관리자 토큰 획득이 표준화됨(ea96a9a).
- **오류 문구가 상류 호스트나 본문을 노출하지 않음**: sync/rollback 응답과 `operation.failed` 이벤트
  스트림에서 제거됨(#245, #246).
- **권한 있는 노드 튜닝**: Job 실행 경계 강화(3a209f7), preflight dry-run(#105), 런타임에서의 정확한
  호출 승인(#90).
- **공급망**: 빌드 이미지를 digest로 고정하고 URL에 Gitea 비밀번호를 넣지 않으며(#109), 설치 시점
  작업의 CI 외부 통신을 차단하고(#106), `kubelogin`을 고정하고 체크섬을 검증함(#104).

### 알려진 문제
- **UI 롤백이 400을 반환함**: 카탈로그 UI(`service-actions.tsx`)는 `{historyId}`를 보내지만
  `POST /api/catalog/[name]/rollback`은 `{id}`를 요구함. 1.0.17 이전부터 있던 문제임.
- **롤백에 멱등성 없음**: 라우트가 `Idempotency-Key`를 점유하지 않으므로, `outcome: "unknown"` 응답
  뒤에 같은 키로 재시도하면 ArgoCD POST가 다시 전송됨.
- **Silence DELETE 소유권**은 팀 범위가 아니라 `createdBy`만 비교하며, 조회와 삭제 사이에 경쟁 구간이
  있음(Alertmanager는 같은 id의 `createdBy` 변경을 허용함).
- **`ArgoForbiddenError` 문구**가 403 본문에 ArgoCD 프로젝트 또는 네임스페이스를 포함함.
- **Groups / users PATCH**(`/api/settings/groups`, `/api/settings/users/[pk]`)는 변경을 다시 읽지 않고
  단순한 `{ok: true}`만 반환함.
- **viewer에게 클러스터 전체 뷰 노출**: `/api/governance/distribution`(인증된 모든 사용자)과
  `/api/service-graph`(viewer 이상)에는 스코프 필터가 없음.
- **클러스터 레지스트리는 기반 단계일 뿐임**: `/api/settings/clusters`는 `config/clusters.json`에
  저장하며, 해당 파일에 쓸 수 없으면 변경이 메모리에만 남아 재시작 시 사라짐. Kubernetes와 ArgoCD
  클라이언트는 아직 요청별로 클러스터를 해석하지 않음.
- **Kaniko 빌드 경로는 검증되지 않음 (a874ac7)**: Job 플레이스홀더 `__HARBOR_DESTINATION__`이
  `__HARBOR_DESTINATION_PREFIX__`로 바뀌었고(태그는 `HARBOR_TAG`로 덧붙임), 커밋은 실제 클러스터 내
  빌드와 푸시로 검증하지 않았다고 밝힘(미검증).
- **릴리스 노트 링크**: `release.yml`은 `CHANGELOG_ko.md`를 링크하지만 실제 파일명은
  `CHANGELOG-ko.md`임.

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
