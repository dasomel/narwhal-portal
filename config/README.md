# `role-filter.json`

What a signed-in user may see. Two mechanisms, and one of them is on its way out.

## The label is the source of truth

A namespace says who owns it:

```yaml
metadata:
  labels:
    narwhal.io/team: platform-team
```

The portal reads that label; the cluster reads the same label in the RoleBinding
each tenant file ships (`narwhal/resources/tenants/`). The portal writes it when a
namespace is requested. One fact, on the object being governed.

`teamMappings[].namespaces` is the **migration path**, not the model. Namespaces
created before the tenant flow carry no label, so the patterns still resolve them —
`resolveNamespaceScope` accepts either and records which one admitted each name.

### Migrating a team

1. Label its namespaces: `kubectl label ns <name> narwhal.io/team=<group>`
   — in the GitOps repo, not with `kubectl`, or ArgoCD's selfHeal reverts it.
2. Confirm the portal still shows them. `/api/my-apps` returns `scope.namespaces`,
   which is the resolved list.
3. Delete that team's `namespaces` array here. `argocdProjects` stays — ArgoCD
   projects are not namespaces and have no label to read.

Nothing needs a deploy in between: both sources resolve at every request.

## The shipped values are a sample

`frontend-team` maps `frontend-*`, and no such namespace exists in this platform.
Treat the file as an example to replace, not as configuration to preserve.

## `roleDefaults` is the open decision

```json
"developer": { "namespaces": ["*"], "argocdProjects": [] }
```

`["*"]` means every namespace, which makes the scope filter a **no-op** for anyone
holding the `developer` or `viewer` role — the code filters, the policy does not.
Only `guest` is actually narrowed today.

Tightening it is an operational decision, not a code change, and it has a real cost:
set it to `[]` and any user without a team mapping or a labelled namespace sees an
empty portal. Decide it per environment. Tracked on narwhal-portal#15.

## Shape

| Key | Meaning |
|---|---|
| `roleDefaults.<role>` | Fallback scope for a role, used when no team mapping matches |
| `teamMappings[].group` | Keycloak group, matched against the user's teams |
| `teamMappings[].namespaces` | Legacy patterns. `*` suffix is a prefix match; `*` alone is everything |
| `teamMappings[].argocdProjects` | ArgoCD projects the team may see. No wildcard-by-label equivalent |

Precedence: `cluster-admin` sees everything; otherwise a matching team mapping wins;
otherwise the highest-priority role's default; otherwise nothing.
