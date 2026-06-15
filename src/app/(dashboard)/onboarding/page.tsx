import { KubeconfigDownload } from "@/components/onboarding/kubeconfig-download"
import { SetupGuide } from "@/components/onboarding/setup-guide"
import { PlatformArchitectureLoader } from "@/components/onboarding/architecture"
import { t } from "@/lib/i18n"
import { getLocale } from "@/lib/i18n-server"

export default async function OnboardingPage() {
  const locale = await getLocale()
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t(locale, "onboarding.title")}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t(locale, "onboarding.description")}</p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <KubeconfigDownload />
        <SetupGuide />
      </div>
      <PlatformArchitectureLoader />
    </div>
  )
}
