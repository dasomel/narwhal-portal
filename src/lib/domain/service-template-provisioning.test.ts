import { describe, expect, it, vi } from "vitest"

vi.mock("next/server", () => ({ NextResponse: { json: vi.fn() } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(), requireRole: vi.fn() }))
import { TEMPLATES } from "@/lib/service-templates"
import { buildProvisioningResult, DEFAULT_TEMPLATE_CATALOG, validateProvisioningRequest, type ProvisioningStepResult } from "./service-template-provisioning"

const validValues = { serviceName: "orders", namespace: "dev-orders", replicas: "2" }
const validate = (overrides: Record<string, unknown> = {}) => validateProvisioningRequest({
  templateId: "nextjs-web",
  values: validValues,
  ...overrides,
}, { resolveOwningTeam: (namespace, team) => namespace === `dev-${team}` ? team : undefined })

describe("validateProvisioningRequest", () => {
  it("accepts a valid preview and defaults omitted mode to preview", () => {
    expect(validate()).toEqual({ valid: true, request: { mode: "preview", templateId: "nextjs-web", values: validValues } })
  })

  it("accepts an apply request with its required idempotency key", () => {
    expect(validate({ mode: "apply", team: "orders", idempotencyKey: "req-1" })).toMatchObject({
      valid: true,
      request: { mode: "apply", idempotencyKey: "req-1" },
    })
  })

  it("derives the default validator catalog, including required flags, from the route catalog", () => {
    expect(DEFAULT_TEMPLATE_CATALOG.map(({ id, fields }) => ({ id, fields }))).toEqual(TEMPLATES.map(({ id, fields }) => ({
      id,
      fields: fields.map(({ name, required, options }) => ({ name, required, ...(options ? { options } : {}) })),
    })))
  })

  it("rejects a preview that omits any field the route catalog marks required", () => {
    const sample: Record<string, string> = { serviceName: "orders", namespace: "dev-orders", replicas: "2", runtime: "go", schedule: "*/5 * * * *", database: "none" }
    for (const template of TEMPLATES) {
      for (const field of template.fields.filter((candidate) => candidate.required)) {
        const values = Object.fromEntries(template.fields.filter((candidate) => candidate.name !== field.name).map((candidate) => [candidate.name, sample[candidate.name]]))
        expect(validateProvisioningRequest({ templateId: template.id, values })).toMatchObject({
          valid: false,
          status: 422,
          error: { code: "REQUIRED_FIELD" },
        })
      }
    }
  })

  it("uses the first session team when apply omits team, and rejects when there is none", () => {
    const resolveOwningTeam = (namespace: string, team: string) => namespace === `dev-${team}` ? team : undefined
    const request = { templateId: "nextjs-web", mode: "apply", idempotencyKey: "req-1", values: { ...validValues, namespace: "dev-orders" } }
    expect(validateProvisioningRequest(request, { resolveOwningTeam, sessionTeams: ["orders", "other"] })).toMatchObject({
      valid: true,
      request: { team: "orders" },
    })
    expect(validateProvisioningRequest(request, { resolveOwningTeam, sessionTeams: [] })).toMatchObject({
      valid: false,
      status: 400,
      error: { code: "NO_TEAM" },
    })
    expect(validateProvisioningRequest(request, { resolveOwningTeam })).toMatchObject({ valid: false, error: { code: "NO_TEAM" } })
  })

  it("rejects apply when the resolved namespace owner differs from the requested team", () => {
    expect(validateProvisioningRequest({
      templateId: "nextjs-web",
      mode: "apply",
      team: "payments",
      idempotencyKey: "req-1",
      values: validValues,
    }, { resolveOwningTeam: () => "platform" })).toMatchObject({
      valid: false,
      status: 422,
      error: { code: "TEAM_MISMATCH" },
    })
  })

  it("requires an ownership resolver for apply requests", () => {
    expect(validateProvisioningRequest({
      templateId: "nextjs-web",
      mode: "apply",
      team: "orders",
      idempotencyKey: "req-1",
      values: validValues,
    })).toMatchObject({ valid: false, error: { code: "INVALID_OWNERSHIP" } })
  })

  it.each([
    [null, "INVALID_REQUEST"],
    [[], "INVALID_REQUEST"],
    [{ mode: "deploy", templateId: "nextjs-web", values: validValues }, "INVALID_MODE"],
    [{ templateId: " ", values: validValues }, "INVALID_REQUEST"],
    [{ templateId: "unknown", values: validValues }, "UNKNOWN_TEMPLATE"],
    [{ templateId: "nextjs-web", values: [] }, "INVALID_REQUEST"],
    [{ templateId: "nextjs-web", values: { ...validValues, surprise: "x" } }, "UNKNOWN_FIELD"],
    [{ templateId: "nextjs-web", values: { ...validValues, replicas: 2 } }, "INVALID_FIELD_TYPE"],
    [{ templateId: "nextjs-web", values: { namespace: "dev-orders", replicas: "2" } }, "REQUIRED_FIELD"],
    [{ templateId: "nextjs-web", values: { ...validValues, serviceName: "   " } }, "REQUIRED_FIELD"],
    [{ templateId: "nextjs-web", values: { ...validValues, replicas: "4" } }, "VALUE_NOT_ALLOWED"],
    [{ templateId: "nextjs-web", values: { ...validValues, namespace: "prod-orders" } }, "INVALID_NAMESPACE"],
    [{ templateId: "nextjs-web", values: { ...validValues, namespace: `dev-${"a".repeat(64)}` } }, "INVALID_NAMESPACE"],
    [{ mode: "apply", idempotencyKey: " ", templateId: "nextjs-web", values: validValues }, "INVALID_REQUEST"],
    [{ mode: "apply", templateId: "nextjs-web", values: validValues }, "INVALID_REQUEST"],
    [{ mode: "apply", idempotencyKey: 7, templateId: "nextjs-web", values: validValues }, "INVALID_REQUEST"],
    [{ team: 7, templateId: "nextjs-web", values: validValues }, "INVALID_REQUEST"],
  ])("rejects invalid input with %s", (input, code) => {
    expect(validateProvisioningRequest(input)).toMatchObject({ valid: false, error: { code } })
  })

  it("accepts namespace boundary labels of 6 and 63 characters", () => {
    const six = validate({ values: { ...validValues, namespace: "dev-a" } })
    const sixtyThree = validate({ values: { ...validValues, namespace: `dev-${"a".repeat(59)}` } })
    expect(six.valid).toBe(true)
    expect(sixtyThree.valid).toBe(true)
  })

  it("allows an omitted optional field and treats its empty value as absent", () => {
    expect(validate({ templateId: "api-service", values: { serviceName: "api", namespace: "dev-api", runtime: "go", database: "" } }))
      .toMatchObject({ valid: true, request: { values: { serviceName: "api", namespace: "dev-api", runtime: "go" } } })
  })

  it("does not mutate input or impose undocumented text limits", () => {
    const longValue = "a".repeat(100_000)
    const input = { templateId: "cronjob", values: { serviceName: longValue, namespace: "dev-jobs", schedule: longValue }, extra: "ignored" }
    const result = validateProvisioningRequest(input)
    expect(result).toMatchObject({ valid: true, request: { values: { serviceName: longValue, schedule: longValue } } })
    expect(input.values.serviceName).toBe(longValue)
  })

  it("rejects objects with non-plain prototypes", () => {
    const values = Object.assign(Object.create({ inherited: "x" }), validValues)
    expect(validate({ values })).toMatchObject({ valid: false, error: { code: "INVALID_REQUEST" } })
  })
})

describe("buildProvisioningResult", () => {
  const step = (id: ProvisioningStepResult["id"], status: ProvisioningStepResult["status"], retryable = false): ProvisioningStepResult => ({
    id,
    status,
    error: status === "failed" ? { code: "UPSTREAM_UNAVAILABLE", message: "Unavailable", retryable } : null,
    retryable,
    compensationRequired: false,
  })

  it("marks success before a failed step as partial and preserves retry/compensation flags", () => {
    expect(buildProvisioningResult("op-1", [step("repository", "succeeded"), step("namespace", "failed", true)]))
      .toMatchObject({ operationId: "op-1", status: "partial", retryable: true, steps: [{ compensationRequired: false }, { retryable: true }] })
  })

  it("distinguishes failed, blocked, running, and fully succeeded results", () => {
    expect(buildProvisioningResult("op", [step("repository", "failed")]).status).toBe("failed")
    expect(buildProvisioningResult("op", [step("repository", "blocked")]).status).toBe("failed")
    expect(buildProvisioningResult("op", [step("repository", "succeeded")]).status).toBe("running")
    expect(buildProvisioningResult("op", [step("repository", "succeeded"), step("namespace", "running")]).status).toBe("running")
    expect(buildProvisioningResult("op", ["repository", "namespace", "argocd", "convergence"].map((id) => step(id as ProvisioningStepResult["id"], "succeeded"))).status).toBe("succeeded")
  })
})
