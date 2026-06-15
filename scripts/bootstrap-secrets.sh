#!/usr/bin/env bash
# bootstrap-secrets.sh — 클린 설치용 시크릿 초기화
# 멱등성: 이미 존재하는 키는 덮어쓰지 않음. 새 키만 추가.
# 사용법: bash scripts/bootstrap-secrets.sh
#         (반복 실행해도 기존 값 보존)
set -euo pipefail

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env.local"

# .env.local 없으면 빈 파일 생성
if [ ! -f "$ENV_FILE" ]; then
  touch "$ENV_FILE"
  echo "[bootstrap] .env.local 신규 생성: $ENV_FILE"
fi

# ────────────────────────────────────────────────
# 헬퍼: 키가 없을 때만 값을 추가
# write_if_absent KEY VALUE
# ────────────────────────────────────────────────
write_if_absent() {
  local key="$1"
  local value_provider="$2"
  if grep -qF "${key}=" "$ENV_FILE" 2>/dev/null; then
    echo "[bootstrap] SKIP  $key (이미 존재)"
  else
    local value
    value="$($value_provider)"
    echo "${key}=${value}" >> "$ENV_FILE"
    echo "[bootstrap] WROTE $key"
  fi
}

literal() { printf '%s' "$1"; }
gen_secret_32() { openssl rand -base64 32; }
gen_secret_24() { openssl rand -base64 24; }

# ────────────────────────────────────────────────
# 자동 생성 시크릿 (lazy: 키 부재 시에만 openssl 실행)
# ────────────────────────────────────────────────
write_if_absent "AUTH_SECRET"        gen_secret_32
write_if_absent "VALKEY_PASSWORD"    gen_secret_24
write_if_absent "LIVE_INGEST_SECRET" gen_secret_24

# ────────────────────────────────────────────────
# 수동 발급 필요 — placeholder
# ────────────────────────────────────────────────
placeholder_oidc()    { literal "REPLACE_ME__keycloak_client_secret"; }
placeholder_kc_sa()   { literal "REPLACE_ME__keycloak_sa_client_secret"; }
placeholder_bao()     { literal "REPLACE_ME__openbao_token"; }

write_if_absent "OIDC_CLIENT_SECRET"             placeholder_oidc
write_if_absent "KEYCLOAK_ADMIN_CLIENT_SECRET"   placeholder_kc_sa
write_if_absent "OPENBAO_TOKEN"                  placeholder_bao

# ────────────────────────────────────────────────
# 파일 권한 좁힘 (owner read/write only)
# ────────────────────────────────────────────────
chmod 600 "$ENV_FILE"
echo "[bootstrap] chmod 600 $ENV_FILE"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 완료: $ENV_FILE"
echo ""
echo " ✔ 자동 생성된 키:"
echo "   AUTH_SECRET / VALKEY_PASSWORD / LIVE_INGEST_SECRET"
echo ""
echo " ✘ 아직 placeholder인 키 — 직접 발급 후 입력 필요:"
echo "   OIDC_CLIENT_SECRET          → Keycloak/Authentik 클라이언트 설정에서 발급"
echo "   KEYCLOAK_ADMIN_CLIENT_SECRET → Keycloak SA 클라이언트(idp-portal-admin) 생성 후 발급"
echo "   OPENBAO_TOKEN               → OpenBao vault operator init / approle auth 후 발급"
echo ""
echo " 자세한 절차: docs/security-clean-install.md"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
