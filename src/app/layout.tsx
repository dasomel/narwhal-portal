import type { Metadata } from "next"
import localFont from "next/font/local"
import "./globals.css"
import { Providers } from "@/components/providers"
import { getLocale } from "@/lib/i18n-server"
import { getTheme } from "@/lib/theme"

const pretendard = localFont({
  src: "./fonts/PretendardVariable.woff2",
  variable: "--font-pretendard",
  display: "swap",
  weight: "45 920",
})

export const metadata: Metadata = {
  title: "Narwhal IDP Portal",
  description: "Internal Developer Platform",
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [locale, theme] = await Promise.all([getLocale(), getTheme()])
  return (
    <html lang={locale} className={`${pretendard.variable} ${theme === "dark" ? "dark" : ""}`.trim()}>
      <body>
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  )
}
