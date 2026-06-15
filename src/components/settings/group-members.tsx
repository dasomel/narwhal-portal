"use client"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useT } from "@/lib/i18n-client"

export interface GroupMember {
  pk: number
  username: string
  email: string
}

export interface GroupMembersUser {
  pk: number
  username: string
  email: string
}

interface GroupMembersProps {
  groupPk: string
  groupName: string
  members: GroupMember[]
  availableUsers: GroupMembersUser[]
  selectedUser: string
  isMutating: boolean
  onSelectUser: (value: string) => void
  onAddUser: (groupPk: string, userPk: number) => void
  onRemoveUser: (groupPk: string, userPk: number) => void
}

export function GroupMembers({
  groupPk,
  groupName,
  members,
  availableUsers,
  selectedUser,
  isMutating,
  onSelectUser,
  onAddUser,
  onRemoveUser,
}: GroupMembersProps) {
  const t = useT()

  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {t("groups.memberMgmt")} — {groupName}
      </h4>

      {/* Add member */}
      <div className="flex gap-2 items-center">
        <Select value={selectedUser} onValueChange={(v) => onSelectUser(v ?? "")}>
          <SelectTrigger className="w-64 h-8 text-xs">
            <SelectValue placeholder={t("groups.selectUser")} />
          </SelectTrigger>
          <SelectContent>
            {availableUsers.map((u) => (
              <SelectItem key={u.pk} value={String(u.pk)} className="text-xs">
                {u.username} ({u.email})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          disabled={!selectedUser || isMutating}
          onClick={() => {
            if (selectedUser) onAddUser(groupPk, Number(selectedUser))
          }}
          className="h-8 text-xs"
        >
          {t("groups.addUser")}
        </Button>
      </div>

      {/* Member list */}
      {members.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("groups.noMembers")}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {members.map((m) => (
            <div
              key={m.pk}
              className="flex items-center gap-1.5 bg-card border border-border rounded-full px-2.5 py-1 text-xs"
            >
              <span className="font-medium text-foreground">{m.username}</span>
              <span className="text-muted-foreground">{m.email}</span>
              <button
                onClick={() => onRemoveUser(groupPk, m.pk)}
                className="text-red-400 hover:text-red-600 ml-0.5"
                title={t("groups.removeUser")}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
