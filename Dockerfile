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
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
