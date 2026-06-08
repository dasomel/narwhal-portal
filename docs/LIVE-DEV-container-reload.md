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
| **A. prod 빌드+push** | 느림(~2-4분) | 높음 (ArgoCD와 `:latest`로 호환) | ✅ 기본 사용 |
| **B. 라이브 HMR (skaffold dev)** | 즉시(파일 저장 시) | ArgoCD selfHeal이 dev 이미지를 prod로 원복 | ⚠️ selfHeal 체인 off 필요 |

일상 작업은 **A**. 즉시 HMR이 필요하면 **B**(아래 전제조건 충족 필요).

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

### ⚠️ B의 최종 차단 요인 — ArgoCD selfHeal (중요)

라이브의 진짜 핵심 장애물. **ArgoCD가 `narwhal-portal` deployment를 prod `:latest`(standalone `server.js`)로
강제 유지**하므로, skaffold dev가 배포한 dev 이미지(`dev-m-...`, `src/` + `next dev`)를 **수 초 내에
원복**한다. 그러면 HMR/소스 변경이 전혀 반영되지 않는다(컨테이너에 `/app/src`가 없고 `server.js`만 존재).

관리 체인 (2중):
- `narwhal-portal` Application — `syncPolicy.automated.selfHeal: true`
- 그 Application 자체를 `narwhal-apps`(app-of-apps, `src=apps`)가 관리 → `narwhal-portal` app을 patch해도
  `narwhal-apps`가 다시 `selfHeal: true`로 되돌림
- `narwhal-apps`는 다시 `argocd-config`(root, `src=resources`)가 관리

라이브를 쓰려면 이 체인의 selfHeal을 꺼야 한다(임시, dev 클러스터 한정):
```bash
# 아래는 상위(app-of-apps)가 다시 원복할 수 있음 → 위에서부터 꺼야 유지됨
kubectl -n devtools patch app narwhal-apps    --type merge -p '{"spec":{"syncPolicy":{"automated":{"selfHeal":false}}}}'
kubectl -n devtools patch app narwhal-portal  --type merge -p '{"spec":{"syncPolicy":{"automated":{"selfHeal":false}}}}'
# 그 다음 skaffold dev 재시작 → dev 이미지(dev-m) 유지 확인:
kubectl -n devtools get deploy narwhal-portal -o jsonpath='{.spec.template.spec.containers[0].image}'   # dev-m-... 이어야 함
```
> 근본 해결은 `narwhal/gitops`에서 `narwhal-portal` app에 deployment `image` 필드 `ignoreDifferences`를
> 추가하거나, dev 동안 app을 app-of-apps에서 제외하는 것(gitea 반영, 다른 세션과 협업).
> `docs/RELEASE-TODO-gitea-permanence.md`에 영구화 항목으로 기록.

### 라이브 종료 후 원복
```bash
# Ctrl+C (skaffold dev) 후 prod로 환원
kubectl -n devtools patch app narwhal-portal -n devtools --type merge -p '{"spec":{"syncPolicy":{"automated":{"selfHeal":true}}}}'
kubectl -n devtools patch app narwhal-apps   --type merge -p '{"spec":{"syncPolicy":{"automated":{"selfHeal":true}}}}'
# ArgoCD가 prod :latest로 자동 환원 (또는 위 A로 최신 prod 재배포)
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
