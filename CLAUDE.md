@AGENTS.md

Claude specialist lanes live in `.claude/agents/` (`portal-frontend`, `portal-backend`, `portal-qa`). For a change spanning frontend and backend: fix the API response-shape contract first, run the two lanes independently, then `portal-qa`; send a QA failure back to the owning lane and stop after two non-converging repair loops. Single-side changes launch no other lane.
