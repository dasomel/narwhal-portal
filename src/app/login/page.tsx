"use client"
import { Suspense, useEffect } from "react"
import { useSearchParams } from "next/navigation"
import { signIn } from "next-auth/react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useT } from "@/lib/i18n-client"

const isMock = process.env.NEXT_PUBLIC_AUTH_MOCK === "true"

const MOCK_ROLES = [
  { label: "Cluster Admin", role: "cluster-admin" },
  { label: "Developer", role: "developer" },
  { label: "Viewer", role: "viewer" },
]

function LoginForm() {
  const t = useT()
  const searchParams = useSearchParams()
  const callbackUrl = searchParams.get("callbackUrl") || "/"

  useEffect(() => {
    if (!isMock) {
      signIn("keycloak", { callbackUrl })
    }
  }, [callbackUrl])

  return (
    <div className="min-h-screen bg-background flex items-center justify-center font-sans">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold tracking-tight">Narwhal IDP</CardTitle>
          <CardDescription>
            {isMock ? t("login.welcome") : t("login.redirecting")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {isMock ? (
            <>
              <p className="text-xs text-center text-muted-foreground mb-1">{t("login.mockMode")}</p>
              {MOCK_ROLES.map(({ label, role }) => (
                <Button
                  key={role}
                  variant="outline"
                  className="w-full"
                  onClick={() => signIn("mock", { role, callbackUrl })}
                >
                  {t("login.loginAs", { label })}
                </Button>
              ))}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-6">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-foreground" />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-background flex items-center justify-center font-sans">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl font-bold tracking-tight">Narwhal IDP</CardTitle>
            <CardDescription>Loading...</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center justify-center py-6">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-foreground" />
          </CardContent>
        </Card>
      </div>
    }>
      <LoginForm />
    </Suspense>
  )
}
