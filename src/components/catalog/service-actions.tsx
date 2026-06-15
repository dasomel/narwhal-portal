"use client"
import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { useSession } from "next-auth/react"
import { useT } from "@/lib/i18n-client"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

interface HistoryEntry {
  id: number
  revision: string
  deployedAt: string
}

interface ServiceActionsProps {
  name: string
  history?: HistoryEntry[]
}

export function ServiceActions({ name, history = [] }: ServiceActionsProps) {
  const t = useT()
  const { data: session } = useSession()
  const role = (session?.user as { role?: string })?.role ?? "guest"
  const canSync = role === "cluster-admin" || role === "developer"
  const canRollback = role === "cluster-admin"

  const [selectedId, setSelectedId] = useState<number | "">("")
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null)
  const [syncDialogOpen, setSyncDialogOpen] = useState(false)
  const [rollbackDialogOpen, setRollbackDialogOpen] = useState(false)

  const syncMutation = useMutation({
    mutationFn: () =>
      fetch(`/api/catalog/${encodeURIComponent(name)}/sync`, { method: "POST" }).then((r) => {
        if (!r.ok) throw new Error(r.statusText)
        return r.json()
      }),
    onSuccess: () => setFeedback({ ok: true, msg: t("svcAction.syncOk") }),
    onError: () => setFeedback({ ok: false, msg: t("svcAction.error") }),
  })

  const rollbackMutation = useMutation({
    mutationFn: (historyId: number) =>
      fetch(`/api/catalog/${encodeURIComponent(name)}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ historyId }),
      }).then((r) => {
        if (!r.ok) throw new Error(r.statusText)
        return r.json()
      }),
    onSuccess: () => setFeedback({ ok: true, msg: t("svcAction.rollbackOk") }),
    onError: () => setFeedback({ ok: false, msg: t("svcAction.error") }),
  })

  function handleSync() {
    setSyncDialogOpen(true)
  }

  function handleRollback() {
    if (selectedId === "") return
    const entry = history.find((h) => h.id === selectedId)
    if (!entry) return
    setRollbackDialogOpen(true)
  }

  function confirmSync() {
    setSyncDialogOpen(false)
    setFeedback(null)
    syncMutation.mutate()
  }

  function confirmRollback() {
    setRollbackDialogOpen(false)
    setFeedback(null)
    if (selectedId !== "") {
      rollbackMutation.mutate(selectedId)
    }
  }

  const isBusy = syncMutation.isPending || rollbackMutation.isPending
  const rollbackEntry = history.find((h) => h.id === selectedId)

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {canSync && (
          <button
            onClick={handleSync}
            disabled={isBusy}
            className="inline-flex items-center px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {syncMutation.isPending ? "..." : t("svcAction.sync")}
          </button>
        )}

        {canRollback && history.length > 0 && (
          <div className="flex items-center gap-2">
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value === "" ? "" : Number(e.target.value))}
              className="text-sm border border-border rounded-md px-2 py-1.5 bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">{t("svcAction.selectRevision")}</option>
              {history.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.revision} — {new Date(h.deployedAt).toLocaleDateString()}
                </option>
              ))}
            </select>
            <button
              onClick={handleRollback}
              disabled={isBusy || selectedId === ""}
              className="inline-flex items-center px-3 py-1.5 rounded-md bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {rollbackMutation.isPending ? "..." : t("svcAction.rollback")}
            </button>
          </div>
        )}

        {feedback && (
          <Badge className={feedback.ok ? "bg-narwhal-success/15 text-narwhal-success" : "bg-narwhal-danger/15 text-narwhal-danger"}>
            {feedback.msg}
          </Badge>
        )}
      </div>

      {/* Sync confirm dialog */}
      <AlertDialog open={syncDialogOpen} onOpenChange={setSyncDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("svcAction.sync")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("svcAction.confirmSync", { name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmSync}>{t("svcAction.sync")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rollback confirm dialog */}
      <AlertDialog open={rollbackDialogOpen} onOpenChange={setRollbackDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("svcAction.rollback")}</AlertDialogTitle>
            <AlertDialogDescription>
              {rollbackEntry
                ? t("svcAction.confirmRollback", { name, revision: rollbackEntry.revision })
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRollback}>{t("svcAction.rollback")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
