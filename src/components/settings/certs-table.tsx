"use client"
import { useState } from "react"
import { useQuery, useMutation } from "@tanstack/react-query"
import { useSession } from "next-auth/react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n-client"

interface Certificate {
  name: string
  namespace: string
  ready: boolean
  notAfter: string | null
  notBefore: string | null
  dnsNames: string[]
  issuer: string
  renewalTime: string | null
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null
  const diff = new Date(dateStr).getTime() - Date.now()
  return Math.floor(diff / (1000 * 60 * 60 * 24))
}

function expiryBadge(days: number | null): { class: string; label: string } {
  if (days === null) return { class: "bg-muted text-muted-foreground", label: "—" }
  if (days < 0) return { class: "bg-narwhal-danger/15 text-narwhal-danger", label: "Expired" }
  if (days < 30) return { class: "bg-narwhal-danger/15 text-narwhal-danger", label: `${days}d` }
  if (days < 90) return { class: "bg-narwhal-warning/15 text-narwhal-warning", label: `${days}d` }
  return { class: "bg-narwhal-success/15 text-narwhal-success", label: `${days}d` }
}

function RenewButton({ name, namespace }: { name: string; namespace: string }) {
  const t = useT()
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  const renewMutation = useMutation({
    mutationFn: () =>
      fetch("/api/settings/certs/renew", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, namespace }),
      }).then((r) => {
        if (!r.ok) throw new Error(r.statusText)
        return r.json()
      }),
    onSuccess: () => setFeedback({ ok: true, msg: t("certs.renewOk") }),
    onError: () => setFeedback({ ok: false, msg: t("certs.renewError") }),
  })

  if (feedback) {
    return (
      <Badge className={feedback.ok ? "bg-narwhal-success/15 text-narwhal-success" : "bg-narwhal-danger/15 text-narwhal-danger"}>
        {feedback.msg}
      </Badge>
    )
  }

  return (
    <button
      onClick={() => renewMutation.mutate()}
      disabled={renewMutation.isPending}
      className="text-xs px-2 py-1 rounded border border-narwhal-accent/50 text-narwhal-accent hover:bg-narwhal-accent/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {renewMutation.isPending ? t("certs.renewing") : t("certs.renew")}
    </button>
  )
}

export function CertsTable() {
  const t = useT()
  const { data: session } = useSession()
  const role = (session?.user as { role?: string })?.role ?? "guest"
  const isAdmin = role === "cluster-admin"

  const { data: certs = [], isLoading } = useQuery<Certificate[]>({
    queryKey: ["settings-certs"],
    queryFn: () => fetch("/api/settings/certs").then((r) => r.json()),
  })

  return (
    <Card className="p-5">
      <h2 className="font-semibold text-foreground mb-4">{t("certs.title")}</h2>
      {isLoading ? (
        <div className="h-32 bg-muted/50 rounded flex items-center justify-center">
          <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
        </div>
      ) : certs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("certs.empty")}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="pb-2 font-medium">{t("certs.name")}</th>
              <th className="pb-2 font-medium">{t("certs.namespace")}</th>
              <th className="pb-2 font-medium">{t("certs.dnsNames")}</th>
              <th className="pb-2 font-medium">{t("certs.issuer")}</th>
              <th className="pb-2 font-medium">{t("certs.expiry")}</th>
              <th className="pb-2 font-medium">{t("certs.status")}</th>
              {isAdmin && <th className="pb-2 font-medium">{t("certs.action")}</th>}
            </tr>
          </thead>
          <tbody>
            {certs.map((cert) => {
              const days = daysUntil(cert.notAfter)
              const badge = expiryBadge(days)
              const expiringSoon = days !== null && days >= 0 && days < 30
              return (
                <tr key={`${cert.namespace}/${cert.name}`} className="border-b last:border-0">
                  <td className="py-2.5 font-medium">
                    <span>{cert.name}</span>
                    {expiringSoon && (
                      <Badge className="ml-2 bg-narwhal-warning/15 text-narwhal-warning text-xs">
                        {t("certs.expiringSoon")}
                      </Badge>
                    )}
                  </td>
                  <td className="py-2.5 text-muted-foreground">{cert.namespace}</td>
                  <td className="py-2.5 text-muted-foreground font-mono text-xs">
                    {cert.dnsNames.length > 0 ? cert.dnsNames.join(", ") : "—"}
                  </td>
                  <td className="py-2.5 text-muted-foreground">{cert.issuer}</td>
                  <td className="py-2.5">
                    <Badge className={badge.class}>{badge.label}</Badge>
                  </td>
                  <td className="py-2.5">
                    <Badge className={cert.ready ? "bg-narwhal-success/15 text-narwhal-success" : "bg-narwhal-danger/15 text-narwhal-danger"}>
                      {cert.ready ? t("certs.ready") : t("certs.notReady")}
                    </Badge>
                  </td>
                  {isAdmin && (
                    <td className="py-2.5">
                      <RenewButton name={cert.name} namespace={cert.namespace} />
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Card>
  )
}
