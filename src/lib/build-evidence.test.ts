import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, "../..");
const BUILD_SCRIPT_PATH = resolve(repoRoot, "scripts/kaniko-build.sh");
const JOB_TEMPLATE_PATH = resolve(repoRoot, "deploy/kaniko-build-job.yaml");

describe("build-evidence: Portal #23 AC build evidence fields", () => {
  const buildScript = readFileSync(BUILD_SCRIPT_PATH, "utf-8");

  it("emits every required build-evidence field name in the jq record", () => {
    expect(buildScript).toContain("schemaVersion: $schemaVersion,");
    expect(buildScript).toContain("sourceRevision: $sourceRevision,");
    expect(buildScript).toContain("lockfileSha256: $lockfileSha256,");
    expect(buildScript).toContain("builderImage: $builderImage,");
    expect(buildScript).toContain("gitHelperImage: $gitHelperImage,");
    expect(buildScript).toContain("imageRef: $imageRef,");
    expect(buildScript).toContain("imageDigest: $imageDigest,");
    // sbom / signature carry explicit literal statuses, never omitted, per the AC.
    expect(buildScript).toContain('sbom: {status: "not-generated"}');
    expect(buildScript).toContain('signature: {status: "not-signed"}');
  });

  it("computes lockfileSha256 from the built revision via git show, not the working tree", () => {
    expect(buildScript).toMatch(/git -C "\$\{WORK_DIR\}" show "\$\{BUILD_GIT_SHA\}:pnpm-lock\.yaml" \| shasum -a 256/);
    expect(buildScript).toMatch(/git -C "\$\{REPO_ROOT\}" show "\$\{BUILD_GIT_SHA\}:pnpm-lock\.yaml" \| shasum -a 256/);
  });

  it("validates lockfileSha256 as a 64-hex-char sha256 before proceeding", () => {
    expect(buildScript).toContain('if [[ ! "${LOCKFILE_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then');
  });

  it("fails the script when imageDigest is not sha256:<64 hex>", () => {
    expect(buildScript).toContain('if [[ ! "${IMAGE_DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]]; then');

    // Regex self-check against the exact digest format the AC requires.
    const digestRegex = /^sha256:[0-9a-f]{64}$/;
    const valid = "sha256:" + "a".repeat(64);
    const tooShort = "sha256:" + "a".repeat(63);
    const wrongPrefix = "sha512:" + "a".repeat(64);
    expect(digestRegex.test(valid)).toBe(true);
    expect(digestRegex.test(tooShort)).toBe(false);
    expect(digestRegex.test(wrongPrefix)).toBe(false);
    expect(digestRegex.test("")).toBe(false);
  });

  it("reads builderImage/gitHelperImage from the rendered Job YAML, not the template", () => {
    expect(buildScript).toContain("RENDERED_JOB_YAML=");
    expect(buildScript).toMatch(/BUILDER_IMAGE="\$\(printf '%s\\n' "\$\{RENDERED_JOB_YAML\}" \|/);
    expect(buildScript).toMatch(/GIT_HELPER_IMAGE="\$\(printf '%s\\n' "\$\{RENDERED_JOB_YAML\}" \|/);
  });

  it("writes build-evidence to an overridable path defaulting under the repo", () => {
    expect(buildScript).toContain("BUILD_EVIDENCE_PATH_OVERRIDE=\"${BUILD_EVIDENCE_PATH:-}\"");
    expect(buildScript).toContain(
      'BUILD_EVIDENCE_PATH="${BUILD_EVIDENCE_PATH_OVERRIDE:-${REPO_ROOT}/build-evidence/${HARBOR_TAG}.json}"',
    );
  });

  it(".gitignore excludes the generated build-evidence directory", () => {
    const gitignore = readFileSync(resolve(repoRoot, ".gitignore"), "utf-8");
    expect(gitignore).toContain("/build-evidence/");
  });
  // Runs the script's own extraction pipelines against the real Job manifest. The pin
  // comments above each `image:` line name the same image, so an unanchored grep records
  // "alpine/git:v2.54.0." (comment text, no digest) instead of the pinned ref.
  it.each([
    ["BUILDER_IMAGE", "gcr.io/kaniko-project/executor:"],
    ["GIT_HELPER_IMAGE", "alpine/git:"],
  ])("extracts %s from the image: line with its digest pin", (variable, prefix) => {
    const line = buildScript.split("\n").find((l) => l.trim().startsWith(`${variable}="$(`));
    expect(line).toBeDefined();
    const pipeline = line!.trim().slice(`${variable}="$(`.length, -2).replace('"${RENDERED_JOB_YAML}"', '"$(cat "$1")"');
    const ref = execFileSync("bash", ["-c", pipeline, "_", JOB_TEMPLATE_PATH], { encoding: "utf-8" }).trim();
    expect(ref.startsWith(prefix)).toBe(true);
    expect(ref).toMatch(/@sha256:[0-9a-f]{64}$/);
  });
});
