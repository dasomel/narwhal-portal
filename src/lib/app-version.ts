export interface AppVersion {
  version: string
  commit: string
  shortCommit: string
  display: string
}

export function getAppVersion(
  version = process.env.APP_VERSION,
  commit = process.env.APP_COMMIT,
): AppVersion {
  const resolvedVersion = version || "0.0.0-dev"
  const resolvedCommit = commit || "dev"
  const shortCommit = resolvedCommit === "dev" ? "dev" : resolvedCommit.slice(0, 7)

  return {
    version: resolvedVersion,
    commit: resolvedCommit,
    shortCommit,
    display: `v${resolvedVersion} · ${shortCommit}`,
  }
}
