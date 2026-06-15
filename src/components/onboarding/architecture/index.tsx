"use client"

import dynamic from "next/dynamic"

const PlatformArchitecture = dynamic(
  () =>
    import("./platform-architecture").then(
      (mod) => mod.PlatformArchitecture
    ),
  { ssr: false }
)

export function PlatformArchitectureLoader() {
  return <PlatformArchitecture />
}
