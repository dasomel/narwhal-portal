---
name: idp-qa
description: "Integration coherence verification guide for Narwhal IDP Portal. Performs API response shape vs frontend type cross-verification, routing consistency checks, role-based access control validation, and cache key conflict detection. Use this skill for verification, testing, QA, bug checks, or consistency checks. Triggers on 'verify', 'test', 'QA', 'check bugs', 'consistency'."
---

# IDP Portal QA Verification

Integration coherence verification procedures for the Narwhal IDP Portal. Systematically detects boundary mismatches at connection points, even when individual modules are correct.

## Verification Procedure

### Step 1: API vs Frontend Response Shape Cross-Verification

Compare each API route's `NextResponse.json()` call with the corresponding component's fetch type.

```
1. Extract object shapes passed to NextResponse.json() in src/app/api/*/route.ts
2. Check the response type/access pattern in components calling that API
3. Compare whether shapes match
4. Verify wrapping (if API returns { items: [...] }, does the component unwrap .items?)
```

API-Component mappings (single source of truth — keep updated when adding new API routes):

| API Route | Response Shape | Consumer Component |
|-----------|---------------|--------------------|
| `/api/metrics` | `{ cpu, memory, nodes, pods }` | `cluster-metrics.tsx` |
| `/api/argocd` | `{ total, synced, outOfSync, degraded, healthy }` | `argocd-status.tsx` |
| `/api/alerts` | `Alert[]` | `alerts-widget.tsx` |
| `/api/settings/users` | `AuthentikUser[]` | `users-table.tsx` |
| `/api/settings/routes` | `ApisixRoute[]` | `routes-table.tsx` |
| `/api/tools/health` | per-service health status | `tools-grid.tsx` |
| `/api/onboarding/kubeconfig` | YAML text | `kubeconfig-download.tsx` |

### Step 2: Routing Consistency Verification

```
1. Extract URL patterns from src/app/(dashboard)/*/page.tsx file paths
   - (dashboard) → removed from URL
   - Result: /, /tools, /settings, /onboarding
2. Collect all menuItems[].href values from src/components/nav.tsx
3. Verify each href matches an actual page path
4. Also verify Link, router.push values within components
```

### Step 3: Role-Based Access Control Verification

```
1. Check Nav menuItems roles arrays:
   - /: cluster-admin, developer, viewer
   - /tools: cluster-admin, developer, viewer
   - /settings: cluster-admin
   - /onboarding: cluster-admin, developer, viewer
2. Check PLATFORM_TOOLS[].roles in src/lib/tools.ts
3. Verify settings page data access is restricted to cluster-admin
4. Check if API routes have auth/permission checks
```

### Step 4: Cache Key Conflict Check

```
1. Extract cache key strings from cacheGet/cacheSet calls in src/lib/*.ts
2. Check for collisions (same key, different data)
3. For dynamic keys (prom:{query}), check for overlapping queries
```

### Step 5: Build Verification

```bash
pnpm build
```

Record build pass/fail and errors/warnings in the report. Note: build pass ≠ runtime correctness, so Steps 1-4 boundary verification is more important.

## Report Format

```markdown
# QA Verification Report

## Summary
- Passed: N
- Failed: N
- Unverified: N

## Failed Items

### [Item Name]
- Location: [file:line] vs [file:line]
- Issue: [specific mismatch description]
- Fix: [file, line, and change details]
- Severity: CRITICAL / WARNING / INFO
```
