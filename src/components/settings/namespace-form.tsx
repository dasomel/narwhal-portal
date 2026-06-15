"use client"
import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n-client"

interface Namespace {
  name: string
  team?: string
  createdAt?: string
}

const NS_REGEX = /^dev-[a-z0-9]([a-z0-9-]{0,55}[a-z0-9])?$/

export function NamespaceForm() {
  const t = useT()
  const queryClient = useQueryClient()
  const [name, setName] = useState("")
  const [team, setTeam] = useState("")
  const [validationError, setValidationError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  const { data: namespaces = [], isLoading } = useQuery<Namespace[]>({
    queryKey: ["namespaces"],
    queryFn: () => fetch("/api/namespaces").then((r) => r.json()).then((d) => Array.isArray(d) ? d : []),
  })

  const createMutation = useMutation({
    mutationFn: (payload: { name: string; team?: string }) =>
      fetch("/api/namespaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then((r) => {
        if (!r.ok) throw new Error(r.statusText)
        return r.json()
      }),
    onSuccess: () => {
      setFeedback({ ok: true, msg: t("ns.createOk") })
      setName("")
      setTeam("")
      queryClient.invalidateQueries({ queryKey: ["namespaces"] })
    },
    onError: () => setFeedback({ ok: false, msg: t("ns.createError") }),
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFeedback(null)
    if (!NS_REGEX.test(name)) {
      setValidationError(t("ns.nameError"))
      return
    }
    setValidationError(null)
    createMutation.mutate({ name, team: team.trim() || undefined })
  }

  function handleNameChange(v: string) {
    setName(v)
    if (validationError) setValidationError(null)
  }

  return (
    <Card className="p-5 space-y-6">
      <div>
        <h2 className="font-semibold text-foreground mb-4">{t("ns.create")}</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">{t("ns.nameLabel")}</label>
            <Input
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder={t("ns.namePlaceholder")}
              className="max-w-sm"
            />
            {validationError ? (
              <p className="text-xs text-red-600">{validationError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{t("ns.nameHint")}</p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">{t("ns.teamLabel")}</label>
            <Input
              value={team}
              onChange={(e) => setTeam(e.target.value)}
              placeholder={t("ns.teamPlaceholder")}
              className="max-w-sm"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={createMutation.isPending || !name}
              className="inline-flex items-center px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {createMutation.isPending ? t("ns.creating") : t("ns.submit")}
            </button>
            {feedback && (
              <Badge className={feedback.ok ? "bg-narwhal-success/15 text-narwhal-success" : "bg-narwhal-danger/15 text-narwhal-danger"}>
                {feedback.msg}
              </Badge>
            )}
          </div>
        </form>
      </div>

      <div>
        <h3 className="font-medium text-foreground mb-2">{t("ns.existing")}</h3>
        {isLoading ? (
          <p className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</p>
        ) : namespaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("ns.empty")}</p>
        ) : (
          <ul className="space-y-1.5">
            {namespaces.map((ns) => (
              <li key={ns.name} className="flex items-center gap-2 text-sm">
                <span className="font-mono text-foreground">{ns.name}</span>
                {ns.team && (
                  <Badge className="bg-blue-50 text-blue-700 text-xs">{ns.team}</Badge>
                )}
                {ns.createdAt && (
                  <span className="text-xs text-muted-foreground">{new Date(ns.createdAt).toLocaleDateString()}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}
