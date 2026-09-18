# digest pin (portal#23): node:22-alpine, digest resolved 2026-09-18 via
#   registry-1.docker.io/v2/library/node/manifests/22-alpine
# Re-pin by re-running that manifest HEAD (or `docker pull` + `docker images --digests`)
# whenever the base image needs a version bump — never drop back to a mutable tag alone.
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# digest pin (portal#23): oven/bun:1.3.13-alpine, digest resolved 2026-09-18 via
#   registry-1.docker.io/v2/oven/bun/manifests/1.3.13-alpine
# Bun binary을 별도 stage에서 가져옴 (curl 설치보다 훨씬 빠름)
FROM oven/bun:1.3.13-alpine@sha256:4de475389889577f346c636f956b42a5c31501b654664e9ae5726f94d7bb5349 AS bun-source

# 의존성 설치: bun.lock 있으면 bun 사용 (3-5x ↑), 없으면 pnpm fallback
FROM base AS deps
WORKDIR /app
COPY --from=bun-source /usr/local/bin/bun /usr/local/bin/bun
COPY package.json bun.lock* pnpm-lock.yaml* ./
# --ignore-scripts on the bun path is not optional. pnpm 10 blocks dependency install
# scripts by default and pnpm-workspace.yaml pins that with an empty
# onlyBuiltDependencies; bun does NOT, so the two branches would apply different trust
# policies to the same dependency graph. There is no bun.lock in the repo today, which
# makes this the dangerous kind of gap: nothing exercises the branch, so nothing would
# notice when someone adds one.
RUN if [ -f bun.lock ]; then \
      echo "==> bun install" && bun install --frozen-lockfile --ignore-scripts; \
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
