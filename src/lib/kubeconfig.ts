import * as yaml from "js-yaml"
import { K8S_API_SERVER } from "./config"

// L-5: idToken/refreshToken were unused — kubectl oidc-login fetches tokens
// itself via PKCE. Removed from the public signature.
export interface KubeconfigOptions {
  username: string
  clientId: string
  issuer: string
}

export function generateKubeconfig(opts: KubeconfigOptions): string {
  const CLUSTER_SERVER = K8S_API_SERVER
  const CLUSTER_CA = process.env.K8S_CA_DATA ?? ""

  const kubeconfig = {
    apiVersion: "v1",
    kind: "Config",
    "current-context": "narwhal",
    clusters: [
      {
        name: "narwhal",
        cluster: {
          server: CLUSTER_SERVER,
          "certificate-authority-data": CLUSTER_CA,
        },
      },
    ],
    users: [
      {
        name: opts.username,
        user: {
          exec: {
            apiVersion: "client.authentication.k8s.io/v1beta1",
            command: "kubectl",
            args: [
              "oidc-login",
              "get-token",
              `--oidc-issuer-url=${opts.issuer}`,
              `--oidc-client-id=${opts.clientId}`,
              "--oidc-use-pkce",
              "--grant-type=auto",
            ],
          },
        },
      },
    ],
    contexts: [
      {
        name: "narwhal",
        context: {
          cluster: "narwhal",
          user: opts.username,
        },
      },
    ],
  }

  return yaml.dump(kubeconfig, { lineWidth: -1 })
}
