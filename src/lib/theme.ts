import { cookies } from "next/headers"

export type Theme = "light" | "dark"

export async function getTheme(): Promise<Theme> {
  const store = await cookies()
  const v = store.get("narwhal-theme")?.value
  return v === "dark" ? "dark" : "light"
}
