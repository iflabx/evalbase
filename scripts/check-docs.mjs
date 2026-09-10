import { access, readdir, readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const forbidden = [
  ".scratch/",
  "frontend-v1/",
  "frontend-v2/",
  "src/web/",
  "/home/bistu",
  "121.194.33.35",
];

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return markdownFiles(path);
      return entry.name.endsWith(".md") ? [path] : [];
    }),
  );
  return nested.flat();
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const files = [
  ...(await markdownFiles(join(root, "docs"))),
  ...[
    "README.md",
    "README.zh-CN.md",
    "CONTRIBUTING.md",
    "CONTRIBUTING.zh-CN.md",
    "SECURITY.md",
    "SECURITY.zh-CN.md",
    "CODE_OF_CONDUCT.md",
    "CODE_OF_CONDUCT.zh-CN.md",
    "THIRD_PARTY_NOTICES.md",
    "docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html",
    "frontend-v3/README.md",
  ].map((path) => join(root, path)),
];

for (const file of files) {
  const content = await readFile(file, "utf8");
  for (const value of forbidden) {
    if (content.includes(value)) throw new Error(`${file}: forbidden ${value}`);
  }
  for (const match of content.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    const target = match[1];
    if (/^(?:https?:|mailto:)/.test(target)) continue;
    const resolved = normalize(join(file, "..", target));
    if (!(await exists(resolved))) throw new Error(`${file}: missing link ${target}`);
  }
}

console.log(`docs:check passed: ${files.length} public Markdown files`);
