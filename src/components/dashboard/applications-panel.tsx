import { ArgoCDAppsTable } from "./argocd-apps-table"

export function ApplicationsPanel() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold tracking-widest text-text-muted uppercase">
          ◇ Applications
        </span>
      </div>
      <ArgoCDAppsTable />
      {/* RecentDeploys — Phase B placeholder */}
      <div
        className="rounded-lg border px-4 py-6 text-center text-[12px] text-text-muted"
        style={{ borderStyle: "dashed" }}
      >
        Recent Deploys — coming in Phase B
      </div>
    </div>
  )
}
