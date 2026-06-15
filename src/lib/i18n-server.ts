import "server-only"
import { cookies } from "next/headers"
import { type Locale, getLocaleFromCookie } from "./i18n"

export async function getLocale(): Promise<Locale> {
  const cookieStore = await cookies()
  return getLocaleFromCookie(cookieStore.get("locale")?.value)
}
