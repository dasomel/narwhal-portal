# ── digest pin (운영 배포 필수) ──────────────────────────────────
# 아직 미고정 상태. 운영 배포 전 아래 명령으로 digest 확인 후 이 줄을 교체:
#
#   docker pull node:22-alpine
#   docker images --digests node | grep 22-alpine
#   # sha256 값을 복사해 아래 FROM 줄에 붙여넣기:
#   FROM node:22-alpine@sha256:<64자 hex digest> AS base
#
# 예시 (실제 값으로 교체 필요):
#   FROM node:22-alpine@sha256:1234abcd...ef AS base
# ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# ── digest pin (운영 배포 필수) ──────────────────────────────────
# 아직 미고정 상태. 운영 배포 전 아래 명령으로 digest 확인 후 교체:
#
#   docker pull oven/bun:1.3.13-alpine
#   docker images --digests oven/bun | grep 1.3.13-alpine
#   FROM oven/bun:1.3.13-alpine@sha256:<digest> AS bun-source
# ─────────────────────────────────────────────────────────────────
# Bun binary을 별도 stage에서 가져옴 (curl 설치보다 훨씬 빠름)
FROM oven/bun:1.3.13-alpine AS bun-source

# 의존성 설치: bun.lock 있으면 bun 사용 (3-5x ↑), 없으면 pnpm fallback
FROM base AS deps
WORKDIR /app
COPY --from=bun-source /usr/local/bin/bun /usr/local/bin/bun
COPY package.json bun.lock* pnpm-lock.yaml* ./
RUN if [ -f bun.lock ]; then \
      echo "==> bun install" && bun install --frozen-lockfile; \
    else \
      echo "==> pnpm install (fallback)" && pnpm install --frozen-lockfile; \
    fi

FROM base AS builder
WORKDIR /app
COPY --from=bun-source /usr/local/bin/bun /usr/local/bin/bun
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN if [ -f bun.lock ]; then bun run build; else pnpm build; fi

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# 라이선스 고지 — 선택이 아니라 재배포 의무다.
# MIT/BSD/ISC는 "all copies or substantial portions"에 저작권·허가 고지를 포함할 것을
# 요구하고 Apache-2.0 §4(d)는 NOTICE 전파를 요구하는데, 이 이미지가 바로 그 copy다.
# 그런데 Next의 파일 트레이싱은 런타임에 필요한 파일만 복사하면서 LICENSE를 걷어낸다
# (1.0.17 빌드 기준 node_modules 631개 -> .next/standalone 3개). 그래서 빌드 산출물에
# 기대지 않고 여기서 명시적으로 넣는다. THIRD-PARTY-NOTICES.md는 pnpm run notices로 생성.
COPY LICENSE NOTICE THIRD-PARTY-NOTICES.md ./
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
