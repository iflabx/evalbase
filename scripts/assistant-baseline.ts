// Serial, synthetic cases. Controlled mode checks contracts; real mode measures the model.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const cases = [
  [
    "A1",
    "这份资料有多少条，包含哪些字段？",
    "aggregates and filters all 100 records",
  ],
  [
    "A2",
    "先帮我设计整理方案，先不执行。",
    "keeps a saved plan inactive|OPT-23 reuses verified background definitions",
  ],
  [
    "A3",
    "清理首尾空白，其他内容不变。",
    "runs processing and selection tools against real domain services",
  ],
  [
    "A4",
    "参考这些问题扩写8条，保持已有分类。",
    "repairs a missing processing scope",
  ],
  [
    "A5",
    "只把勾选的两条改得自然些，答案不变。",
    "prepares a short selection and reuses only that frozen scope|OPT-25 refines two cross-batch",
  ],
  [
    "A6",
    "改成4条，保留原问题和答案。",
    "replaces current requirements without losing history",
  ],
  [
    "A7",
    "继续沿用刚才的资料和要求。",
    "submits a real operation after seven bounded source reads|OPT-23 rebuilds current source facts|OPT-23 keeps selected older metadata candidates",
  ],
  [
    "A8",
    "按附件分类，保留原问题和答案。",
    "classifies in the worker then selects and reviews candidates|OPT-23 reuses verified background definitions",
  ],
  [
    "A9",
    "查询资料。",
    "OPT-25 reconciles|OPT-25 rolls back|OPT-22|OPT-21|OPT-20 classifies provider failure|OPT-20 preserves completed operations|repairs missing prerequisites and a no-effect scope failure|keeps an unknown write bound when replanning|stops budget continuation when new query arguments",
  ],
  [
    "A10",
    "采用全部结果，准备发布。",
    "requires a bound explicit confirmation|OPT-25 partially adopts|OPT-25 rejects",
  ],
] as const;
const arg = (key: string, fallback: string) =>
  process.argv
    .find((x) => x.startsWith(`--${key}=`))
    ?.split("=")
    .slice(1)
    .join("=") ?? fallback;
const mode = arg("mode", "controlled");
assert(
  ["controlled", "real"].includes(mode),
  "mode must be controlled or real",
);
const selectedIds = arg("cases", "A1,A2,A3,A4,A5,A6,A7,A8,A9,A10").split(",");
assert(
  selectedIds.every((id) => cases.some(([key]) => key === id)),
  "unknown case",
);
const repeatCases = new Set(arg("repeat-cases", "").split(",")),
  repeat = Number(arg("repeat", "1"));
assert(
  Number.isSafeInteger(repeat) && repeat >= 1 && repeat <= 3,
  "repeat must be between 1 and 3",
);
const selected = cases
  .filter(([id]) => selectedIds.includes(id))
  .flatMap((item) =>
    Array.from(
      { length: mode === "real" && repeatCases.has(item[0]) ? repeat : 1 },
      () => item,
    ),
  );
const integration200 = arg("integration", "") === "200";
assert(
  !integration200 || (mode === "real" && selectedIds.join(",") === "A2"),
  "integration=200 requires real A2 only",
);
const output = resolve(
  arg("output", ".scratch/assistant-optimization/opt20-baseline.json"),
);
const sourceRoot = resolve(process.env.BASELINE_SOURCE_ROOT ?? ".");
const version = process.env.GIT_SHA ?? "unknown";
const report: any = {
  format: "assistant-baseline-v1",
  caseDefinitionsHash: createHash("sha256")
    .update(JSON.stringify(cases))
    .digest("hex"),
  mode,
  codeVersion: version,
  fixtureVersion:
    mode === "real"
      ? integration200
        ? "synthetic-orders-200-v1"
        : "synthetic-eight-v1"
      : "public-contract-fixtures-v1",
  promptVersion: "assistant-prompt-v5",
  toolsVersion: "assistant-tools-v4",
  startedAt: new Date().toISOString(),
  results: [],
};
const details: any[] = [];
function save() {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
}
// The fixed mapping reuses the existing HTTP/DB/provider fixtures. It is not a real-model success rate.
if (mode === "controlled") {
  report.inputHash = createHash("sha256")
    .update(
      readFileSync(
        resolve(sourceRoot, "tests/integration/project-assistant.test.ts"),
      ),
    )
    .digest("hex");
  for (const [id, , pattern] of selected) {
    const temporary = `${output}.${id}.vitest.json`;
    const started = Date.now();
    const run = spawnSync(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        "tests/integration/project-assistant.test.ts",
        "--exclude",
        "**/.scratch/**",
        "-t",
        ["A3", "A9", "A10"].includes(id)
          ? `uses real SDK tool calls and keeps one active turn|${id === "A3" ? "requires a bound explicit confirmation|" : ""}${pattern}`
          : pattern,
        "--reporter=json",
        `--outputFile=${temporary}`,
      ],
      { cwd: sourceRoot, stdio: "ignore", timeout: 180_000 },
    );
    let summary: any;
    try {
      summary = JSON.parse(readFileSync(temporary, "utf8"));
    } catch {
      /* bounded fixture failed before reporting */
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        /* no partial report */
      }
    }
    report.results.push({
      id,
      contractPassed: run.status === 0 && summary?.numPassedTests > 0,
      assertions: summary?.numPassedTests ?? 0,
      goalCompleted: null,
      durationMs: Date.now() - started,
      userPrompts: null,
      automaticRepairs: null,
      userClarifications: null,
      semanticCorrections: null,
      reason:
        run.status === 0
          ? "controlled_contract_only"
          : "controlled_fixture_failed",
    });
    save();
  }
  console.log(
    JSON.stringify({
      output,
      cases: report.results.length,
      contractsPassed: report.results.filter((r: any) => r.contractPassed)
        .length,
    }),
  );
  if (report.results.some((r: any) => !r.contractPassed)) process.exitCode = 1;
} else {
  // BASELINE_MODEL_FILE contains the encrypted connection row copied read-only by the operator.
  // No endpoint, credential, source text or model reply is written to the report.
  assert(
    process.env.BASELINE_MODEL_FILE,
    "real mode requires an isolated model configuration file",
  );
  const moduleAt = async (file: string) =>
    import(pathToFileURL(resolve(sourceRoot, file)).href);
  const [
    { createPool },
    { migrate },
    { loadConfig },
    { buildApp },
    { runProcessing },
    { ArtifactRepository },
  ] = await Promise.all([
    moduleAt("src/db/pool.ts"),
    moduleAt("src/db/migrate.ts"),
    moduleAt("src/config.ts"),
    moduleAt("src/server/app.ts"),
    moduleAt("src/processing/execute.ts"),
    moduleAt("src/storage/artifacts.ts"),
  ]);
  const settings = loadConfig();
  const databaseName = `opt20_baseline_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(settings.databaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const root = createPool(settings.databaseUrl);
  await root.query(`CREATE DATABASE ${databaseName}`);
  const config = {
    ...settings,
    databaseUrl: databaseUrl.href,
    gitSha: version,
    soloOwnerMode: false,
    allowTestIdentity: false,
    minio: {
      ...settings.minio,
      bucket: `agent-${databaseName.replaceAll("_", "-")}`,
    },
  };
  let app: any, db: any;
  const artifacts = new ArtifactRepository(config.minio);
  try {
    await migrate(config.databaseUrl);
    db = createPool(config.databaseUrl);
    app = await buildApp(config, { disableLegacyTestBootstrap: true });
    const account = {
      email: "baseline@example.test",
      password: randomUUID() + "Aa1!",
      displayName: "隔离基线",
    };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/installation/administrator",
          headers: { origin: config.appOrigin },
          payload: { ...account, confirmPassword: account.password },
        })
      ).statusCode,
      201,
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: config.appOrigin },
      payload: account,
    });
    assert.equal(login.statusCode, 200);
    const headers = {
      origin: config.appOrigin,
      cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
      "x-csrf-token": login.json().csrfToken,
    };
    async function call(method: string, url: string, payload?: any) {
      const result = await app.inject({
        method,
        url,
        headers: { ...headers, "idempotency-key": randomUUID() },
        ...(payload === undefined ? {} : { payload }),
      });
      assert(result.statusCode < 400, `http_${result.statusCode}`);
      return result.json();
    }
    const model = JSON.parse(
      readFileSync(process.env.BASELINE_MODEL_FILE!, "utf8"),
    );
    report.modelRevision = model.revision;
    report.model = model.model;
    await db.query(
      "INSERT INTO model_connection(revision,name,endpoint,model,enabled,credential,updated_by) VALUES($1,$2,$3,$4,$5,$6,(SELECT id FROM app_user WHERE email='baseline@example.test'))",
      [
        model.revision,
        model.name,
        model.endpoint,
        model.model,
        model.enabled,
        model.credential,
      ],
    );
    const projectId = (
      await call("POST", "/api/projects", { name: "OPT20隔离基线" })
    ).project.id;
    const drafts = `/api/projects/${projectId}/collaborative-drafts`,
      base = `/api/projects/${projectId}/assistant`;
    let rows = [
      "退款什么时候到账？",
      "退款需要几天？",
      "价格是多少？",
      "为什么收服务费？",
      "我想退货。",
      "退款到哪里了？",
      "月费多少？",
      "年费有优惠吗？",
    ].map((q, i) => ({
      question: `  ${q}  `,
      expectedOutput: `原答案${i}`,
      metadata: [{ key: "类别", value: i % 4 < 2 ? "进度" : "费用" }],
    }));
    if (integration200) {
      const templates = rows;
      rows = Array.from({ length: 200 }, (_, i) => ({
        ...templates[i % 8]!,
        question: `  第${i + 1}笔订单：${templates[i % 8]!.question.trim()}  `,
      }));
    }
    report.inputHash = createHash("sha256")
      .update(JSON.stringify(rows))
      .digest("hex");
    for (const [id, prompt] of selected) {
      if (id === "A9") {
        report.results.push({
          id,
          skipped: true,
          reason: "fault_injection_uses_controlled_mode",
        });
        save();
        continue;
      }
      const started = Date.now();
      let state: any,
        path = "",
        userPrompts = 0,
        clarifications = 0;
      async function drive() {
        const deadline = Date.now() + 180_000;
        let stable = 0;
        while (Date.now() < deadline) {
          state = await call("GET", path);
          for (const runId of state.task?.runIds ??
            (state.task?.runId ? [state.task.runId] : [])) {
            const job = (
              await db.query(
                "UPDATE job SET status='running',attempt=attempt+1,lease_owner='opt20-baseline',lease_expires_at=now()+interval '5 minutes' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) AND status IN('queued','retry_wait') RETURNING *",
                [runId],
              )
            ).rows[0];
            if (!job) continue;
            try {
              const result = await runProcessing(db, artifacts, config, job);
              await db.query(
                "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
                [job.id, result],
              );
            } catch {
              await db.query(
                "UPDATE job SET status='failed',error_code='baseline_worker_failed' WHERE id=$1",
                [job.id],
              );
            }
          }
          const active = state.turns.some((t: any) =>
            ["queued", "running"].includes(t.status),
          );
          stable =
            !active &&
            [
              "awaiting_review",
              "awaiting_confirmation",
              "waiting_input",
              "planning",
              "complete",
              "failed",
              "stopped",
            ].includes(state.task?.stage)
              ? stable + 1
              : 0;
          if (stable >= 4) {
            if (state.task?.question) clarifications++;
            return;
          }
          await delay(500);
        }
        throw new Error("baseline_timeout");
      }
      async function send(message: string, extra: any = {}) {
        userPrompts++;
        await call("POST", `${path}/turns`, { message, ...extra });
        await drive();
      }
      const candidates = async () => {
        const rows = [];
        for (let offset = 0; ; offset += 100) {
          const page = await call(
            "GET",
            `${path}/candidates?scope=task&limit=100&offset=${offset}`,
          );
          rows.push(...page.records);
          if (rows.length >= page.total) return rows;
        }
      };
      let businessReplies = 0;
      let retriedNoEffectTurn: string | undefined;
      let approvedFields: string[] | undefined;
      let assertionCode: string | null = null;
      let goalCompleted = false,
        reason = "goal_not_reached";
      try {
        const source = (await call("POST", drafts, { name: `基线${id}资料` }))
          .draft.id;
        for (const row of rows)
          await call("POST", `${drafts}/${source}/records`, row);
        path = `${base}/sessions/${(await call("POST", `${base}/sessions`, {})).sessionId}`;
        const context = { kind: "draft", id: source };
        if (id === "A8")
          await call("POST", `${path}/background-documents`, {
            fileName: "两类要求.md",
            contentBase64: Buffer.from(
              "分类依据：进度指退款到账、退货和退款进度；费用指价格、服务费、月费和年费。仅新增Metadata「主题」分类，保留原问题、答案和原Metadata。",
            ).toString("base64"),
          });
        if (["A5", "A6", "A7", "A10"].includes(id)) {
          await send("清理首尾空白，其他内容不变。", { context });
          assert.equal(
            (await candidates()).length,
            8,
            "initial_cleanup_incomplete",
          );
        }
        if (id === "A5") {
          const before = await candidates();
          assert(before.length >= 2, "precondition_candidates_missing");
          const selection = await call(
            "GET",
            `${path}/candidates?scope=task&limit=100`,
          );
          await send(prompt, {
            candidates: {
              scope: "task",
              reviewRevision: selection.reviewRevision,
              resultIds: before.slice(0, 2).map((r: any) => r.id),
            },
          });
          if (state.task?.question) {
            businessReplies++;
            await send("我已勾选两条，按日常说话的方式改写，答案和分类不变。");
          }
          const after = await candidates();
          goalCompleted =
            after.length === 8 &&
            after.every((r: any) =>
              rows.some(
                (row) => row.expectedOutput === r.result.expectedOutput,
              ),
            ) &&
            before
              .slice(2)
              .every((r: any) =>
                after.some(
                  (s: any) =>
                    s.id === r.id &&
                    JSON.stringify([
                      r.result.question,
                      r.result.expectedOutput,
                      r.result.metadata,
                    ]) ===
                      JSON.stringify([
                        s.result.question,
                        s.result.expectedOutput,
                        s.result.metadata,
                      ]),
                ),
              ) &&
            before
              .slice(0, 2)
              .every((r: any) =>
                after.some(
                  (s: any) =>
                    s.id === r.id &&
                    s.result.expectedOutput === r.result.expectedOutput &&
                    JSON.stringify(s.result.metadata) ===
                      JSON.stringify(r.result.metadata) &&
                    s.result.question !== r.result.question,
                ),
              );
        } else if (id === "A7") {
          const beforeRows = await candidates();
          const facts = (task: any) =>
            JSON.stringify(
              Object.fromEntries(
                [
                  "requirements",
                  "processingScope",
                  "targetCount",
                  "countKind",
                  "targetDraftId",
                  "allowedLabels",
                  "classifications",
                  "allowedFields",
                  "metadataKeys",
                ].map((key) => [key, task?.[key] ?? null]),
              ),
            );
          const constraints = facts(state.task);
          const runCount = (
            await db.query(
              "SELECT count(*) FROM processing_run WHERE project_id=$1",
              [projectId],
            )
          ).rows[0].count;
          for (let n = 0; n < 7; n++) await send("当前资料有多少条？");
          await send("继续沿用刚才的资料和要求，只核对结果，别生成新数据。");
          const afterRows = await candidates();
          goalCompleted =
            beforeRows.length === 8 &&
            afterRows.length === 8 &&
            beforeRows.every((r: any) =>
              afterRows.some(
                (s: any) =>
                  s.id === r.id &&
                  JSON.stringify(s.result) === JSON.stringify(r.result),
              ),
            ) &&
            facts(state.task) === constraints &&
            (
              await db.query(
                "SELECT count(*) FROM processing_run WHERE project_id=$1",
                [projectId],
              )
            ).rows[0].count === runCount;
        } else if (id === "A10") {
          await send("采用全部结果新建测试集，准备发布。");
          const adoption = state.proposals.find(
            (p: any) => p.action === "processing" && p.status === "pending",
          );
          assert(adoption, "adoption_confirmation_missing");
          const receipt = await call(
            "POST",
            `${base}/proposals/${adoption.id}/confirm`,
            {},
          );
          assert.deepEqual(
            (await call("POST", `${base}/proposals/${adoption.id}/confirm`, {}))
              .receipt,
            receipt.receipt,
          );
          await drive();
          if (
            !state.proposals.some(
              (p: any) => p.action === "publish" && p.status === "pending",
            )
          )
            await send("发布刚才的测试集。");
          const proposal = state.proposals.find(
            (p: any) => p.action === "publish" && p.status === "pending",
          );
          assert(proposal, "publication_confirmation_missing");
          const published = await call(
            "POST",
            `${base}/proposals/${proposal.id}/confirm`,
            {},
          );
          assert.deepEqual(
            (await call("POST", `${base}/proposals/${proposal.id}/confirm`, {}))
              .receipt,
            published.receipt,
          );
          goalCompleted =
            Number(
              (
                await db.query(
                  "SELECT count(*) FROM test_set_version v JOIN test_set s ON s.id=v.test_set_id WHERE s.project_id=$1",
                  [projectId],
                )
              ).rows[0].count,
            ) === 1;
        } else {
          const runsBeforePlanning =
            id === "A2"
              ? (
                  await db.query(
                    "SELECT count(*) FROM processing_run WHERE project_id=$1",
                    [projectId],
                  )
                ).rows[0].count
              : undefined;
          await send(prompt, { context });
          if (id === "A2") {
            if (
              state.task?.question ||
              !(state.task?.executionPlan?.steps ?? []).some((step: any) =>
                ["submit_processing", "refine_candidates"].includes(
                  step.action,
                ),
              )
            ) {
              businessReplies++;
              await send(
                "先只整理首尾空白，保留问题、答案和分类，仍先给方案。",
              );
            }
            assert.equal(
              state.task?.executionPlan?.mode,
              "plan",
              "plan_mode_missing",
            );
            assert.equal(
              (
                await db.query(
                  "SELECT count(*) FROM processing_run WHERE project_id=$1",
                  [projectId],
                )
              ).rows[0].count,
              runsBeforePlanning,
              "plan_executed_early",
            );
            approvedFields = [...(state.task?.allowedFields ?? ["question"])];
            await send("按方案执行。");
            if (state.task?.question && businessReplies === 0) {
              businessReplies++;
              await send("是，按刚才方案执行，保留答案和分类。");
            }
          }
          if (
            id === "A6" &&
            (state.task?.question || (await candidates()).length !== 4)
          ) {
            businessReplies++;
            await send("随机从已有候选中保留4条，其他内容不要改。");
          }
          if (id === "A4" && state.task?.error === "processing_scope_invalid") {
            const failed = state.turns.at(-1);
            if (
              failed?.tools.some(
                (tool: any) =>
                  tool.status === "failed" &&
                  tool.error?.code === "processing_scope_invalid" &&
                  tool.effect === "none",
              )
            ) {
              retriedNoEffectTurn = failed.id;
              businessReplies++;
              await send("参考当前草稿的全部问题扩写8条，保持已有分类。");
            }
          }
          if (id === "A1") {
            const receipts = state.turns
              .flatMap((t: any) => t.tools)
              .filter((r: any) => r.status === "succeeded");
            const currentCount = (
              await db.query(
                "SELECT count(*)::int AS total FROM collaborative_draft_record WHERE draft_id=$1 AND NOT deleted",
                [source],
              )
            ).rows[0].total;
            const correctStatistic = receipts.some(
              (r: any) =>
                (r.name === "read_records" &&
                  r.input?.source?.id === source &&
                  r.result?.total === 8) ||
                (r.name === "query_project" &&
                  r.result?.items?.some(
                    (item: any) => item.id === source && item.recordCount === 8,
                  )),
            );
            goalCompleted =
              currentCount === 8 &&
              correctStatistic &&
              receipts.every((r: any) =>
                [
                  "query_project",
                  "read_records",
                  "read_background",
                  "read_processing",
                  "plan_task",
                ].includes(r.name),
              ) &&
              receipts
                .filter((r: any) => r.name === "read_records")
                .every(
                  (r: any) =>
                    r.input?.source?.kind === "draft" &&
                    r.input?.source?.id === source,
                ) &&
              state.turns.some(
                (t: any) =>
                  /(?:\b8\b|八)\s*条/.test(t.assistantText ?? "") &&
                  /(question|问题)/i.test(t.assistantText) &&
                  /(expected.?output|期望输出)/i.test(t.assistantText) &&
                  /metadata/i.test(t.assistantText),
              );
          } else {
            const outputRows = await candidates();
            const expected = id === "A6" ? 4 : rows.length;
            goalCompleted = outputRows.length === expected;
            if (id === "A2") {
              // "Design a tidy-up plan" may include a proposed classification.
              // Check the approved field contract, not a hidden trim-only plan.
              const allowed = approvedFields ?? ["question"];
              goalCompleted &&=
                !state.task?.question &&
                outputRows.every((r: any) => {
                  const original = rows.find(
                    (row) => row.expectedOutput === r.result.expectedOutput,
                  );
                  return (
                    original &&
                    (allowed.includes("question") ||
                      original.question === r.result.question) &&
                    (allowed.includes("metadata") ||
                      JSON.stringify(original.metadata) ===
                        JSON.stringify(r.result.metadata))
                  );
                }) &&
                !state.task?.review?.protectedFieldChanges;
            }
            if (["A3", "A6"].includes(id))
              goalCompleted &&= outputRows.every((r: any) =>
                rows.some(
                  (row) =>
                    r.result.question === row.question.trim() &&
                    r.result.expectedOutput === row.expectedOutput &&
                    JSON.stringify(r.result.metadata) ===
                      JSON.stringify(row.metadata),
                ),
              );
            if (id === "A4")
              goalCompleted &&=
                outputRows.every(
                  (r: any) =>
                    !rows.some(
                      (row) => row.question.trim() === r.result.question.trim(),
                    ) &&
                    r.result.metadata.some(
                      (m: any) =>
                        m.key === "类别" && ["进度", "费用"].includes(m.value),
                    ),
                ) &&
                new Set(outputRows.map((r: any) => r.result.question.trim()))
                  .size === 8;
            if (id === "A8")
              goalCompleted &&= outputRows.every((r: any) =>
                rows.some(
                  (row) =>
                    r.result.question === row.question &&
                    r.result.expectedOutput === row.expectedOutput &&
                    row.metadata.every((m) =>
                      r.result.metadata.some(
                        (n: any) => n.key === m.key && n.value === m.value,
                      ),
                    ) &&
                    r.result.metadata.some(
                      (m: any) =>
                        m.key === "主题" && m.value === row.metadata[0].value,
                    ),
                ),
              );
          }
        }
        if (integration200) {
          assert(goalCompleted, "integration_cleanup_failed");
          const before = await call(
            "GET",
            `${path}/candidates?scope=task&limit=100`,
          );
          const later = await call(
            "GET",
            `${path}/candidates?scope=task&offset=100&limit=100`,
          );
          const all = [...before.records, ...later.records],
            chosen = [all[0].id, all.at(-1).id];
          assert.equal(all.length, 200, "integration_collection_count");
          assert.equal(
            new Set(all.map((row) => row.id)).size,
            200,
            "integration_identity_count",
          );
          await send("这两条改得更口语化，答案和Metadata保留。", {
            candidates: {
              scope: "task",
              reviewRevision: before.reviewRevision,
              resultIds: chosen,
            },
          });
          const current = [
            ...(await call("GET", `${path}/candidates?scope=task&limit=100`))
              .records,
            ...(
              await call(
                "GET",
                `${path}/candidates?scope=task&offset=100&limit=100`,
              )
            ).records,
          ];
          assert.equal(current.length, 200, "integration_refinement_count");
          for (const row of current) {
            const original = all.find((old) => old.id === row.id);
            assert(original, "integration_stable_identity");
            assert.equal(
              row.result.expectedOutput,
              original.result.expectedOutput,
              "integration_answer_protection",
            );
            assert.deepEqual(
              row.result.metadata,
              original.result.metadata,
              "integration_metadata_protection",
            );
            assert(
              chosen.includes(row.id)
                ? row.result.question !== original.result.question
                : row.result.question === original.result.question,
              "integration_selection_scope",
            );
          }
          writeFileSync(
            output + ".content.json",
            JSON.stringify(
              {
                syntheticOnly: true,
                selected: current
                  .filter((row) => chosen.includes(row.id))
                  .map((row) => ({
                    before: all.find((old) => old.id === row.id).result,
                    after: row.result,
                  })),
              },
              null,
              2,
            ),
          );
          await send("将全部成果保存回原草稿。", { candidates: null });
          const proposal = state.proposals.find(
            (p: any) => p.status === "pending" && p.action === "processing",
          );
          assert(proposal, "integration_confirmation_missing");
          assert.equal(
            proposal.summary.count,
            200,
            "integration_confirmation_scope",
          );
          const saved = await call(
            "POST",
            `${base}/proposals/${proposal.id}/confirm`,
            {},
          );
          assert.deepEqual(
            (await call("POST", `${base}/proposals/${proposal.id}/confirm`, {}))
              .receipt,
            saved.receipt,
            "integration_receipt_replay",
          );
          await drive();
          const actual = (
            await db.query(
              "SELECT id,question,expected_output,metadata,source FROM collaborative_draft_record WHERE draft_id=$1 AND NOT deleted",
              [source],
            )
          ).rows;
          assert.equal(actual.length, 200, "integration_saved_count");
          for (const row of current) {
            const persisted = actual.find(
              (item: any) =>
                item.id === (row.original?.baseline?.id ?? row.original?.id),
            );
            assert(persisted, "integration_original_draft_target");
            assert.equal(persisted.question, row.result.question);
            assert.equal(persisted.expected_output, row.result.expectedOutput);
            assert.deepEqual(persisted.metadata, row.result.metadata);
            assert(persisted.source, "integration_source_missing");
          }
          const savedPage = await call(
            "GET",
            `${path}/candidates?scope=task&limit=100`,
          );
          assert.equal(savedPage.savedCount, 200, "integration_delivery_count");
          await send("发布这个草稿。");
          const publishing = state.proposals.find(
            (p: any) => p.status === "pending" && p.action === "publish",
          );
          assert(publishing, "integration_publication_confirmation_missing");
          const published = await call(
            "POST",
            `${base}/proposals/${publishing.id}/confirm`,
            {},
          );
          assert.equal(
            published.receipt.version.recordCount,
            200,
            "integration_published_count",
          );
          await drive();
          goalCompleted = true;
          report.integration = {
            structurallyChecked: 200,
            unchangedResults: 198,
            modelRewritten: 2,
            semanticReview:
              "two_model_rows_pending_review; unchanged_198_preservation_verified",
            manualCorrections: 0,
            sourceReferencesChecked: 200,
          };
        }
        if (
          state.turns.some(
            (t: any) => t.status === "failed" && t.id !== retriedNoEffectTurn,
          )
        ) {
          goalCompleted = false;
          reason = "turn_failed";
        } else
          reason = goalCompleted
            ? "goal_assertions_passed"
            : "goal_not_reached";
      } catch (error) {
        // Only locally-defined assertion codes enter evidence, never provider exception strings.
        if (
          error instanceof assert.AssertionError &&
          /^[a-z_]+$/.test(error.message)
        )
          assertionCode = error.message;
        reason =
          error instanceof assert.AssertionError
            ? "goal_or_precondition_assertion_failed"
            : "baseline_execution_incomplete";
      }
      const turns = state?.turns ?? [];
      const parameterCodes = new Set([
        "assistant_tool_input_invalid",
        "processing_scope_invalid",
        "processing_configuration_invalid",
        "assistant_plan_count_conflict",
        "assistant_requirement_conflict",
        "assistant_plan_prerequisite_missing",
        "assistant_reference_invalid",
        "assistant_candidate_selection_invalid",
      ]);
      const toolParameterFailures = state?.turns
        ? state.turns.reduce(
            (total: number, t: any) =>
              total +
              t.tools.filter(
                (r: any) =>
                  r.status === "failed" && parameterCodes.has(r.error?.code),
              ).length,
            0,
          )
        : null;
      const toolParameterRecoveries = state?.turns
        ? state.turns.reduce(
            (total: number, t: any) =>
              total +
              t.tools.filter(
                (r: any, index: number) =>
                  r.status === "succeeded" &&
                  t.tools
                    .slice(0, index)
                    .some(
                      (prior: any) =>
                        prior.name === r.name &&
                        prior.status === "failed" &&
                        parameterCodes.has(prior.error?.code),
                    ),
              ).length,
            0,
          )
        : null;
      report.results.push({
        id,
        goalCompleted,
        sample: report.results.filter((item: any) => item.id === id).length + 1,
        toolParameterFailures,
        toolParameterRecoveries,
        reason,
        assertionCode,
        stage: state?.task?.stage ?? null,
        userPrompts,
        automaticRepairs: null,
        protocolRepairs: turns.every((t: any) =>
          Number.isInteger(t.diagnostics?.protocolRepairs),
        )
          ? turns.reduce(
              (sum: number, t: any) => sum + t.diagnostics.protocolRepairs,
              0,
            )
          : null,
        userClarifications: clarifications,
        extraBusinessPrompts: businessReplies,
        userRetriedNoEffectTurns: retriedNoEffectTurn ? 1 : 0,
        semanticCorrections: null,
        semanticReview: "pending_human_review",
        durationMs: Date.now() - started,
        turns: turns.map((t: any) => ({
          id: t.id,
          event: t.event,
          status: t.status,
          errorCode: t.errorCode,
          diagnostics: t.diagnostics
            ? {
                diagnosticId: t.diagnostics.diagnosticId ?? null,
                finishReason: t.diagnostics.finishReason,
                requestAttempts: t.diagnostics.requestAttempts ?? null,
                durationMs: t.diagnostics.durationMs,
                category: t.diagnostics.failure?.category ?? null,
              }
            : null,
        })),
      });
      // Only this script's synthetic database is read; keep review evidence apart
      // from the small baseline metrics, without any connection credentials.
      let reviewRows: any[] = [];
      if (state?.task?.runId) {
        try {
          reviewRows = await candidates();
        } catch {
          /* unavailable results remain a failure */
        }
      }
      details.push({
        id,
        sample: report.results.at(-1).sample,
        input: rows,
        task: state?.task,
        turns: state?.turns,
        records: integration200 ? reviewRows.slice(0, 20) : reviewRows,
      });
      writeFileSync(
        output + ".details.json",
        JSON.stringify(
          { syntheticOnly: true, codeVersion: version, cases: details },
          null,
          2,
        ),
      );
      save();
      console.log(
        JSON.stringify({ case: id, goalCompleted, reason, userPrompts }),
      );
    }
  } finally {
    save();
    await app?.close();
    for (const object of await artifacts.list(""))
      await artifacts.remove(object.key);
    if (await artifacts.client.bucketExists(artifacts.bucket))
      await artifacts.client.removeBucket(artifacts.bucket);
    await db?.end();
    await root.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    await root.end();
  }
}
