import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
const problems = [];
for (const path of files) {
  if (
    /^(?:\.scratch|local-acceptance-evidence|\.local|backups?|docs\/private)\//u.test(
      path,
    ) ||
    (/(?:^|\/)\.env(?:\..+)?$/u.test(path) && !path.endsWith(".env.example")) ||
    /(?:\.private\.|\.(?:dump|bundle|bak)$|(?:^|\/)id_(?:rsa|ed25519))/u.test(
      path,
    ) ||
    /(?:^|\/)compose\.(?:local|override)\.ya?ml$/u.test(path)
  ) {
    problems.push(`${path}: private/generated file is tracked`);
    continue;
  }
  const bytes = readFileSync(new URL(path, new URL("../", import.meta.url)));
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  // Conservative patterns: report locations only; never print credential values.
  const credential =
    /(?<![\w-])(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{25,}|github_pat_[A-Za-z0-9_]{25,}|hf_[A-Za-z0-9]{25,}|AKIA[0-9A-Z]{16})(?![\w-])|-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/u;
  const internal =
    /\/home\/[^\s/]+\/(?:EvalBase|AgentBench)(?:\/|\b)|[CD]:[\\/]Users[\\/][^\s\\/]+[\\/]|(?:project|assistant|conversation|processing|collabdraft)_[a-f0-9]{24,}/u;
  for (const [n, line] of text.split(/\r?\n/u).entries()) {
    if (credential.test(line))
      problems.push(`${path}:${n + 1}: possible credential`);
    if (!path.startsWith("tests/") && internal.test(line))
      problems.push(
        `${path}:${n + 1}: internal environment/acceptance identifier`,
      );
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `security:check passed: ${files.length} tracked files; location-only checks, not a full secret audit`,
  );
