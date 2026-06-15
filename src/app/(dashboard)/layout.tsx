import { Nav } from "@/components/nav"
import { CommandPalette } from "@/components/command-palette"

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <CommandPalette />
      <main className="container mx-auto px-6 py-8 max-w-7xl">{children}</main>
    </div>
  )
}
