# ADR-001: Skaffold 기반 in-cluster 개발 워크플로우

- **Status**: Accepted
- **Date**: 2026-04-22
- **Deciders**: @dasomel
- **관련 문서**: [local-dev.md](./local-dev.md)

---

## Context

IDP Portal은 클러스터 내부 인프라(Keycloak, OpenBao, Prometheus, Alertmanager, Loki, ArgoCD, APISIX, Valkey) 6~8개에 의존합니다. IntelliJ에서 "컨테이너 배포 후 K8s에서 테스트"하는 환경을 구축하면서, 다음 요건이 필요합니다.

- Istio ambient mesh 쿠키 처리, ztunnel HBONE 동작, `idp-portal-secrets` 마운트, 서비스 간 DNS 해석 등 **pod 관점 동작** 재현
- 권한 테스트(ServiceAccount + ClusterRoleBinding 기반)
- OpenBao agent injector, Keycloak redirect URI 실제 통합 검증
- 계정/라이선스 비용 없이 팀 전체가 사용 가능
- ArgoCD GitOps와 공존(운영 매니페스트와 분기 없이)

---

## Decision

**Skaffold + Kaniko 기반 in-cluster 빌드/배포 워크플로우 채택.** ArgoCD `ignoreDifferences`로 GitOps와 공존(A안).

### 채택 기준

| 기준 | 요구사항 | 충족 여부 |
|------|---------|----------|
| 클러스터 조건 재현 | pod 관점 동작 완전 재현 | ✅ in-cluster 실행 |
| 로컬 의존성 | 로컬 Docker/Docker Desktop 불필요 | ✅ Kaniko cluster build |
| TLS/CA 처리 | Harbor self-signed cert 자동 신뢰 | ✅ narwhal-root-ca-secret mount |
| 계정/비용 | 무료 | ✅ |
| 반복 속도 | 코드→반영 3초 이내 | ✅ file sync + HMR 2~3s |
| IntelliJ 디버깅 | Inspector attach 지원 | ✅ Cloud Code 플러그인 |
| ArgoCD 공존 | 운영 매니페스트 재사용 | ✅ `ignoreDifferences` |

### 빌드 경로 선택: Kaniko (cluster) vs local Docker

| 기준 | 로컬 Docker | **Kaniko (채택)** |
|------|-------------|------------------|
| 로컬 Docker Desktop | 필요 | 불필요 |
| macOS Keychain ECDSA 이슈 | 재발 우려 | 해당 없음 |
| Harbor CA 신뢰 | Docker Desktop VM 조정 필요 | `narwhal-ca-installer` + pod volume mount로 자동 |
| 첫 빌드 속도 | 빠름 (BuildKit cache) | 중간 (~1~2분) |
| 반복 빌드 (HMR 포함) | 동일 (file sync는 재빌드 안 함) | 동일 |
| 레이어 캐시 | 로컬 BuildKit | Harbor `idp-portal-cache` 리포 |
| 리소스 소비 | 로컬 디스크/CPU | 클러스터 ephemeral |

### 핵심 설계

**이미지 태그 정책**: `dev-{USER}-{YYYYMMDD-HHMMSS}`
- 매 빌드 고유 태그 → Kubernetes가 image pull 정책과 무관하게 새 Pod 생성 보장
- `:latest` 태그 재사용은 Pod 재시작 시에도 같은 이미지로 간주되는 리스크 회피

**ArgoCD 공존 (A안)**:
```yaml
ignoreDifferences:
  - group: apps
    kind: Deployment
    name: idp-portal
    jsonPointers:
      - /spec/template/spec/containers/0/image
      - /spec/template/spec/containers/0/env
```
- Skaffold가 건드리는 필드만 drift에서 제외
- 운영 배포(`:latest` 태그)는 GitOps 매니페스트 그대로 유지
- 개발자가 실수로 resources/replicas 등 수정 시 ArgoCD가 자동 원복 → 안전장치

**매니페스트 재사용**: Skaffold `rawYaml`이 `../gitops/resources/idp-portal-k8s.yaml`을 그대로 참조
- 개발/운영 매니페스트 이원화 방지
- 컨테이너 이미지 이름만 Skaffold가 자동 rewriting

**dev 프로필 전략**:
- `Dockerfile.dev`: `pnpm dev` + `NODE_TLS_REJECT_UNAUTHORIZED=0`
- Skaffold `sync.manual`로 `src/**`, `public/**`, `next.config.ts`를 재빌드 없이 컨테이너 `/app`에 동기화 → Next.js HMR
- 코드 변경→반영 2~3초

**debug 프로필**: post-deploy hook으로 `NODE_OPTIONS=--inspect=0.0.0.0:9229` 주입 + 9229 포트 포워드

---

## Consequences

### Positive

- **프로덕션과 동일한 환경**에서 테스트 (Istio, OpenBao, Keycloak 전부 실제 통합)
- **IntelliJ Cloud Code 플러그인** 한 번 설정으로 Run/Debug/Watch 자동화
- port-forward 스크립트 유지보수 부담 소멸
- 계정 비용 제로

### Negative / Trade-off

- **Harbor push 의존**: 코드 변경마다 이미지를 Harbor에 push. 첫 빌드 5~10분, 이후 레이어 캐시로 1~2분. `sync.manual`로 대부분의 반복은 이미지 재빌드 없이 처리.
- **클러스터 리소스 점유**: 로컬 `pnpm dev`보다 Pod 메모리(256~512Mi) 소비. 개발자 수가 많아지면 Dev 네임스페이스 분리 고려 필요 (→ 향후 ADR-002 후보).
- **초기 설정 복잡도**: kubeconfig + Harbor 로그인 + `/etc/hosts` + Docker insecure-registries 설정 필요. `docs/local-dev.md`에서 체크리스트화.
- **ArgoCD drift 가시성 저하**: 개발자가 `spec.replicas` 등 의도치 않은 필드 변경 시 ArgoCD가 즉시 원복하므로 디버깅 단서 축소. `ignoreDifferences` 범위를 image/env로 좁힘으로써 리스크 최소화.

### Neutral

- IntelliJ Dev Containers(`devcontainer.json`) 패턴은 추가로 병행 가능 (Skaffold와 배타적이지 않음). 팀이 IDE 통일성을 높이고 싶을 때 ADR-003으로 별도 제안.

---

## Alternatives Considered

### A1. 기존 `:latest` 태그 재사용 + `imagePullPolicy: Always`
- **기각**: 같은 태그 재push 시 kubelet이 캐시를 쓸 수 있어 실제 반영 불확실. 타임스탬프 태그가 예측 가능성 높음.

### A2. Dev 전용 네임스페이스(`devtools-dev`)에 완전 격리
- **기각**: Secret/Valkey/RBAC 중복 생성 필요. 실제 Secret은 OpenBao/GitOps가 devtools에만 주입하므로 dev 전용 secret 추가 운영이 더 번거로움. 필요 시 ADR-002로 재검토.

### A3. Tilt
- **기각**: Skaffold와 유사 기능이나 Starlark 설정 문법이 러닝커브 높고 팀에 익숙한 Skaffold가 이미 존재.

### A4. DevSpace
- **기각**: Skaffold 대비 생태계/문서 규모가 작음. 큰 차별점 없음.

---

## Implementation

| 파일 | 역할 |
|------|------|
| `idp-portal/skaffold.yaml` | Skaffold + Kaniko cluster build, dev(기본) / debug 프로필 |
| `idp-portal/Dockerfile.dev` | 개발 이미지 (HMR + inspector) |
| `idp-portal/scripts/harbor-kaniko-setup.sh` | Kaniko 인증 Secret 주입 (1회 실행) |
| `idp-portal/package.json` | `dev:skaffold`, `debug:skaffold`, `deploy:skaffold`, `harbor:setup` |
| `idp-portal/.dockerignore` | 빌드 컨텍스트 축소 |
| `idp-portal/docs/local-dev.md` | Skaffold + Kaniko 가이드 |
| `gitops/apps/idp-portal.yaml` | `ignoreDifferences`로 dev 이미지/env drift 무시 |

**클러스터 의존성**:
- `devtools/idp-portal-kaniko-harbor` (Opaque Secret, config.json) — Kaniko가 Harbor push 시 사용
- `devtools/narwhal-root-ca-secret` (platform-system에서 복제) — Kaniko pod에 볼륨 마운트되어 TLS 검증

**후속 액션**:
1. `gitops/apps/idp-portal.yaml` 변경을 Gitea repo에 push → ArgoCD 반영
2. 팀원 전체 안내: `brew install skaffold` + Cloud Code 플러그인 + `pnpm harbor:setup`
3. Harbor `library/idp-portal` / `library/idp-portal-cache` 리포지토리의 **GC/retention 정책** 검토 — dev 태그가 무제한으로 쌓임 (ADR-002 후보)
4. Harbor를 Docker Hub 프록시로 설정해 Kaniko base image 빌드가 rate limit에 걸리지 않게 검토

---

## References

- Skaffold 공식: https://skaffold.dev/docs/
- Cloud Code for IntelliJ: https://cloud.google.com/code/docs/intellij/
- ArgoCD `ignoreDifferences`: https://argo-cd.readthedocs.io/en/stable/user-guide/diffing/
- Telepresence pricing (비교 근거): https://www.getambassador.io/editions
