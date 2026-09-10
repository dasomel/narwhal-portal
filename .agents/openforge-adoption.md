# OpenForge adoption

Follow the canonical OpenForge standards for model-agnostic instructions, agent engineering, and user-centric validation:

- https://github.com/dasomel/openforge/blob/main/docs/model-agnostic-agent-instructions.md
- https://github.com/dasomel/openforge/blob/main/docs/agent-engineering.md
- https://github.com/dasomel/openforge/blob/main/docs/user-centric-validation.md

Keep Portal-specific UI/API/auth/routing constraints local. Model/tool files are thin adapters, not forks of engineering policy. For user-facing, auth, routing, API integration, install/configuration, or upgrade changes, verify the real public/browser path from a clean state where practical; green CI alone is not sufficient. Convert confirmed user-visible defects into regression evidence.

Safe local/disposable work within scope may proceed autonomously. Production/shared mutation, destructive external actions, releases, credential/permission widening, or unrelated external mutation requires explicit authorization unless already granted.
