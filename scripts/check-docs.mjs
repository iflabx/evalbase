import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const issueDir = join(root, ".scratch/phase1a-test-data-management/issues");
const progressPath = join(root, "docs/agents/phase1a-progress.md");
const stalePhrases = [
  "does not yet contain the Phase 1A application implementation",
  "Gate 当前为 `Pending`",
  "Ticket 01 remains under the Project Owner's explicit execution hold",
  "本 Ticket 尚未开始",
  "当前测试结果 | 尚未执行",
  "硬件参数尚未记录",
  "当前实现状态 | Tickets 01–05 已完成；Tickets 06–17 尚未开始",
  "当前测试结果 | Tickets 01–05 已有各自 Ticket Comments",
  "本仓库当前已完成 Tickets 01–05",
  "Tickets 01–05 的局部测试",
  "Implementation: Tickets 01–05 completed; Tickets 06–17 not-started",
];

function fail(message) {
  throw new Error(message);
}

function commitExists(sha) {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const progress = await readFile(progressPath, "utf8");
const issueNames = (await readdir(issueDir))
  .filter((name) => /^\d\d-.*\.md$/u.test(name))
  .sort();
if (!issueNames.length) {
  fail("expected at least one Ticket file");
}
for (const [index, name] of issueNames.entries()) {
  const expected = String(index + 1).padStart(2, "0");
  if (!name.startsWith(`${expected}-`)) {
    fail(
      `Ticket files must be contiguous from 01; expected ${expected}, found ${name}`,
    );
  }
}

const progressRows = new Map();
for (const match of progress.matchAll(
  /^\|\s*(\d\d)\s*\|\s*(completed|in-progress|not-started)\s*\|\s*(?:`([0-9a-f]{7,40})`|-)\s*\|$/gmu,
)) {
  progressRows.set(match[1], {
    implementation: match[2],
    commit: match[3] ?? null,
  });
}
if (progressRows.size !== issueNames.length) {
  fail(
    `expected ${issueNames.length} progress rows, found ${progressRows.size}`,
  );
}

for (const name of issueNames) {
  const ticket = await readFile(join(issueDir, name), "utf8");
  const number = name.slice(0, 2);
  const status = ticket.match(
    /^Status: (needs-triage|needs-info|ready-for-agent|ready-for-human|wontfix)$/mu,
  )?.[1];
  const implementation = ticket.match(
    /^Implementation: (completed|in-progress|not-started)$/mu,
  )?.[1];
  const row = progressRows.get(number);
  if (!status) fail(`${name}: missing or unsupported Status field`);
  if (!implementation) fail(`${name}: missing Implementation field`);
  if (!row || row.implementation !== implementation) {
    fail(`${name}: Implementation does not match ${progressPath}`);
  }
  if (implementation === "completed") {
    const comments = ticket.split(/^## Comments\s*$/mu)[1];
    if (!comments || !row.commit || !comments.includes(row.commit)) {
      fail(`${name}: Comments must reference the progress commit SHA`);
    }
    if (!row.commit || !commitExists(row.commit)) {
      fail(`${name}: progress commit does not exist in Git`);
    }
  } else if (implementation === "not-started" && row.commit) {
    fail(
      `${name}: not-started Ticket must not have a commit in progress ledger`,
    );
  } else if (implementation === "in-progress" && row.commit && !commitExists(row.commit)) {
    fail(`${name}: in-progress Ticket references a missing commit`);
  }
}

const documents = [
  "AGENTS.md",
  "README.md",
  "docs/PRD-evalbase-v1.md",
  "docs/architecture/phase1a-architecture.md",
  "docs/reviews/phase1a-solo-owner-decision-record.md",
  "docs/reviews/phase1a-nonproduction-server-development-gate.md",
  "docs/test-plan-phase1a.md",
  "docs/agents/ticket-review-protocol.md",
  ".scratch/phase1a-test-data-management/spec.md",
];
const progressReference = "docs/agents/phase1a-progress.md";
const staleTicketRange =
  /(?:through Ticket\s+\d\d|Tickets\s+\d\d\s*(?:–|-)\s*\d\d)/iu;
const staleLifecycleRange =
  /当前 Ticket\s+\d\d\s*(?:–|-)\s*\d\d\s+已完成.*?Ticket\s+\d\d\s*(?:–|-)\s*\d\d\s+尚未开始/su;
for (const relative of documents) {
  const content = await readFile(join(root, relative), "utf8");
  for (const phrase of stalePhrases) {
    if (content.includes(phrase)) {
      fail(`${relative}: stale phrase: ${phrase}`);
    }
  }
  if (staleLifecycleRange.test(content))
    fail(`${relative}: stale hardcoded Ticket lifecycle range`);
}

for (const relative of ["AGENTS.md", "README.md"]) {
  const content = await readFile(join(root, relative), "utf8");
  if (!content.includes(progressReference)) {
    fail(`${relative}: must reference ${progressReference}`);
  }
  const staleRange = content.match(staleTicketRange)?.[0];
  if (staleRange) {
    fail(
      `${relative}: stale hardcoded Ticket range "${staleRange}"; use ${progressReference} instead`,
    );
  }
}

if (
  !(await readFile(join(root, "AGENTS.md"), "utf8")).includes(
    "docs/agents/ticket-review-protocol.md",
  )
) {
  fail("AGENTS.md must reference the Ticket review protocol");
}

const gate = await readFile(
  join(root, "docs/reviews/phase1a-nonproduction-server-development-gate.md"),
  "utf8",
);
if (!/\| Gate 状态 \| \*\*Passed\*\* \|/u.test(gate)) {
  fail("Gate record is not Passed");
}

console.log(
  `docs:check passed: ${issueNames.length} Ticket lifecycle rows, commit references, Gate state, and stale-status phrases`,
);
