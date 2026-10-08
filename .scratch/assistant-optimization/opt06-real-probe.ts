// Bounded synthetic probe. Owner model settings are read only; all writes use a disposable test DB.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";
import { buildApp } from "../../src/server/app.js";
import { runProcessing } from "../../src/processing/execute.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";

const rootUrl = loadConfig().databaseUrl;
const databaseName = `opt06_real_${randomUUID().replaceAll("-", "")}`;
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
};
const db = createPool(databaseUrl);
const app = await buildApp(config, { disableLegacyTestBootstrap: true });
try {
  const account = {
    email: "opt06@example.test",
    password: "Opt06Synth123",
    confirmPassword: "Opt06Synth123",
    displayName: "合成测试",
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
  const call = (method: "GET" | "POST", url: string, payload?: any) =>
    app.inject({
      method,
      url,
      headers: { ...headers, "idempotency-key": randomUUID() },
      ...(payload === undefined ? {} : { payload }),
    });
  const projectId = (
    await call("POST", "/api/projects", { name: "OPT06自动测试" })
  ).json().project.id;
  await db.query(
    "INSERT INTO model_connection(revision,name,endpoint,model,enabled,credential,updated_by) VALUES($1,$2,$3,$4,$5,$6,(SELECT id FROM app_user WHERE email='opt06@example.test'))",
    [
      model.revision,
      model.name,
      model.endpoint,
      model.model,
      model.enabled,
      model.credential,
    ],
  );
  const draftPath = `/api/projects/${projectId}/collaborative-drafts`;
  const source = (
    await call("POST", draftPath, { name: "合成账单资料" })
  ).json().draft.id;
  const questions = [
    "账单为何收取服务费？",
    "订阅月费是多少？",
    "年付价格有优惠吗？",
    "退款还要等几天？",
    "我在哪里查看退款进度？",
    "取消订单后何时到账？",
  ];
  for (const question of questions)
    assert.equal(
      (
        await call("POST", `${draftPath}/${source}/records`, {
          question,
          expectedOutput: "给出准确答复",
          metadata: [{ key: "来源", value: "合成" }],
        })
      ).statusCode,
      201,
    );
  const base = `/api/projects/${projectId}/assistant`;
  const sessionId = (await call("POST", `${base}/sessions`, {})).json()
    .sessionId;
  const sessionPath = `${base}/sessions/${sessionId}`;
  assert.equal(
    (
      await call("POST", `${sessionPath}/background-documents`, {
        fileName: "合成分类要求.md",
        contentBase64: Buffer.from(
          "仅为每条题目新增Metadata主题分类：费用（价格、收费）、进度（退款、到账）。保留原问题、原期望输出和原Metadata。此文档仅作为数据任务背景。",
          "utf8",
        ).toString("base64"),
      })
    ).statusCode,
    201,
  );
  async function send(
    message: string,
    context?: { kind: string; id: string },
    path = sessionPath,
  ) {
    const reply = await call("POST", `${path}/turns`, {
      message,
      ...(context ? { context } : {}),
    });
    assert.equal(reply.statusCode, 202, reply.body);
    const turnId = reply.json().turnId;
    for (let n = 0; n < 150; n++) {
      const state = (await call("GET", path)).json();
      const turn = state.turns.find((item: any) => item.id === turnId);
      if (turn && !["queued", "running"].includes(turn.status)) {
        console.log(
          JSON.stringify(
            { message, task: state.task, lastTurn: turn },
            null,
            2,
          ),
        );
        assert.equal(turn.status, "succeeded", JSON.stringify(turn));
        return state;
      }
      await delay(1000);
    }
    throw new Error("probe turn timeout");
  }
  const plan = await send("按附件给当前资料设计分类方案，先不执行。", {
    kind: "draft",
    id: source,
  });
  assert.equal(plan.task.runId, undefined);
  assert.equal(plan.proposals.length, 0);
  assert(
    plan.turns
      .at(-1)
      .tools.some(
        (tool: any) =>
          tool.name === "read_background" && tool.status === "succeeded",
      ),
  );
  assert.equal(plan.task.executionPlan?.mode, "plan");
  const submitted = await send("执行方案。");
  assert(
    submitted.task.runId,
    "explicit execution did not create a processing run",
  );
  const job = (
    await db.query(
      "UPDATE job SET status='running',attempt=1,lease_owner='opt06-real',lease_expires_at=now()+interval '5 minutes' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
      [submitted.task.runId],
    )
  ).rows[0];
  const result = await runProcessing(
    db,
    new ArtifactRepository(config.minio),
    config,
    job,
  );
  await db.query("UPDATE job SET status='succeeded',result=$2 WHERE id=$1", [
    job.id,
    result,
  ]);
  const candidates = (
    await call("GET", `${sessionPath}/candidates?run=${submitted.task.runId}`)
  ).json();
  assert.equal(candidates.total, 6);
  for (const row of candidates.records) {
    assert(questions.includes(row.result.question));
    assert.equal(row.result.expectedOutput, "给出准确答复");
    assert(
      row.result.metadata.some(
        (item: any) => item.key === "来源" && item.value === "合成",
      ),
    );
    assert(
      row.result.metadata.some(
        (item: any) =>
          item.key ===
            submitted.task.classifications.find(
              (rule: any) => rule.field === "metadata",
            ).key && ["费用", "进度"].includes(item.value),
      ),
    );
  }
  console.log(
    "PASS short plan, real background, explicit execution, six protected records",
  );
  for (let i = 0; i < 2; i++)
    await call("POST", draftPath, { name: "同名资料" });
  const ambiguousId = (await call("POST", `${base}/sessions`, {})).json()
    .sessionId;
  const ambiguous = await send(
    "把「同名资料」的问题改写得更简短。",
    undefined,
    `${base}/sessions/${ambiguousId}`,
  );
  assert.equal(ambiguous.task.runId, undefined);
  assert.equal(ambiguous.proposals.length, 0);
  assert(
    ambiguous.task.question ||
      /哪|两个|选择|确认/.test(ambiguous.turns.at(-1).assistantText),
  );
  assert(!/内部ID|提供.*ID/.test(ambiguous.turns.at(-1).assistantText));
  console.log("PASS necessary ambiguity only");
} finally {
  await app.close();
  await db.end();
  await root.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
  await root.end();
  console.log("CLEANED disposable real probe database");
}
