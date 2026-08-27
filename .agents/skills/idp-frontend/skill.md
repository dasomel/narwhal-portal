---
name: idp-frontend
description: "Frontend development guide for Narwhal IDP Portal. Covers Next.js 16 App Router, React 19, shadcn/ui, TanStack Query patterns. Use this skill when adding new pages, building dashboard widgets, implementing settings tabs, or role-based UI branching. Triggers on 'UI', 'page', 'component', 'dashboard', 'widget'."
---

# IDP Portal Frontend Development

Frontend development patterns and rules for the Narwhal IDP Portal.

## Tech Stack
- Next.js 16 (App Router) + React 19
- TailwindCSS 4 + shadcn/ui
- TanStack Query (server data) + Zustand (client state)
- `pnpm` package manager

## Mandatory Rules
- Next.js 16 APIs may differ from training data. Always read guides in `node_modules/next/dist/docs/` before writing code.
- Server Components are the default. Only declare `"use client"` when client features like `useState`, `useEffect`, or `onClick` are needed.
- All UI text must use the i18n system — no hardcoded Korean or English strings in components.
  - Server components: `import { getLocale } from "@/lib/i18n-server"` then `t(locale, "key")`
  - Client components: `import { useT } from "@/lib/i18n-client"` then `const t = useT(); t("key")`
  - When adding new UI text, add keys to both `ko` and `en` dictionaries in `src/lib/i18n.ts`.

## Adding a New Page

Follow this sequence when adding a page:

1. Create `src/app/(dashboard)/{page-name}/page.tsx`
2. Add menu entry in `src/components/nav.tsx` — append `{ href, label, roles }` to the `menuItems` array
3. Create page-specific components under `src/components/{page-name}/`

```tsx
// Server Component page (default)
import { MyWidget } from "@/components/{page-name}/my-widget"

export default function MyPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Page Title</h1>
        <p className="text-gray-500 text-sm mt-1">Description</p>
      </div>
      <MyWidget />
    </div>
  )
}
```

## Data Fetching Patterns

### Direct fetch in Server Components (preferred)
```tsx
// Server Component — runs on server at build/request time
async function getData() {
  const res = await fetch("/api/metrics", { next: { revalidate: 0 } })
  if (!res.ok) throw new Error("fetch failed")
  return res.json()
}
```

### TanStack Query in Client Components
```tsx
"use client"
import { useQuery } from "@tanstack/react-query"

function MyWidget() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["my-data"],
    queryFn: () => fetch("/api/my-data").then(r => r.json()),
    refetchInterval: 15_000,
  })
}
```

## Role-Based Access Control

Four roles: `cluster-admin`, `developer`, `viewer`, `guest`

```tsx
// In Server Components
import { auth } from "@/lib/auth"
const session = await auth()
const role = session?.user?.role ?? "guest"

// In Client Components
import { useSession } from "next-auth/react"
const { data: session } = useSession()
const role = session?.user?.role ?? "guest"
```

Menu access is controlled by the `menuItems[].roles` array in Nav. Always set roles when adding a new menu item.

## Available shadcn/ui Components

Currently installed: `button`, `card`, `table`, `badge`, `input`, `select`, `dropdown-menu`, `navigation-menu`, `separator`, `avatar`, `tabs`, `dialog`, `sheet`

For new components, run `npx shadcn@latest add {component}` then use.

## Project Structure

```
src/
├── app/
│   ├── (dashboard)/          # Dashboard pages (/, /tools, /settings, /onboarding)
│   ├── api/                  # API Routes
│   ├── login/                # Login page
│   ├── layout.tsx            # Root layout
│   └── globals.css
├── components/
│   ├── ui/                   # shadcn/ui base components
│   ├── dashboard/            # Dashboard widgets (metrics, argocd, alerts)
│   ├── settings/             # Settings tabs (users, routes)
│   ├── onboarding/           # Onboarding (kubeconfig, setup guide)
│   ├── tools/                # Platform tools grid
│   ├── nav.tsx               # Navigation (menuItems + roles)
│   └── providers.tsx         # TanStack Query + Session provider
├── lib/                      # Shared utilities and clients
└── types/                    # Shared type definitions
```

## Style Rules
- Use TailwindCSS utility classes, avoid inline styles
- Colors: gray-900 (headings), gray-500 (descriptions), gray-50 (background)
- Spacing: `space-y-6` (between sections), `gap-4` (within grids)
- Cards: `rounded-lg border bg-white p-4`
- Responsive: `grid-cols-1 lg:grid-cols-2` (2-col), `max-w-7xl` (container)
