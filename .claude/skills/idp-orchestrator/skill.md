---
name: idp-orchestrator
description: "Deprecated — orchestration workflow is now in CLAUDE.md Agent Team Harness section. Main context executes directly."
---

# IDP Portal Orchestrator (Deprecated)

Orchestration workflow has been moved to `CLAUDE.md` → **Agent Team Harness** section.

The main context executes the workflow directly:
1. Analyze requirements + write API response shape spec
2. Run `portal-frontend` + `portal-backend` in parallel (`run_in_background: true`)
3. Run `portal-qa` after both complete
4. Fix loop (max 2 iterations) if QA finds failures
