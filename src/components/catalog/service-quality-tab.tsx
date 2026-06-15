"use client"
// TODO(wrap-up): i18n keys for ko/en — see spec §5.7

import { useQuery } from "@tanstack/react-query"
import { useT, useLocale } from "@/lib/i18n-client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import type { ScorecardDetailResponse } from "@/app/api/scorecards/[svc]/route"
import type { ScorecardRulesResponse } from "@/app/api/scorecards/rules/route"

// ---------------------------------------------------------------------------
// Tier display helpers
// ---------------------------------------------------------------------------

const TIER_COLORS: Record<string, string> = {
  gold: "bg-yellow-100 text-yellow-800 border-yellow-300",
  silver: "bg-gray-100 text-gray-700 border-gray-300",
  bronze: "bg-orange-100 text-orange-700 border-orange-300",
  none: "bg-muted text-muted-foreground border-border",
}

const TIER_ICONS: Record<string, string> = {
  gold: "🥇",
  silver: "🥈",
  bronze: "🥉",
  none: "—",
}

// ---------------------------------------------------------------------------
// Rules modal
// ---------------------------------------------------------------------------

function RulesModal() {
  const t = useT()
  const { data, isLoading } = useQuery<ScorecardRulesResponse>({
    queryKey: ["scorecard-rules"],
    queryFn: () => fetch("/api/scorecards/rules").then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  })

  return (
    <Dialog>
      <DialogTrigger className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2">
        {t("scorecard.viewRules")}
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("scorecard.rulesTitle")}</DialogTitle>
        </DialogHeader>
        {isLoading && (
          <p className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</p>
        )}
        {data?.rawYaml && (
          <pre className="text-xs bg-muted p-4 rounded overflow-x-auto whitespace-pre-wrap">
            {data.rawYaml}
          </pre>
        )}
        {data && !data.rawYaml && (
          <div className="space-y-2">
            {(data.rules as Array<{ id: string; name: string; weight: number }>).map((r) => (
              <div key={r.id} className="flex justify-between text-sm border-b pb-1">
                <span>{r.name}</span>
                <span className="text-muted-foreground">{r.weight}pt</span>
              </div>
            ))}
          </div>
        )}
        {!isLoading && !data && (
          <p className="text-sm text-destructive">{t("scorecard.noConfigMap")}</p>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface ServiceQualityTabProps {
  serviceName: string
}

export function ServiceQualityTab({ serviceName }: ServiceQualityTabProps) {
  const t = useT()
  const locale = useLocale()
  const { data, isLoading, error } = useQuery<ScorecardDetailResponse>({
    queryKey: ["scorecard-detail", serviceName],
    queryFn: () => fetch(`/api/scorecards/${encodeURIComponent(serviceName)}`).then((r) => r.json()),
    staleTime: 5 * 60 * 1000,
  })

  if (isLoading) {
    return (
      <div className="h-40 flex items-center justify-center">
        <span className="text-sm text-muted-foreground animate-pulse">{t("scorecard.evaluating")}</span>
      </div>
    )
  }

  if (error || (data && "error" in data)) {
    const errData = data as { error?: string; message?: string } | undefined
    const isConfigMapMissing = errData?.message?.includes("ConfigMap")
    return (
      <Card className="border-destructive/50">
        <CardContent className="pt-4">
          <p className="text-sm text-destructive">
            {isConfigMapMissing
              ? t("scorecard.rulesMissing")
              : (errData?.message ?? t("scorecard.loadError"))}
          </p>
        </CardContent>
      </Card>
    )
  }

  if (!data) return null

  const passed = data.rules.filter((r) => r.status === "pass")
  const failed = data.rules.filter((r) => r.status === "fail")

  return (
    <div className="space-y-4">
      {/* Score header card */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-4">
            <span className="text-4xl">{TIER_ICONS[data.tier]}</span>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-3xl font-bold">{data.score}</span>
                <span className="text-muted-foreground">/100</span>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-sm font-medium border ${TIER_COLORS[data.tier] ?? TIER_COLORS.none}`}
                >
                  {data.tier.charAt(0).toUpperCase() + data.tier.slice(1)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {t("scorecard.evaluatedAt", { date: new Date(data.evaluatedAt).toLocaleString(locale === "ko" ? "ko-KR" : "en-US") })}
                {data.service.owner && ` · Owner: ${data.service.owner}`}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Passed rules */}
      {passed.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-green-700">
              {t("scorecard.passedRules", { count: passed.length })}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-1">
            {passed.map((rule) => (
              <div key={rule.id} className="flex items-center justify-between py-1 border-b last:border-0">
                <div className="flex items-center gap-2">
                  <span className="text-green-600">✓</span>
                  <span className="text-sm">{rule.name}</span>
                </div>
                <Badge variant="outline" className="text-xs text-muted-foreground">
                  +{rule.weight}pt
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Failed rules */}
      {failed.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-destructive">
              {t("scorecard.failedRules", { count: failed.length })}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-2">
            {failed.map((rule) => (
              <div key={rule.id} className="py-2 border-b last:border-0">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-destructive">✗</span>
                    <span className="text-sm font-medium">{rule.name}</span>
                  </div>
                  <Badge variant="outline" className="text-xs text-muted-foreground">
                    {rule.weight}pt
                  </Badge>
                </div>
                {rule.failReason && (
                  <p className="text-xs text-muted-foreground mt-1 ml-5">{rule.failReason}</p>
                )}
                {rule.actionUrl && (
                  <div className="mt-1 ml-5">
                    <a
                      href={rule.actionUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-600 hover:underline"
                    >
                      {t("scorecard.takeAction")}
                    </a>
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Rules definition link */}
      <div className="flex justify-end">
        <RulesModal />
      </div>
    </div>
  )
}
