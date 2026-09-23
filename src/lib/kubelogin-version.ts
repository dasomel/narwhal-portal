// Single source of truth for the kubelogin version used in onboarding instructions.
// int128/kubelogin release: https://github.com/int128/kubelogin/releases/tag/v1.28.1
//
// D1: pinned instead of `releases/latest` so onboarding downloads are reproducible and
// reviewable (issue #94). Bumping this requires reviewing the release notes/checksums and
// updating this single constant — every onboarding surface (macOS/Linux/Windows) derives
// its URLs from it, so they cannot drift apart.
export const KUBELOGIN_VERSION = "v1.28.1"

// Immutable per-tag checksums file published by the kubelogin release itself. Verifying
// against this (rather than trusting the transport) covers the "checksum/signature before
// use" acceptance criterion without us hand-baking hash values into source, which would go
// stale silently on a version bump.
export function kubeloginChecksumsUrl(version: string = KUBELOGIN_VERSION): string {
  return `https://github.com/int128/kubelogin/releases/download/${version}/checksums.txt`
}

export function kubeloginArchiveUrl(
  platform: "linux_amd64" | "windows_amd64",
  version: string = KUBELOGIN_VERSION,
): string {
  const ext = platform === "windows_amd64" ? "zip" : "zip"
  return `https://github.com/int128/kubelogin/releases/download/${version}/kubelogin_${platform}.${ext}`
}
