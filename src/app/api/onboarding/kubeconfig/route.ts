import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { generateKubeconfig } from "@/lib/kubeconfig"

export const dynamic = "force-dynamic"

export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const username = session.user.name ?? session.user.email ?? "user"
  // K8s OIDC uses the 'kubernetes' provider, separate from the portal's own OIDC provider
  const kubeconfig = generateKubeconfig({
    username,
    clientId: process.env.KEYCLOAK_K8S_CLIENT_ID ?? "kubernetes",
    issuer:
      process.env.KEYCLOAK_K8S_ISSUER ??
      "https://keycloak.local.narwhal.io/realms/narwhal",
  })

  return new NextResponse(kubeconfig, {
    headers: {
      "Content-Type": "application/yaml",
      "Content-Disposition": `attachment; filename="kubeconfig-narwhal-${username}.yaml"`,
    },
  })
}
