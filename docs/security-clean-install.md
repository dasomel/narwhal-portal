# Narwhal IDP Portal — 클린 설치 보안 운영 가이드

이 문서는 0부터 시작하는 클린 설치에서 보안 감사 결과를 빠짐없이 반영하기 위한 단계별 절차다. 자동화 가능한 부분은 `scripts/bootstrap-secrets.sh`가 담당하고, 외부 시스템(Keycloak/ArgoCD/OpenBao 등) 설정은 운영자가 직접 수행한다.

## 0. 사전 요구

- Narwhal 클러스터 부트스트랩 완료 (narwhal 리포의 `idp/` Terraform + `gitops/apps/app-of-apps.yaml` 적용)
- 도구: `kubectl`, `openssl`, `docker`, `helm`, `vault`(OpenBao), `argocd` CLI, `curl`, `jq`
- 클러스터 접근 권한: cluster-admin
- 도메인: 본 가이드는 `*.local.narwhal.internal`을 가정. 실제 환경에 맞게 치환

---

## 1. 시크릿 부트스트랩

**목적:** 자동 생성 가능한 랜덤 시크릿을 생성해 `.env.local`을 초기화.

```bash
./scripts/bootstrap-secrets.sh
```

생성되는 키: `AUTH_SECRET`, `VALKEY_PASSWORD`, `LIVE_INGEST_SECRET`
placeholder로 남는 키 (이후 단계에서 채움): `OIDC_CLIENT_SECRET`, `KEYCLOAK_ADMIN_CLIENT_SECRET`, `OPENBAO_TOKEN`, `K8S_SA_TOKEN`, `ARGOCD_TOKEN`, `APISIX_API_KEY`

스크립트는 멱등이므로 재실행해도 기존 값을 보존한다. 재생성하려면 `.env.local`에서 해당 라인을 직접 삭제 후 재실행.

**검증:**
```bash
test -f .env.local && stat -f '%Sp' .env.local  # -rw------- (600) 확인
grep -c '^AUTH_SECRET=' .env.local              # 1
```

---

## 2. Keycloak OIDC 클라이언트 등록

**목적:** 포털 사용자 로그인을 OIDC로 위임. Keycloak이 IdP 역할.

> 클러스터 `scripts/cluster/11-3-keycloak-clients.sh`가 narwhal-portal 클라이언트(realm `narwhal`, redirect `/api/auth/callback/keycloak`)를 자동 등록한다. 수동 등록이 필요할 때만 아래 절차를 따른다.

**Keycloak Admin Console:**
1. Clients → Create client → Type: OpenID Connect, Client ID: `narwhal-portal`, Client authentication: On
2. `Valid redirect URIs`: `https://portal.local.narwhal.internal/api/auth/callback/keycloak`
3. Scopes: `openid email profile groups`
4. Client scopes → `groups` mapper로 groups claim에 RBAC 4 role(`cluster-admin`, `developer`, `viewer`, `guest`)만 노출
5. 발급된 Client ID/Secret 추출

**`.env.local`:**
```bash
KEYCLOAK_ISSUER=https://keycloak.local.narwhal.internal/realms/narwhal
KEYCLOAK_CLIENT_ID=narwhal-portal
KEYCLOAK_CLIENT_SECRET=<keycloak-client-secret>
```

**검증:**
```bash
curl -s "$KEYCLOAK_ISSUER/.well-known/openid-configuration" | jq .issuer
# 출력의 issuer가 KEYCLOAK_ISSUER와 정확히 일치해야 함 (NextAuth iss 검증)
```

---

## 3. Keycloak Service Account 클라이언트 생성

**목적:** 포털이 Keycloak admin API(사용자 관리)에 접근할 때 ROPC가 아닌 client_credentials 사용.

> 클러스터 리포: `narwhal/gitops/apps/keycloak.yaml`, `narwhal/gitops/resources/keycloak-cr.yaml`.

**Keycloak Admin Console:**
1. realm 선택 → Clients → Create
2. `Client ID`: `idp-portal-admin`, `Access Type`: `confidential`
3. `Service Accounts Enabled`: ON
4. `Standard Flow Enabled`: OFF, `Direct Access Grants Enabled`: OFF (ROPC 차단)
5. Save → Service Account Roles 탭
6. Client Roles → `realm-management` 선택 → `realm-admin` (또는 최소: `manage-users`, `query-users`, `view-realm`, `view-users`) 할당
7. Credentials 탭 → Secret 복사

**`.env.local`:**
```bash
KEYCLOAK_URL=https://keycloak.local.narwhal.internal
KEYCLOAK_REALM=narwhal
KEYCLOAK_ADMIN_CLIENT_ID=narwhal-portal-admin
KEYCLOAK_ADMIN_CLIENT_SECRET=<copied-secret>
```

**검증:**
```bash
curl -s -X POST "$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
  -d "grant_type=client_credentials" \
  -u "$KEYCLOAK_ADMIN_CLIENT_ID:$KEYCLOAK_ADMIN_CLIENT_SECRET" | jq -r .access_token | head -c 40
# Bearer 토큰 prefix가 출력되어야 함
```

ROPC 절대 사용 금지(보안 감사 C-6).

---

## 4. ArgoCD project allowlist 결정

**목적:** `developer` role이 sync/rollback 가능한 project 범위 제한.

> 클러스터 리포: `narwhal/gitops/apps/` 의 ArgoCD Application들이 사용하는 `spec.project` 값 확인.

**절차:**
```bash
argocd login argocd.local.narwhal.internal
argocd proj list
```

`developer`가 만질 수 있는 project를 콤마 구분으로 환경변수에 입력:

**`.env.local`:**
```bash
ARGOCD_URL=https://argocd.local.narwhal.internal
ARGOCD_TOKEN=<argocd-account-token>
ARGOCD_DEVELOPER_PROJECTS=user-apps,sandbox  # 예시. 실제 project 이름으로 교체
```

ArgoCD 토큰 발급:
```bash
# Settings → Accounts → idp-portal → Generate Token
# 또는
argocd account generate-token --account idp-portal
```

`cluster-admin`은 모든 project 허용. `viewer`/`guest`는 sync/rollback 불가(role 자체 차단).

---

## 5. Tuning Job 이미지 빌드·푸시 (digest pin)

**목적:** 노드 튜닝 Job(privileged + nsenter)이 사용하는 이미지를 digest로 고정해 supply-chain 변조 방지.

> 클러스터 리포: 별도 Tuning 이미지가 없으면 신규 작성 필요. 예: `narwhal/idp/manifests/tuning/Dockerfile`.

**Dockerfile 예시 (별도 디렉터리):**
```dockerfile
FROM alpine:3.20@sha256:<pinned>
RUN apk add --no-cache util-linux bash kmod iproute2
ENTRYPOINT ["/bin/bash"]
```

**빌드·푸시:**
```bash
TAG=0.1.0
docker build -t harbor.local.narwhal.internal/narwhal/tuning:$TAG narwhal/idp/manifests/tuning/
docker push harbor.local.narwhal.internal/narwhal/tuning:$TAG
docker images --digests harbor.local.narwhal.internal/narwhal/tuning | grep $TAG
# RELEASE@sha256:<64hex> 추출
```

**`.env.local`:**
```bash
TUNING_JOB_IMAGE=harbor.local.narwhal.internal/narwhal/tuning@sha256:<64hex>
TUNING_JOB_NAMESPACE=devtools
```

태그만(`@sha256:` 누락) 입력하면 부팅 시 `k8s-job-runner.ts`의 정규식 검증이 거부.

**검증:**
```bash
node -e "console.log(/^[^\s@:]+(?::[0-9]+)?\/[a-z0-9._\-\/]+@sha256:[0-9a-f]{64}$/i.test(process.env.TUNING_JOB_IMAGE))" \
  TUNING_JOB_IMAGE=$TUNING_JOB_IMAGE
# true
```

---

## 6. Valkey TLS + AUTH 활성화

**목적:** 포털 캐시(Valkey) 평문 통신 차단, AUTH 강제.

> 클러스터 리포: `narwhal/gitops/resources/narwhal-portal-k8s.yaml` 의 `narwhal-portal-valkey` Deployment에 TLS/AUTH가 없는 상태(`valkey-server --save "" --appendonly no`만). 이 매니페스트를 갱신해야 한다(클러스터 리포에서 처리).

**클러스터 리포 변경 사항(narwhal/ repo에서 처리):**

1. `valkey.conf` ConfigMap 생성:
   ```yaml
   apiVersion: v1
   kind: ConfigMap
   metadata:
     name: narwhal-portal-valkey-config
     namespace: devtools
   data:
     valkey.conf: |
       requirepass ${VALKEY_PASSWORD}
       tls-port 6379
       port 0
       tls-cert-file /tls/tls.crt
       tls-key-file /tls/tls.key
       tls-ca-cert-file /tls/ca.crt
       save ""
       appendonly no
   ```
2. cert-manager Certificate 리소스로 `narwhal-portal-valkey-tls` Secret 발급 (CA: cluster issuer)
3. Deployment 갱신: command를 `valkey-server /etc/valkey/valkey.conf`로 변경, ConfigMap+TLS Secret 마운트
4. Service의 port는 그대로 6379 유지 (TLS 포트로 사용)

**포털 측(`.env.local`):**
```bash
VALKEY_URL=rediss://narwhal-portal-valkey.devtools.svc.cluster.local:6379  # rediss:// (TLS)
VALKEY_TLS=true
VALKEY_PASSWORD=<bootstrap-secrets.sh가 생성한 값>
```

VALKEY_PASSWORD는 K8s Secret으로 cluster에 배포해야 하며, narwhal-portal Deployment에서 envFrom으로 주입.

**검증:**
```bash
kubectl exec -n devtools deploy/narwhal-portal-valkey -- \
  valkey-cli --tls --cacert /tls/ca.crt -a "$VALKEY_PASSWORD" ping
# PONG
```

production 환경에서 `VALKEY_TLS!=true` 또는 `VALKEY_PASSWORD` 미설정이면 포털이 부팅 거부(`src/lib/valkey.ts`).

---

## 7. OpenBao 서버 HTTPS 강제

**목적:** OpenBao 통신 평문 차단.

> 클러스터 리포: `narwhal/gitops/apps/openbao.yaml`, `narwhal/idp/manifests/openbao/`(있다면).

**OpenBao listener 설정(클러스터 리포에서):**
```hcl
listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = false
  tls_cert_file = "/vault/tls/tls.crt"
  tls_key_file  = "/vault/tls/tls.key"
}
```

cert-manager Certificate로 TLS Secret 발급 → openbao Deployment에 마운트.

**`.env.local`:**
```bash
OPENBAO_ADDR=https://openbao.local.narwhal.internal  # https:// 필수
OPENBAO_TOKEN=<vault token 또는 AppRole secret_id>
```

OpenBao 초기화 + 토큰 발급:
```bash
vault operator init -key-shares=5 -key-threshold=3   # 최초 1회만
vault operator unseal <key1>; vault operator unseal <key2>; vault operator unseal <key3>
# AppRole 권장
vault auth enable approle
vault write auth/approle/role/idp-portal token_policies="idp-portal" \
  token_ttl=1h token_max_ttl=4h
ROLE_ID=$(vault read -field=role_id auth/approle/role/idp-portal/role-id)
SECRET_ID=$(vault write -f -field=secret_id auth/approle/role/idp-portal/secret-id)
TOKEN=$(vault write -field=token auth/approle/login role_id=$ROLE_ID secret_id=$SECRET_ID)
echo $TOKEN  # → OPENBAO_TOKEN
```

`http://`로 시작하면 production에서 `src/lib/openbao.ts`가 첫 호출 시 throw.

**검증:**
```bash
curl -sk -H "X-Vault-Token: $OPENBAO_TOKEN" "$OPENBAO_ADDR/v1/sys/health" | jq .
```

---

## 8. K8s Service Account 단기 토큰 (TokenRequest API)

**목적:** SA 토큰 만료가 2036년인 장기 토큰 대신 1시간 단위 회전 토큰 사용.

> 보안 감사 C-1: SA 토큰 단기화는 운영 측 핵심 권고.

**옵션 A — projected service account token (권장):**

`narwhal-portal` Deployment 매니페스트에 다음 추가(클러스터 리포):
```yaml
spec:
  template:
    spec:
      serviceAccountName: idp-portal
      containers:
        - name: portal
          volumeMounts:
            - name: kube-api-token
              mountPath: /var/run/secrets/tokens
              readOnly: true
      volumes:
        - name: kube-api-token
          projected:
            sources:
              - serviceAccountToken:
                  path: token
                  expirationSeconds: 3600
                  audience: https://kubernetes.default.svc
```

포털 코드에서 `K8S_SA_TOKEN` 대신 `/var/run/secrets/tokens/token` 파일을 매 요청마다 읽도록 수정 필요(별도 작업, 본 문서 범위 외 — 코드 수정 후 별도 PR로 처리).

**옵션 B — kubectl create token (임시):**
```bash
kubectl -n devtools create serviceaccount idp-portal
kubectl create clusterrolebinding idp-portal --clusterrole=narwhal-portal \
  --serviceaccount=devtools:idp-portal
TOKEN=$(kubectl -n devtools create token idp-portal --duration=3600s)
```

`TOKEN` 값을 `.env.local`의 `K8S_SA_TOKEN`에 입력. CronJob 등으로 30분마다 갱신 권장(아니면 옵션 A로 전환).

**검증:**
```bash
curl -sk -H "Authorization: Bearer $TOKEN" \
  "https://kubernetes.default.svc/api/v1/namespaces/devtools/pods" | jq '.items | length'
```

---

## 9. `.env.local` placeholder 채우기

`scripts/bootstrap-secrets.sh` 실행 + 단계 2~8 완료 후, `.env.local`이 다음 키를 모두 가져야 한다.

| 키 | 출처 단계 | 비고 |
|---|---|---|
| `AUTH_SECRET` | 1 | 자동 생성 |
| `AUTH_URL` | 수동 | `https://portal.local.narwhal.internal` |
| `AUTH_MOCK` | 미설정 또는 `false` | production에서 `true`면 부팅 차단 |
| `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` | 2 | 포털 로그인 OIDC |
| `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_ADMIN_CLIENT_ID`, `KEYCLOAK_ADMIN_CLIENT_SECRET` | 3 | Keycloak admin API |
| `K8S_API_SERVER`, `K8S_SA_TOKEN` | 8 | 클러스터 내 부팅 시 in-cluster config 자동 사용 가능 |
| `ARGOCD_URL`, `ARGOCD_TOKEN`, `ARGOCD_DEVELOPER_PROJECTS` | 4 | |
| `APISIX_ADMIN_URL`, `APISIX_API_KEY` | 수동 | APISIX admin 설정값 |
| `PROMETHEUS_URL`, `ALERTMANAGER_URL`, `LOKI_URL` | 수동 | 클러스터 내부 DNS |
| `VALKEY_URL`, `VALKEY_TLS=true`, `VALKEY_PASSWORD` | 1+6 | rediss:// + AUTH |
| `OPENBAO_ADDR`, `OPENBAO_TOKEN` | 7 | https:// 필수 |
| `TUNING_JOB_IMAGE`, `TUNING_JOB_NAMESPACE` | 5 | digest pin |
| `LIVE_INGEST_SECRET` | 1 | 자동 생성 |
| `OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT` | 수동 | OTEL 사용 시 둘 다 필수 |

전체 키 그룹·prod 필수 표기는 `.env.example` 참조.

---

## 10. 배포 직전 체크리스트

```bash
# 1) 의존성 + 빌드
pnpm install
pnpm audit                   # → 0 vulnerabilities
pnpm build                   # → 성공
npx tsc --noEmit             # → 0 errors

# 2) 환경변수 누락 확인
for k in AUTH_SECRET AUTH_URL OIDC_CLIENT_ID OIDC_CLIENT_SECRET \
         KEYCLOAK_URL KEYCLOAK_ADMIN_CLIENT_SECRET \
         ARGOCD_URL ARGOCD_TOKEN \
         VALKEY_URL VALKEY_TLS VALKEY_PASSWORD \
         OPENBAO_ADDR OPENBAO_TOKEN \
         TUNING_JOB_IMAGE LIVE_INGEST_SECRET; do
  grep -q "^$k=.\+" .env.local || echo "MISSING: $k"
done

# 3) Tuning 이미지 digest 형식 검증
grep '^TUNING_JOB_IMAGE=' .env.local | grep -qE '@sha256:[0-9a-f]{64}$' \
  && echo "OK" || echo "FAIL: TUNING_JOB_IMAGE must be digest-pinned"

# 4) AUTH_MOCK 누설 차단
grep -q '^AUTH_MOCK=true' .env.local && echo "FAIL: AUTH_MOCK must not be true" || echo "OK"
```

배포 후 런타임 검증:

```bash
# CSP / 보안 헤더
curl -sI https://portal.local.narwhal.internal | grep -iE 'strict-transport-security|content-security-policy|x-frame-options|x-content-type-options|referrer-policy|permissions-policy'

# 미인증 API 차단
curl -s -o /dev/null -w '%{http_code}' https://portal.local.narwhal.internal/api/cluster
# → 401

# events/ingest 미인증 차단 (shared-secret 검증)
curl -s -o /dev/null -w '%{http_code}' -X POST https://portal.local.narwhal.internal/api/events/ingest -d '{}'
# → 401

# /api/auth는 통과
curl -s -o /dev/null -w '%{http_code}' https://portal.local.narwhal.internal/api/auth/session
# → 200 (세션 없음 응답)
```

모든 체크가 통과하면 배포 준비 완료.

---

## 부록: 추가 권장 후속 작업

- **Valkey CVE-2025-49844 ("RediShell", CVSS 10.0)** — Valkey/Redis 서버 자체 패치 버전 사용 확인 (이미지 `valkey/valkey:8-alpine`의 보안 패치 라인 점검)
- **Dockerfile 베이스 이미지 digest pin** — `node:22-alpine`, `oven/bun:1.3.13-alpine` digest 추출 후 Dockerfile/Dockerfile.dev 1번째·2번째 FROM 절에 적용
- **Makefile `:latest` 태그 푸시 정책** — immutable tag(SHA 또는 semver) 정책으로 전환
- **추후 CSP 강화** — 현재 `script-src 'unsafe-inline'`. nonce 기반으로 전환(`src/proxy.ts`에서 nonce 발급 후 layout/heads에 주입)
