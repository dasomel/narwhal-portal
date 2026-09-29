import { TEMPLATES } from "@/lib/service-templates"
export type ProvisioningMode = "preview" | "apply"
export type ProvisioningStepId = "repository" | "namespace" | "argocd" | "convergence"
export type ProvisioningStepStatus = "succeeded" | "running" | "failed" | "blocked" | "skipped"
export type ProvisioningStatus = "running" | "partial" | "failed" | "succeeded"

export interface ProvisioningRequest {
  mode: ProvisioningMode
  templateId: string
  values: Record<string, string>
  team?: string
  idempotencyKey?: string
}

export interface ProvisioningValidationError {
  code: string
  message: string
  fields?: Array<{ name: string; code: string }>
}

export type ProvisioningRequestValidation =
  | { valid: true; request: ProvisioningRequest }
  | { valid: false; status: 400 | 422; error: ProvisioningValidationError }

export interface ProvisioningStepResult {
  id: ProvisioningStepId
  status: ProvisioningStepStatus
  resource?: string
  error: { code: string; message: string; retryable: boolean } | null
  retryable: boolean
  compensationRequired: boolean
}

export interface ProvisioningResult {
  operationId: string
  status: ProvisioningStatus
  retryable: boolean
  steps: ProvisioningStepResult[]
  error: { code: string; message: string; retryable: boolean } | null
}

export interface ProvisioningTemplateCatalogEntry {
  id: string
  fields: Array<{ name: string; required: boolean; options?: readonly string[] }>
}

/** Derived from the single server catalog so validation can never drift from what the route advertises. */
export const DEFAULT_TEMPLATE_CATALOG: ProvisioningTemplateCatalogEntry[] = TEMPLATES.map(({ id, fields }) => ({
  id,
  fields: fields.map(({ name, required, options }) => ({ name, required, ...(options ? { options } : {}) })),
}))
const REQUIRED_STEPS: readonly ProvisioningStepId[] = ["repository", "namespace", "argocd", "convergence"]

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const invalid = (code: string, message: string, status: 400 | 422 = 400): ProvisioningRequestValidation => ({
  valid: false,
  status,
  error: { code, message },
})

export type ResolveOwningTeam = (namespace: string, requestedTeam: string) => string | undefined

export interface ProvisioningValidationDependencies {
  catalog?: readonly ProvisioningTemplateCatalogEntry[]
  resolveOwningTeam?: ResolveOwningTeam
  /** The caller's session teams; the first is used when an apply request omits `team` (contract rule 6). */
  sessionTeams?: readonly string[]
}

/**
 * Validates request shape without mutation. This shape validator alone is NOT an authorization gate;
 * apply requests require an ownership resolver and a matching owning team.
 */
export function validateProvisioningRequest(
  input: unknown,
  dependencies: ProvisioningValidationDependencies = {},
): ProvisioningRequestValidation {
  if (!isPlainObject(input)) return invalid("INVALID_REQUEST", "Request body must be an object")

  const mode = input.mode === undefined ? "preview" : input.mode
  if (mode !== "preview" && mode !== "apply") return invalid("INVALID_MODE", "Mode must be preview or apply")
  if (typeof input.templateId !== "string" || input.templateId.trim() === "") {
    return invalid("INVALID_REQUEST", "templateId must be a non-empty string")
  }
  if (!isPlainObject(input.values)) return invalid("INVALID_REQUEST", "values must be an object")

  const template = (dependencies.catalog ?? DEFAULT_TEMPLATE_CATALOG).find(({ id }) => id === input.templateId)
  if (!template) return invalid("UNKNOWN_TEMPLATE", "Template does not exist", 422)
  const fields = Object.fromEntries(template.fields.map((field) => [field.name, field]))

  for (const key of Object.keys(input.values)) {
    if (!Object.hasOwn(fields, key)) return invalid("UNKNOWN_FIELD", `Unknown field: ${key}`, 422)
    if (typeof input.values[key] !== "string") return invalid("INVALID_FIELD_TYPE", `Field ${key} must be a string`, 422)
  }

  const values: Record<string, string> = {}
  for (const [key, definition] of Object.entries(fields)) {
    const value = input.values[key]
    if (value === undefined || value === "" || (typeof value === "string" && definition.required && value.trim() === "")) {
      if (definition.required) return invalid("REQUIRED_FIELD", `Field ${key} is required`, 422)
      continue
    }
    if (typeof value !== "string") return invalid("INVALID_FIELD_TYPE", `Field ${key} must be a string`, 422)
    if (definition.options && !definition.options.includes(value)) {
      return invalid("VALUE_NOT_ALLOWED", `Field ${key} has an unsupported value`, 422)
    }
    if (key === "namespace" && (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)$/.test(value) || !value.startsWith("dev-"))) {
      return invalid("INVALID_NAMESPACE", "Namespace must be a valid dev- DNS label", 422)
    }
    values[key] = value
  }

  if (input.team !== undefined && typeof input.team !== "string") return invalid("INVALID_REQUEST", "team must be a string")
  if (input.idempotencyKey !== undefined && typeof input.idempotencyKey !== "string") {
    return invalid("INVALID_REQUEST", "idempotencyKey must be a string")
  }
  if (mode === "apply" && (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim() === "")) {
    return invalid("INVALID_REQUEST", "Apply requires an idempotencyKey")
  }
  let team: string | undefined = typeof input.team === "string" ? input.team : undefined
  if (mode === "apply") {
    if (team === undefined || team.trim() === "") {
      team = dependencies.sessionTeams?.[0]
      if (team === undefined || team.trim() === "") return invalid("NO_TEAM", "Apply requires a team")
    }
    const namespace = values.namespace
    if (!namespace || !dependencies.resolveOwningTeam) {
      return invalid("INVALID_OWNERSHIP", "Apply requires namespace ownership resolution", 422)
    }
    let owningTeam: string | undefined
    try {
      owningTeam = dependencies.resolveOwningTeam(namespace, team)
    } catch {
      return invalid("INVALID_OWNERSHIP", "Namespace ownership could not be resolved", 422)
    }
    if (owningTeam !== team) return invalid("TEAM_MISMATCH", "Team does not own the namespace", 422)
  }

  return {
    valid: true,
    request: {
      mode,
      templateId: input.templateId,
      values,
      ...(team !== undefined ? { team } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey as string } : {}),
    },
  }
}

/** Builds the contract response and derives terminal status from recorded steps. */
export function buildProvisioningResult(
  operationId: string,
  steps: ProvisioningStepResult[],
  error: ProvisioningResult["error"] = null,
): ProvisioningResult {
  const terminal = steps.some((step) => step.status === "failed" || step.status === "blocked")
  const anySucceeded = steps.some((step) => step.status === "succeeded")
  const status: ProvisioningStatus = terminal
    ? (anySucceeded ? "partial" : "failed")
    : (REQUIRED_STEPS.every((id) => steps.some((step) => step.id === id && step.status === "succeeded")) ? "succeeded" : "running")
  return {
    operationId,
    status,
    retryable: steps.some((step) => step.retryable),
    steps,
    error,
  }
}
