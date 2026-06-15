"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight, Copy, Check, ExternalLink, Terminal, Loader2, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useT } from "@/lib/i18n-client"
import type { ApplyTarget } from "@/lib/tuning-commands"
import { useTuningApply } from "@/hooks/use-tuning-apply"

export interface ConfigHint {
  location: string
  command?: string
  docLink?: string
  autoApply: "node-ssh" | "kubectl" | "manual"
}

interface ConfigHintRowProps {
  hint: ConfigHint
  /** 자동 적용 대상. 없으면 버튼 비활성 (legacy 항목). */
  applyTarget?: ApplyTarget
  /** 자동 적용 실행 노드 이름. 없으면 버튼 비활성. */
  nodeName?: string
  /** 사용자 역할. cluster-admin이 아니면 비활성. */
  userRole?: string
  /** 적용 성공 후 부모에서 데이터 재조회. */
  onApplied?: () => void
}

export function ConfigHintRow({
  hint, applyTarget, nodeName, userRole, onApplied,
}: ConfigHintRowProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [showLogs, setShowLogs] = useState(false)

  const apply = useTuningApply(nodeName ?? "")

  const isAdmin = userRole === "cluster-admin"
  const canAutoApply =
    hint.autoApply === "node-ssh" && !!applyTarget && !!nodeName && isAdmin

  function handleCopy() {
    if (!hint.command) return
    navigator.clipboard.writeText(hint.command).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  function handleApply() {
    if (!canAutoApply || !applyTarget) return
    const msg = t("nodes.audit.autoApply.confirm.body", { node: nodeName ?? "" })
    if (!window.confirm(msg)) return
    apply.mutate([applyTarget], {
      onSuccess: (res) => {
        if (res.ok) onApplied?.()
        setShowLogs(true)
      },
    })
  }

  const autoApplyBadge = () => {
    if (hint.autoApply === "kubectl") {
      return (
        <Badge
          variant="outline"
          className="text-[9px] font-black uppercase px-1.5 h-4 leading-none text-narwhal-success border-narwhal-success/30 bg-narwhal-success/15"
        >
          <Terminal className="w-2.5 h-2.5 mr-1 inline-block" />
          {t("nodes.audit.configHint.autoApply.kubectl")}
        </Badge>
      )
    }
    if (hint.autoApply === "node-ssh") {
      return (
        <Badge
          variant="outline"
          className="text-[9px] font-black uppercase px-1.5 h-4 leading-none text-narwhal-warning border-narwhal-warning/30 bg-narwhal-warning/15"
        >
          {t("nodes.audit.configHint.autoApply.nodeSsh")}
        </Badge>
      )
    }
    return (
      <Badge
        variant="outline"
        className="text-[9px] font-black uppercase px-1.5 h-4 leading-none text-muted-foreground bg-muted"
      >
        {t("nodes.audit.configHint.autoApply.manual")}
      </Badge>
    )
  }

  const autoApplyButton = () => {
    if (hint.autoApply === "manual") return null

    const isKubectl = hint.autoApply === "kubectl"
    const isPending = apply.isPending
    const lastResult = apply.data
    const succeeded = lastResult?.ok === true
    const failed = lastResult && !lastResult.ok

    let tooltip: string
    if (!isAdmin) tooltip = t("nodes.audit.autoApply.tooltip.disabled")
    else if (isKubectl) tooltip = t("nodes.audit.autoApply.tooltip.kubectl")
    else if (!applyTarget) tooltip = t("nodes.audit.autoApply.tooltip.unsupported")
    else tooltip = t("nodes.audit.autoApply.tooltip.nodeSsh")

    const disabled = !canAutoApply || isPending
    const label = isPending
      ? t("nodes.audit.autoApply.applying")
      : succeeded
      ? t("nodes.audit.autoApply.success")
      : failed
      ? t("nodes.audit.autoApply.failed")
      : t("nodes.audit.configHint.autoApply")

    const colorClass = succeeded
      ? "border-narwhal-success/40 text-narwhal-success bg-narwhal-success/10"
      : failed
      ? "border-narwhal-danger/40 text-narwhal-danger bg-narwhal-danger/10"
      : isKubectl
      ? "border-narwhal-success/40 text-narwhal-success bg-narwhal-success/10"
      : "border-narwhal-warning/40 text-narwhal-warning bg-narwhal-warning/10"

    return (
      <button
        type="button"
        disabled={disabled}
        onClick={handleApply}
        title={tooltip}
        className={`text-[9px] font-black uppercase px-2 h-5 rounded border leading-none transition-all inline-flex items-center gap-1 ${colorClass} ${
          disabled ? "cursor-not-allowed opacity-60" : "hover:brightness-110 cursor-pointer"
        }`}
      >
        {isPending && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
        {label}
      </button>
    )
  }

  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors font-bold"
        type="button"
      >
        {open ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
        {t("nodes.audit.configHint")}
      </button>

      {open && (
        <div className="mt-1.5 ml-4 rounded-lg bg-muted/30 border border-border/60 px-3 py-2.5 space-y-2 text-xs">
          {/* Location */}
          <div className="flex items-start gap-2">
            <span className="text-muted-foreground font-bold shrink-0 w-16">
              {t("nodes.audit.configHint.location")}
            </span>
            <code className="font-mono text-narwhal-accent bg-narwhal-accent-soft px-1.5 py-0.5 rounded text-xs leading-tight break-all">
              {hint.location}
            </code>
          </div>

          {/* Command */}
          {hint.command && (
            <div className="flex items-start gap-2">
              <span className="text-muted-foreground font-bold shrink-0 w-16">
                {t("nodes.audit.configHint.command")}
              </span>
              <div className="flex items-center gap-1.5 flex-1 min-w-0">
                <code className="font-mono text-foreground bg-muted px-1.5 py-0.5 rounded text-xs leading-tight break-all flex-1">
                  {hint.command}
                </code>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={handleCopy}
                    type="button"
                    title={t("nodes.audit.configHint.copy")}
                    className="p-0.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                  >
                    {copied ? (
                      <Check className="w-3.5 h-3.5 text-narwhal-success" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                  {copied && (
                    <span className="text-[9px] text-narwhal-success font-bold">
                      {t("nodes.audit.configHint.copied")}
                    </span>
                  )}
                  {autoApplyButton()}
                </div>
              </div>
            </div>
          )}

          {/* Auto-apply badge */}
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground font-bold shrink-0 w-16">
              {t("nodes.audit.configHint.autoApply")}
            </span>
            {autoApplyBadge()}
          </div>

          {/* Apply result logs */}
          {apply.data && showLogs && (
            <div className="flex items-start gap-2">
              <span className="text-muted-foreground font-bold shrink-0 w-16">
                {t("nodes.audit.autoApply.viewLogs")}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <span className={`text-[9px] font-black uppercase ${apply.data.ok ? "text-narwhal-success" : "text-narwhal-danger"}`}>
                    {apply.data.ok ? t("nodes.audit.autoApply.success") : t("nodes.audit.autoApply.failed")}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowLogs(false)}
                    className="text-muted-foreground hover:text-foreground"
                    title="close"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <pre className="font-mono text-xs bg-muted text-foreground rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">
                  {apply.data.logs || apply.data.error || "(no output)"}
                </pre>
              </div>
            </div>
          )}

          {/* Doc link */}
          {hint.docLink && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground font-bold shrink-0 w-16" />
              <a
                href={hint.docLink}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-black text-blue-600 inline-flex items-center gap-1 hover:underline underline-offset-4"
              >
                <ExternalLink className="w-2.5 h-2.5" />
                {t("nodes.audit.configHint.runbook")}
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
