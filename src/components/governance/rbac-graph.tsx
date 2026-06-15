"use client"
import { useMemo } from "react"
import { useT } from "@/lib/i18n-client"

interface RbacBinding {
  name: string
  namespace: string | null
  scope: "cluster" | "namespace"
  roleRef: { kind: string; name: string }
  subjects: Array<{ kind: string; name: string; namespace?: string }>
}

const KIND_STYLE: Record<string, { bg: string; border: string; text: string; abbr: string }> = {
  User:           { bg: "var(--narwhal-accent-light, oklch(0.95 0.03 250))", border: "var(--narwhal-accent)", text: "var(--narwhal-accent)", abbr: "U" },
  Group:          { bg: "var(--narwhal-success-light, oklch(0.95 0.05 145))", border: "var(--narwhal-success)", text: "var(--narwhal-success)", abbr: "G" },
  ServiceAccount: { bg: "var(--narwhal-warning-light, oklch(0.97 0.03 60))", border: "var(--narwhal-warning)", text: "var(--narwhal-warning)", abbr: "S" },
}

const ROLE_STYLE: Record<string, { bg: string; text: string }> = {
  ClusterRole: { bg: "var(--purple-light, oklch(0.95 0.04 300))", text: "var(--purple-600, oklch(0.5 0.15 300))" },
  Role:        { bg: "var(--narwhal-accent-light, oklch(0.95 0.03 220))", text: "var(--narwhal-accent)" },
}

const MAX_SUBJECTS = 40
const MAX_ROLES = 30

function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

export function RbacGraph({ bindings }: { bindings: RbacBinding[] }) {
  const t = useT()
  const { subjects, roles, matrix, truncated } = useMemo(() => {
    const subjectMap = new Map<string, { kind: string; name: string }>()
    const roleMap = new Map<string, { kind: string; name: string }>()

    for (const b of bindings) {
      for (const s of b.subjects) {
        const k = `${s.kind}::${s.name}`
        if (!subjectMap.has(k)) subjectMap.set(k, { kind: s.kind, name: s.name })
      }
      const rk = `${b.roleRef.kind}::${b.roleRef.name}`
      if (!roleMap.has(rk)) roleMap.set(rk, b.roleRef)
    }

    const truncated = subjectMap.size > MAX_SUBJECTS || roleMap.size > MAX_ROLES
    const subjects = [...subjectMap.entries()].slice(0, MAX_SUBJECTS).map(([key, v]) => ({ key, ...v }))
    const roles    = [...roleMap.entries()].slice(0, MAX_ROLES).map(([key, v]) => ({ key, ...v }))

    const subjectKeys = new Set(subjects.map((s) => s.key))
    const roleKeys    = new Set(roles.map((r) => r.key))

    const matrix = new Set<string>()
    for (const b of bindings) {
      const rk = `${b.roleRef.kind}::${b.roleRef.name}`
      if (!roleKeys.has(rk)) continue
      for (const s of b.subjects) {
        const sk = `${s.kind}::${s.name}`
        if (subjectKeys.has(sk)) matrix.add(`${sk}||${rk}`)
      }
    }

    return { subjects, roles, matrix, truncated }
  }, [bindings])

  if (bindings.length === 0) {
    return (
      <div className="h-32 bg-muted/50 rounded flex items-center justify-center">
        <span className="text-sm text-muted-foreground">{t("common.notFound")}</span>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/* 범례 */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="font-medium">Subject:</span>
        {Object.entries(KIND_STYLE).map(([kind, s]) => (
          <span key={kind} className="flex items-center gap-1">
            <span
              className="inline-flex items-center justify-center w-4 h-4 rounded text-xs font-bold border"
              style={{ background: s.bg, borderColor: s.border, color: s.text }}
            >
              {s.abbr}
            </span>
            {kind}
          </span>
        ))}
        <span className="w-px h-3 bg-muted mx-1" />
        <span className="font-medium">Role:</span>
        {Object.entries(ROLE_STYLE).map(([kind, s]) => (
          <span key={kind} className="flex items-center gap-1">
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm border"
              style={{ background: s.bg, borderColor: s.text }}
            />
            {kind}
          </span>
        ))}
        {truncated && (
          <span className="ml-auto text-narwhal-warning bg-narwhal-warning/10 px-2 py-0.5 rounded">
            {t("rbac.graph.truncated", { maxSubjects: MAX_SUBJECTS, maxRoles: MAX_ROLES })}
          </span>
        )}
      </div>

      {/* Matrix */}
      <div className="overflow-auto border border-border rounded" style={{ maxHeight: 520 }}>
        <table className="border-collapse text-xs" style={{ tableLayout: "fixed" }}>
          <thead>
            <tr>
              {/* 좌상단 빈 셀 */}
              <th
                className="sticky left-0 top-0 z-20 bg-card border-b border-r border-border"
                style={{ width: 200, minWidth: 200 }}
              />
              {roles.map((role) => {
                const rs = ROLE_STYLE[role.kind] ?? { bg: "var(--muted)", text: "var(--foreground)" }
                return (
                  <th
                    key={role.key}
                    className="sticky top-0 z-10 bg-card border-b border-r border-border align-bottom pb-1"
                    style={{ width: 32, minWidth: 32, height: 120 }}
                    title={`${role.kind}: ${role.name}`}
                  >
                    <div
                      className="flex items-center"
                      style={{
                        writingMode: "vertical-rl",
                        transform: "rotate(180deg)",
                        height: 112,
                        paddingLeft: 4,
                      }}
                    >
                      <span
                        className="inline-block px-1 py-0.5 rounded text-xs font-medium leading-tight"
                        style={{ background: rs.bg, color: rs.text, maxHeight: 108, overflow: "hidden" }}
                      >
                        {truncate(role.name, 24)}
                      </span>
                    </div>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {subjects.map((subject, i) => {
              const ks = KIND_STYLE[subject.kind] ?? { bg: "var(--muted)", border: "var(--muted-foreground)", text: "var(--foreground)", abbr: "?" }
              return (
                <tr key={subject.key} className={i % 2 === 0 ? "bg-card" : "bg-muted/30"}>
                  {/* Subject 행 헤더 */}
                  <td
                    className="sticky left-0 z-10 border-b border-r border-border px-2 py-1 font-mono"
                    style={{
                      background: i % 2 === 0 ? "var(--card)" : "var(--muted/30)",
                      width: 200,
                      minWidth: 200,
                    }}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded border text-xs font-bold"
                        style={{ background: ks.bg, borderColor: ks.border, color: ks.text }}
                      >
                        {ks.abbr}
                      </span>
                      <span className="truncate text-foreground" title={subject.name}>
                        {truncate(subject.name, 22)}
                      </span>
                    </div>
                  </td>
                  {/* 매트릭스 셀 */}
                  {roles.map((role) => {
                    const has = matrix.has(`${subject.key}||${role.key}`)
                    const rs = ROLE_STYLE[role.kind] ?? { bg: "var(--muted)", text: "var(--foreground)" }
                    return (
                      <td
                        key={role.key}
                        className="border-b border-r border-border/50 text-center"
                        style={{ width: 32, minWidth: 32, height: 28 }}
                        title={has ? `${subject.name} → ${role.name}` : undefined}
                      >
                        {has && (
                          <span
                            className="inline-block w-3 h-3 rounded-sm"
                            style={{ background: rs.text, opacity: 0.7 }}
                          />
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
