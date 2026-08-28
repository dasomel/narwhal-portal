/**
 * Centralized portal configurations and typed environment validation.
 * Ensures production deployments fail-fast on missing critical variables
 * while preserving local development ergonomics.
 */

export const IS_PRODUCTION = process.env.NODE_ENV === "production"
export const IS_DEVELOPMENT = process.env.NODE_ENV === "development"
export const IS_TEST = process.env.NODE_ENV === "test"

// Centralized K8S_API_SERVER configuration
export function getK8sApiServer(): string {
  if (process.env.K8S_API_SERVER) {
    return process.env.K8S_API_SERVER
  }
  if (process.env.KUBERNETES_SERVICE_HOST) {
    const port = process.env.KUBERNETES_SERVICE_PORT || "443"
    return `https://${process.env.KUBERNETES_SERVICE_HOST}:${port}`
  }
  if (!IS_PRODUCTION) {
    // Development-only fallback for local VM cluster
    return "https://192.168.56.100:6443"
  }
  throw new Error("Missing required production configuration: K8S_API_SERVER")
}

export const K8S_API_SERVER =
  process.env.K8S_API_SERVER ||
  (process.env.KUBERNETES_SERVICE_HOST
    ? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT || "443"}`
    : IS_PRODUCTION
    ? ""
    : "https://192.168.56.100:6443")

export interface ConfigValidationResult {
  valid: boolean
  environment: string
  missingRequired: string[]
  missingOptional: string[]
  details: Record<string, "configured" | "missing" | "defaulted">
}

export function validateRuntimeConfig(): ConfigValidationResult {
  const isProd = IS_PRODUCTION
  const missingRequired: string[] = []
  const missingOptional: string[] = []
  const details: Record<string, "configured" | "missing" | "defaulted"> = {}

  // Critical variables required in production
  const requiredInProd = [
    "AUTH_SECRET",
    "KEYCLOAK_ISSUER",
    "KEYCLOAK_CLIENT_ID",
    "KEYCLOAK_CLIENT_SECRET",
  ]

  for (const key of requiredInProd) {
    if (process.env[key]) {
      details[key] = "configured"
    } else {
      details[key] = "missing"
      if (isProd && process.env.AUTH_MOCK !== "true") {
        missingRequired.push(key)
      }
    }
  }

  // K8s API server check
  if (process.env.K8S_API_SERVER || process.env.KUBERNETES_SERVICE_HOST) {
    details["K8S_API_SERVER"] = "configured"
  } else if (!isProd) {
    details["K8S_API_SERVER"] = "defaulted"
  } else {
    details["K8S_API_SERVER"] = "missing"
    missingRequired.push("K8S_API_SERVER")
  }

  // Optional / Recommended variables
  const optionalServices = [
    "VALKEY_URL",
    "ARGOCD_URL",
    "PROMETHEUS_URL",
    "ALERTMANAGER_URL",
    "GITEA_URL",
    "OPENBAO_ADDR",
    "LOKI_URL",
  ]

  for (const key of optionalServices) {
    if (process.env[key]) {
      details[key] = "configured"
    } else {
      details[key] = "missing"
      missingOptional.push(key)
    }
  }

  return {
    valid: missingRequired.length === 0,
    environment: process.env.NODE_ENV || "development",
    missingRequired,
    missingOptional,
    details,
  }
}
