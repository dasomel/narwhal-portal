/**
 * Centralized portal configurations and default fallbacks.
 * Aligning with the cluster's authoritative values.
 */

// WO-D15: Centralized K8S_API_SERVER fallback (authoritative HTTPS VIP)
export const K8S_API_SERVER = process.env.K8S_API_SERVER ?? "https://192.168.56.100:6443"
