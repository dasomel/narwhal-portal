import { describe, expect, it } from "vitest"
import { readTemplatePreviewResponse } from "./service-templates"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe("readTemplatePreviewResponse", () => {
  it("returns a successful preview unchanged", async () => {
    const body = { success: true, preview: { templateId: "cronjob", values: {}, willCreate: ["a"] } }
    await expect(readTemplatePreviewResponse(json(body))).resolves.toEqual(body)
  })

  it("throws the validator message for a rejected request instead of returning it as a preview", async () => {
    await expect(readTemplatePreviewResponse(json({ error: { code: "INVALID_NAMESPACE", message: "Namespace must be a valid dev- DNS label" } }, 422)))
      .rejects.toThrow("Namespace must be a valid dev- DNS label")
  })

  it("throws a status-based message for a non-JSON failure and for a 200 without a preview", async () => {
    await expect(readTemplatePreviewResponse(new Response("Bad Gateway", { status: 502 }))).rejects.toThrow("HTTP 502")
    await expect(readTemplatePreviewResponse(json({ success: true }))).rejects.toThrow("Preview failed")
  })
})
