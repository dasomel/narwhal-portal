"use client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useT } from "@/lib/i18n-client"
import type { TranslationKey } from "@/lib/i18n"
import { KUBELOGIN_VERSION, kubeloginArchiveUrl, kubeloginChecksumsUrl } from "@/lib/kubelogin-version"

interface Step {
  step: number
  titleKey: TranslationKey
  macos: string
  linux: string
  windows: string
}

// D1 (issue #94): kubelogin is pinned to KUBELOGIN_VERSION (src/lib/kubelogin-version.ts)
// and installs verify the upstream checksums.txt before the binary reaches PATH, instead of
// trusting `releases/latest` + transport alone. brew's path is documented separately since
// its trust/update boundary is the formula's own pin, not this file.
const steps: Step[] = [
  { step: 1, titleKey: "setup.step1", macos: "brew install kubectl", linux: "curl -LO https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl\nchmod +x kubectl && sudo mv kubectl /usr/local/bin/", windows: "winget install -e --id Kubernetes.kubectl\n# or: choco install kubernetes-cli" },
  {
    step: 2,
    titleKey: "setup.step2",
    macos: `# brew tracks the formula's own pinned+checksummed revision (trust boundary: homebrew-core)\nbrew install int128/kubelogin/kubelogin`,
    linux: `# pinned ${KUBELOGIN_VERSION}, verified against upstream checksums.txt before install\ncurl -Lo kubelogin.zip ${kubeloginArchiveUrl("linux_amd64")}\ncurl -Lo checksums.txt ${kubeloginChecksumsUrl()}\nsha256sum --ignore-missing -c checksums.txt\nunzip kubelogin.zip && sudo mv kubelogin /usr/local/bin/kubectl-oidc_login\n# Upgrade: bump KUBELOGIN_VERSION in src/lib/kubelogin-version.ts, don't just re-run with latest`,
    windows: `# pinned ${KUBELOGIN_VERSION}, verified against upstream checksums.txt before install\ncurl.exe -Lo kubelogin.zip ${kubeloginArchiveUrl("windows_amd64")}\ncurl.exe -Lo checksums.txt ${kubeloginChecksumsUrl()}\nCertUtil -hashfile kubelogin.zip SHA256 | findstr /i (Select-String kubelogin_windows_amd64.zip checksums.txt).Line.Split()[0]\nExpand-Archive kubelogin.zip -DestinationPath C:\\kubelogin\n# Add C:\\kubelogin to PATH, rename kubelogin.exe -> kubectl-oidc_login.exe\n# Upgrade: bump KUBELOGIN_VERSION in src/lib/kubelogin-version.ts, don't just re-run with latest`,
  },
  { step: 3, titleKey: "setup.step3", macos: "DYNAMIC:setup.step3.macos", linux: "DYNAMIC:setup.step3.linux", windows: "DYNAMIC:setup.step3.windows" },
  { step: 4, titleKey: "setup.step4", macos: "DYNAMIC:setup.step4.cmd", linux: "DYNAMIC:setup.step4.cmd", windows: "DYNAMIC:setup.step4.cmd" },
]

export function SetupGuide() {
  const t = useT()

  function getStepCommand(step: Step, os: "macos" | "linux" | "windows"): string {
    const raw = step[os]
    if (raw.startsWith("DYNAMIC:")) {
      return t(raw.slice(8) as TranslationKey)
    }
    return raw
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("setup.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="macos">
          <TabsList>
            <TabsTrigger value="macos">macOS</TabsTrigger>
            <TabsTrigger value="linux">Linux</TabsTrigger>
            <TabsTrigger value="windows">Windows</TabsTrigger>
          </TabsList>
          {(["macos", "linux", "windows"] as const).map((os) => (
            <TabsContent key={os} value={os} className="mt-4 space-y-4">
              {steps.map((s) => (
                <div key={s.step} className="flex gap-4">
                  <Badge className="h-6 w-6 flex items-center justify-center shrink-0 bg-blue-600 text-white rounded-full p-0">
                    {s.step}
                  </Badge>
                  <div className="flex-1">
                    <p className="font-medium text-foreground mb-1">{t(s.titleKey)}</p>
                    <pre className="text-xs bg-foreground/95 text-background rounded p-3 overflow-x-auto whitespace-pre">
                      {getStepCommand(s, os)}
                    </pre>
                  </div>
                </div>
              ))}
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  )
}
