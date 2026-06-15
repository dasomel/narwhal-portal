"use client"
import { useQuery, useMutation } from "@tanstack/react-query"
import { useState } from "react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { useT } from "@/lib/i18n-client"

interface TemplateField {
  name: string
  label: string
  type: "text" | "select"
  options?: string[]
  required: boolean
}

interface ServiceTemplate {
  id: string
  name: string
  description: string
  stack: string[]
  fields: TemplateField[]
}

interface PreviewResult {
  success: boolean
  preview: {
    templateId: string
    values: Record<string, string>
    willCreate: string[]
  }
}

export function TemplateList() {
  const t = useT()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [fieldValues, setFieldValues] = useState<Record<string, Record<string, string>>>({})
  const [preview, setPreview] = useState<PreviewResult | null>(null)

  const { data: templates = [], isLoading } = useQuery<ServiceTemplate[]>({
    queryKey: ["templates"],
    queryFn: () => fetch("/api/templates").then((r) => r.json()),
    refetchInterval: 30_000,
  })

  const submitMutation = useMutation({
    mutationFn: async ({ templateId, values }: { templateId: string; values: Record<string, string> }) => {
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId, values }),
      })
      return res.json() as Promise<PreviewResult>
    },
    onSuccess: (data) => setPreview(data),
  })

  function setField(templateId: string, name: string, value: string) {
    setFieldValues((prev) => ({
      ...prev,
      [templateId]: { ...(prev[templateId] ?? {}), [name]: value },
    }))
  }

  function handleSubmit(template: ServiceTemplate) {
    const values = fieldValues[template.id] ?? {}
    submitMutation.mutate({ templateId: template.id, values })
  }

  if (isLoading) {
    return (
      <div className="h-32 bg-muted/50 rounded flex items-center justify-center">
        <span className="text-sm text-muted-foreground animate-pulse">{t("common.loading")}</span>
      </div>
    )
  }

  if (templates.length === 0) {
    return (
      <div className="h-32 bg-muted/50 rounded flex items-center justify-center">
        <span className="text-sm text-muted-foreground">{t("templates.empty")}</span>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {preview && (
        <Card className="p-4 border-narwhal-success/30 bg-narwhal-success/10">
          <h3 className="font-semibold text-narwhal-success text-sm mb-2">{t("templates.successTitle")}</h3>
          <ul className="space-y-1">
            {preview.preview.willCreate.map((item, i) => (
              <li key={i} className="text-xs text-narwhal-success font-mono">{item}</li>
            ))}
          </ul>
          <button
            onClick={() => setPreview(null)}
            className="mt-3 text-xs text-narwhal-success underline"
          >
            {t("templates.collapse")}
          </button>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {templates.map((template) => {
          const isOpen = expanded === template.id
          const values = fieldValues[template.id] ?? {}

          return (
            <Card key={template.id} className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-foreground">{template.name}</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">{template.description}</p>
                  <div className="flex gap-1 flex-wrap mt-2">
                    {template.stack.map((s) => (
                      <Badge key={s} className="bg-muted text-muted-foreground text-xs">
                        {s}
                      </Badge>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => {
                    setExpanded(isOpen ? null : template.id)
                    setPreview(null)
                  }}
                  className="shrink-0 text-xs px-3 py-1.5 rounded border border-border text-muted-foreground hover:bg-muted transition-colors"
                >
                  {isOpen ? t("templates.collapse") : t("templates.configure")}
                </button>
              </div>

              {isOpen && (
                <div className="mt-4 space-y-3 border-t pt-4">
                  {template.fields.map((field) => (
                    <div key={field.name}>
                      <label className="block text-xs font-medium text-foreground mb-1">
                        {field.label}
                        {field.required && (
                          <span className="ml-1 text-narwhal-danger">*</span>
                        )}
                      </label>
                      {field.type === "select" ? (
                        <select
                          value={values[field.name] ?? ""}
                          onChange={(e) => setField(template.id, field.name, e.target.value)}
                          className="w-full text-xs border border-border rounded px-2 py-1.5 text-foreground bg-background focus:outline-none focus:ring-1 focus:ring-gray-300"
                        >
                          <option value="">—</option>
                          {field.options?.map((opt) => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                      ) : (
                        <Input
                          value={values[field.name] ?? ""}
                          onChange={(e) => setField(template.id, field.name, e.target.value)}
                          className="h-8 text-xs"
                          placeholder={field.label}
                        />
                      )}
                    </div>
                  ))}
                  <button
                    onClick={() => handleSubmit(template)}
                    disabled={submitMutation.isPending}
                    className="w-full mt-2 py-2 px-4 bg-foreground text-background text-xs font-medium rounded hover:bg-foreground/90 disabled:opacity-50 transition-colors"
                  >
                    {submitMutation.isPending ? t("templates.submitting") : t("templates.submit")}
                  </button>

                  {submitMutation.isSuccess && preview && (
                    <div className="mt-3 p-3 bg-muted/50 rounded">
                      <p className="text-xs font-medium text-foreground mb-2">{t("templates.preview")}</p>
                      <ul className="space-y-1">
                        {preview.preview.willCreate.map((item, i) => (
                          <li key={i} className="text-xs text-muted-foreground font-mono">{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </Card>
          )
        })}
      </div>
    </div>
  )
}
