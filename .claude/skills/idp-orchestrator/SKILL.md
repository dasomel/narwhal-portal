---
name: idp-orchestrator
description: Deprecated Claude-only Portal orchestration adapter. Use only for existing workflows that invoke idp-orchestrator; project domain work now lives in narwhal-portal frontend/backend/qa skills and team-lane orchestration belongs in CLAUDE.md or .claude/rules/.
license: Apache-2.0
compatibility: Claude-only compatibility entry.
metadata:
  openforge-scope: project
  openforge-owner: dasomel/narwhal-portal
  openforge-maturity: deprecated
  openforge-version: "2"
---

# Deprecated Portal orchestrator

Do not encode portable project knowledge or model routing here.

Use the canonical project skills under `.agents/skills/` for frontend, backend, and QA work. Claude-specific parallel lane orchestration is documented by the repository `CLAUDE.md` / `.claude/rules/` harness.
