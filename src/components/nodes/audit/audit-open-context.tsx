"use client"

import * as React from "react"

// Default-open accordion items (single source of truth for initial state)
export const DEFAULT_OPEN_ITEMS = new Set([
  // NodeTuningSection
  "kernel-params",
  // K8sTuningSection
  "cluster-version",
  "cni-plugin",
])

interface AuditOpenContextValue {
  openItems: Set<string>
  filterActive: boolean
  toggleItem: (id: string, open: boolean) => void
  /** Replace open set with exactly actionIds and mark filter active. */
  activateFilter: (actionIds: Set<string>) => void
  /** Reset to defaults and clear filter. */
  resetFilter: () => void
}

export const AuditOpenContext = React.createContext<AuditOpenContextValue>({
  openItems: new Set(DEFAULT_OPEN_ITEMS),
  filterActive: false,
  toggleItem: () => {},
  activateFilter: () => {},
  resetFilter: () => {},
})

export function AuditOpenProvider({ children }: { children: React.ReactNode }) {
  const [openItems, setOpenItems] = React.useState<Set<string>>(new Set(DEFAULT_OPEN_ITEMS))
  const [filterActive, setFilterActive] = React.useState(false)

  const toggleItem = React.useCallback((id: string, open: boolean) => {
    setOpenItems(prev => {
      const next = new Set(prev)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const activateFilter = React.useCallback((actionIds: Set<string>) => {
    // Replace: show ONLY action-needed items, close everything else
    setOpenItems(new Set(actionIds))
    setFilterActive(true)
  }, [])

  const resetFilter = React.useCallback(() => {
    setOpenItems(new Set(DEFAULT_OPEN_ITEMS))
    setFilterActive(false)
  }, [])

  return (
    <AuditOpenContext.Provider value={{ openItems, filterActive, toggleItem, activateFilter, resetFilter }}>
      {children}
    </AuditOpenContext.Provider>
  )
}

export function useAuditOpen() {
  return React.useContext(AuditOpenContext)
}
