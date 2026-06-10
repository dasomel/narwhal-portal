# Release TODO — 게이트웨이/배포 런타임 패치 영구화 (gitea 반영)

> **목적:** 라이브 개발(`skaffold dev`)을 떠받치기 위해 클러스터에 **직접(런타임)** 적용한
> 패치들을 정리한다. 이것들은 **gitea/GitOps에 반영되지 않은 임시 상태**이며, ArgoCD가
> 재동기화하면 사라질 수 있어 현재 `apisix-routes` ArgoCD App의 **selfHeal을 off**로 막아 둔
> 상태다. **다음 tagging / release 시점에 아래를 gitea(GitOps)로 영구화**하고 selfHeal을
> 복구한다.
>
> 작성: 2026-06-08 · 대상 클러스터: narwhal (dev) · 작성자: 라이브 개발 세션

---

## 0. 현재 상태 요약 (왜 임시인가)

| 패치 | 적용 방식(현재) | 영구화 위치 | 위험 |
|------|----------------|-------------|------|
| harbor route `client-control: max_body_size=0` (이미지 push 100MB 제한 해제) | **etcd 직접 patch** (apisix admin API, route `id=harbor`) | `narwhal/gitops/resources/apisix-routes.yaml` | ArgoCD 재sync 시 100MB로 원복 |
| harbor cross-ns 라우팅 (ExternalName→ApisixUpstream) | narwhal **로컬 커밋만** (`123d1b8`) | 동 파일, gitea push 필요 | gitea 미반영 → ArgoCD 옛 소스 유지 |
| apisix `client_max_body_size 0` (nginx_config) | 런타임 configmap patch + narwhal 로컬 커밋 (`131e723`) | `narwhal/gitops/apps/apisix.yaml` | 동일 |
| `apisix-routes` ArgoCD App **selfHeal=off** | 런타임 patch | 영구화 완료 후 **on 복구** | 자동 동기화 중단 상태 |
| `narwhal-portal` ArgoCD App **selfHeal=off** | 런타임 patch | 라이브 종료 후 **on 복구** + deploy 이미지 prod `:latest`로 환원 | selfHeal이 켜져 있으면 skaffold dev 이미지를 prod `:latest`로 즉시 원복 → 라이브 불가 |
| portal 코드/빌드 변경 | portal repo **로컬 커밋** (`de566f7`, `29acc98`, `f70afe6`) | portal 배포 파이프라인 | 미배포 시 운영 미반영 |
| portal route `enable_websocket=true` (dev HMR 웹소켓: route id `narwhal-portal`, `698afbe4`) | **etcd 직접 patch** (admin API) + narwhal 로컬 커밋 (`313a832`, ApisixRoute `websocket: true`) | `narwhal/gitops/resources/apisix-routes.yaml` (gitea push) | route 재생성 시 ws 끊겨 라이브 모드 클라이언트(HMR) 불능. IC가 이 route를 sync 못 하므로(cross-ns) admin API 재적용 필요할 수 있음 |
| Istio waypoint 3개 (platform-system/devtools/monitoring) + `istio-waypoints` PodMonitor — 서비스 맵 L7(req/s) 텔레메트리 | **런타임 kubectl apply** (2026-06-11) + narwhal 로컬 커밋 (`cb93217`, `scripts/cluster/09-istio-ambient.sh`) | 클러스터 재프로비저닝 시 09 스크립트가 자동 적용; gitea에는 스크립트 커밋 push만 필요 | waypoint/PodMonitor 소실 시 서비스 맵이 L4(B/s)로 강등(기능 동작은 유지 — 포털 코드가 L7+L4 병합). database/storage ns는 의도적으로 waypoint 제외 |
| argocd-cm `ignoreDifferences` 5키 (kyverno ClusterPolicy 기본값 + Application pre-delete finalizer + skaffold dev Deployment image/resources/라벨 무시 + 키 self-ignore) | **런타임 patch** (kubectl patch cm argocd-cm) + narwhal 로컬 커밋 (`03eaa2a`, `ab51121`) | `narwhal/gitops/resources/argocd-config.yaml` (gitea push) | gitea 미반영 상태에서 argocd-cm이 통째로 재생성되면(예: 13-argocd.sh 재실행) ① narwhal-portal 영구 OutOfSync + narwhal-apps 플래핑 재발(Sync 버튼 무효 증상), ② 라이브 HMR(skaffold dev) 즉시 원복으로 다시 불능 |

> ⚠️ **다른 세션이 동시에 harbor/포털/게이트웨이를 정리 중**이었다. gitea 반영 전 반드시
> `git fetch` + rebase로 그 세션의 변경을 흡수하고, **force push 금지**. 충돌 시 멈추고 조율.

---

## 1. narwhal (클러스터/GitOps) 영구화

### 1-1. 로컬 커밋을 gitea에 반영
narwhal 로컬에 있는 다음 커밋들을 gitea origin에 push (rebase 기반):
- `131e723` feat(apisix): set client_max_body_size to 0 / client_body_buffer_size 128k
- `123d1b8` fix(ingress): cross-namespace routing via ApisixUpstreams + disable Harbor size cap

```bash
cd narwhal
git fetch origin
git rebase origin/<배포브랜치>      # 다른 세션 변경 흡수, 충돌 시 STOP+조율
# 검토 후
git push origin <배포브랜치>         # ⚠️ release 시점에만, 명시적 승인하에
```

### 1-2. ArgoCD 동기화 확인
```bash
# apisix(configmap) + apisix-routes(route/upstream) App 동기화
kubectl -n devtools get application apisix apisix-routes
# 필요 시 refresh/sync (gitea HEAD 반영)
```
- `gitops/resources/apisix-routes.yaml`의 harbor route가 **ApisixUpstream 참조 + client-control 0**으로
  렌더되는지 확인.
- `gitops/apps/apisix.yaml`에 `nginx_config.http.client_max_body_size: 0` 포함 확인.

### 1-3. ⭐ 중복 harbor route 정리 (중요)
런타임에 harbor route가 **2개** 존재했다 (디버깅 잔재):
- `id=harbor` — admin API로 직접 만든 route (upstream 정상, 우리가 cc=0 patch) ← **실제 트래픽 처리**
- `id=3de05552` (`platform-system_harbor_harbor`) — ingress-controller 생성, **upstream nodes 비어 있음**

GitOps 정식 반영 후, apisix-ingress-controller가 만드는 route 하나로 수렴되어야 한다.
admin API로 직접 만든 `id=harbor` stale route는 **수동 삭제** 필요할 수 있음:
```bash
kubectl -n platform-system port-forward deploy/apisix 9180:9180 &
AK=$(kubectl -n platform-system exec deploy/apisix -- sh -c 'env|grep ADMIN_KEY' | cut -d= -f2 | tr -d '\r\n ')
curl -s http://127.0.0.1:9180/apisix/admin/routes -H "X-API-KEY: $AK"   # route 목록 확인
# 정식 route(upstream 정상 + cc 0)만 남기고 stale route 삭제:
# curl -X DELETE http://127.0.0.1:9180/apisix/admin/routes/harbor -H "X-API-KEY: $AK"
```
> 정식 route가 **upstream nodes를 제대로 가지는지**(harbor.devtools.svc:80) + cc=0 인지 먼저 확인 후 삭제.

### 1-3b. ArgoCD 영구/플래핑 OutOfSync 수정 (argocd-cm ignoreDifferences)
두 가지 라이브 전용 변형이 OutOfSync를 유발 → 포털 Sync 버튼이 무효처럼 보임:
1. kyverno 웹훅이 라이브 ClusterPolicy에 기본값 필드(`spec.admission`, `spec.emitWarning`,
   룰별 `skipBackgroundRequests`, `validate.allowExistingViolations`) 주입
   → `narwhal-portal` 앱이 Sync 직후 다시 OutOfSync (영구).
2. ArgoCD가 PreDelete hook 차트(kyverno)의 자식 Application에 `pre-delete-finalizer.argocd.argoproj.io(/cleanup)` 추가
   → `narwhal-apps`(app-of-apps)가 `Application/kyverno`로 플래핑 OutOfSync.

- 런타임: argocd-cm에 `resource.customizations.ignoreDifferences.{kyverno.io_ClusterPolicy, argoproj.io_Application}`
  + 키 자체에 대한 ConfigMap self-ignore를 patch (2026-06-10, 적용·검증 완료 — 전 앱 Synced).
- 추가(라이브 HMR, 같은 날): `ignoreDifferences.apps_Deployment`(narwhal-portal 컨테이너 image/resources)
  + `ignoreDifferences.all`(skaffold 라벨) — skaffold dev의 dev 이미지를 selfHeal이 원복하지 않게 함.
  검증: dev 이미지 90초+ 유지, 앱 Synced, file-sync 동작 (`docs/LIVE-DEV-container-reload.md`).
- 영구화: narwhal 로컬 커밋 `03eaa2a` + `ab51121` (`gitops/resources/argocd-config.yaml`)를 gitea에 push.
- 검증: push 후 `kubectl -n devtools get app narwhal-portal narwhal-apps argocd-config` 모두 Synced 유지.
- ⚠️ release 시점 주의: `apps_Deployment`/`all` 무시 규칙은 **dev 편의 설정**이다. 운영 전환 시 유지 여부를
  결정할 것 — 유지하면 prod 이미지 드리프트도 ArgoCD가 못 본다(수동 set image가 silent drift 됨).

### 1-4. selfHeal 복구
```bash
kubectl -n devtools patch app apisix-routes --type merge \
  -p '{"spec":{"syncPolicy":{"automated":{"selfHeal":true}}}}'
```

### 1-5. 영구화 검증
- `docker push harbor.local.narwhal.io/library/narwhal-portal:<tag>` 가 **413 없이** 통과 (100MB 초과 레이어).
- `kubectl -n platform-system logs deploy/apisix-ingress-controller | grep harbor` 에 `endpoints/service not found` 없음.
- `curl -sk https://harbor.local.narwhal.io/v2/ -w '%{http_code}'` → 401 (도달).
- 게이트웨이 다른 cross-ns route(argocd/gitea/grafana 등)도 sync 정상화됐는지 확인
  (동일 ExternalName 문제를 공유했음 — ApisixUpstream 전환이 전반에 적용됐는지).

---

## 2. portal (narwhal-portal) 반영

### 2-1. 로컬 커밋 → 배포 파이프라인
portal repo 로컬 커밋:
- `de566f7` feat(my-apps): role-default visibility scope with team override
- `29acc98` build(skaffold): local Docker build for dev profile (kaniko OOM 회피)
- `f70afe6` build(skaffold): dev live-reload (Dockerfile.dev chown + dev manifest)

→ portal 정식 배포 경로(harbor 이미지 빌드 + `narwhal-portal` ArgoCD App)로 반영.
**운영 이미지는 prod `Dockerfile`로 빌드**할 것 (dev `Dockerfile.dev`는 HMR 전용).

### 2-2. dev manifest drift 주의
`deploy/skaffold-dev-portal.yaml`은 `narwhal/gitops/resources/narwhal-portal-k8s.yaml`에서
**security-system Role/RoleBinding을 제외한 사본**이다. 원본(RBAC/env/리소스)이 바뀌면
이 사본도 **수동 동기화** 필요. (장기적으로는 skaffold가 원본을 직접 쓰되 cross-ns 객체를
별도 파일로 분리하는 구조가 더 깔끔.)

### 2-3. my-apps 스코프 설정 (기능 측면)
`config/role-filter.json`의 `roleDefaults`(admin/dev/viewer=전체) + `teamMappings`(team별 정밀)는
이미 반영됨. **팀 기반(B) 스코프를 실제로 쓰려면** Keycloak이 팀 그룹(예: `platform-team`)을
토큰 `groups` 클레임에 실어줘야 함 → narwhal `scripts/cluster/11-3-keycloak-clients.sh`
그룹 매퍼 설정 (별도 작업, cross-repo).

---

## 3. dev 빌드 인프라 메모

- dev 워크플로용 kaniko secret(`idp-portal-kaniko-harbor`, `devtools/narwhal-root-ca-secret`)을
  `scripts/harbor-kaniko-setup.sh`로 생성해 둠. **단 dev 프로파일은 이제 로컬 docker 빌드**라
  kaniko secret은 `debug` 프로파일(클러스터 kaniko)에서만 쓰임.
- 노드 메모리(~5.9Gi/노드)가 작아 in-cluster kaniko가 node_modules 스냅샷에서 OOM →
  dev는 로컬 docker 빌드 채택. 노드 증설 시 kaniko 재검토 가능.
- 로컬 docker push 인증: `docker login harbor.local.narwhal.io` (admin / `devtools/harbor-secrets`
  의 `HARBOR_ADMIN_PASSWORD`). TLS는 narwhal CA가 Docker Desktop에 신뢰됨.

---

## 4. 라이브 개발 재개/종료

```bash
cd narwhal-portal
skaffold dev -p dev --cleanup=false --status-check=true   # 라이브 시작 (HMR)
# 종료: Ctrl+C (--cleanup=false 라 배포는 유지됨)
```
- `--cleanup=false`: skaffold 종료해도 dev pod 유지.
- 라이브 중 `src/**/*.{ts,tsx,js,jsx,css}`, `public/**`, `next.config.ts` 저장 → 컨테이너 sync → HMR.
- selfHeal이 off인 동안에는 ArgoCD가 `apisix-routes`를 자동 복구하지 않으므로 harbor push가 계속 통과.
