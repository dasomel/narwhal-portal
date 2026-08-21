"use client"
import { useQuery } from "@tanstack/react-query"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n-client"
import type { EffectivePermissions as Data } from "@/app/api/settings/effective-permissions/route"

// Answers "why can I see what I see" for the signed-in user.
//
// The chain crosses four systems — Keycloak group, portal role, team, namespace — and
// when someone reports an empty portal, the question is which link is broken. The
// unmapped-claims panel is the one that pays for this view: a group named
// `cluster-admins` instead of `cluster-admin` is dropped by the RBAC allowlist and the
// session lands on guest with no error anywhere, so the symptom reads as "the portal is
// broken" rather than "the group name is wrong".
export function EffectivePermissions() {
  const t = useT()
  const { data, isLoading } = useQuery<Data>({
    queryKey: ["settings-effective-permissions"],
    queryFn: () => fetch("/api/settings/effective-permissions").then((r) => r.json()),
  })

  if (isLoading) {
    return (
      <Card className="p-5">
        <div className="h-32 bg-muted/50 rounded flex items-center justify-center">
          <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
        </div>
      </Card>
    )
  }
  if (!data) return null

  const hasProblem = data.claims.unmappedClaims.length > 0 || data.claims.fellBackToGuest

  return (
    <div className="space-y-4">
      {hasProblem && (
        <Card className="p-5 border-narwhal-warning/40">
          <h2 className="font-semibold text-foreground mb-2">{t("perm.diagTitle")}</h2>
          {data.claims.fellBackToGuest && (
            <p className="text-sm text-muted-foreground mb-2">{t("perm.diagGuest")}</p>
          )}
          {data.claims.unmappedClaims.length > 0 && (
            <>
              <p className="text-sm text-muted-foreground mb-2">{t("perm.diagUnmapped")}</p>
              <div className="flex gap-1 flex-wrap">
                {data.claims.unmappedClaims.map((c) => (
                  <Badge key={c} className="bg-narwhal-warning/15 text-narwhal-warning">{c}</Badge>
                ))}
              </div>
            </>
          )}
        </Card>
      )}

      <Card className="p-5">
        <h2 className="font-semibold text-foreground mb-4">{t("perm.chainTitle")}</h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{t("perm.role")}</dt>
            <dd className="text-foreground font-medium">{data.identity.role}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("perm.teams")}</dt>
            <dd className="flex gap-1 flex-wrap mt-0.5">
              {data.claims.mappedTeams.length === 0 ? (
                <span className="text-muted-foreground">{t("perm.none")}</span>
              ) : (
                data.claims.mappedTeams.map((g) => (
                  <Badge key={g} className="bg-muted text-muted-foreground">{g}</Badge>
                ))
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("perm.argocdProjects")}</dt>
            <dd className="flex gap-1 flex-wrap mt-0.5">
              {data.argocdProjects.length === 0 ? (
                <span className="text-muted-foreground">{t("perm.none")}</span>
              ) : (
                data.argocdProjects.map((p) => (
                  <Badge key={p} className="bg-muted text-muted-foreground">{p}</Badge>
                ))
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("perm.nsCount")}</dt>
            <dd className="text-foreground font-medium">
              {data.allNamespaces ? t("perm.allNamespaces") : data.namespaces.length}
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold text-foreground mb-1">{t("perm.nsTitle")}</h2>
        <p className="text-xs text-muted-foreground mb-4">{t("perm.nsWhy")}</p>
        {data.namespaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("perm.nsEmpty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border">
                  <th className="py-2 pr-4 font-medium">{t("perm.colNamespace")}</th>
                  <th className="py-2 pr-4 font-medium">{t("perm.colVia")}</th>
                  <th className="py-2 font-medium">{t("perm.colOwner")}</th>
                </tr>
              </thead>
              <tbody>
                {data.namespaces.map((ns) => (
                  <tr key={ns.name} className="border-b border-border/50 last:border-0">
                    <td className="py-2 pr-4 text-foreground">{ns.name}</td>
                    <td className="py-2 pr-4">
                      <Badge
                        className={
                          ns.via === "label"
                            ? "bg-narwhal-success/15 text-narwhal-success"
                            : "bg-muted text-muted-foreground"
                        }
                      >
                        {t(ns.via === "label" ? "perm.viaLabel" : ns.via === "all" ? "perm.viaAll" : "perm.viaPattern")}
                      </Badge>
                    </td>
                    <td className="py-2 text-muted-foreground">{ns.owner ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold text-foreground mb-1">{t("perm.defaultsTitle")}</h2>
        <p className="text-xs text-muted-foreground mb-4">{t("perm.defaultsWhy")}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground border-b border-border">
                <th className="py-2 pr-4 font-medium">{t("perm.colRole")}</th>
                <th className="py-2 pr-4 font-medium">{t("perm.colNamespaces")}</th>
                <th className="py-2 font-medium">{t("perm.colProjects")}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.configured.roleDefaults).map(([role, d]) => (
                <tr key={role} className="border-b border-border/50 last:border-0">
                  <td className="py-2 pr-4 text-foreground">{role}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{d.namespaces.join(", ") || "—"}</td>
                  <td className="py-2 text-muted-foreground">{d.argocdProjects.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
