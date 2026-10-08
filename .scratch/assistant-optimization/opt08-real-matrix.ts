// Bounded synthetic probe. Owner model settings are read only; all writes use a disposable test DB.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { parse as parseCsv } from "csv-parse/sync";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";
import { buildApp } from "../../src/server/app.js";
import { runProcessing } from "../../src/processing/execute.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";

const rootUrl = loadConfig().databaseUrl;
const databaseName = `opt08_real_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = rootUrl.replace(/\/[^/]+$/, `/${databaseName}`);
const privateEnv = Object.fromEntries(
  readFileSync(".scratch/agent-data-processing/checkpoint.env", "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1).trim()];
    }),
);
const inspected = JSON.parse(
  execFileSync(
    "docker",
    ["inspect", "evalbase-agent-owner-checkpoint-postgres-1"],
    { encoding: "utf8" },
  ),
)[0];
const pgEnv = Object.fromEntries(
  inspected.Config.Env.map((line: string) => {
    const i = line.indexOf("=");
    return [line.slice(0, i), line.slice(i + 1)];
  }),
);
const address = (
  Object.values(inspected.NetworkSettings.Networks)[0] as { IPAddress: string }
).IPAddress;
const ownerDb = createPool(
  `postgresql://${encodeURIComponent(pgEnv.POSTGRES_USER)}:${encodeURIComponent(pgEnv.POSTGRES_PASSWORD)}@${address}:5432/${pgEnv.POSTGRES_DB}`,
);
const model = (
  await ownerDb.query(
    "SELECT revision,name,endpoint,model,enabled,credential FROM model_connection ORDER BY revision DESC LIMIT 1",
  )
).rows[0];
await ownerDb.end();
assert(model?.enabled);
const root = createPool(rootUrl);
await root.query(`CREATE DATABASE ${databaseName}`);
await migrate(databaseUrl);
const config = {
  ...loadConfig(),
  databaseUrl,
  appOrigin: "http://127.0.0.1:4217",
  soloOwnerMode: false,
  allowTestIdentity: false,
  modelEncryptionKey: privateEnv.MODEL_ENCRYPTION_KEY,
  minio: {
    ...loadConfig().minio,
    bucket: `agent-${databaseName.replaceAll("_", "-")}`,
  },
};
const db = createPool(databaseUrl);
const app = await buildApp(config, { disableLegacyTestBootstrap: true });
type Row = {
  question: string;
  expectedOutput: string;
  metadata: { key: string; value: string }[];
};
const make = (
  question: string,
  expectedOutput = "原答案",
  metadata: Row["metadata"] = [],
) => ({ question, expectedOutput, metadata });
const cases = [
  {
    name: "清洗",
    prompt: "清理这份资料的首尾空白，其他内容不变，给我检查结果。",
    rows: Array.from({ length: 12 }, (_, i) =>
      make(
        i === 10 ? "" : i === 11 ? "  合成问题1  " : `  合成问题${i + 1}  `,
        `答案${i}`,
        [
          { key: "编号", value: String(i) },
          { key: "空值", value: "" },
        ],
      ),
    ),
  },
  {
    name: "改写",
    prompt: "把这组问法改得自然一些，原意和答案保持不变。",
    rows: [
      "退款能在3天内到账吗？",
      "我只要退1件，不是整单。",
      "周五18点后还可以取消吗？",
      "订单未发货时怎么改地址？",
      "满100元但不含运费，有优惠吗？",
      "已经使用过的优惠券能退吗？",
      "购买2年服务可以按月退款吗？",
      "我不想自动续费，该怎么关？",
      "没有发票可以报销吗？",
      "海外订单只有在签收后才能退货吗？",
    ].map((q) => make(q)),
  },
  {
    name: "意图扩写",
    prompt: "参考这些客服问题扩写12条，保持已有意图分类，表达多样一些。",
    rows: [
      make("订单什么时候发货？", "物流"),
      make("包裹到哪里了？", "物流"),
      make("我要申请退款。", "退款"),
      make("退货多久能到账？", "退款"),
      make("如何修改密码？", "账号"),
      make("账号无法登录怎么办？", "账号"),
    ].map((r) => ({
      ...r,
      metadata: [{ key: "意图", value: r.expectedOutput }],
    })),
  },
  {
    name: "实体提取",
    prompt:
      "从这10条句子提取城市和日期，放到Metadata，缺失留空，原句和答案不变。",
    rows: [
      "2026年10月8日去北京。",
      "明天到上海。",
      "我想去广州。",
      "2026-10-09没有行程。",
      "从北京经天津到上海，2026年10月10日出发。",
      "南京和南昌各停一天。",
      "2026年10月11日和2026年10月12日去深圳。",
      "没有城市和日期。",
      "2026年10月13日返回杭州。",
      "想去苏州，日期待定。",
    ].map((q) => make(q)),
  },
  {
    name: "背景分类",
    prompt: "按附件的类别整理这批记录，保留原文，然后每类选2条给我审核。",
    rows: [
      "多少钱？",
      "为什么收服务费？",
      "年费可以优惠吗？",
      "总价格怎么算？",
      "退款到哪了？",
      "多久到账？",
      "订单什么时候发货？",
      "处理进度在哪里？",
      "密码忘了。",
      "无法登录。",
      "修改手机号。",
      "怎么注销账号？",
    ].map((q) => make(q)),
    background:
      "分类依据：费用（价格、收费、优惠）；进度（退款到账、发货、处理进度）；账号（密码、登录、手机号、注销）。将类别放入Metadata「类别」，保留原问题、期望输出及其他Metadata。",
  },
];
try {
  const account = {
    email: "opt08@example.test",
    password: "Opt08Synth123",
    confirmPassword: "Opt08Synth123",
    displayName: "合成管理员",
  };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/installation/administrator",
        headers: { origin: config.appOrigin },
        payload: account,
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
  const headers = {
    origin: config.appOrigin,
    cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
    "x-csrf-token": login.json().csrfToken,
  };
  async function call(
    method: "GET" | "POST",
    url: string,
    payload?: any,
    key = randomUUID(),
  ) {
    const r = await app.inject({
      method,
      url,
      headers: { ...headers, "idempotency-key": key },
      ...(payload === undefined ? {} : { payload }),
    });
    assert(r.statusCode < 400, `${method} ${url}: ${r.body}`);
    return r.json();
  }
  const projectId = (
    await call("POST", "/api/projects", { name: "OPT08合成自动测试" })
  ).project.id;
  await db.query(
    "INSERT INTO model_connection(revision,name,endpoint,model,enabled,credential,updated_by) VALUES($1,$2,$3,$4,$5,$6,(SELECT id FROM app_user WHERE email='opt08@example.test'))",
    [
      model.revision,
      model.name,
      model.endpoint,
      model.model,
      model.enabled,
      model.credential,
    ],
  );
  const drafts = `/api/projects/${projectId}/collaborative-drafts`,
    base = `/api/projects/${projectId}/assistant`;
  async function drive(path: string) {
    const started = Date.now();
    let stable = 0;
    for (let n = 0; n < 1200; n++) {
      const state = await call("GET", path);
      for (const runId of state.task?.runIds ??
        (state.task?.runId ? [state.task.runId] : [])) {
        const job = (
          await db.query(
            "UPDATE job SET status='running',attempt=attempt+1,lease_owner='opt08-probe',lease_expires_at=now()+interval '5 minutes' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) AND status IN('queued','retry_wait') RETURNING *",
            [runId],
          )
        ).rows[0];
        if (!job) continue;
        const t = Date.now();
        try {
          const result = await runProcessing(
            db,
            new ArtifactRepository(config.minio),
            config,
            job,
          );
          await db.query(
            "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
            [job.id, result],
          );
          console.log("WORKER", JSON.stringify({ runId, ms: Date.now() - t }));
        } catch (e: any) {
          await db.query(
            "UPDATE job SET status='failed',error_code=$2 WHERE id=$1",
            [job.id, e.code ?? "probe_failed"],
          );
          console.log(
            "WORKER_FAILED",
            JSON.stringify({ runId, code: e.code ?? e.message }),
          );
        }
      }
      if (
        !state.turns.some((t: any) =>
          ["queued", "running"].includes(t.status),
        ) &&
        [
          "awaiting_review",
          "awaiting_confirmation",
          "waiting_input",
          "planning",
          "complete",
          "failed",
          "stopped",
        ].includes(state.task?.stage)
      )
        stable++;
      else stable = 0;
      if (stable >= 6) return { state, ms: Date.now() - started };
      await delay(500);
    }
    throw new Error("bounded probe timeout");
  }
  async function send(
    path: string,
    message: string,
    context?: { kind: string; id: string },
    candidates?: { runId: string; resultIds: string[] },
  ) {
    await call("POST", `${path}/turns`, {
      message,
      ...(context ? { context } : {}),
      ...(candidates ? { candidates } : {}),
    });
    return drive(path);
  }
  const report = [];
  for (const fixture of cases.filter(
    (x) =>
      !process.env.OPT08_CASES ||
      process.env.OPT08_CASES.split(",").includes(x.name),
  )) {
    const source = (
      await call("POST", drafts, { name: `合成${fixture.name}资料` })
    ).draft.id;
    for (const row of fixture.rows)
      await call("POST", `${drafts}/${source}/records`, row);
    const sessionId = (await call("POST", `${base}/sessions`, {})).sessionId,
      path = `${base}/sessions/${sessionId}`;
    if (fixture.background)
      await call("POST", `${path}/background-documents`, {
        fileName: "三类要求.md",
        contentBase64: Buffer.from(fixture.background).toString("base64"),
      });
    const first = await send(path, fixture.prompt, {
      kind: "draft",
      id: source,
    });
    const outputs = [];
    for (const runId of first.state.task?.runIds ??
      (first.state.task?.runId ? [first.state.task.runId] : []))
      outputs.push(
        await call("GET", `${path}/candidates?run=${runId}&limit=100`),
      );
    const item = {
      name: fixture.name,
      prompt: fixture.prompt,
      rows: fixture.rows,
      ...first,
      outputs,
      userPrompts: 1,
    };
    report.push(item);
    console.log("CASE", JSON.stringify(item));
    if (fixture.name === "改写" && outputs[0]?.records.length) {
      const edited = await send(
        path,
        "把勾选的问题改得更礼貌，其他记录和答案保持不变。",
        undefined,
        {
          runId: first.state.task.runId,
          resultIds: [outputs[0].records[0].id],
        },
      );
      console.log(
        "LOCAL_CHANGE",
        JSON.stringify({
          sessionId,
          ...edited,
          outputs: await call("GET", `${path}/candidates?limit=100`),
          userPrompts: 2,
        }),
      );
    }
  }
  const fixture = cases.find((x) => x.name === "背景分类")!;
  const source = (await call("POST", drafts, { name: "目标式请求资料" })).draft
    .id;
  for (const row of fixture.rows)
    await call("POST", `${drafts}/${source}/records`, row);
  const goalSession = (await call("POST", `${base}/sessions`, {})).sessionId,
    goalPath = `${base}/sessions/${goalSession}`;
  await call("POST", `${goalPath}/background-documents`, {
    fileName: "类别要求.md",
    contentBase64: Buffer.from(fixture.background!).toString("base64"),
  });
  const goal = await send(
    goalPath,
    "根据这批资料和附件，帮我准备6条测试数据，覆盖附件中的类别。你安排方法，直接整理成候选给我审核。",
    { kind: "draft", id: source },
  );
  console.log(
    "GOAL",
    JSON.stringify({
      ...goal,
      outputs: await call("GET", `${goalPath}/candidates?limit=100`),
      userPrompts: 1,
    }),
  );
  const corrected = await send(
    goalPath,
    "改成费用4条、进度和账号各1条，仍保留原问题和答案。",
  );
  console.log(
    "GOAL_CORRECTED",
    JSON.stringify({
      ...corrected,
      outputs: await call("GET", `${goalPath}/candidates?limit=100`),
      userPrompts: 2,
    }),
  );
  const audited = (await call("GET", `${goalPath}/candidates?limit=100`))
    .records;
  assert.equal(audited.length, 6);
  const counts: Record<string, number> = {};
  const category = (question: string) =>
    fixture.rows.findIndex((row) => row.question === question);
  for (const row of audited) {
    const i = category(row.result.question);
    assert(i >= 0, "goal fabricated original question");
    assert.equal(row.result.expectedOutput, "原答案");
    const label = row.result.metadata.find((x: any) => x.key === "类别")?.value;
    assert.equal(label, ["费用", "进度", "账号"][Math.floor(i / 4)]);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  assert.deepEqual(counts, { 费用: 4, 进度: 1, 账号: 1 });
  console.log(
    "GOAL_SEMANTIC_REVIEW",
    JSON.stringify({
      count: audited.length,
      counts,
      sourceAndAnswerPreserved: true,
    }),
  );
  const ready = await send(
    goalPath,
    "结果可以，采用全部结果新建“六条审核样例”测试集，准备发布。",
  );
  console.log("ADOPTION_READY", JSON.stringify(ready));
  const adoption = ready.state.proposals.find(
    (x: any) => x.action === "processing" && x.status === "pending",
  );
  assert(adoption, "adoption confirmation missing");
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
  let publication = await drive(goalPath);
  if (
    !publication.state.proposals.some(
      (x: any) => x.action === "publish" && x.status === "pending",
    )
  )
    publication = await send(goalPath, "发布刚才采用的六条审核样例。");
  console.log("PUBLICATION_READY", JSON.stringify(publication));
  const confirmation = publication.state.proposals.find(
    (x: any) => x.action === "publish" && x.status === "pending",
  );
  assert(confirmation, "publication confirmation missing");
  const published = await call(
    "POST",
    `${base}/proposals/${confirmation.id}/confirm`,
    {},
  );
  const repeated = await call(
    "POST",
    `${base}/proposals/${confirmation.id}/confirm`,
    {},
  );
  assert.deepEqual(repeated.receipt, published.receipt);
  const rawReceipt = published.receipt;
  console.log(
    "PUBLISHED",
    JSON.stringify({ published, session: await drive(goalPath) }),
  );
  const version = rawReceipt.version,
    set = rawReceipt.testSet;
  const versionPath = `/api/projects/${projectId}/solo-test-sets/${set.id}/versions/${version.id}`;
  const records = await call("GET", `${versionPath}/records?limit=100`);
  assert.equal(records.pagination.total, 6);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int FROM test_set_version WHERE test_set_id=$1",
        [set.id],
      )
    ).rows[0].count,
    1,
  );
  for (const file of ["data.csv", "provenance.csv"]) {
    const download = await app.inject({
      method: "GET",
      url: `${versionPath}/${file}`,
      headers,
    });
    assert.equal(download.statusCode, 200, download.body);
    const parsed = parseCsv(download.body, { columns: true, bom: true });
    assert.equal(parsed.length, 6);
    if (file === "data.csv")
      assert.deepEqual(
        parsed.map((r: any) => [r.question, r.expected_output]),
        records.records.map((r: any) => [r.question, r.expectedOutput]),
      );
    console.log("DOWNLOAD", JSON.stringify({ file, body: download.body }));
  }
  console.log(
    "MATRIX_FINISHED",
    JSON.stringify(
      report.map((x) => ({
        name: x.name,
        stage: x.state.task?.stage,
        count: x.state.task?.review?.total,
        complete: x.state.task?.review?.complete,
        userPrompts: x.userPrompts,
        durationMs: x.ms,
      })),
    ),
  );
} finally {
  await app.close();
  const artifacts = new ArtifactRepository(config.minio);
  for (;;) {
    const objects = await artifacts.list("");
    if (!objects.length) break;
    for (const object of objects) await artifacts.remove(object.key);
  }
  await artifacts.client.removeBucket(artifacts.bucket);
  await db.end();
  await root.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
  await root.end();
  console.log("CLEANED disposable matrix database");
}
