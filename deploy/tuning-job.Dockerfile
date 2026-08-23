# narwhal-tuning job image (issue #55, item 2)
#
# k8s-job-runner.ts (runHostJob) runs this image as a privileged, hostPID+hostNetwork
# pod that nsenters into the host's namespaces to apply allowlisted node-tuning
# operations (see src/lib/tuning-commands.ts). It previously ran `apk add --no-cache
# util-linux` at container start on every single job execution — fetching tooling from
# the network at runtime, unpinned, defeating the digest pin already enforced on
# TUNING_JOB_IMAGE (see getTuningImage() in k8s-job-runner.ts). This Dockerfile bakes
# nsenter (from util-linux) in at BUILD time instead, so no package fetch happens at
# job runtime.
#
# ── digest pin (운영 배포 필수) ──────────────────────────────────
# 아직 미고정 상태. 운영 배포 전 아래 명령으로 digest 확인 후 이 줄을 교체:
#
#   docker pull alpine:3.21
#   docker images --digests alpine | grep 3.21
#   FROM alpine:3.21@sha256:<64자 hex digest>
# ─────────────────────────────────────────────────────────────────
FROM alpine:3.21

# util-linux provides /usr/bin/nsenter. `apk add util-linux` alone floats to whatever
# the mirror serves at BUILD time (still better than the old runtime fetch, but not
# fully pinned) — resolve the exact version before shipping this to production:
#
#   docker run --rm alpine:3.21 sh -c 'apk update >/dev/null && apk info util-linux'
#
# then replace the line below with `util-linux=<resolved-version>` (this repo's build
# pipeline has no live registry/network access to resolve that version from this pass,
# so it is left unpinned here rather than asserting an unverified number).
RUN apk add --no-cache util-linux \
    && nsenter --version

# No shell entrypoint beyond what k8s-job-runner.ts supplies via the pod's
# `command`/`args` (command: ["/bin/sh", "-c"], args: ["nsenter ... sh -c <script>"]).
