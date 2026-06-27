#!/usr/bin/env bash
# Kaniko in-cluster 빌드 1회 설정 (Narwhal IDP Portal)
#
# 동작:
#   1. kubectl 연결 확인
#   2. Harbor 관리자 비밀번호 조회 (devtools/harbor-secrets)
#   3. docker config.json 생성 → Opaque Secret `idp-portal-kaniko-harbor` (devtools)
#      Kaniko가 mount 후 Harbor로 push 인증에 사용
#   4. Narwhal Root CA secret 복제
#      platform-system/narwhal-root-ca-secret → devtools/narwhal-root-ca-secret
#      Kaniko pod이 같은 namespace의 secret만 volume mount 가능
#
# 재실행 안전 (idempotent). 비밀번호 회전 또는 CA 갱신 시 다시 실행하세요.
#
# 사용: ./scripts/harbor-kaniko-setup.sh
#
# 환경변수 오버라이드:
#   BUILD_NAMESPACE=devtools               # Kaniko 빌드 네임스페이스
#   REGISTRY=harbor.local.narwhal.internal
#   HARBOR_USERNAME=admin
#   HARBOR_SECRET_NS=devtools
#   HARBOR_SECRET_NAME=harbor-secrets
#   HARBOR_SECRET_KEY=HARBOR_ADMIN_PASSWORD
#   CA_SECRET_NS=platform-system
#   CA_SECRET_NAME=narwhal-root-ca-secret

set -euo pipefail

BUILD_NAMESPACE="${BUILD_NAMESPACE:-devtools}"
REGISTRY="${REGISTRY:-harbor.local.narwhal.internal}"
HARBOR_USERNAME="${HARBOR_USERNAME:-admin}"
HARBOR_SECRET_NS="${HARBOR_SECRET_NS:-devtools}"
HARBOR_SECRET_NAME="${HARBOR_SECRET_NAME:-harbor-secrets}"
HARBOR_SECRET_KEY="${HARBOR_SECRET_KEY:-HARBOR_ADMIN_PASSWORD}"
CA_SECRET_NS="${CA_SECRET_NS:-platform-system}"
CA_SECRET_NAME="${CA_SECRET_NAME:-narwhal-root-ca-secret}"

KANIKO_DOCKER_SECRET="idp-portal-kaniko-harbor"

# ---- 출력 유틸 -------------------------------------------------------------
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
yellow() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
info()   { printf '▸ %s\n' "$*"; }

# ---- 1. kubectl 연결 확인 --------------------------------------------------
info "kubectl 연결 확인..."
if ! kubectl cluster-info >/dev/null 2>&1; then
  red "kubectl이 클러스터에 연결되지 않습니다."
  red "  KUBECONFIG를 설정한 뒤 다시 시도하세요. 예) export KUBECONFIG=~/.kube/narwhal.yaml"
  exit 1
fi
info "현재 컨텍스트: $(kubectl config current-context)"

# ---- 2. 네임스페이스 존재 확인 ---------------------------------------------
for ns in "$BUILD_NAMESPACE" "$HARBOR_SECRET_NS" "$CA_SECRET_NS"; do
  if ! kubectl get namespace "$ns" >/dev/null 2>&1; then
    red "네임스페이스가 존재하지 않습니다: $ns"
    exit 1
  fi
done

# ---- 3. Harbor 비밀번호 조회 -----------------------------------------------
info "Harbor 비밀번호 조회 (${HARBOR_SECRET_NS}/${HARBOR_SECRET_NAME})..."
HARBOR_PASS=$(kubectl -n "$HARBOR_SECRET_NS" get secret "$HARBOR_SECRET_NAME" \
  -o jsonpath="{.data.${HARBOR_SECRET_KEY}}" 2>/dev/null | base64 -d || true)

if [[ -z "$HARBOR_PASS" ]]; then
  red "Harbor 비밀번호 조회 실패. Secret/Key를 확인하세요."
  exit 1
fi

# ---- 4. Kaniko docker config secret 생성 (Opaque) --------------------------
info "Kaniko Harbor 인증 Secret 생성: ${BUILD_NAMESPACE}/${KANIKO_DOCKER_SECRET}"
AUTH_B64=$(printf '%s:%s' "$HARBOR_USERNAME" "$HARBOR_PASS" | base64 | tr -d '\n')
CONFIG_JSON=$(cat <<EOF
{
  "auths": {
    "${REGISTRY}": {
      "auth": "${AUTH_B64}"
    }
  }
}
EOF
)

# --dry-run=client + apply -f - 로 idempotent 업데이트
kubectl create secret generic "$KANIKO_DOCKER_SECRET" \
  --namespace="$BUILD_NAMESPACE" \
  --from-literal=config.json="$CONFIG_JSON" \
  --dry-run=client -o yaml | kubectl apply -f -

# ---- 5. Narwhal Root CA secret 복제 ----------------------------------------
info "Narwhal Root CA secret 복제: ${CA_SECRET_NS}/${CA_SECRET_NAME} → ${BUILD_NAMESPACE}/${CA_SECRET_NAME}"
if ! kubectl -n "$CA_SECRET_NS" get secret "$CA_SECRET_NAME" >/dev/null 2>&1; then
  red "원본 CA secret이 없습니다: ${CA_SECRET_NS}/${CA_SECRET_NAME}"
  red "  Narwhal 클러스터 provisioning이 완료되었는지 확인하세요."
  exit 1
fi

# platform-system → devtools 로 복제 (namespace만 교체 + managed field 정리)
kubectl -n "$CA_SECRET_NS" get secret "$CA_SECRET_NAME" -o json | \
  jq --arg ns "$BUILD_NAMESPACE" '
    .metadata.namespace = $ns |
    .metadata.labels = ((.metadata.labels // {}) + {"narwhal.io/synced-from": "platform-system"}) |
    del(.metadata.creationTimestamp, .metadata.resourceVersion, .metadata.uid,
        .metadata.ownerReferences, .metadata.managedFields,
        .metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"])
  ' | kubectl apply -f -

# ---- 6. CA secret에 ca.crt key 존재 확인 -----------------------------------
if ! kubectl -n "$BUILD_NAMESPACE" get secret "$CA_SECRET_NAME" \
    -o jsonpath='{.data.ca\.crt}' 2>/dev/null | grep -q .; then
  yellow "[경고] 복제된 Secret에 'ca.crt' key가 없습니다."
  yellow "Kaniko volumeMount 설정을 실제 key 이름에 맞춰 조정해야 할 수 있습니다."
  kubectl -n "$BUILD_NAMESPACE" get secret "$CA_SECRET_NAME" -o jsonpath='{.data}' | jq 'keys'
fi

echo
green "[완료] Kaniko in-cluster 빌드 준비 끝."
info "이제 로컬 Docker 없이 다음 명령으로 개발 가능합니다:"
echo "  pnpm dev:skaffold      # HMR 모드"
echo "  pnpm debug:skaffold    # Node inspector 모드"
echo "  pnpm deploy:skaffold   # 1회 배포"
