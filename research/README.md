# Research Evidence

Narwhal Portal follows the OpenForge Research Evidence Collection Standard:
https://github.com/dasomel/openforge/blob/main/docs/research-evidence.md

Collect sanitized, machine-readable evidence during normal development when practical. Useful Portal evidence includes build/test/E2E duration and results, browser/auth/integration outcomes, failures/retries/recovery, runtime or page/API latency where relevant, and agent-assisted task attempts, elapsed time, human interventions, review corrections, CI retries, and final verification.

Preserve failed and partial runs as well as successes. Tie measurements to UTC timestamp, git revision, schema version, and a normalized non-identifying environment label.

## Public-data rule

Only sanitized records may be committed publicly. Never publish credentials/tokens/cookies, private URLs/IPs/hostnames, personal/customer/employer/tenant data, raw auth/browser traces, screenshots with sensitive content, confidential prompts/source, arbitrary environment dumps, or security-sensitive infrastructure details. Raw CI logs, Playwright traces, prompts, screenshots, stack dumps, and security output are sensitive-by-default.

Before public storage: validate against the OpenForge schema, run secret/pattern checks, review free-form fields, and publish normalized aggregates instead of raw artifacts whenever safe redaction cannot be proven.
