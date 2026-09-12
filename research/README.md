# Research Evidence

Narwhal Portal follows the OpenForge Research Evidence Collection Standard:
https://github.com/dasomel/openforge/blob/main/docs/research-evidence.md

Collect machine-readable evidence during normal development when practical. Useful Portal evidence includes build/test/E2E duration and results, browser/auth/integration outcomes, failures/retries/recovery, runtime or page/API latency where relevant, and agent-assisted task attempts, elapsed time, human interventions, review corrections, CI retries, and final verification. Preserve failed and partial runs as well as successes.

## Legacy evidence on discovery

Evidence collection is prospective and retrospective. During implementation, fixes, verification, releases, or documentation work, register existing QA reports, test outputs, benchmark results, traces, CI results, dated reports, and other historical measurements encountered during the task as legacy evidence instead of discarding or rewriting them.

Use `dasomel/openforge#89` as the portfolio-level legacy catalog source of truth. Record source/path, known date, evidence class/strength, environment scope, metrics/facts, limitations, and likely paper use. Never backfill values that were not measured historically. Preserve negative, partial, and obsolete evidence when it has longitudinal value.

The archived `docs/archive/portal-full-check.qa-report-2026-06-10.md`, for example, is valid quantitative legacy QA evidence and should remain in its original form while being cataloged for future analysis.

## Public-data rule

These are personal OSS/test environments. Public test identifiers such as RFC1918 addresses, `*.local.*` domains, pod/node/namespace names, local topology, browser test endpoints, and runtime details may be retained when useful for reproducibility.

Never publish actual secrets/credentials/tokens/cookies/private keys or accidental personal data. Review any future third-party/non-public environment artifact separately. Validate structured evidence against the OpenForge schema and run secret/pattern checks before publication.