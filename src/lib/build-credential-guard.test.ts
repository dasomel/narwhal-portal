import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(currentDir, "../..");
const JOB_YAML_PATH = resolve(repoRoot, "deploy/kaniko-build-job.yaml");
const BUILD_SCRIPT_PATH = resolve(repoRoot, "scripts/kaniko-build.sh");

const EMBEDDED_CREDENTIAL_URL_REGEX = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s]+@/i;
const GITEA_PASSWORD_VAR_REGEX = /\$(?:\{?GITEA(?:_ADMIN)?_PASSWORD\}?)/;
const URL_SCHEME_REGEX = /[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Joins shell line continuations (a line ending in `\`) with the following line, so a
 * command wrapped across several lines (e.g. a continued `git clone ...` invocation) is
 * checked as one logical line instead of fragments that can each look safe in isolation.
 */
function joinLineContinuations(content: string): { line: string; lineNum: number }[] {
  const rawLines = content.split("\n");
  const logical: { line: string; lineNum: number }[] = [];
  let buffer = "";
  let startLineNum = 1;
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    if (buffer === "") startLineNum = i + 1;
    const trimmedEnd = raw.replace(/\s+$/, "");
    if (trimmedEnd.endsWith("\\")) {
      buffer += trimmedEnd.slice(0, -1) + " ";
    } else {
      buffer += raw;
      logical.push({ line: buffer.trim(), lineNum: startLineNum });
      buffer = "";
    }
  }
  if (buffer !== "") {
    logical.push({ line: buffer.trim(), lineNum: startLineNum });
  }
  return logical;
}

/** True when a logical line has a URL scheme and the Gitea password var anywhere on
 * it — catches `http://${GITEA_ADMIN_PASSWORD}@host`, which has no `user:pass@` so
 * EMBEDDED_CREDENTIAL_URL_REGEX alone would miss it. */
function urlLineHasPasswordVar(line: string): boolean {
  return URL_SCHEME_REGEX.test(line) && GITEA_PASSWORD_VAR_REGEX.test(line);
}

/**
 * Strips leading `VAR="value" ` shell env-assignment prefixes (e.g.
 * `GITEA_ADMIN_PASSWORD="${GITEA_ADMIN_PASSWORD}" git push ...`), which set the
 * process environment rather than pass a command-line argument. Joining line
 * continuations merges such a prefix with the command it precedes onto one logical
 * line, and without this the git-argument check below would flag the (safe)
 * GIT_ASKPASS env-var handoff as if the password were a literal git argument.
 */
function stripLeadingEnvAssignments(line: string): string {
  return line.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|\S*)\s+)+/, "");
}

describe("build-credential-guard: Portal #23 AC1 credential-safe build", () => {
  const jobYaml = readFileSync(JOB_YAML_PATH, "utf-8");
  const buildScript = readFileSync(BUILD_SCRIPT_PATH, "utf-8");
  const jobYamlLines = joinLineContinuations(jobYaml);
  const buildScriptLines = joinLineContinuations(buildScript);

  describe("requirement 1: no URL with embedded credentials", () => {
    it("regex self-check: matches user:pass@host and rejects bare user@host", () => {
      // Must match sample string with embedded password
      expect(EMBEDDED_CREDENTIAL_URL_REGEX.test("http://gitea-admin:s3cret@gitea/x.git")).toBe(true);
      expect(EMBEDDED_CREDENTIAL_URL_REGEX.test("https://user:password123@host.local/repo.git")).toBe(true);

      // Must NOT match bare user@host without password (used in kaniko-build.sh)
      expect(EMBEDDED_CREDENTIAL_URL_REGEX.test("http://gitea-admin@gitea/x.git")).toBe(false);
      expect(EMBEDDED_CREDENTIAL_URL_REGEX.test("http://${GITEA_ADMIN_USER}@localhost:3000/repo.git")).toBe(false);
      expect(EMBEDDED_CREDENTIAL_URL_REGEX.test("http://gitea-http.devtools.svc.cluster.local:3000/repo.git")).toBe(false);
    });

    it("regex self-check: flags a password-only credential URL (no username) that EMBEDDED_CREDENTIAL_URL_REGEX alone misses", () => {
      expect(urlLineHasPasswordVar("http://${GITEA_ADMIN_PASSWORD}@host")).toBe(true);
      expect(urlLineHasPasswordVar("http://${GITEA_ADMIN_USER}@localhost:3000/repo.git")).toBe(false);

      // Multi-line continued git clone carrying the password — only visible as an
      // offender once continuations are joined into one logical line.
      const continued = joinLineContinuations(
        [
          "git clone \\",
          '  "http://${GITEA_ADMIN_PASSWORD}@gitea-http.devtools.svc.cluster.local:3000/x.git" \\',
          "  /workspace",
        ].join("\n"),
      );
      expect(continued).toHaveLength(1);
      expect(urlLineHasPasswordVar(continued[0].line)).toBe(true);
    });

    it("deploy/kaniko-build-job.yaml contains no URL with embedded credentials", () => {
      const offenders = jobYamlLines.filter(({ line }) => EMBEDDED_CREDENTIAL_URL_REGEX.test(line));

      expect(offenders, `Found embedded credentials in ${JOB_YAML_PATH}`).toEqual([]);
      expect(jobYaml).not.toMatch(EMBEDDED_CREDENTIAL_URL_REGEX);
    });

    it("scripts/kaniko-build.sh contains no URL with embedded credentials", () => {
      const offenders = buildScriptLines.filter(({ line }) => EMBEDDED_CREDENTIAL_URL_REGEX.test(line));

      expect(offenders, `Found embedded credentials in ${BUILD_SCRIPT_PATH}`).toEqual([]);
      expect(buildScript).not.toMatch(EMBEDDED_CREDENTIAL_URL_REGEX);
    });

    it("deploy/kaniko-build-job.yaml has no logical line with a URL and the Gitea password variable together", () => {
      const offenders = jobYamlLines.filter(({ line }) => urlLineHasPasswordVar(line));

      expect(offenders, `Found URL + password variable in ${JOB_YAML_PATH}`).toEqual([]);
    });

    it("scripts/kaniko-build.sh has no logical line with a URL and the Gitea password variable together", () => {
      const offenders = buildScriptLines.filter(({ line }) => urlLineHasPasswordVar(line));

      expect(offenders, `Found URL + password variable in ${BUILD_SCRIPT_PATH}`).toEqual([]);
    });
  });

  describe("requirement 2: password interpolation and echo guards", () => {
    it("never interpolates GITEA_ADMIN_PASSWORD / GITEA_PASSWORD into a git command line argument or URL", () => {
      const files = [
        { path: JOB_YAML_PATH, lines: jobYamlLines },
        { path: BUILD_SCRIPT_PATH, lines: buildScriptLines },
      ];

      for (const { path, lines } of files) {
        const gitArgOffenders = lines.filter(({ line: rawLine }) => {
          // A leading `VAR="..."` prefix sets the process environment for the
          // command that follows, not a command-line argument — check the command
          // itself, not the env-assignment prefix (e.g. GIT_ASKPASS's env handoff).
          const line = stripLeadingEnvAssignments(rawLine);
          const hasGitCommand = line.includes("git ") || /(?:^|\s)git\s+/.test(line);
          const hasPasswordVar =
            line.includes("$GITEA_ADMIN_PASSWORD") ||
            line.includes("${GITEA_ADMIN_PASSWORD}") ||
            line.includes("$GITEA_PASSWORD") ||
            line.includes("${GITEA_PASSWORD}") ||
            GITEA_PASSWORD_VAR_REGEX.test(line);
          return hasGitCommand && hasPasswordVar;
        });

        expect(gitArgOffenders, `Found password interpolated into git command in ${path}`).toEqual([]);
      }

      // Explicitly check PUSH_URL in kaniko-build.sh does not contain password
      const pushUrlLine = buildScriptLines.find(({ line }) => line.includes("PUSH_URL="))?.line;
      expect(pushUrlLine).toBeDefined();
      expect(pushUrlLine).not.toMatch(GITEA_PASSWORD_VAR_REGEX);
      expect(pushUrlLine).toMatch(/\$\{GITEA_ADMIN_USER\}@/);
    });

    it("never echoes GITEA_ADMIN_PASSWORD / GITEA_PASSWORD to stdout", () => {
      // In job yaml: no echo/printf references the password at all
      const jobEchoOffenders = jobYamlLines.filter(
        ({ line }) => /\b(echo|printf)\b/.test(line) && GITEA_PASSWORD_VAR_REGEX.test(line),
      );
      expect(jobEchoOffenders, `Job yaml echoes password: ${JSON.stringify(jobEchoOffenders)}`).toEqual([]);

      // In scripts/kaniko-build.sh:
      // No echo referencing the password anywhere
      const scriptEchoOffenders = buildScriptLines.filter(
        ({ line }) => /\becho\b/.test(line) && GITEA_PASSWORD_VAR_REGEX.test(line),
      );
      expect(scriptEchoOffenders, `Build script uses echo with password: ${JSON.stringify(scriptEchoOffenders)}`).toEqual([]);

      // The only allowed printf referencing password is inside the ASKPASS_SCRIPT heredoc
      // (which writes to the chmod 700 file, not stdout)
      const scriptPrintfLines = buildScriptLines.filter(
        ({ line }) => /\bprintf\b/.test(line) && GITEA_PASSWORD_VAR_REGEX.test(line),
      );

      expect(scriptPrintfLines.length).toBe(1);
      expect(scriptPrintfLines[0].line).toBe("printf '%s\\n' \"${GITEA_ADMIN_PASSWORD}\"");

      // Verify that this printf is strictly between cat > "${ASKPASS_SCRIPT}" <<'EOF' and EOF
      const askpassHeredocRegex = /cat\s+>\s*"\$\{ASKPASS_SCRIPT\}"\s*<<'EOF'[\s\S]*?printf\s+'%s\\n'\s*"\$\{GITEA_ADMIN_PASSWORD\}"[\s\S]*?EOF/;
      expect(buildScript).toMatch(askpassHeredocRegex);
    });
  });

  describe("requirement 3: transient .netrc created with chmod 600 and removed after clone", () => {
    it("deploy/kaniko-build-job.yaml secures .netrc with chmod 600 and removes it after git clone", () => {
      // Assert exact presence of chmod 600 and rm -f commands on .netrc
      expect(jobYaml).toContain('chmod 600 "${HOME}/.netrc"');
      expect(jobYaml).toContain('rm -f "${HOME}/.netrc"');

      // Verify command execution order: creation -> chmod 600 -> git clone -> rm -f
      const netrcCreatePos = jobYaml.indexOf('cat > "${HOME}/.netrc"');
      const chmodPos = jobYaml.indexOf('chmod 600 "${HOME}/.netrc"');
      const gitClonePos = jobYaml.indexOf("git clone");
      const rmNetrcPos = jobYaml.indexOf('rm -f "${HOME}/.netrc"');

      expect(netrcCreatePos, "cat > .netrc must be present").toBeGreaterThan(-1);
      expect(chmodPos, "chmod 600 must appear after .netrc creation").toBeGreaterThan(netrcCreatePos);
      expect(gitClonePos, "git clone must appear after chmod 600").toBeGreaterThan(chmodPos);
      expect(rmNetrcPos, "rm -f .netrc must appear after git clone").toBeGreaterThan(gitClonePos);
    });

    it("scripts/kaniko-build.sh secures ASKPASS_SCRIPT with chmod 700 and removes it on EXIT trap", () => {
      expect(buildScript).toContain('chmod 700 "${ASKPASS_SCRIPT}"');
      expect(buildScript).toContain('rm -f "${ASKPASS_SCRIPT}"');

      const chmodPos = buildScript.indexOf('chmod 700 "${ASKPASS_SCRIPT}"');
      const gitPushPos = buildScript.indexOf("git push");

      expect(chmodPos, "chmod 700 must appear before git push").toBeGreaterThan(-1);
      expect(gitPushPos, "git push must appear after chmod 700").toBeGreaterThan(chmodPos);
    });
  });
});
