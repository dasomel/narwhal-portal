#!/usr/bin/env bash
# kaniko-build.sh — In-cluster Kaniko build + push to Harbor for narwhal-portal
#
# 동작 순서:
#   1. kubectl / git 연결 확인
#   2. Kaniko 인증 Secret 준비 (harbor-kaniko-setup.sh 위임)
#   3. narwhal-portal 소스를 in-cluster Gitea에 push
#      (gitea-admin/narwhal-portal repo 없으면 Gitea API로 생성)
#   4. Kaniko Job manifest 적용 (domain placeholder sed 치환)
#   5. Job 완료 대기 (최대 20분)
#   6. Job 결과 출력 — 성공/실패 반환
#
# 재실행 안전 (idempotent):
#   - Gitea repo 이미 있으면 create 무시 (|| true)
#   - 이전 Job이 있으면 삭제 후 재생성
#
# 사용: ./scripts/kaniko-build.sh [--skip-push]
#   --skip-push : Gitea push 생략 (소스가 이미 최신 상태일 때 사용)
#
# 환경변수 오버라이드:
#   DOMAIN=local.narwhal.internal
#   BUILD_NAMESPACE=devtools
#   HARBOR_PROJECT=library
#   HARBOR_REPO=narwhal-portal
#   HARBOR_TAG=latest
#   GITEA_ADMIN_USER=gitea-admin
#   GITEA_PORTAL_REPO=narwhal-portal
#   JOB_TIMEOUT=1200   # seconds (default 20 min)
#   SCRIPT_DIR        # auto-detected; override only for testing
#
# 의존:
#   - harbor-kaniko-setup.sh (Kaniko Secret + CA 복제)
#   - narwhal-portal/deploy/kaniko-build-job.yaml (Job template)
#   - kubectl, curl, git, jq

set -euo pipefail

DOMAIN="${DOMAIN:-local.narwhal.internal}"
BUILD_NAMESPACE="${BUILD_NAMESPACE:-devtools}"
HARBOR_HOST="harbor.${DOMAIN}"
HARBOR_PROJECT="${HARBOR_PROJECT:-library}"
HARBOR_REPO="${HARBOR_REPO:-narwhal-portal}"
HARBOR_TAG="${HARBOR_TAG:-latest}"
GITEA_ADMIN_USER="${GITEA_ADMIN_USER:-gitea-admin}"
GITEA_PORTAL_REPO="${GITEA_PORTAL_REPO:-narwhal-portal}"
JOB_TIMEOUT="${JOB_TIMEOUT:-1200}"
JOB_NAME="kaniko-build-narwhal-portal"

SKIP_PUSH="false"
for arg in "$@"; do
  case "$arg" in
    --skip-push) SKIP_PUSH="true" ;;
  esac
done

# ---- 출력 유틸 -------------------------------------------------------------
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
yellow() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
info()   { printf '▸ %s\n' "$*"; }

# ---- 스크립트 위치 자동 감지 -----------------------------------------------
SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
JOB_TEMPLATE="${REPO_ROOT}/deploy/kaniko-build-job.yaml"

# ---- 필수 파일 확인 --------------------------------------------------------
if [[ ! -f "${JOB_TEMPLATE}" ]]; then
  red "Job template not found: ${JOB_TEMPLATE}"
  exit 1
fi

# ---- 1. kubectl 연결 확인 --------------------------------------------------
info "kubectl 연결 확인..."
if ! kubectl cluster-info >/dev/null 2>&1; then
  red "kubectl이 클러스터에 연결되지 않습니다."
  red "  KUBECONFIG를 설정한 뒤 다시 시도하세요."
  exit 1
fi
info "컨텍스트: $(kubectl config current-context)"

# ---- 2. Kaniko Secret / CA 준비 -------------------------------------------
info "Kaniko 인증 Secret + CA 준비 (harbor-kaniko-setup.sh)..."
bash "${SCRIPT_DIR}/harbor-kaniko-setup.sh"

# ---- 3. Gitea 접근 정보 조회 -----------------------------------------------
info "Gitea admin 비밀번호 조회..."
GITEA_ADMIN_PASSWORD="$(kubectl get secret gitea-admin -n "${BUILD_NAMESPACE}" \
  -o jsonpath='{.data.admin-password}' 2>/dev/null | base64 -d || echo "")"
if [[ -z "${GITEA_ADMIN_PASSWORD}" ]]; then
  red "gitea-admin secret이 ${BUILD_NAMESPACE} 네임스페이스에 없습니다."
  red "  12-gitea.sh 가 성공적으로 실행되었는지 확인하세요."
  exit 1
fi

# ---- 4. Gitea port-forward (로컬에서 실행 시) --------------------------------
# in-cluster 환경(VM)이면 http://gitea-http.devtools.svc.cluster.local:3000 직접 접근 가능.
# 로컬 호스트에서 실행 시 port-forward 필요.
GITEA_BASE_URL=""
PF_PID=""

cleanup_pf() {
  if [[ -n "${PF_PID}" ]]; then
    kill "${PF_PID}" 2>/dev/null || true
    PF_PID=""
  fi
}
trap cleanup_pf EXIT

# in-cluster 여부 확인: gitea-http DNS 직접 resolve 시도
if curl -s --max-time 3 \
    "http://gitea-http.${BUILD_NAMESPACE}.svc.cluster.local:3000/api/healthz" \
    >/dev/null 2>&1; then
  GITEA_BASE_URL="http://gitea-http.${BUILD_NAMESPACE}.svc.cluster.local:3000"
  info "in-cluster Gitea 직접 접근: ${GITEA_BASE_URL}"
else
  info "로컬 환경 — Gitea port-forward 시작..."
  kubectl port-forward svc/gitea-http -n "${BUILD_NAMESPACE}" 13000:3000 &
  PF_PID=$!
  sleep 5
  GITEA_BASE_URL="http://localhost:13000"
  info "port-forward PID=${PF_PID}, URL=${GITEA_BASE_URL}"
fi

GITEA_API="${GITEA_BASE_URL}/api/v1"
GITEA_AUTH="-u ${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASSWORD}"

# ---- 5. Gitea repo 생성 (없으면) -------------------------------------------
info "Gitea 저장소 확인: ${GITEA_ADMIN_USER}/${GITEA_PORTAL_REPO}"
REPO_CHECK_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  ${GITEA_AUTH} \
  "${GITEA_API}/repos/${GITEA_ADMIN_USER}/${GITEA_PORTAL_REPO}" \
  --max-time 10 2>/dev/null || echo "000")

if [[ "${REPO_CHECK_HTTP}" != "200" ]]; then
  info "저장소 없음 — 생성 중..."
  curl -s -X POST "${GITEA_API}/user/repos" \
    -H "Content-Type: application/json" \
    ${GITEA_AUTH} \
    -d "{
      \"name\": \"${GITEA_PORTAL_REPO}\",
      \"description\": \"narwhal-portal source (Kaniko build source)\",
      \"private\": true,
      \"auto_init\": false
    }" >/dev/null || true
  info "저장소 생성 완료"
else
  info "저장소 이미 존재 — 건너뜀"
fi

# ---- 6. narwhal-portal 소스 push -------------------------------------------
if [[ "${SKIP_PUSH}" == "true" ]]; then
  yellow "[--skip-push] Gitea push 생략"
else
  info "narwhal-portal 소스를 Gitea에 push 중..."

  PUSH_URL="${GITEA_BASE_URL}/${GITEA_ADMIN_USER}/${GITEA_PORTAL_REPO}.git"
  PUSH_URL_AUTH="${PUSH_URL/http:\/\//http://${GITEA_ADMIN_USER}:${GITEA_ADMIN_PASSWORD}@}"

  WORK_DIR="$(mktemp -d)"
  trap 'cleanup_pf; rm -rf "${WORK_DIR}"' EXIT

  # 현재 narwhal-portal 소스 복사 (node_modules, .next 제외)
  rsync -a --exclude='.git' --exclude='node_modules' --exclude='.next' \
    "${REPO_ROOT}/" "${WORK_DIR}/"

  cd "${WORK_DIR}"
  git init -b main
  git config user.email "kaniko-build@local"
  git config user.name "Kaniko Build"
  git add -A
  git commit -m "build: narwhal-portal source for Kaniko in-cluster build"

  # push (force: 이전 build 커밋 덮어쓰기)
  git push --force "${PUSH_URL_AUTH}" main
  cd "${REPO_ROOT}"

  info "Gitea push 완료"
fi

cleanup_pf
trap - EXIT

# ---- 7. Harbor 준비 대기 (D8: push race 방지) ---------------------------------
# D8: On a clean install, harbor-core and harbor-registry restart several times
# while config DB migrations run. Kaniko's push attempt hitting a mid-restart core
# returns 502 Bad Gateway. Gate here: wait for both deployments to be fully
# available before applying the Job, so the push never races a restarting Harbor.
# Timeout: 5 min (300s). If Harbor is already ready this completes immediately.
info "Harbor 준비 대기 (최대 5분)..."
HARBOR_READY_TIMEOUT=300
if ! kubectl rollout status deployment/harbor-core \
    -n "${BUILD_NAMESPACE}" \
    --timeout="${HARBOR_READY_TIMEOUT}s"; then
  red "harbor-core가 ${HARBOR_READY_TIMEOUT}초 내에 Ready 상태가 되지 않았습니다."
  red "  kubectl rollout status deployment/harbor-core -n ${BUILD_NAMESPACE} 로 상태를 확인하세요."
  exit 1
fi
if ! kubectl rollout status deployment/harbor-registry \
    -n "${BUILD_NAMESPACE}" \
    --timeout="${HARBOR_READY_TIMEOUT}s"; then
  red "harbor-registry가 ${HARBOR_READY_TIMEOUT}초 내에 Ready 상태가 되지 않았습니다."
  red "  kubectl rollout status deployment/harbor-registry -n ${BUILD_NAMESPACE} 로 상태를 확인하세요."
  exit 1
fi
info "Harbor 준비 완료 (core + registry 모두 Available)"

# ---- 8. 이전 Job 삭제 (있으면) ---------------------------------------------
if kubectl get job "${JOB_NAME}" -n "${BUILD_NAMESPACE}" &>/dev/null; then
  info "이전 Job 삭제: ${JOB_NAME}"
  kubectl delete job "${JOB_NAME}" -n "${BUILD_NAMESPACE}" --ignore-not-found=true
  # Pods가 Terminating에서 벗어날 때까지 잠시 대기
  sleep 5
fi

# ---- 9. Job manifest 적용 (domain placeholder 치환) -----------------------
HARBOR_DESTINATION="${HARBOR_HOST}/${HARBOR_PROJECT}/${HARBOR_REPO}:${HARBOR_TAG}"
info "Kaniko Job 적용: destination=${HARBOR_DESTINATION}"

sed \
  -e "s|__HARBOR_DESTINATION__|${HARBOR_DESTINATION}|g" \
  -e "s|__HARBOR_HOST__|${HARBOR_HOST}|g" \
  "${JOB_TEMPLATE}" | kubectl apply -f -

# ---- 10. Job 완료 대기 -------------------------------------------------------
info "Kaniko 빌드 대기 중 (최대 ${JOB_TIMEOUT}초)..."
info "  로그 확인: kubectl logs -n ${BUILD_NAMESPACE} -l app.kubernetes.io/name=${JOB_NAME} -f"

# Job Pod이 생성될 때까지 대기 (Kaniko executor 이미지 pull 포함)
POD_WAIT=0
while [[ ${POD_WAIT} -lt 120 ]]; do
  POD_PHASE=$(kubectl get pods -n "${BUILD_NAMESPACE}" \
    -l "app.kubernetes.io/name=${JOB_NAME}" \
    -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "")
  if [[ -n "${POD_PHASE}" ]] && [[ "${POD_PHASE}" != "Pending" ]]; then
    break
  fi
  sleep 5
  POD_WAIT=$((POD_WAIT + 5))
done

# Job 성공/실패 대기
if kubectl wait \
    --for=condition=complete \
    job/"${JOB_NAME}" \
    -n "${BUILD_NAMESPACE}" \
    --timeout="${JOB_TIMEOUT}s" 2>/dev/null; then
  green ""
  green "[완료] Kaniko 빌드 성공!"
  green "  이미지: ${HARBOR_DESTINATION}"
  exit 0
else
  # 실패 또는 타임아웃 — 로그 출력
  red ""
  red "[실패] Kaniko 빌드 실패 또는 타임아웃"
  red "  Job 상태:"
  kubectl get job "${JOB_NAME}" -n "${BUILD_NAMESPACE}" || true
  red ""
  red "  Pod 로그 (마지막 50줄):"
  kubectl logs -n "${BUILD_NAMESPACE}" \
    -l "app.kubernetes.io/name=${JOB_NAME}" \
    --tail=50 2>/dev/null || red "  (로그 없음)"
  exit 1
fi
