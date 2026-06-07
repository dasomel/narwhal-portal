"use client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useT } from "@/lib/i18n-client"
import type { TranslationKey } from "@/lib/i18n"

interface Step {
  step: number
  titleKey: TranslationKey
  macos: string
  linux: string
  windows: string
}

const steps: Step[] = [
  { step: 1, titleKey: "setup.step1", macos: "brew install kubectl", linux: "curl -LO https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl\nchmod +x kubectl && sudo mv kubectl /usr/local/bin/", windows: "winget install -e --id Kubernetes.kubectl\n# or: choco install kubernetes-cli" },
  { step: 2, titleKey: "setup.step2", macos: "brew install int128/kubelogin/kubelogin", linux: "curl -Lo kubelogin.zip https://github.com/int128/kubelogin/releases/latest/download/kubelogin_linux_amd64.zip\nunzip kubelogin.zip && sudo mv kubelogin /usr/local/bin/kubectl-oidc_login", windows: "curl.exe -Lo kubelogin.zip https://github.com/int128/kubelogin/releases/latest/download/kubelogin_windows_amd64.zip\nExpand-Archive kubelogin.zip -DestinationPath C:\\kubelogin\n# Add C:\\kubelogin to PATH, rename kubelogin.exe -> kubectl-oidc_login.exe" },
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
