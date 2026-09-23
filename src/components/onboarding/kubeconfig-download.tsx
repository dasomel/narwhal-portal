"use client"
import { useSession } from "next-auth/react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n-client"
import { KUBELOGIN_VERSION, kubeloginArchiveUrl, kubeloginChecksumsUrl } from "@/lib/kubelogin-version"

export function KubeconfigDownload() {
  const { data: session } = useSession()
  const t = useT()

  const handleDownload = async () => {
    const res = await fetch("/api/onboarding/kubeconfig")
    if (!res.ok) return
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `kubeconfig-narwhal-${session?.user?.name ?? "user"}.yaml`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("kubeconfig.title")}</CardTitle>
        <CardDescription>{t("kubeconfig.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button onClick={handleDownload} className="w-full sm:w-auto">
          {t("kubeconfig.download")}
        </Button>
        <div className="text-sm text-muted-foreground bg-muted/50 rounded p-3 font-mono">
          <p className="text-foreground font-semibold mb-2">{t("kubeconfig.howToInstall")}</p>

          <p className="text-foreground/80 font-semibold">— {t("kubeconfig.osUnix")} —</p>
          <p>{t("kubeconfig.installPlugin")}</p>
          <p># brew tracks the formula&apos;s own pinned+checksummed revision (trust boundary: homebrew-core)</p>
          <p>brew install int128/kubelogin/kubelogin</p>
          <br />
          <p>{t("kubeconfig.applyConfig")}</p>
          <p>mkdir -p ~/.kube</p>
          <p>mv ~/Downloads/kubeconfig-narwhal-*.yaml ~/.kube/config</p>
          <br />
          <p>{t("kubeconfig.testConnection")}</p>
          <p>kubectl get nodes</p>

          <br />
          <p className="text-foreground/80 font-semibold">— {t("kubeconfig.osWindows")} —</p>
          <p>{t("kubeconfig.installPlugin")} (pinned {KUBELOGIN_VERSION})</p>
          <p>curl.exe -Lo kubelogin.zip {kubeloginArchiveUrl("windows_amd64")}</p>
          <p>curl.exe -Lo checksums.txt {kubeloginChecksumsUrl()}</p>
          <p># verify checksum before installing</p>
          <p>CertUtil -hashfile kubelogin.zip SHA256 | findstr /i (Select-String kubelogin_windows_amd64.zip checksums.txt).Line.Split()[0]</p>
          <p>Expand-Archive kubelogin.zip -DestinationPath C:\kubelogin</p>
          <p># Add C:\kubelogin to PATH, rename kubelogin.exe -&gt; kubectl-oidc_login.exe</p>
          <p># Upgrade guidance: bump KUBELOGIN_VERSION in src/lib/kubelogin-version.ts and re-verify; this installer never silently tracks a moving target</p>
          <br />
          <p>{t("kubeconfig.applyConfig")}</p>
          <p>mkdir $HOME\.kube -Force</p>
          <p>Move-Item $HOME\Downloads\kubeconfig-narwhal-*.yaml $HOME\.kube\config</p>
          <br />
          <p>{t("kubeconfig.testConnection")}</p>
          <p>kubectl get nodes</p>
        </div>
      </CardContent>
    </Card>
  )
}
