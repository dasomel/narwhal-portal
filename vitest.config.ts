import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

// portal#21: every existing "@/..." import in a src/lib/*.ts file that vitest
// actually exercises at runtime happened to be `import type` (erased by esbuild
// before module resolution runs), so the "@/*" -> "./src/*" alias tsconfig.json
// declares for Next.js/tsc was never actually resolved by vitest — there was no
// vitest.config.ts at all. This surfaced the first time a lib module needed a
// real (non-type) "@/..." value import (DEFAULT_CLUSTER_ID from
// src/types/cluster.ts). Mirrors the one alias tsconfig.json's "paths" defines.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
})
