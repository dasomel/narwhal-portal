# 컨테이너 라이브 반영 (Live Dev) 가이드

> narwhal-portal 소스 변경을 클러스터(devtools)의 실행 중인 컨테이너에 반영하는 방법.
> 두 가지 경로가 있으며, 현재 **기본은 "prod 빌드+push"** 이고 **라이브 HMR은 ArgoCD
> selfHeal 충돌로 추가 설정이 필요**하다.
>
> 작성: 2026-06-09 · 대상: narwhal 클러스터(dev)

---

## TL;DR

| 방식 | 속도 | 안정성 | 현재 상태 |
|------|------|--------|-----------|
| **A. prod 빌드+push** | 느림(~2-4분) | 높음 (ArgoCD와 `:latest`로 호환) | ✅ 안정 경로 |
| **B. 라이브 HMR (skaffold dev)** | 즉시(파일 저장 시) | ✅ argocd-cm ignoreDifferences로 selfHeal 원복 차단 (2026-06-10) | ✅ **사용 가능** |

개발 중에는 **B**(즉시 HMR), 검증/마무리 시 **A**로 prod 이미지 확정.

---

## A. prod 빌드 + push (현재 기본 경로)

검증된 경로. ArgoCD가 `narwhal-portal`을 `:latest`로 관리하므로 같은 태그로 push하면 충돌 없음.

```bash
cd narwhal-portal

# (최초 1회) harbor 로그인 — admin / devtools/harbor-secrets 의 HARBOR_ADMIN_PASSWORD
PASS=$(kubectl -n devtools get secret harbor-secrets -o jsonpath='{.data.HARBOR_ADMIN_PASSWORD}' | base64 -d)
echo "$PASS" | docker login harbor.local.narwhal.io -u admin --password-stdin

# 빌드 → push → 롤아웃
docker build -f Dockerfile -t harbor.local.narwhal.io/library/narwhal-portal:latest .
docker push harbor.local.narwhal.io/library/narwhal-portal:latest   # imagePullPolicy: Always
kubectl -n devtools rollout restart deploy/narwhal-portal
kubectl -n devtools rollout status  deploy/narwhal-portal --timeout=220s
```

- push 경로: 로컬 Docker daemon → APISIX 게이트웨이(`harbor.local.narwhal.io` → 192.168.56.200) → Harbor.
- 큰 레이어가 **413**으로 막히면 harbor route의 APISIX `client-control` 한도 때문 → 아래 "100MB 제한" 참고.
- TLS는 narwhal CA를 Docker가 신뢰(로그인 성공 시 OK).

---

## B. 라이브 HMR (skaffold dev) — 파일 저장 즉시 반영

`src/**/*.{ts,tsx,js,jsx,css}`, `public/**`, `next.config.ts` 저장 → Skaffold file-sync로 컨테이너에
복사 → Next.js HMR. **재빌드 없이 즉시 반영.**

```bash
cd narwhal-portal
skaffold dev -p dev --cleanup=false --status-check=true
# 종료: Ctrl+C (--cleanup=false 라 배포 유지)
```

### B를 가능하게 한 전제조건 (이미 코드/설정에 반영됨)

라이브를 막던 요인들과 해결 — 모두 repo에 커밋되어 있어 재현 가능:

| 증상 | 원인 | 해결 (위치) |
|------|------|-------------|
| kaniko 빌드 OOMKilled | VM 노드 메모리(~5.9Gi)에서 in-cluster kaniko가 node_modules 스냅샷 시 OOM | dev 프로파일을 **로컬 Docker 빌드**로 (`skaffold.yaml` dev `build.local`) |
| harbor push 413 | APISIX `client-control` `max_body_size=100MB` | harbor route client-control **0**(무제한) — 런타임 etcd + gitea(`narwhal/gitops/resources/apisix-routes.yaml`) |
| Skaffold sync 실패 `didn't sync any files` | Alpine **busybox tar**로는 file-sync 추출 불가 (GNU tar 필요) | dev base를 **Debian**(`node:22-slim`)으로 → GNU tar 포함 (`Dockerfile.dev`) |
| `next dev` EACCES `/app/.next/dev` | `/app`이 root 소유, non-root nextjs가 쓰기 불가 | `chown -R nextjs:nodejs /app` (`Dockerfile.dev`) |
| dev pod OOMKilled / 간헐 502 | `next dev`(Turbopack 상주)가 512Mi 초과 | dev 메모리 **2Gi** (`deploy/skaffold-dev-portal.yaml`) |
| 로그인 `error=Configuration` | `package.json` dev 스크립트가 `NODE_EXTRA_CA_CERTS=./certs/...`(없는 경로)로 덮어써 Keycloak TLS 실패 | `"dev": "next dev"` (`package.json`) — deployment env(`/etc/ssl/narwhal/ca.crt`)가 적용되게 |
| deploy가 cross-ns RBAC에서 실패 | `narwhal-portal-k8s.yaml`에 security-system Role/RoleBinding(다른 ns) 혼재 → kubectl deployer 충돌 | dev 전용 manifest(해당 객체 제외)로 override (`deploy/skaffold-dev-portal.yaml`, `skaffold.yaml` dev `manifests`) |

런타임 선행(클러스터 상태, 코드 아님):
```bash
# harbor 로그인 (위 A 참고)
# harbor route client-control 0 (etcd, 100MB 해제) — docs/RELEASE-TODO-gitea-permanence.md 참고
```

### ✅ (해결됨 2026-06-10) ArgoCD selfHeal 원복 — argocd-cm ignoreDifferences

과거 차단 요인: **ArgoCD selfHeal이 skaffold dev의 dev 이미지(`dev-m-...`)를 수 초 내에 prod
`:latest`로 원복**해 HMR이 무효였다. selfHeal off는 app-of-apps 체인(`argocd-config` →
`narwhal-apps` → `narwhal-portal`)이 다시 켜버려 유지가 안 됐다.

**해결**: argocd-cm에 시스템 레벨 `ignoreDifferences`를 추가해 skaffold dev가 바꾸는 필드만
ArgoCD diff에서 제외 — selfHeal은 켜진 채로 dev 배포가 유지되고 앱은 Synced로 남는다.
- `apps_Deployment`: narwhal-portal 컨테이너의 `image`/`resources` (jq select로 스코프 한정)
- `all`: `skaffold.dev/run-id`, `app.kubernetes.io/managed-by` 라벨
- 런타임 patch 적용 + narwhal 로컬 커밋 `ab51121`(`gitops/resources/argocd-config.yaml`) —
  gitea 반영 전 argocd-cm 재생성 시 재적용 필요 (`docs/RELEASE-TODO-gitea-permanence.md` 참고)

검증(2026-06-10): dev 이미지 배포 후 90초+ 유지, `narwhal-portal` 앱 Synced, file-sync로
`/app/src`에 즉시 반영, 포털 200 응답.

### 라이브 종료 후 prod 환원
ArgoCD가 image diff를 무시하므로 **자동 환원되지 않는다**. 둘 중 하나로 명시적 환원:
```bash
# 방법 1: 최신 prod 재배포 (권장 — 위 A 절차: build → push → rollout restart)
# 방법 2: ArgoCD 수동 Sync (포털 incident Sync 버튼 또는 argocd CLI)
#   — sync는 RespectIgnoreDifferences가 없어서 git 매니페스트(:latest)로 덮어쓴다
kubectl -n devtools get deploy narwhal-portal -o jsonpath='{.spec.template.spec.containers[0].image}'  # :latest 확인
```

---

## 빠른 sync 동작 검증
```bash
echo "export const __t=1" > src/__synctest.ts   # skaffold dev 가 떠 있을 때
# skaffold 로그에 "Syncing 1 files" + 에러 없이 "Watching for changes" → OK
POD=$(kubectl -n devtools get pods -l app=narwhal-portal --no-headers | grep 1/1 | awk '{print $1}' | head -1)
kubectl -n devtools exec "$POD" -- cat /app/src/__synctest.ts   # 내용 보이면 sync 성공
rm -f src/__synctest.ts
```

---

## 관련 문서
- `docs/RELEASE-TODO-gitea-permanence.md` — 런타임 패치(client-control 0, selfHeal off)의 gitea 영구화
- `docs/local-dev.md` — kubeconfig / kaniko secret 셋업
- `docs/adr-skaffold-dev-workflow.md` — Skaffold+Kaniko 워크플로 ADR
