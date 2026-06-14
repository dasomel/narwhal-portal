# 로컬 개발 가이드 (Skaffold + Kaniko + Bun)

## Clean Install (신규 환경 초기 설정)

1. `bash scripts/bootstrap-secrets.sh` — `AUTH_SECRET`, `VALKEY_PASSWORD`, `LIVE_INGEST_SECRET` 자동 생성, `.env.local` 신규 작성
2. `.env.local` 열어 placeholder 값 직접 채우기:
   - `OIDC_CLIENT_SECRET` / `KEYCLOAK_CLIENT_SECRET` — Keycloak 클라이언트 설정에서 발급
   - `KEYCLOAK_ADMIN_CLIENT_SECRET` — Keycloak SA 클라이언트 생성 후 입력
   - `OPENBAO_TOKEN` — OpenBao AppRole auth 후 발급
   - 자세한 절차: [docs/security-clean-install.md](./security-clean-install.md)
3. `pnpm install`
4. `pnpm dev` (로컬) 또는 `bun run dev:skaffold` (클러스터 내 HMR)

### ⚠️ 클린설치 후 첫 빌드: kaniko OOM 회피 (자주 발생)

> **🚧 초안 (DRAFT) — 테스트 검증 전**: 아래 drain 기반 첫 빌드 절차는 아직 실제 클린설치
> 테스트로 검증되지 않은 초안입니다. drain → pin-kaniko → skaffold run 빌드가 끝까지
> 성공하는지(특히 skaffold `build.cluster.tolerations` 동작 여부)를 확인한 뒤 이 섹션을
> 재검토·확정합니다.

클린설치(클러스터 재생성) 직후에는 Harbor의 kaniko 레이어 캐시(`library/narwhal-portal-cache`)가
비어 있어, 첫 `skaffold run` / `dev:skaffold`가 node_modules 전체를 스냅샷합니다
(피크 ~3.5–3.9GB anon RSS). worker VM이 6GB(`WORKER_MEMORY`)이고 기본 워크로드가 ~2.5GB를
쓰므로, 첫 풀빌드 kaniko Pod이 **전역 OOM(dmesg `constraint=CONSTRAINT_NONE`)** 으로 죽어
`narwhal-portal` Pod이 `ImagePullBackOff`에 머뭅니다.

> **중요**: 이건 worker RAM이 부족해서가 아니라 *캐시가 없는 첫 풀빌드*만 무겁기 때문입니다.
> 캐시가 한 번 채워지면 이후 빌드는 증분이라 6GB worker에서 정상 동작합니다. 따라서 **RAM 영구
> 증설은 불필요**하고, 첫 빌드 한 번만 worker 한 대를 비워서 통과시키면 됩니다.

```bash
# 1) kubeconfig 갱신(클린설치로 CA가 바뀜) + kaniko 빌드 secret 준비
bash ../narwhal/scripts/common/set-config.sh
bun run harbor:setup            # devtools/idp-portal-kaniko-harbor + narwhal-root-ca-secret 생성

# 2) worker-2 비우기 (cordon + evict → 그 위 파드가 worker-1/3로 이동)
vagrant ssh master-1 -c "kubectl drain narwhal-worker-2 \
  --ignore-daemonsets --delete-emptydir-data --force --timeout=120s"

# 3) kaniko를 비워진 worker-2에 고정해 첫 빌드 (skaffold.yaml build.cluster에 임시로
#    nodeSelector: kubernetes.io/hostname=narwhal-worker-2 +
#    tolerations: node.kubernetes.io/unschedulable (NoSchedule, Exists) 를 추가)
skaffold run -f skaffold.yaml
git checkout skaffold.yaml       # 임시 변경 원복

# 4) 노드 복구
vagrant ssh master-1 -c "kubectl uncordon narwhal-worker-2"
```

첫 빌드가 Harbor에 `narwhal-portal-cache`를 채우고 나면, 이후 `bun run dev:skaffold`는 6GB
worker에서 OOM 없이 file sync/HMR로 동작합니다.

(영구 해결을 원하면 Vagrantfile `WORKER_MEMORY`를 8–10GB로 올릴 수도 있습니다 — 호스트 RAM
여유가 충분할 때만. 다만 위 캐시 워밍업 방식으로 충분하므로 권장하지 않습니다.)

---

Skaffold가 Kaniko를 이용해 **Narwhal 클러스터 안에서 이미지를 빌드**하고, Harbor에 push한 뒤 `devtools/idp-portal` Deployment를 갱신합니다. 로컬 Docker/Docker Desktop이 필요하지 않습니다.

> **패키지 매니저: Bun** (1.3.13+, 2026-04 전환). `bun.lock` 사용. pnpm-lock.yaml은 fallback으로 병행 유지 중.

---

## 동작 방식

```
코드 수정
  ├─ (작은 변경) Skaffold file sync → 컨테이너 /app 갱신 → Next.js HMR
  └─ (큰 변경)  Kaniko Pod 빌드 → Harbor push → Deployment rollout
                      ↑
                 클러스터 안에서 실행
                      ↓
               devtools/idp-portal Service
                      ↓
          localhost:3000 ← port-forward 자동
```

- Next.js는 **클러스터 안에서** 실행됩니다 (로컬 `bun dev` 불필요)
- 이미지 빌드도 클러스터 안에서 (**로컬 Docker 불필요**)
- Keycloak/Prometheus/Loki/ArgoCD/Valkey는 pod 내부 DNS로 직접 접근 → port-forward 불필요
- ArgoCD는 `image`/`env` 필드 drift를 무시 (`gitops/apps/idp-portal.yaml` `ignoreDifferences`) — Skaffold와 GitOps 공존
- 이미지 태그: `dev-{USER}-{YYYYMMDD-HHMMSS}` — 매 빌드 고유

---

## 사전 준비

### 1. Skaffold + Bun 설치

```bash
brew install skaffold
skaffold version   # v2.x 이상

brew tap oven-sh/bun
brew install bun
bun --version      # 1.3.x 이상
```

> 의존성 변경 시 `bun install` 실행. lockfile 동기화를 위해 가능하면 `pnpm install`도 병행.

### 2. kubeconfig 설정

```bash
vagrant ssh master-1 -c "sudo cat /etc/kubernetes/admin.conf" > ~/.kube/narwhal.yaml
sed -i '' 's|https://.*:6443|https://192.168.56.100:6443|' ~/.kube/narwhal.yaml

export KUBECONFIG=~/.kube/narwhal.yaml
kubectl config rename-context kubernetes-admin@kubernetes narwhal
kubectl config use-context narwhal
kubectl get nodes
```

> VIP ping 안 되면: `sudo route delete -host 192.168.56.100`

### 3. Kaniko 빌드용 Secret 주입 (1회)

클러스터에 Harbor push 자격과 Narwhal CA를 등록합니다:

```bash
bun run harbor:setup
# = bash scripts/harbor-kaniko-setup.sh
```

스크립트 동작:
1. `devtools/harbor-secrets` → `HARBOR_ADMIN_PASSWORD` 조회
2. `docker config.json` 생성 → Opaque Secret `idp-portal-kaniko-harbor` (devtools)
3. `platform-system/narwhal-root-ca-secret` → `devtools/narwhal-root-ca-secret`로 복제 (Kaniko pod이 같은 namespace의 Secret만 mount 가능)

Harbor 관리자 비밀번호가 회전되거나 CA가 갱신되면 재실행.

### 4. Secret 확인

`idp-portal-secrets`(앱 런타임 환경변수)는 GitOps가 이미 생성. 누락 여부만 확인:

```bash
kubectl -n devtools get secret idp-portal-secrets
```

---

## 개발 워크플로우

### 일반 개발 (HMR)

```bash
bun run dev:skaffold
# = skaffold dev (dev 프로필 자동 활성)
```

실행 흐름:

1. Kaniko Pod이 `Dockerfile.dev` 기반으로 빌드
2. Harbor(`harbor.local.narwhal.io/library/idp-portal:dev-...`)에 push
3. `gitops/resources/idp-portal-k8s.yaml`을 적용 → Deployment 이미지 교체
4. `idp-portal` Service 3000 → `localhost:3000` port-forward
5. `src/**`, `public/**`, `next.config.ts` 변경 감지 → 컨테이너 `/app`으로 파일 동기화 → Next.js HMR

브라우저: **http://localhost:3000**

종료: `Ctrl+C` (Skaffold가 정리 여부 확인)

### 디버깅 (Node Inspector)

```bash
bun run debug:skaffold
```

- 배포 직후 `NODE_OPTIONS=--inspect=0.0.0.0:9229` env 주입
- `localhost:3000` + `localhost:9229` port-forward

#### IntelliJ IDEA Ultimate Attach

1. **Run → Edit Configurations → + → Attach to Node.js/Chrome**
2. Host: `localhost`, Port: `9229`
3. Run → **Debug '...'**

#### VS Code Attach

`.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "attach",
      "name": "Attach to Skaffold",
      "address": "localhost",
      "port": 9229,
      "localRoot": "${workspaceFolder}",
      "remoteRoot": "/app",
      "skipFiles": ["<node_internals>/**"]
    }
  ]
}
```

### 1회 배포 (dev 이미지)

```bash
bun run deploy:skaffold
# = skaffold run
```

빌드 + 배포 후 종료. watch/port-forward 없음.

### 운영 이미지 수동 배포

GitOps가 기본이지만 긴급 수동 배포가 필요하면:

```bash
# Skaffold 없이 로컬 docker로 빌드/푸시 (Docker Desktop 필요)
make all
kubectl -n devtools rollout restart deployment/idp-portal
```

---

## IntelliJ Cloud Code 통합 (선택)

JetBrains Marketplace에서 **Cloud Code** 플러그인 설치:

- `skaffold.yaml` 자동 인식
- Run/Debug Configurations에 `Develop on Kubernetes`, `Debug on Kubernetes` 자동 생성
- 빌드 로그, 배포 상태, port-forward 상태를 IDE 통합 패널에서 확인
- 디버거 어태치 자동화 (debug 프로필 시 9229 auto-attach)

설정:
1. Preferences → Plugins → `Cloud Code` 설치 + IDE 재시작
2. Run → Edit Configurations → `+` → Cloud Code: Kubernetes → Develop
3. Deployment type: `Skaffold`, Skaffold config: `skaffold.yaml` 자동 선택

---

## 파일 구조

| 파일 | 역할 |
|------|------|
| `skaffold.yaml` | Skaffold + Kaniko 설정. dev(기본)/debug 프로필 |
| `Dockerfile` | 운영 이미지 (multi-stage, standalone) |
| `Dockerfile.dev` | 개발 이미지 (`bun run dev`, HMR) |
| `scripts/harbor-kaniko-setup.sh` | Kaniko 인증 Secret 주입 (1회) |
| `Makefile` | 수동 `make build / push / all` (Skaffold 미사용 시) |
| `../gitops/resources/idp-portal-k8s.yaml` | Skaffold가 재사용하는 Deployment/RBAC/Valkey 매니페스트 |
| `../gitops/apps/idp-portal.yaml` | ArgoCD Application — `ignoreDifferences`로 dev 이미지 drift 무시 |

---

## 트러블슈팅

### Kaniko Pod이 `ImagePullBackOff` (base image `node:22-alpine`)

Docker Hub rate limit. `docker.io/library/node` 이미지가 당겨지지 않을 수 있음. 클러스터 노드에서 재시도:

```bash
kubectl -n devtools delete pod -l skaffold.dev/run-id  # 빌드 pod 재시도
```

장기 대응: Harbor를 Docker Hub 프록시로 설정하거나 Harbor에 base image 미러링.

### Kaniko push 시 `x509` 에러

`narwhal-root-ca-secret`이 devtools에 복제 안 됐거나 ca.crt key 이름이 다름:

```bash
kubectl -n devtools get secret narwhal-root-ca-secret -o jsonpath='{.data}' | jq 'keys'
# ca.crt가 없으면 → bun run harbor:setup 재실행
```

그래도 실패하면 임시로 TLS 검증 건너뛰기 (skaffold.yaml `kaniko.skipTLS: true` 또는 `skipTLSVerifyRegistry: ["harbor.local.narwhal.io"]`).

### Kaniko push 시 `UNAUTHORIZED`

Harbor 비밀번호가 회전됐을 가능성. setup 스크립트 재실행:

```bash
bun run harbor:setup
```

### 빌드 Pod이 `CreateContainerConfigError`

`idp-portal-kaniko-harbor` secret이 없음:

```bash
kubectl -n devtools get secret idp-portal-kaniko-harbor
# 없으면 → bun run harbor:setup
```

### 배포가 계속 원복됨 (ArgoCD selfHeal)

`gitops/apps/idp-portal.yaml`의 `ignoreDifferences`에 해당 필드 포함 확인. 추가 필드 무시가 필요하면 jsonPointers에 경로 추가:

```yaml
ignoreDifferences:
  - group: apps
    kind: Deployment
    name: idp-portal
    jsonPointers:
      - /spec/template/spec/containers/0/image
      - /spec/template/spec/containers/0/env
      - /spec/replicas   # 예: 복제본 수도 바꾸면 추가
```

### HMR 반영 안 됨

Skaffold 콘솔에서 `Syncing 1 file(s) to ...` 로그 확인. 파일 경로가 `skaffold.yaml`의 `sync.manual` 패턴에 매치되지 않을 수 있음. 패턴 확장 후 재시작.

### `unable to connect to the server`

VIP 라우팅 문제:

```bash
ping -c 1 192.168.56.100 || sudo route delete -host 192.168.56.100
kubectl --server=https://192.168.56.10:6443 get nodes   # 개별 master 우회
```

### 세션 쿠키 오류 (`http: named cookie not present`)

Istio ambient mesh가 쿠키를 손상시킴. 매니페스트 pod label `istio.io/dataplane-mode: "none"` 유지 확인 (이미 설정됨).

---

## ArgoCD 관련 주의사항

- Skaffold는 `gitops/resources/idp-portal-k8s.yaml` (GitOps와 동일 파일)을 재사용합니다. image/env 외 다른 필드(리소스, 복제본 등)를 로컬에서 수정하면 **ArgoCD가 원복**합니다.
- 영구 변경이 필요하면 GitOps repo에 push해야 합니다.

---

## 참고

- Skaffold Kaniko builder: https://skaffold.dev/docs/builders/builder-types/kaniko/
- Kaniko 공식: https://github.com/GoogleContainerTools/kaniko
- Cloud Code for IntelliJ: https://cloud.google.com/code/docs/intellij/
- ArgoCD `ignoreDifferences`: https://argo-cd.readthedocs.io/en/stable/user-guide/diffing/
