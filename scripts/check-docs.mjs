import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
const tracked = new Set(files);
const problems = [];
for (const file of files.filter((f) => f.endsWith(".md"))) {
  const text = readFileSync(
    new URL(file, new URL("../", import.meta.url)),
    "utf8",
  );
  let inFence = false;
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const match of line.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/gu)) {
      let href = match[1].split(/\s+"/u)[0].replace(/^<|>$/gu, "");
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(href)) continue;
      try {
        href = decodeURIComponent(href.split("#")[0]);
      } catch {
        problems.push(`${file}:${index + 1}: invalid link encoding`);
        continue;
      }
      if (!href) continue;
      const target = posix.normalize(posix.join(dirname(file), href));
      if (
        !tracked.has(target) &&
        !files.some((f) => f.startsWith(target.replace(/\/$/u, "") + "/"))
      )
        problems.push(`${file}:${index + 1}: untracked link target ${target}`);
    }
  }
  if (inFence) problems.push(`${file}: unclosed fenced code block`);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    "docs:check passed: public tracked Markdown links and fences; private acceptance ledgers are not required",
  );
