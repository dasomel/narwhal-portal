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

describe("build-credential-guard: Portal #23 AC1 credential-safe build", () => {
  const jobYaml = readFileSync(JOB_YAML_PATH, "utf-8");
  const buildScript = readFileSync(BUILD_SCRIPT_PATH, "utf-8");

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

    it("deploy/kaniko-build-job.yaml contains no URL with embedded credentials", () => {
      const lines = jobYaml.split("\n");
      const offenders = lines
        .map((line, idx) => ({ line: line.trim(), lineNum: idx + 1 }))
        .filter(({ line }) => EMBEDDED_CREDENTIAL_URL_REGEX.test(line));

      expect(offenders, `Found embedded credentials in ${JOB_YAML_PATH}`).toEqual([]);
      expect(jobYaml).not.toMatch(EMBEDDED_CREDENTIAL_URL_REGEX);
    });

    it("scripts/kaniko-build.sh contains no URL with embedded credentials", () => {
      const lines = buildScript.split("\n");
      const offenders = lines
        .map((line, idx) => ({ line: line.trim(), lineNum: idx + 1 }))
        .filter(({ line }) => EMBEDDED_CREDENTIAL_URL_REGEX.test(line));

      expect(offenders, `Found embedded credentials in ${BUILD_SCRIPT_PATH}`).toEqual([]);
      expect(buildScript).not.toMatch(EMBEDDED_CREDENTIAL_URL_REGEX);
    });
  });

  describe("requirement 2: password interpolation and echo guards", () => {
    it("never interpolates GITEA_ADMIN_PASSWORD / GITEA_PASSWORD into a git command line argument or URL", () => {
      const files = [
        { path: JOB_YAML_PATH, content: jobYaml },
        { path: BUILD_SCRIPT_PATH, content: buildScript },
      ];

      for (const { path, content } of files) {
        const lines = content.split("\n");
        const gitArgOffenders = lines
          .map((line, idx) => ({ line: line.trim(), lineNum: idx + 1 }))
          .filter(({ line }) => {
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
      const pushUrlLine = buildScript.split("\n").find((line) => line.includes("PUSH_URL="));
      expect(pushUrlLine).toBeDefined();
      expect(pushUrlLine).not.toMatch(GITEA_PASSWORD_VAR_REGEX);
      expect(pushUrlLine).toMatch(/\$\{GITEA_ADMIN_USER\}@/);
    });

    it("never echoes GITEA_ADMIN_PASSWORD / GITEA_PASSWORD to stdout", () => {
      // In job yaml: no echo/printf references the password at all
      const jobLines = jobYaml.split("\n");
      const jobEchoOffenders = jobLines
        .map((line, idx) => ({ line: line.trim(), lineNum: idx + 1 }))
        .filter(({ line }) => /\b(echo|printf)\b/.test(line) && GITEA_PASSWORD_VAR_REGEX.test(line));
      expect(jobEchoOffenders, `Job yaml echoes password: ${JSON.stringify(jobEchoOffenders)}`).toEqual([]);

      // In scripts/kaniko-build.sh:
      // No echo referencing the password anywhere
      const scriptLines = buildScript.split("\n");
      const scriptEchoOffenders = scriptLines
        .map((line, idx) => ({ line: line.trim(), lineNum: idx + 1 }))
        .filter(({ line }) => /\becho\b/.test(line) && GITEA_PASSWORD_VAR_REGEX.test(line));
      expect(scriptEchoOffenders, `Build script uses echo with password: ${JSON.stringify(scriptEchoOffenders)}`).toEqual([]);

      // The only allowed printf referencing password is inside the ASKPASS_SCRIPT heredoc
      // (which writes to the chmod 700 file, not stdout)
      const scriptPrintfLines = scriptLines
        .map((line, idx) => ({ line: line.trim(), lineNum: idx + 1 }))
        .filter(({ line }) => /\bprintf\b/.test(line) && GITEA_PASSWORD_VAR_REGEX.test(line));

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
