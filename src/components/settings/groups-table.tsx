"use client"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Fragment, useState } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n-client"
import { PLATFORM_TOOLS } from "@/lib/tools"
import { Input } from "@/components/ui/input"
import { Search, CheckCircle2, XCircle, Save, Users, ChevronDown, ChevronUp } from "lucide-react"
import { GroupMembers } from "./group-members"
import type { GroupMember } from "./group-members"

interface GroupRole {
  pk: string
  name: string
}

interface Group {
  pk: string
  name: string
  num_pk: number
  is_superuser: boolean
  parent: string | null
  parent_name: string | null
  users: number[]
  attributes: Record<string, unknown>
  roles_obj: GroupRole[]
  members: GroupMember[]
}

interface User {
  pk: number
  username: string
  email: string
}

// Local state tracker: { [groupPk]: string[] }
type PendingMap = Record<string, string[]>

export function GroupsTable() {
  const t = useT()
  const qc = useQueryClient()
  const [search, setSearch] = useState("")
  // Track pending changes: groupPk -> new allowed_tools array
  const [pending, setPending] = useState<PendingMap>({})
  // Expand member management for a specific group
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)
  const [selectedUser, setSelectedUser] = useState<string>("")

  const { data: groups = [], isLoading } = useQuery<Group[]>({
    queryKey: ["settings-groups"],
    queryFn: async () => {
      const res = await fetch("/api/settings/groups")
      const json = await res.json()
      return Array.isArray(json) ? json : []
    },
  })

  const { data: allUsers = [] } = useQuery<User[]>({
    queryKey: ["settings-users"],
    queryFn: async () => {
      const res = await fetch("/api/settings/users")
      const json = await res.json()
      return Array.isArray(json) ? json : []
    },
  })

  const mutation = useMutation({
    mutationFn: ({
      groupPk,
      userPk,
      action,
      attributes,
    }: {
      groupPk: string
      userPk: number
      action: "add" | "remove" | "update-attributes"
      attributes?: Record<string, unknown>
    }) =>
      fetch("/api/settings/groups", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupPk, userPk, action, attributes }),
      }),
    onSuccess: (_data, { groupPk, action, attributes }) => {
      if (action === "update-attributes" && attributes) {
        qc.setQueryData(["settings-groups"], (old: Group[] | undefined) => {
          if (!old) return old
          return old.map((g) => (g.pk === groupPk ? { ...g, attributes } : g))
        })
        setPending((prev) => {
          const next = { ...prev }
          delete next[groupPk]
          return next
        })
      } else {
        qc.invalidateQueries({ queryKey: ["settings-groups"] })
        qc.invalidateQueries({ queryKey: ["settings-users"] })
      }
      setSelectedUser("")
    },
  })

  const filteredGroups = groups.filter((g) => g.name.toLowerCase().includes(search.toLowerCase()))

  function getAllowedTools(group: Group): string[] {
    if (group.pk in pending) return pending[group.pk]
    return (group.attributes.allowed_tools as string[]) ?? []
  }
  function toggleTool(group: Group, toolId: string) {
    const current = getAllowedTools(group)
    const next = current.includes(toolId) ? current.filter((id) => id !== toolId) : [...current, toolId]
    setPending((prev) => ({ ...prev, [group.pk]: next }))
  }
  function saveGroup(group: Group) {
    mutation.mutate({
      groupPk: group.pk,
      action: "update-attributes",
      attributes: { ...group.attributes, allowed_tools: getAllowedTools(group) },
      userPk: 0,
    })
  }
  function hasPending(group: Group): boolean {
    if (!(group.pk in pending)) return false
    const original = (group.attributes.allowed_tools as string[]) ?? []
    return JSON.stringify([...original].sort()) !== JSON.stringify([...pending[group.pk]].sort())
  }

  const expandedGroupData = groups.find((g) => g.pk === expandedGroup)
  const availableUsers = expandedGroupData
    ? allUsers.filter((u) => !expandedGroupData.members.some((m) => m.pk === u.pk))
    : []

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-foreground">{t("groups.title")}</h2>
        <p className="text-xs text-muted-foreground">{t("groups.checkboxHint")}</p>
      </div>

      {/* Search */}
      <div className="relative mb-4 max-w-xs">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t("groups.search")}
          className="pl-9 h-9 text-sm"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {isLoading ? (
        <div className="h-32 bg-muted/50 rounded flex items-center justify-center">
          <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
        </div>
      ) : (
        <div className="overflow-auto rounded-lg border border-border/50 shadow-sm">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-muted/50 border-b border-border">
                <th className="py-3 px-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider sticky left-0 bg-muted/50 z-20 min-w-[160px] border-r border-border">
                  {t("groups.name")}
                </th>
                <th className="py-3 px-3 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider min-w-[60px] border-r border-border/50">
                  <Users className="inline h-3.5 w-3.5" />
                </th>
                {PLATFORM_TOOLS.map((tool) => (
                  <th
                    key={tool.id}
                    className="py-3 px-3 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider min-w-[80px]"
                  >
                    <div className="flex flex-col items-center gap-1">
                      <img src={tool.icon} alt={tool.name} className="w-6 h-6 rounded" />
                      <span className="text-xs leading-tight text-center whitespace-nowrap">{tool.name}</span>
                    </div>
                  </th>
                ))}
                <th className="py-3 px-4 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wider sticky right-0 bg-muted/50 z-20 border-l border-border min-w-[70px]">
                  {t("common.save")}
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredGroups.map((group, idx) => {
                const allowedTools = getAllowedTools(group)
                const isDirty = hasPending(group)
                const isExpanded = expandedGroup === group.pk

                return (
                  <Fragment key={group.pk}>
                    <tr
                      className={`border-b border-border/50 transition-colors ${
                        isDirty ? "bg-narwhal-warning/5" : idx % 2 === 0 ? "bg-card" : "bg-muted/20"
                      } hover:bg-muted/30`}
                    >
                      {/* Group name */}
                      <td className="py-3 px-4 sticky left-0 bg-inherit z-10 border-r border-border">
                        <div className="flex flex-col">
                          <span className="font-medium text-foreground text-sm">{group.name}</span>
                          {group.is_superuser && (
                            <span className="text-xs text-narwhal-danger font-semibold">Admin</span>
                          )}
                          {isDirty && (
                            <span className="text-xs text-narwhal-warning font-medium">
                              {t("groups.unsaved")}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Member count with expand */}
                      <td className="py-3 px-3 text-center border-r border-border/50">
                        <button
                          onClick={() => setExpandedGroup(isExpanded ? null : group.pk)}
                          className="flex items-center justify-center gap-0.5 text-muted-foreground hover:text-narwhal-accent transition-colors mx-auto"
                          title={t("groups.memberMgmt")}
                        >
                          <span className="text-xs font-medium">{group.members.length}</span>
                          {isExpanded ? (
                            <ChevronUp className="h-3 w-3" />
                          ) : (
                            <ChevronDown className="h-3 w-3" />
                          )}
                        </button>
                      </td>

                      {/* Tool checkboxes */}
                      {PLATFORM_TOOLS.map((tool) => {
                        const checked = allowedTools.includes(tool.id)
                        return (
                          <td key={tool.id} className="py-3 px-3 text-center">
                            <button
                              onClick={() => toggleTool(group, tool.id)}
                              className={`inline-flex items-center justify-center w-7 h-7 rounded-full transition-all hover:scale-110 ${
                                checked
                                  ? "text-narwhal-accent hover:text-narwhal-accent/80"
                                  : "text-muted-foreground/30 hover:text-muted-foreground"
                              }`}
                              title={`${group.name} / ${tool.name}`}
                            >
                              {checked ? (
                                <CheckCircle2 className="w-5 h-5 fill-narwhal-accent/10" />
                              ) : (
                                <XCircle className="w-5 h-5" />
                              )}
                            </button>
                          </td>
                        )
                      })}

                      {/* Save button */}
                      <td className="py-3 px-4 text-center sticky right-0 bg-inherit z-10 border-l border-border">
                        {isDirty ? (
                          <Button
                            size="sm"
                            disabled={mutation.isPending}
                            onClick={() => saveGroup(group)}
                            className="h-7 text-xs bg-narwhal-accent hover:bg-narwhal-accent/80 text-white px-2"
                          >
                            <Save className="w-3 h-3 mr-1" />
                            {t("common.save")}
                          </Button>
                        ) : (
                          <span className="text-muted-foreground/30 text-xs">—</span>
                        )}
                      </td>
                    </tr>

                    {/* Expanded member management row */}
                    {isExpanded && (
                      <tr key={`${group.pk}-members`} className="bg-narwhal-accent/5 border-b border-narwhal-accent/20">
                        <td colSpan={PLATFORM_TOOLS.length + 3} className="py-3 px-4">
                          <GroupMembers
                            groupPk={group.pk}
                            groupName={group.name}
                            members={group.members}
                            availableUsers={availableUsers}
                            selectedUser={selectedUser}
                            isMutating={mutation.isPending}
                            onSelectUser={setSelectedUser}
                            onAddUser={(gPk, uPk) =>
                              mutation.mutate({ groupPk: gPk, userPk: uPk, action: "add" })
                            }
                            onRemoveUser={(gPk, uPk) =>
                              mutation.mutate({ groupPk: gPk, userPk: uPk, action: "remove" })
                            }
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
              {filteredGroups.length === 0 && (
                <tr>
                  <td colSpan={PLATFORM_TOOLS.length + 3} className="py-12 text-center text-muted-foreground italic text-sm">
                    {t("groups.noResults")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
