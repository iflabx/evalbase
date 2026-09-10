import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = `${root}/THIRD_PARTY_NOTICES.md`;
const packages = new Map();

for (const path of ["package-lock.json", "frontend-v3/package-lock.json"]) {
  const lock = JSON.parse(await readFile(`${root}/${path}`, "utf8"));
  for (const [key, value] of Object.entries(lock.packages ?? {})) {
    if (!key.includes("node_modules/")) continue;
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    packages.set(`${name}@${value.version}`, value.license ?? "UNKNOWN");
  }
}

const rows = [...packages]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([name, license]) => `| \`${name}\` | ${license} |`);
const content = `# Third-Party Notices\n\nEvalBase does not distribute \`node_modules\` or third-party binaries. Dependencies are resolved from the checked-in npm lockfiles. This generated inventory records the SPDX license metadata supplied by those lockfiles.\n\n| Package | License |\n| --- | --- |\n${rows.join("\n")}\n`;

if (process.argv.includes("--check")) {
  if ((await readFile(output, "utf8")) !== content)
    throw new Error("THIRD_PARTY_NOTICES.md is stale; run npm run licenses:generate");
} else {
  await writeFile(output, content);
}
