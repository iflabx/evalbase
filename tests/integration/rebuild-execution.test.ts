import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { changeAssistantMode } from "../../src/assistant-rebuild/cutover.js";
import { processingCost } from "../../src/assistant-rebuild/budget.js";
import { chromium, expect as browserExpect } from "@playwright/test";
import { sendFormalCompletion } from "../support/formal-completion.js";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";
import {
  FormalSessionHost,
  type ModelAttempt,
  type ModelOutcome,
} from "../../src/assistant-rebuild/session-host.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import { createProcessingRun } from "../../src/processing/store.js";
import { runProcessing } from "../../src/processing/execute.js";
import * as acceptance from "../../src/processing/accept.js";
import { rebuildSchema } from "../../src/assistant-rebuild/schema.js";
vi.mock("../../src/assistant/agent.js", () => ({
  executeAssistantTurn: () => {
    throw Error("legacy_dispatch_disabled");
  },
}));
let origin = "http://127.0.0.1:4217";
const base = loadConfig(),
  databaseName = "formal_execution_" + randomUUID().replaceAll("-", ""),
  databaseUrl = base.databaseUrl.replace(/\/[^/]+$/, "/" + databaseName);
const config = {
  ...base,
  databaseUrl,
  appOrigin: origin,
  soloOwnerMode: false,
  allowTestIdentity: false,
  modelEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
};
const db = createPool(databaseUrl),
  identities = new Map<string, Record<string, string>>(),
  actors = new Map<string, string>();
let app: AgentBenchApp,
  host: FormalSessionHost,
  projectId: string,
  otherProject: string,
  assetId: string,
  provider: Server;
let outputs: any[] = [];
let r07DuplicateQuestions = false;
let r07WorkerLimits: number[] = [];
let r07RefundAsset: string | undefined;
const omitUsage = false;
const requests: any[] = [];
const route = (id?: string) =>
  "/api/projects/" +
  projectId +
  "/assistant-runtime/sessions" +
  (id ? "/" + id : "");
const scope = (actor = "admin") => ({ projectId, actorId: actors.get(actor)! });
const call = (name: string, args: unknown, id = "call_" + randomUUID()) => ({
  role: "assistant",
  content: "",
  tool_calls: [
    {
      id,
      type: "function",
      function: {
        name:
          name === "update_requirements" &&
          args &&
          typeof args === "object" &&
          (args as any).expectedRevision === 0 &&
          (args as any).changes?.deliveries?.some((d: any) => !d.deliveryId)
            ? "create_requirements"
            : name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    },
  ],
});
async function api(
  method: any,
  url: string,
  payload?: unknown,
  actor = "admin",
) {
  return app.inject({
    method,
    url,
    headers: {
      origin,
      ...identities.get(actor),
      "idempotency-key": randomUUID(),
    },
    ...(payload === undefined ? {} : { payload: payload as any }),
  });
}
async function fresh(actor = "admin") {
  const response = await api("POST", route(), {}, actor);
  expect(response.statusCode, response.body).toBe(200);
  return response.json().session.id as string;
}
async function submit(
  id: string,
  text: string,
  extra: Record<string, unknown> = {},
  actor = "admin",
) {
  const state = await host.store.get(scope(actor), id);
  return api(
    "POST",
    route(id) + "/messages",
    {
      submissionId: "submission_" + randomUUID(),
      expectedRevision: state.revision,
      text,
      ...extra,
    },
    actor,
  );
}
async function run(
  id: string,
  text: string,
  replies: any[],
  options: {
    summaryTokens?: number;
    hooks?: {
      beforeRequest?: (a: ModelAttempt) => Promise<void>;
      afterResponse?: (o: ModelOutcome) => Promise<void>;
    };
  } = {},
) {
  outputs = [...replies];
  const accepted = await submit(id, text);
  expect(accepted.statusCode, accepted.body).toBe(202);
  return host.runPending(scope(), id, accepted.json().turnId, options);
}
const plan = (count = 400) => ({
  expectedRevision: 0,
  changes: {
    mode: "plan",
    objective: "两份测试集方案",
    deliveries: [
      { patch: { name: "第一份", operation: "generate", count } },
      { patch: { name: "第二份", operation: "generate", count: 2 } },
    ],
  },
});

// Compatibility for pre-v2 trusted fixtures; new identity tests exercise explicit model commands.
const changeRequirements = (proof: any, input: any) =>
  host.store.change(
    proof,
    input,
    input.changes?.deliveries?.some((d: any) => !d.deliveryId)
      ? "create"
      : "update",
  );
async function effects() {
  return (
    await db.query(
      "SELECT (SELECT count(*) FROM collaborative_draft WHERE project_id=$1)::int AS drafts,(SELECT count(*) FROM processing_run WHERE project_id=$1)::int AS runs",
      [projectId],
    )
  ).rows[0];
}

async function isolateDispatcher(sessionId: string) {
  if (!databaseName.startsWith("formal_execution_"))
    throw Error("test_database_required");
  const rows = (
    await db.query(
      "SELECT DISTINCT session_id FROM assistant_runtime_turn WHERE session_id<>$1 AND status IN('pending','running','waiting','confirmation')",
      [sessionId],
    )
  ).rows;
  for (const row of rows) await host.execution.quiesce(row.session_id);
}
describe("REBUILD-03 formal session and Deep Agents host", () => {
  beforeAll(async () => {
    const root = createPool(base.databaseUrl);
    try {
      await root.query("CREATE DATABASE " + databaseName);
    } finally {
      await root.end();
    }
    await migrate(databaseUrl);
    const portProbe = createServer();
    await new Promise<void>((resolve) =>
      portProbe.listen(0, "127.0.0.1", resolve),
    );
    const port = (portProbe.address() as { port: number }).port;
    origin = "http://127.0.0.1:" + port;
    config.appOrigin = origin;
    app = await buildApp(config, {
      disableLegacyTestBootstrap: true,
      disableAssistantRuntimeDispatch: true,
    });
    // Bind immediately after releasing the probe, before the local provider or
    // later browser fixtures can take the same ephemeral port.
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));
    await app.listen({ host: "127.0.0.1", port });
    host = new FormalSessionHost(db, config);
    for (const who of ["admin", "editor", "viewer"]) {
      const payload = {
        email: who + "@r03.example.test",
        password: "Rebuild02Pass123",
        confirmPassword: "Rebuild02Pass123",
        ...(who === "admin" ? { displayName: who } : {}),
      };
      const created = await api(
        "POST",
        who === "admin" ? "/api/installation/administrator" : "/api/accounts",
        payload,
      );
      expect(created.statusCode, created.body).toBe(201);
      const login = await api("POST", "/api/session", {
        email: payload.email,
        password: payload.password,
      });
      expect(login.statusCode, login.body).toBe(200);
      identities.set(who, {
        cookie: login.cookies[0].name + "=" + login.cookies[0].value,
        "x-csrf-token": login.json().csrfToken,
      });
      actors.set(
        who,
        (
          await db.query("SELECT id FROM app_user WHERE email=$1", [
            payload.email,
          ])
        ).rows[0].id,
      );
    }
    projectId = (
      await api("POST", "/api/projects", { name: "R03 synthetic" })
    ).json().project.id;
    otherProject = (
      await api("POST", "/api/projects", { name: "R03 other" })
    ).json().project.id;
    for (const who of ["editor", "viewer"])
      await db.query(
        "INSERT INTO project_member(project_id,user_id,role) VALUES($1,$2,$3)",
        [projectId, actors.get(who), who],
      );
    const collectionId = (
      await api("GET", "/api/projects/" + projectId + "/collections")
    ).json().collections[0].id;
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/pending-uploads",
      headers: {
        origin,
        ...identities.get("admin"),
        "content-type": "application/octet-stream",
        "x-file-name": "r03-source.jsonl",
      },
      payload:
        [1, 2, 3]
          .map((n) =>
            JSON.stringify({ question: " 问题" + n + " ", answer: "答案" + n }),
          )
          .join("\n") + "\n",
    });
    const confirmed = await api(
      "POST",
      "/api/projects/" + projectId + "/pending-upload-batches/confirm",
      {
        collectionId,
        pendingUploadIds: [uploaded.json().pendingUpload.id],
        mode: "raw",
      },
    );
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    assetId = confirmed.json().assets[0].id;
    const mapping = (
      await api(
        "GET",
        "/api/projects/" + projectId + "/assets/" + assetId + "/mapping",
      )
    ).json();
    expect(
      (
        await api(
          "PUT",
          "/api/projects/" + projectId + "/assets/" + assetId + "/mapping",
          {
            parsedViewId: mapping.parsedViewId,
            expectedRevision: 0,
            mapping: {
              question: "/question",
              expectedOutput: "/answer",
              metadata: [],
            },
          },
        )
      ).statusCode,
    ).toBe(200);
    provider = createServer(async (req, res) => {
      try {
        let text = "";
        for await (const chunk of req) text += chunk;
        const body = JSON.parse(text);
        requests.push(body);
        const worker = body.messages?.some(
          (m: any) =>
            typeof m.content === "string" &&
            (m.content.includes("You transform test data") ||
              m.content.startsWith("Generate test data from")),
        );
        const summary = !body.tools?.length;
        let message = summary
          ? {
              role: "assistant",
              content: "历史摘要：旧名称，数量2；以服务端当前要求为准。",
            }
          : (outputs.shift() ?? {
              role: "assistant",
              content: "已根据工具结果说明当前要求，未执行生成或业务保存。",
            });
        if (worker) {
          const data = JSON.parse(body.messages.at(-1).content);
          if (data.operation === "generate") {
            const rule = data.background?.classifications?.[0],
              value = rule?.allowedValues?.[0] ?? "咨询";
            message = {
              role: "assistant",
              content: JSON.stringify({
                records: Array.from({ length: data.outputCount }, (_, i) => ({
                  question: `请问${value}服务中第${i + 1}种情况应如何处理？`,
                  expectedOutput: "应核实需求并说明可用的办理步骤。",
                  metadata:
                    rule?.field === "metadata"
                      ? [{ key: rule.key, value }]
                      : [],
                })),
              }),
            };
          } else {
            if (!Array.isArray(data.records))
              throw Error("controlled_worker_records_missing");
            message = {
              role: "assistant",
              content: JSON.stringify({
                records: (data.operation === "augment"
                  ? Array.from({ length: data.outputCount }, (_, i) => ({
                      ...data.records[i % data.records.length],
                      question:
                        data.records[i % data.records.length].question +
                        " 衍生情景" +
                        i,
                    }))
                  : data.records
                ).map((r: any) => ({
                  sourceId: r.id,
                  question: r07DuplicateQuestions
                    ? "请问办理咨询需要哪些材料？"
                    : r.question.trim() + "（自然问法）",
                  expectedOutput: r.expectedOutput,
                  metadata: r.metadata,
                })),
              }),
            };
          }
        }
        if (worker && r07WorkerLimits.length) {
          const n = r07WorkerLimits.shift()!;
          const result = JSON.parse(message.content);
          result.records = result.records.slice(0, n);
          message.content = JSON.stringify(result);
        }
        if (typeof message === "function") message = await message(body);
        if (message.httpStatus) {
          res.writeHead(message.httpStatus, {
            "content-type": "application/json",
          });
          res.end(
            JSON.stringify({
              error: { message: "synthetic provider unavailable" },
            }),
          );
          return;
        }
        await sendFormalCompletion(res, body, message, omitUsage);
      } catch {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid_test_request" } }));
      }
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    expect(
      (
        await api("PUT", "/api/settings/model-connection", {
          revision: 0,
          name: "R03 controlled model",
          endpoint:
            "http://127.0.0.1:" +
            (provider.address() as { port: number }).port +
            "/v1",
          model: "synthetic",
          apiKey: "synthetic-private-key",
          enabled: true,
        })
      ).statusCode,
    ).toBe(200);
    await db.query(rebuildSchema);
    await db.query(
      "INSERT INTO rebuild_campaign(id,max_requests,max_rows,max_generated,max_minutes,requests,rows,generated,closed_at) VALUES('old-r03-sentinel',9,9,9,9,7,6,5,'2026-10-01T00:00:00Z')",
    );
  });
  afterAll(async () => {
    await host?.close();
    await app?.close();
    if (provider)
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    await db.end();
    const root = createPool(base.databaseUrl);
    try {
      await root.query(
        "DROP DATABASE IF EXISTS " + databaseName + " WITH(FORCE)",
      );
    } finally {
      await root.end();
    }
  });
  it("stops accepted work through the priority control endpoint", async () => {
    const id = await fresh();
    await submit(id, "整理方案");
    const stopped = await api("POST", route(id) + "/control", {
      action: "stop",
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(stopped.json().execution.status).toBe("paused");
  });
  const until = async (test: () => Promise<boolean>) => {
    for (let n = 0; n < 200; n++) {
      if (await test()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error("test_condition_timeout");
  };
  const jobState = async (id: string) =>
    (await host.present(scope(), id)).execution;
  const seed = async (id: string) => {
    const a = await submit(id, "处理当前资料");
    const proof = await host.execution.claim(scope(), id, a.json().turnId);
    return proof;
  };
  const artifacts = new ArtifactRepository(config.minio);
  async function processing(
    id: string,
    operationKind: "clean" | "rewrite" = "clean",
  ) {
    const proof = await seed(id),
      operation = await host.execution.operation(
        proof,
        "processing:first",
        "processing",
        { assetId },
      );
    const result = await createProcessingRun(
      db,
      artifacts,
      host.execution.operationScope(proof, operation),
      operation.id,
      {
        source: (
          await host.store.freezeSource(scope(), {
            kind: "assets",
            assetIds: [assetId],
          })
        ).source,
        options: {
          operation: operationKind,
          instructions: operationKind === "clean" ? "" : "保留原意，问法自然",
          allowedFields: ["question"],
        },
      },
    );
    return { proof, operation, runId: result.run.id };
  }
  async function completeRun(runId: string) {
    const job = (
      await db.query(
        "UPDATE job SET status='running',lease_owner='r03',lease_expires_at=now()+interval '60 seconds',attempt=attempt+1 WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) RETURNING *",
        [runId],
      )
    ).rows[0];
    await runProcessing(db, artifacts, config, job);
    await db.query(
      "UPDATE job SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
      [job.id],
    );
  }
  it("recovers accepted work once across competing hosts and same-message replay", async () => {
    const id = await fresh(),
      a = await submit(id, "看看项目");
    outputs = [{ role: "assistant", content: "只读完成" }];
    const start = requests.length;
    const other = new FormalSessionHost(db, config);
    try {
      const settled = await Promise.allSettled([
        host.runPending(scope(), id, a.json().turnId),
        other.runPending(scope(), id, a.json().turnId),
      ]);
      expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
      expect(requests.length - start).toBe(1);
      const original = (
        await db.query(
          "SELECT payload FROM assistant_runtime_turn WHERE id=$1",
          [a.json().turnId],
        )
      ).rows[0].payload;
      expect(
        (await api("POST", route(id) + "/messages", original)).json(),
      ).toMatchObject({ replayed: true, turnId: a.json().turnId });
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM assistant_runtime_message WHERE turn_id=$1 AND role='user'",
            [a.json().turnId],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await other.close();
    }
  });
  it("pauses a real in-flight request, queries without spending, and resumes after the old request timeout", async () => {
    const id = await fresh();
    const a = await submit(id, "看项目情况");
    let release!: () => void;
    let entered = false;
    outputs = [
      async () => {
        entered = true;
        await new Promise<void>((r) => (release = r));
        return { role: "assistant", content: "迟到响应" };
      },
    ];
    const short = new FormalSessionHost(db, config, {
      policy: { requestMs: 150, leaseMs: 10000, graphSteps: 30 },
    });
    try {
      const started = Date.now(),
        running = short.runPending(scope(), id, a.json().turnId);
      await until(async () => entered);
      const row = (
        await db.query(
          "SELECT runner_token FROM assistant_runtime_turn WHERE id=$1",
          [a.json().turnId],
        )
      ).rows[0];
      const proof = {
        ...scope(),
        sessionId: id,
        turnId: a.json().turnId,
        token: row.runner_token,
      };
      expect(
        (await api("POST", route(id) + "/control", { action: "stop" }))
          .statusCode,
      ).toBe(200);
      release();
      await running;
      await expect(changeRequirements(proof, plan())).rejects.toMatchObject({
        code: "runtime_interrupted",
      });
      const count = requests.length;
      expect((await api("GET", route(id))).json().execution.status).toBe(
        "paused",
      );
      expect(requests.length).toBe(count);
      await new Promise((r) => setTimeout(r, 180));
      expect(Date.now() - started).toBeGreaterThan(150);
      outputs = [{ role: "assistant", content: "恢复完成" }];
      expect(
        (await api("POST", route(id) + "/control", { action: "continue" }))
          .statusCode,
      ).toBe(200);
      const done = await short.runPending(scope(), id, a.json().turnId);
      expect(done.execution.status).toBe("completed");
      expect(done.execution.requests).toBe(2);
      expect(
        (
          await db.query(
            "SELECT error_code FROM assistant_runtime_request WHERE turn_id=$1 ORDER BY started_at",
            [a.json().turnId],
          )
        ).rows[0].error_code,
      ).toBeNull();
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM assistant_runtime_event WHERE turn_id=$1 AND kind='request_outcome_reconciled'",
            [a.json().turnId],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await short.close();
    }
  });
  it("pauses on task budget and appends only a fixed user-confirmed offer", async () => {
    const id = await fresh();
    await host.execution.ensure(db, scope(), id);
    await db.query(
      "UPDATE assistant_runtime_execution SET request_limit=1 WHERE session_id=$1",
      [id],
    );
    const state = await run(id, "查看项目", [call("read_project", {})]);
    expect(state.execution).toMatchObject({
      status: "paused",
      reason: "task_budget_exhausted",
      requests: 1,
    });
    expect(
      (await api("POST", route(id) + "/control", { action: "continue" })).json()
        .error.code,
    ).toBe("task_budget_exhausted");
    const before = (await jobState(id))!;
    const offer = (await api("POST", route(id) + "/budget-offer", {})).json();
    expect(offer.payload.requests).toBe(12);
    expect(
      (
        await api("POST", route(id) + "/confirmations/" + offer.id, {
          accept: true,
          requests: 999,
        })
      ).statusCode,
    ).toBe(422);
    const granted = await api(
      "POST",
      route(id) + "/confirmations/" + offer.id,
      { accept: true },
    );
    expect(granted.statusCode, granted.body).toBe(200);
    expect(
      (
        await api("POST", route(id) + "/confirmations/" + offer.id, {
          accept: true,
        })
      ).json().replayed,
    ).toBe(true);
    const after = (await jobState(id))!;
    expect(after.requests).toBe(before.requests);
    expect(after.request_limit).toBe(13);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM assistant_runtime_grant WHERE session_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(2);
    outputs = [{ role: "assistant", content: "完成" }];
    await api("POST", route(id) + "/control", { action: "continue" });
    await host.runPending(scope(), id, after.turn_id);
    expect((await jobState(id))!.requests).toBe(2);
  });
  it("persists three no-progress observations across restart and refuses ordinary continue", async () => {
    const id = await fresh();
    const state = await run(id, "查一下项目", [
      call("read_project", {}),
      call("read_project", {}),
      call("read_project", {}),
      call("read_project", {}),
    ]);
    expect(state.execution).toMatchObject({
      status: "paused",
      reason: "no_progress",
      no_progress: 3,
      requests: 4,
    });
    const other = new FormalSessionHost(db, config);
    try {
      const before = requests.length;
      await expect(other.continue(scope(), id)).rejects.toMatchObject({
        code: "no_progress",
      });
      expect((await other.present(scope(), id)).execution.no_progress).toBe(3);
      expect(requests.length).toBe(before);
    } finally {
      await other.close();
    }
  });
  it("advances across graph segments with actual new page coverage", async () => {
    const id = await fresh(),
      a = await submit(id, "逐页查看三条数据");
    outputs = [0, 1, 2].map((offset) =>
      call("read_records", {
        source: { kind: "assets", assetIds: [assetId] },
        offset,
        limit: 1,
      }),
    );
    outputs.push({ role: "assistant", content: "三条已核对" });
    const state = await host.runPending(scope(), id, a.json().turnId, {
      graphSteps: 8,
    });
    expect(state.execution.status).toBe("completed");
    expect(state.execution.progress_version).toBeGreaterThanOrEqual(3);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM assistant_runtime_event WHERE turn_id=$1 AND kind='execution_segment'",
          [a.json().turnId],
        )
      ).rows[0].n,
    ).toBeGreaterThanOrEqual(1);
  });
  it("waits durably for a real processing job with no model polling and one wake", async () => {
    const id = await fresh(),
      p = await processing(id);
    await host.execution.yield(p.proof, "paused", "test_boundary");
    await host.continue(scope(), id);
    outputs = [call("wait_processing", {})];
    const state = await host.runPending(scope(), id, p.proof.turnId);
    expect(state.execution.status).toBe("waiting");
    const count = requests.length;
    await host.execution.wake();
    await host.execution.wake();
    expect((await jobState(id))!.status).toBe("waiting");
    expect(requests.length).toBe(count);
    await completeRun(p.runId);
    const other = new FormalSessionHost(db, config);
    try {
      await other.execution.wake();
      await other.execution.wake();
      outputs = [{ role: "assistant", content: "已有结果，尚未保存" }];
      const result = await other.runPending(scope(), id, p.proof.turnId);
      expect(result.execution.status).toBe("completed");
      expect(result.businessStatus).toBe("generated");
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM processing_run WHERE id=$1",
            [p.runId],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM assistant_runtime_event WHERE turn_id=$1 AND kind='tool_error'",
            [p.proof.turnId],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await other.close();
    }
  });
  it("requires a fixed confirmation and reconciles real adoption after a lost business response", async () => {
    const id = await fresh(),
      p = await processing(id);
    await completeRun(p.runId);
    const op = await host.execution.operation(p.proof, "adopt:first", "adopt", {
      runId: p.runId,
      input: {
        resultIds: (
          await api(
            "GET",
            "/api/projects/" + projectId + "/processing-runs/" + p.runId,
          )
        )
          .json()
          .records.map((r: any) => r.id),
        target: { kind: "newDraft", name: "R03回执唯一", purpose: "" },
      },
    });
    const card = await host.execution.prepare(p.proof, op);
    await host.execution.yield(p.proof, "confirmation");
    const real = acceptance.acceptProcessingResults;
    const spy = vi
      .spyOn(acceptance, "acceptProcessingResults")
      .mockImplementationOnce(async (...args) => {
        try {
          await real(...args);
        } catch (error) {
          console.error(
            "r03_adoption_service",
            (error as any).code,
            (error as Error).message,
          );
          throw error;
        }
        throw Error("response_lost_after_commit");
      });
    try {
      const first = await api("POST", route(id) + "/confirmations/" + card.id, {
        accept: true,
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().receipt.adopted).toBe(3);
      const repeated = await api(
        "POST",
        route(id) + "/confirmations/" + card.id,
        { accept: true },
      );
      expect(repeated.json().replayed).toBe(true);
      const facts = await host.present(scope(), id);
      expect(facts.businessStatus).toBe("saved");
      expect(facts.receipts.filter((r) => r.acceptanceId)).toHaveLength(1);
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM collaborative_draft WHERE name=$1",
            ["R03回执唯一"],
          )
        ).rows[0].n,
      ).toBe(1);
      await expect(
        host.execution.operation(p.proof, "adopt:first", "adopt", {
          changed: true,
        }),
      ).rejects.toMatchObject({ code: "operation_payload_conflict" });
    } finally {
      spy.mockRestore();
    }
  });
  async function adoptionCard() {
    const id = await fresh(),
      p = await processing(id);
    await completeRun(p.runId);
    const rows = (
      await api(
        "GET",
        "/api/projects/" + projectId + "/processing-runs/" + p.runId,
      )
    ).json().records;
    const op = await host.execution.operation(
      p.proof,
      "adopt:fixture",
      "adopt",
      {
        runId: p.runId,
        input: {
          resultIds: rows.map((r: any) => r.id),
          target: {
            kind: "newDraft",
            name: "R03固定确认" + randomUUID(),
            purpose: "",
          },
        },
      },
    );
    const card = await host.execution.prepare(p.proof, op);
    await host.execution.yield(p.proof, "confirmation");
    return { id, p, op, card };
  }
  it("rejects expired, changed-requirement, foreign-owner and revoked confirmations", async () => {
    const expired = await adoptionCard();
    await db.query(
      "UPDATE assistant_runtime_confirmation SET expires_at=now()-interval '1 second' WHERE id=$1",
      [expired.card.id],
    );
    expect(
      (
        await api(
          "POST",
          route(expired.id) + "/confirmations/" + expired.card.id,
          { accept: true },
        )
      ).json().error.code,
    ).toBe("confirmation_expired");
    const changed = await adoptionCard();
    await db.query(
      "UPDATE assistant_runtime_session SET requirements_revision=requirements_revision+1 WHERE id=$1",
      [changed.id],
    );
    expect(
      (
        await api(
          "POST",
          route(changed.id) + "/confirmations/" + changed.card.id,
          { accept: true },
        )
      ).json().error.code,
    ).toBe("confirmation_expired");
    const own = await adoptionCard();
    await expect(
      host.execution.approve(
        { ...scope(), projectId: otherProject },
        own.id,
        own.card.id,
        artifacts,
      ),
    ).rejects.toMatchObject({ code: "conversation_not_found" });
    expect(
      (
        await api(
          "POST",
          route(own.id) + "/confirmations/" + own.card.id,
          { accept: true },
          "editor",
        )
      ).statusCode,
    ).toBe(404);
    const oldRole = (
      await db.query("SELECT role FROM app_user WHERE id=$1", [
        actors.get("admin"),
      ])
    ).rows[0].role;
    const oldMember = (
      await db.query(
        "SELECT role FROM project_member WHERE project_id=$1 AND user_id=$2",
        [projectId, actors.get("admin")],
      )
    ).rows[0]?.role;
    await db.query("UPDATE app_user SET role='viewer' WHERE id=$1", [
      actors.get("admin"),
    ]);
    await db.query(
      "UPDATE project_member SET role='viewer' WHERE project_id=$1 AND user_id=$2",
      [projectId, actors.get("admin")],
    );
    try {
      await expect(
        host.execution.approve(scope(), own.id, own.card.id, artifacts),
      ).rejects.toMatchObject({ code: "project_not_found" });
    } finally {
      await db.query("UPDATE app_user SET role=$2 WHERE id=$1", [
        actors.get("admin"),
        oldRole,
      ]);
      if (oldMember)
        await db.query(
          "UPDATE project_member SET role=$3 WHERE project_id=$1 AND user_id=$2",
          [projectId, actors.get("admin"), oldMember],
        );
    }
    for (const c of [expired, changed, own])
      expect(await host.execution.receipt(scope(), c.id, c.op.id)).toBeNull();
  });
  it("guards adopted target revision inside the actual business transaction", async () => {
    const id = await fresh(),
      p = await processing(id);
    await completeRun(p.runId);
    const draft = (
      await api(
        "POST",
        "/api/projects/" + projectId + "/collaborative-drafts",
        { name: "R03并发目标" },
      )
    ).json().draft;
    const rows = (
      await api(
        "GET",
        "/api/projects/" + projectId + "/processing-runs/" + p.runId,
      )
    ).json().records;
    const op = await host.execution.operation(
      p.proof,
      "adopt:revision",
      "adopt",
      {
        runId: p.runId,
        input: {
          resultIds: rows.map((r: any) => r.id),
          target: {
            kind: "draft",
            id: draft.id,
            expectedRevision: draft.revision,
          },
        },
      },
    );
    const card = await host.execution.prepare(p.proof, op);
    await host.execution.yield(p.proof, "confirmation");
    await db.query(
      "UPDATE collaborative_draft SET revision=revision+1 WHERE id=$1",
      [draft.id],
    );
    const response = await api(
      "POST",
      route(id) + "/confirmations/" + card.id,
      { accept: true },
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(await host.execution.receipt(scope(), id, op.id)).toBeNull();
  });
  it("returns one pending or committed identity on concurrent double confirmation", async () => {
    const f = await adoptionCard(),
      start = await effects();
    const result = await Promise.all([
      api("POST", route(f.id) + "/confirmations/" + f.card.id, {
        accept: true,
      }),
      api("POST", route(f.id) + "/confirmations/" + f.card.id, {
        accept: true,
      }),
    ]);
    expect(result.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(result.every((r) => r.json().receipt || r.json().pending)).toBe(
      true,
    );
    expect((await effects()).drafts).toBe(start.drafts + 1);
    expect(
      (await host.present(scope(), f.id)).receipts.filter(
        (r) => r.acceptanceId,
      ),
    ).toHaveLength(1);
  });
  it("recovers an executing confirmation from a real receipt after restart without adopting again", async () => {
    const f = await adoptionCard();
    await host.execution.approve(scope(), f.id, f.card.id, artifacts);
    await db.query(
      "UPDATE assistant_runtime_confirmation SET status='executing',receipt=NULL WHERE id=$1",
      [f.card.id],
    );
    await db.query(
      "UPDATE assistant_runtime_execution SET status='running',lease_until=now()-interval '1 second' WHERE session_id=$1",
      [f.id],
    );
    await db.query(
      "UPDATE assistant_runtime_turn SET status='running',runner_token='dead-owner' WHERE id=$1",
      [f.p.proof.turnId],
    );
    const count = requests.length,
      before = await effects();
    const other = new FormalSessionHost(db, config);
    try {
      await other.execution.recoverConfirmations();
      await other.execution.recoverConfirmations();
      expect((await jobState(f.id))!.status).toBe("pending");
      expect((await other.present(scope(), f.id)).businessStatus).toBe("saved");
      expect(await effects()).toEqual(before);
      expect(requests.length).toBe(count);
    } finally {
      await other.close();
    }
  });
  it("does not auto-wake a paused or changed job owner", async () => {
    for (const change of [false, true]) {
      const id = await fresh(),
        p = await processing(id);
      await host.execution.yield(p.proof, "waiting");
      if (change)
        await db.query(
          "UPDATE assistant_runtime_session SET requirements_revision=requirements_revision+1 WHERE id=$1",
          [id],
        );
      else await host.stop(scope(), id);
      const before = requests.length;
      await completeRun(p.runId);
      await host.execution.wake();
      await host.execution.wake();
      expect((await jobState(id))!.status).toBe("paused");
      expect(requests.length).toBe(before);
    }
  });
  it("accounts a timed-out actual SDK request without refund and resumes on the same task", async () => {
    const id = await fresh(),
      a = await submit(id, "看看项目");
    outputs = [
      async () => {
        await new Promise((r) => setTimeout(r, 180));
        return { role: "assistant", content: "超时响应" };
      },
    ];
    const short = new FormalSessionHost(db, config, {
      policy: { requestMs: 80, leaseMs: 10000, graphSteps: 30 },
    });
    try {
      const state = await short.runPending(scope(), id, a.json().turnId);
      expect(state.execution).toMatchObject({
        status: "paused",
        reason: "model_request_timeout",
        requests: 1,
      });
      const request = (
        await db.query(
          "SELECT usage,error_code FROM assistant_runtime_request WHERE turn_id=$1",
          [a.json().turnId],
        )
      ).rows[0];
      expect(request).toMatchObject({
        usage: null,
        error_code: "model_request_timeout",
      });
      await host.continue(scope(), id);
      outputs = [{ role: "assistant", content: "继续完成" }];
      const done = await short.runPending(scope(), id, a.json().turnId);
      expect(done.execution.requests).toBe(2);
      expect(done.execution.status).toBe("completed");
    } finally {
      await short.close();
    }
  });
  it("counts worker attempts separately and respects a closed external activity without spending old budgets", async () => {
    const id = await fresh(),
      p = await processing(id),
      activity = "r03-cap-" + randomUUID();
    await db.query(
      "INSERT INTO assistant_runtime_activity(id,request_limit,max_ms) VALUES($1,1,10000)",
      [activity],
    );
    await db.query(
      "UPDATE assistant_runtime_execution SET activity_id=$2 WHERE session_id=$1",
      [id, activity],
    );
    const { formalWorkerFetch } =
      await import("../../src/assistant-rebuild/worker-fetch.js");
    let invoked = 0;
    const rawRequest = formalWorkerFetch(
      db,
      p.runId,
    )(async () => {
      invoked++;
      return new Response(
        JSON.stringify({ choices: [], usage: { total_tokens: 2 } }),
        { status: 200 },
      );
    });
    const request: typeof fetch = (...args) =>
      processingCost.run({ rows: 3, generated: 0 }, () => rawRequest(...args));
    await request("http://synthetic.invalid", { body: "{}" });
    await expect(
      request("http://synthetic.invalid", { body: "{}" }),
    ).rejects.toMatchObject({ code: "activity_budget_exhausted" });
    const state = (await jobState(id))!;
    expect(state.worker_requests).toBe(1);
    expect(state.requests).toBe(0);
    expect(invoked).toBe(1);
    await db.query(
      "UPDATE assistant_runtime_activity SET closed_at=now() WHERE id=$1",
      [activity],
    );
    await expect(
      host.execution.reserve(p.proof, {
        id: "closed_" + randomUUID(),
        sessionId: id,
        turnId: p.proof.turnId,
        purpose: "assistant",
        correctionOf: null,
        requestHash: "synthetic",
      }),
    ).rejects.toMatchObject({ code: "activity_budget_exhausted" });
    expect(
      (
        await db.query(
          "SELECT requests,closed_at FROM rebuild_campaign WHERE id='old-r03-sentinel'",
        )
      ).rows[0].requests,
    ).toBe(7);
    await host.stop(scope(), id);
  });
  it("preserves correction intent and the attempt limit across a stopped SDK continuation", async () => {
    const id = await fresh(),
      a = await submit(id, "只给方案");
    let entered = false,
      release!: () => void;
    const invalid = {
      expectedRevision: 0,
      changes: { deliveries: [{ patch: { name: "第一份", count: 50 } }] },
      steps: [],
    };
    outputs = [
      call("update_requirements", invalid),
      async () => {
        entered = true;
        await new Promise<void>((r) => (release = r));
        return call("update_requirements", {
          expectedRevision: 0,
          changes: { deliveries: [{ patch: { name: "第一份", count: 50 } }] },
        });
      },
    ];
    const running = host.runPending(scope(), id, a.json().turnId);
    await until(async () => entered);
    await host.stop(scope(), id);
    release();
    await running;
    expect(
      (
        await db.query(
          "SELECT feedback FROM assistant_runtime_execution WHERE session_id=$1",
          [id],
        )
      ).rows[0].feedback,
    ).toMatchObject({ attempts: 1, args: invalid });
    await host.continue(scope(), id);
    outputs = [
      call("update_requirements", {
        expectedRevision: 0,
        changes: { deliveries: [{ patch: { name: "第一份", count: 51 } }] },
      }),
    ];
    await expect(
      host.runPending(scope(), id, a.json().turnId),
    ).rejects.toMatchObject({ code: "correction_intent_changed" });
    expect((await host.store.get(scope(), id)).requirements.deliveries).toEqual(
      [],
    );
  });

  it("records an actual AI SDK Worker HTTP attempt without consuming the assistant allowance", async () => {
    const id = await fresh(),
      p = await processing(id, "rewrite");
    await completeRun(p.runId);
    const task = (await jobState(id))!;
    expect(task.worker_requests).toBeGreaterThanOrEqual(1);
    expect(task.requests).toBe(0);
    const entries = (
      await db.query(
        "SELECT purpose,status,usage FROM assistant_runtime_request WHERE session_id=$1",
        [id],
      )
    ).rows;
    expect(
      entries.every(
        (r) => r.purpose === "worker" && r.status === 200 && r.usage !== null,
      ),
    ).toBe(true);
    await host.execution.yield(p.proof, "paused", "test_completed_worker");
  });
  it("reclaims an expired owner, retains unknown history and actual outcome, and fences its late response", async () => {
    const id = await fresh(),
      a = await submit(id, "查看项目");
    let entered = false,
      release!: () => void;
    outputs = [
      async () => {
        entered = true;
        await new Promise<void>((r) => (release = r));
        return { role: "assistant", content: "失去归属的旧响应" };
      },
    ];
    const old = host.runPending(scope(), id, a.json().turnId);
    await until(async () => entered);
    await db.query(
      "UPDATE assistant_runtime_execution SET lease_until=now()-interval '1 second' WHERE session_id=$1",
      [id],
    );
    const other = new FormalSessionHost(db, config);
    try {
      outputs = [{ role: "assistant", content: "新的执行归属完成" }];
      const done = await other.runPending(scope(), id, a.json().turnId);
      release();
      await old;
      expect(done.execution.requests).toBe(2);
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM assistant_runtime_message WHERE turn_id=$1 AND role='assistant'",
            [a.json().turnId],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await db.query(
            "SELECT error_code FROM assistant_runtime_request WHERE turn_id=$1 ORDER BY started_at",
            [a.json().turnId],
          )
        ).rows[0].error_code,
      ).toBeNull();
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM assistant_runtime_event WHERE turn_id=$1 AND kind='request_outcome_reconciled'",
            [a.json().turnId],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      release?.();
      await other.close();
    }
  });
  it("resumes completed processing after a pause without re-running a successful batch", async () => {
    const id = await fresh(),
      p = await processing(id);
    await host.execution.yield(p.proof, "paused", "user_paused");
    await completeRun(p.runId);
    const batch = (
      await db.query("SELECT * FROM processing_batch WHERE run_id=$1", [
        p.runId,
      ])
    ).rows;
    await host.continue(scope(), id);
    outputs = [
      call("wait_processing", {}),
      { role: "assistant", content: "结果保留" },
    ];
    const done = await host.runPending(scope(), id, p.proof.turnId);
    expect(done.execution.status).toBe("completed");
    expect(
      (
        await db.query("SELECT * FROM processing_batch WHERE run_id=$1", [
          p.runId,
        ])
      ).rows,
    ).toEqual(batch);
    expect(done.execution.worker_requests).toBe(0);
  });
  it("does not turn historical receipts into current success after requirements change", async () => {
    const f = await adoptionCard();
    await host.execution.approve(scope(), f.id, f.card.id, artifacts);
    await db.query(
      "UPDATE assistant_runtime_session SET requirements_revision=requirements_revision+1 WHERE id=$1",
      [f.id],
    );
    const result = await host.present(scope(), f.id);
    expect(result.receipts.filter((r) => r.acceptanceId)).toHaveLength(1);
    expect(result.receipts.find((r) => r.acceptanceId)?.isCurrent).toBe(false);
    expect(result.businessStatus).not.toBe("saved");
  });

  it("allows real requirement amendments after no-progress without resetting spent budget", async () => {
    const id = await fresh();
    const frozen = await host.store.freezeSource(scope(), {
      kind: "assets",
      assetIds: [assetId],
    });
    const calls = [0, 1, 2, 3].map((n) =>
      call("read_records", {
        source: {
          ...frozen.source,
          recordIds:
            n % 2
              ? [...frozen.source.recordIds].reverse()
              : frozen.source.recordIds,
        },
      }),
    );
    const stopped = await run(id, "查看选中的数据", calls);
    expect(stopped.execution).toMatchObject({
      status: "paused",
      reason: "no_progress",
      no_progress: 3,
    });
    const used = stopped.execution.requests;
    const next = await run(id, "修改要求，先做三条方案", [
      call("update_requirements", plan(3)),
    ]);
    expect(next.execution.status).toBe("completed");
    expect(next.execution.no_progress).toBe(0);
    expect(next.execution.requests).toBeGreaterThan(used);
    expect(next.session.requirements_revision).toBe(1);
  });
  it("rolls back all terminal facts on failure between execution and turn updates", async () => {
    const id = await fresh(),
      proof = await seed(id);
    await db.query(
      "CREATE FUNCTION r03_fail_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='" +
        proof.turnId +
        "' AND NEW.status='succeeded' THEN RAISE EXCEPTION 'r03_before_terminal_commit'; END IF; RETURN NEW; END $$",
    );
    await db.query(
      "CREATE TRIGGER r03_terminal_fault BEFORE UPDATE ON assistant_runtime_turn FOR EACH ROW EXECUTE FUNCTION r03_fail_terminal()",
    );
    try {
      await expect(host.store.finish(proof, "尚未提交的回复")).rejects.toThrow(
        "r03_before_terminal_commit",
      );
      const task = (
        await db.query(
          "SELECT status,lease_until FROM assistant_runtime_execution WHERE session_id=$1",
          [id],
        )
      ).rows[0];
      expect(task.status).toBe("running");
      expect(task.lease_until).not.toBeNull();
      expect(
        (
          await db.query(
            "SELECT status FROM assistant_runtime_turn WHERE id=$1",
            [proof.turnId],
          )
        ).rows[0].status,
      ).toBe("running");
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM assistant_runtime_message WHERE turn_id=$1 AND role='assistant'",
            [proof.turnId],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await db.query(
        "DROP TRIGGER r03_terminal_fault ON assistant_runtime_turn",
      );
      await db.query("DROP FUNCTION r03_fail_terminal()");
    }
    await host.store.finish(proof, "原子完成");
    expect((await jobState(id))!.status).toBe("completed");
  });
  it("keeps a new owner lease when an old adoption receipt arrives after stop and continue", async () => {
    const f = await adoptionCard(),
      real = acceptance.acceptProcessingResults;
    let entered = false,
      release!: () => void;
    const spy = vi
      .spyOn(acceptance, "acceptProcessingResults")
      .mockImplementationOnce(async (...args) => {
        const result = await real(...args);
        entered = true;
        await new Promise<void>((r) => (release = r));
        return result;
      });
    try {
      const committing = host.execution.approve(
        scope(),
        f.id,
        f.card.id,
        artifacts,
      );
      await until(async () => entered);
      await host.stop(scope(), f.id);
      await host.continue(scope(), f.id);
      const owner = await host.execution.claim(scope(), f.id, f.p.proof.turnId);
      const before = (
        await db.query(
          "SELECT lease_until FROM assistant_runtime_execution WHERE session_id=$1",
          [f.id],
        )
      ).rows[0].lease_until;
      release();
      await committing;
      await host.execution.guard(owner);
      expect(
        (
          await db.query(
            "SELECT lease_until FROM assistant_runtime_execution WHERE session_id=$1",
            [f.id],
          )
        ).rows[0].lease_until,
      ).toEqual(before);
      expect((await host.present(scope(), f.id)).businessStatus).toBe("saved");
      await host.execution.yield(owner, "paused", "test_complete");
    } finally {
      release?.();
      spy.mockRestore();
    }
  });
  it("records a response-body timeout as unknown rather than a successful 200 result", async () => {
    const id = await fresh(),
      a = await submit(id, "查看项目");
    outputs = [{ role: "assistant", content: "迟到正文", bodyDelayMs: 160 }];
    const short = new FormalSessionHost(db, config, {
      policy: { requestMs: 70, leaseMs: 10000, graphSteps: 30 },
    });
    try {
      const result = await short.runPending(scope(), id, a.json().turnId);
      expect(result.execution).toMatchObject({
        status: "paused",
        reason: "model_request_timeout",
      });
      expect(
        (
          await db.query(
            "SELECT status,error_code,usage FROM assistant_runtime_request WHERE turn_id=$1",
            [a.json().turnId],
          )
        ).rows[0],
      ).toMatchObject({
        status: 200,
        error_code: "model_request_timeout",
        usage: null,
      });
    } finally {
      await short.close();
    }
  });
  it("enforces the first assistant and worker request against a short external activity deadline", async () => {
    const id = await fresh();
    await host.execution.ensure(db, scope(), id);
    const cap = "r03-first-cap-" + randomUUID();
    await db.query(
      "INSERT INTO assistant_runtime_activity(id,request_limit,max_ms) VALUES($1,5,60)",
      [cap],
    );
    await db.query(
      "UPDATE assistant_runtime_execution SET activity_id=$2 WHERE session_id=$1",
      [id, cap],
    );
    const result = await run(id, "查看项目", [
      async () => {
        await new Promise((r) => setTimeout(r, 150));
        return { role: "assistant", content: "迟到活动" };
      },
    ]);
    expect(result.execution).toMatchObject({
      status: "paused",
      reason: "activity_budget_exhausted",
      requests: 1,
    });
    await expect(host.continue(scope(), id)).rejects.toMatchObject({
      code: "activity_budget_exhausted",
    });
    const wid = await fresh(),
      p = await processing(wid),
      wcap = "r03-worker-cap-" + randomUUID();
    await db.query(
      "INSERT INTO assistant_runtime_activity(id,request_limit,max_ms) VALUES($1,5,60)",
      [wcap],
    );
    await db.query(
      "UPDATE assistant_runtime_execution SET activity_id=$2 WHERE session_id=$1",
      [wid, wcap],
    );
    outputs = [
      async () => {
        await new Promise((r) => setTimeout(r, 150));
        return { role: "assistant", content: "迟到Worker" };
      },
    ];
    const { formalWorkerFetch } =
      await import("../../src/assistant-rebuild/worker-fetch.js");
    const rawSend = formalWorkerFetch(db, p.runId)(fetch);
    const send: typeof fetch = (...args) =>
      processingCost.run({ rows: 3, generated: 0 }, () => rawSend(...args));
    await expect(
      send(
        "http://127.0.0.1:" +
          (provider.address() as { port: number }).port +
          "/v1/chat/completions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            tools: [{ name: "synthetic" }],
            messages: [],
          }),
        },
      ),
    ).rejects.toBeDefined();
    expect(
      (
        await db.query(
          "SELECT error_code,usage FROM assistant_runtime_request WHERE session_id=$1 AND purpose='worker'",
          [wid],
        )
      ).rows[0],
    ).toMatchObject({ error_code: "activity_or_request_timeout", usage: null });
    await host.stop(scope(), wid);
  });

  it("uses execution-before-request lock order while another owner holds the execution row", async () => {
    const id = await fresh(),
      proof = await seed(id),
      requestId = "lock_" + randomUUID();
    await host.execution.reserve(proof, {
      id: requestId,
      sessionId: id,
      turnId: proof.turnId,
      purpose: "assistant",
      correctionOf: null,
      requestHash: "synthetic_admitted_fault",
    });
    const owner = await db.connect(),
      probe = await db.connect();
    let finishing: Promise<void> | undefined;
    try {
      await owner.query("BEGIN");
      await owner.query(
        "SELECT session_id FROM assistant_runtime_execution WHERE session_id=$1 FOR UPDATE",
        [id],
      );
      finishing = host.execution.outcome({
        id: requestId,
        status: 200,
        usage: null,
        error: null,
      });
      await until(async () =>
        Boolean(
          (
            await db.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT session_id FROM assistant_runtime_execution%'",
            )
          ).rowCount,
        ),
      );
      await probe.query("BEGIN");
      await probe.query(
        "SELECT id FROM assistant_runtime_request WHERE id=$1 FOR UPDATE NOWAIT",
        [requestId],
      );
      await probe.query("ROLLBACK");
      await owner.query("COMMIT");
      await finishing;
    } finally {
      await owner.query("ROLLBACK");
      await probe.query("ROLLBACK");
      owner.release();
      probe.release();
      await finishing;
    }
    await host.store.finish(proof, "锁序核对完成");
  });
  it("preserves saved business success when an optional subsequent model explanation fails", async () => {
    const f = await adoptionCard();
    await host.execution.approve(scope(), f.id, f.card.id, artifacts);
    const before = await effects();
    outputs = [{ httpStatus: 503 }];
    await host.runPending(scope(), f.id, f.p.proof.turnId);
    const result = await host.present(scope(), f.id);
    expect(result.businessStatus).toBe("saved");
    expect(
      result.receipts.filter((r) => r.isCurrent && r.acceptanceId),
    ).toHaveLength(1);
    expect(await effects()).toEqual(before);
  });
  it("keeps no-progress and actual request accounting across a real framework summary", async () => {
    const id = await fresh(),
      before = requests.length;
    const result = await run(
      id,
      "只查看当前项目。".repeat(100),
      [
        call("read_project", {}),
        call("read_project", {}),
        call("read_project", {}),
        call("read_project", {}),
      ],
      { summaryTokens: 100 },
    );
    expect(result.execution).toMatchObject({
      status: "paused",
      reason: "no_progress",
      no_progress: 3,
    });
    const actual = (
      await db.query(
        "SELECT purpose,usage FROM assistant_runtime_request WHERE session_id=$1",
        [id],
      )
    ).rows;
    expect(actual.some((r) => r.purpose === "summary")).toBe(true);
    expect(actual.length).toBe(requests.length - before);
    expect(result.execution.requests).toBe(actual.length);
  });

  it("treats the same selected record as the same fact even with an extra unused asset in scope", async () => {
    const other = await adoptionCard();
    const adopted = await host.execution.approve(
      scope(),
      other.id,
      other.card.id,
      artifacts,
    );
    const b = adopted.receipt.assetId;
    const frozen = await host.store.freezeSource(scope(), {
      kind: "assets",
      assetIds: [assetId],
    });
    const recordIds = [frozen.source.recordIds[0]];
    const id = await fresh();
    const result = await run(
      id,
      "查看这一条记录",
      [0, 1, 2, 3].map((n) =>
        call("read_records", {
          source: {
            kind: "assets",
            assetIds: n % 2 ? [assetId, b] : [assetId],
            recordIds,
          },
        }),
      ),
    );
    expect(result.execution).toMatchObject({
      status: "paused",
      reason: "no_progress",
      no_progress: 3,
      progress_version: 1,
    });
  });
  it("starts a new explicit user intent after paused parameter correction without inheriting the old constraint", async () => {
    const id = await fresh();
    const invalid = {
      expectedRevision: 0,
      changes: { deliveries: [{ patch: { name: "第一份", count: 50 } }] },
      steps: [],
    };
    const stopped = await run(
      id,
      "先给五十条方案",
      [call("update_requirements", invalid)],
      {
        hooks: {
          beforeRequest: async (attempt) => {
            if (attempt.purpose === "correction") await host.stop(scope(), id);
          },
        },
      },
    );
    expect(stopped.execution.status).toBe("paused");
    expect(
      (
        await db.query(
          "SELECT feedback FROM assistant_runtime_execution WHERE session_id=$1",
          [id],
        )
      ).rows[0].feedback.args,
    ).toEqual(invalid);
    const amended = await run(id, "我改主意了，改成五十一条，仍然只给方案", [
      call("update_requirements", {
        expectedRevision: 0,
        changes: { deliveries: [{ patch: { name: "第一份", count: 51 } }] },
      }),
    ]);
    expect(amended.session.requirements.deliveries[0].count).toBe(51);
    // Changing a plan does not revoke an explicit user stop.
    expect(amended.execution.status).toBe("paused");
  });
  it("starts the public durable dispatcher on application startup for already accepted work", async () => {
    // A completed save remains authoritative if its optional model explanation later fails.
    for (const row of (
      await db.query(
        "SELECT id FROM assistant_runtime_turn WHERE status='pending'",
      )
    ).rows)
      await db.query(
        "UPDATE assistant_runtime_turn SET status='paused' WHERE id=$1",
        [row.id],
      );
    const id = await fresh(),
      a = await submit(id, "查看项目");
    outputs = [{ role: "assistant", content: "后台受理完成" }];
    const restarted = await buildApp(config, {
      disableLegacyTestBootstrap: true,
    });
    try {
      await restarted.ready();
      await until(async () => (await jobState(id))?.status === "completed");
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM assistant_runtime_request WHERE turn_id=$1",
            [a.json().turnId],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await restarted.close();
    }
  });
  it("R04 lists, searches and renames only the current actor private sessions with revision checks", async () => {
    const id = await fresh();
    const state = await host.store.get(scope(), id);
    expect(
      (
        await api("PATCH", route(id), {
          title: "独立会话四",
          expectedRevision: state.revision,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await api("PATCH", route(id), {
          title: "过期改名",
          expectedRevision: state.revision,
        })
      ).json().error.code,
    ).toBe("conversation_revision_conflict");
    expect(
      (
        await api(
          "GET",
          route() + "?search=" + encodeURIComponent("独立会话四"),
        )
      )
        .json()
        .sessions.map((r: any) => r.id),
    ).toContain(id);
    expect(
      (
        await api(
          "GET",
          route() + "?search=" + encodeURIComponent("独立会话四"),
          undefined,
          "editor",
        )
      ).json().sessions,
    ).toEqual([]);
    expect(
      (
        await api(
          "PATCH",
          route(id),
          { title: "越权", expectedRevision: 2 },
          "editor",
        )
      ).statusCode,
    ).toBe(404);
  });
  it("R04 validates private attachments and keeps upload bytes out of public events", async () => {
    const id = await fresh();
    const upload = await api("POST", route(id) + "/attachments", {
      fileName: "需求.md",
      contentBase64: Buffer.from(
        "只清洗问题，标签与Metadata保持不变。",
      ).toString("base64"),
    });
    expect(upload.statusCode, upload.body).toBe(200);
    const a = upload.json();
    expect(
      (await api("GET", route(id) + "/attachments/" + a.id)).json().extracted
        .fragments[0].text,
    ).toContain("Metadata");
    expect(
      (
        await api(
          "GET",
          route(id) + "/attachments/" + a.id,
          undefined,
          "editor",
        )
      ).statusCode,
    ).toBe(404);
    const state = await host.present(scope(), id);
    expect(state.workspace.attachments.map((r: any) => r.id)).toEqual([a.id]);
    expect(JSON.stringify(state.workspace)).not.toContain("object_ref");
    const unknown = await submit(id, "查看文档", { attachments: ["unknown"] });
    expect(unknown.json().error.code).toBe("attachment_not_found");
    expect(
      (await api("DELETE", route(id) + "/attachments/" + a.id)).statusCode,
    ).toBe(200);
    expect(
      (await api("GET", route(id) + "/attachments/" + a.id)).statusCode,
    ).toBe(404);
  });
  it("R04 streams actual SDK text and reconciles the persisted final message", async () => {
    const id = await fresh();
    const state = await run(id, "看一下项目", [
      {
        role: "assistant",
        content: "已经读取真实资料，解释不会当作保存回执。",
      },
    ]);
    expect(state.messages.at(-1)?.content).toContain("真实资料");
    expect(state.workspace.streams.map((s: any) => s.text).join("")).toBe(
      state.messages.at(-1)?.content,
    );
    expect(state.receipts).toEqual([]);
    expect(JSON.stringify(state.workspace)).not.toContain("requestHash");
  });
  it("R04 runs the real clean → durable wait → fixed confirmation → unique saved draft SDK chain", async () => {
    const id = await fresh();
    const fixed = await host.store.freezeSource(scope(), {
      kind: "assets",
      assetIds: [assetId],
    });
    const before = await effects();
    const original = {
      expectedRevision: 0,
      steps: [],
      changes: {
        mode: "execute",
        objective: "清洗前三条，保留原标签分布",
        deliveries: [
          {
            operation: "clean",
            source: JSON.stringify(fixed.source),
            count: "3",
            allowedFields: ["question"],
            metadataKeys: [],
            instructions: "",
            classifications: [
              {
                field: "expectedOutput",
                allowedValues: ["答案1", "答案2", "答案3"],
                quotas: [
                  { value: "答案1", count: 1 },
                  { value: "答案2", count: 1 },
                  { value: "答案3", count: 1 },
                ],
              },
            ],
            saveTarget: { kind: "newDraft", name: "R04三条整理版" },
          },
        ],
      },
    };
    const state = await run(id, "清洗前三条，只改问题，保存成三条整理版。", [
      { ...call("update_requirements", original), toolArgumentChunkSize: 2 },
      call("update_requirements", {
        expectedRevision: 0,
        changes: { deliveries: [{ patch: { count: 3 } }] },
      }),
      call("submit_processing", {}),
      call("wait_processing", {}),
    ]);
    expect(state.execution.status).toBe("waiting");
    expect(state.results).toHaveLength(1);
    const runId = state.results[0]!.run_id;
    const frozenRow = (
      await db.query(
        "SELECT input_ref,options FROM processing_run WHERE id=$1",
        [runId],
      )
    ).rows[0];
    const frozen = JSON.parse(
      (
        await new ArtifactRepository(config.minio).readBytes(
          frozenRow.input_ref,
          1000000,
        )
      ).toString("utf8"),
    );
    expect(frozen.background.requirements.join(" ")).toContain("处理 3 条");
    expect(frozen.background.requirements).toContain(
      original.changes.objective,
    );
    expect(frozen.background.classifications[0].quotas).toEqual(
      original.changes.deliveries[0].classifications[0].quotas,
    );
    expect(frozen.records).toHaveLength(3);
    expect(frozenRow.options.metadataKeys).toBeUndefined();

    await completeRun(runId);
    await host.execution.wake();
    outputs = [call("prepare_adoption", {}), call("wait_confirmation", {})];
    const turn = (await host.execution.projection(scope(), id)).execution
      .turn_id;
    const pending = await host.runPending(scope(), id, turn);
    expect(pending.execution.status).toBe("confirmation");
    const card = pending.confirmations.find(
      (c: any) => c.status === "pending" && c.action === "adopt",
    );
    expect(card).toBeTruthy();
    const approved = await api(
      "POST",
      route(id) + "/confirmations/" + card.id,
      { accept: true },
    );
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().receipt.adopted).toBe(3);
    expect(
      (
        await api("POST", route(id) + "/confirmations/" + card.id, {
          accept: true,
        })
      ).json().replayed,
    ).toBe(true);
    const after = await effects();
    expect(after.drafts - before.drafts).toBe(1);
    expect(after.runs - before.runs).toBe(1);
    const refreshed = (await api("GET", route(id))).json();
    expect(refreshed.receipts.filter((r: any) => r.acceptanceId)).toHaveLength(
      1,
    );
    expect(refreshed.receipts[0].draftId).toBe(approved.json().receipt.draftId);
  });

  it.each([["question"], ["question", "expectedOutput"]])(
    "R04 refuses impossible deterministic classification with fields %j before creating a job",
    async (...allowedFields) => {
      const id = await fresh(),
        fixed = await host.store.freezeSource(scope(), {
          kind: "assets",
          assetIds: [assetId],
        }),
        before = await effects();
      await expect(
        run(id, "清洗但保留标签", [
          call("update_requirements", {
            expectedRevision: 0,
            changes: {
              mode: "execute",
              deliveries: [
                {
                  patch: {
                    operation: "clean",
                    source: fixed.source,
                    count: 3,
                    allowedFields,
                    instructions: "",
                    classifications: [
                      {
                        field: "expectedOutput",
                        allowedValues: ["来源中不存在"],
                      },
                    ],
                    saveTarget: { kind: "newDraft", name: "不应保存" },
                  },
                },
              ],
            },
          }),
          call("submit_processing", {}),
        ]),
      ).rejects.toMatchObject({ code: "assistant_requirement_conflict" });
      expect(await effects()).toEqual(before);
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM assistant_runtime_event WHERE session_id=$1 AND kind='parameter_feedback'",
            [id],
          )
        ).rows[0].n,
      ).toBe(0);
    },
  );

  it("R04 validates actual rewritten output constraints before a save confirmation", async () => {
    const id = await fresh(),
      fixed = await host.store.freezeSource(scope(), {
        kind: "assets",
        assetIds: [assetId],
      }),
      before = await effects();
    const patch = {
      operation: "rewrite",
      source: fixed.source,
      count: 3,
      allowedFields: ["question", "expectedOutput"],
      instructions: "期望输出改成新标签",
      classifications: [{ field: "expectedOutput", allowedValues: ["新标签"] }],
      saveTarget: { kind: "newDraft", name: "不得误保存" },
    };
    const state = await run(id, "改写三条", [
      call("update_requirements", {
        expectedRevision: 0,
        changes: { mode: "execute", deliveries: [{ patch }] },
      }),
      call("submit_processing", {}),
      call("wait_processing", {}),
    ]);
    expect(state.execution.status).toBe("waiting");
    await completeRun(state.results[0].run_id);
    await host.execution.wake();
    outputs = [call("prepare_adoption", {})];
    const turn = (await host.execution.projection(scope(), id)).execution
      .turn_id;
    await expect(host.runPending(scope(), id, turn)).rejects.toMatchObject({
      code: "assistant_requirement_conflict",
    });
    const after = await effects();
    expect(after.runs - before.runs).toBe(1);
    expect(after.drafts - before.drafts).toBe(0);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM assistant_runtime_confirmation WHERE session_id=$1 AND action='adopt'",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it.each(["continue", "rename-only"])(
    "SAVE RECOVERY stopped result survives target amendment %s",
    async (mode) => {
      const { id, plan } = await reviewCreate();
      const before = await effects();
      const start = await run(id, "清洗后保存", [
        plan,
        call("submit_processing", {}),
      ]);
      const runId = start.results[0].run_id;
      await completeRun(runId);
      await host.execution.wake();
      outputs = [call("prepare_adoption", {})];
      const ready = await host.runPending(scope(), id, start.execution.turn_id);
      const oldCard = ready.confirmations.find(
        (c: any) => c.status === "pending",
      );
      expect(oldCard).toBeTruthy();
      await host.stop(scope(), id);
      await run(id, "现在做到哪了？", [
        call("read_task_progress", {}),
        { role: "assistant", content: "已处理，尚未保存。" },
      ]);
      const saved = await host.store.get(scope(), id);
      const changed = await run(
        id,
        mode === "continue"
          ? "继续，完成后保存成客服整理版。"
          : "只改名为客服整理版，先不要继续。",
        [
          call("update_requirements", {
            expectedRevision: saved.requirements_revision,
            changes: {
              deliveries: [
                {
                  deliveryId: saved.requirements.deliveries[0].id,
                  patch: {
                    name: "客服整理版",
                    saveTarget: { kind: "newDraft", name: "客服整理版" },
                  },
                },
              ],
            },
          }),
          ...(mode === "continue"
            ? [call("continue_task", {})]
            : [{ role: "assistant", content: "已修改名称，保持暂停。" }]),
        ],
      );
      expect(
        changed.results.find((r: any) => r.run_id === runId)?.isCurrent,
      ).toBe(true);
      if (mode === "rename-only") {
        expect(changed.execution.status).toBe("paused");
        expect(
          changed.confirmations.filter((c: any) => c.status === "pending"),
        ).toHaveLength(0);
        expect(
          (await api("POST", route(id) + "/control", { action: "continue" }))
            .statusCode,
        ).toBe(200);
      }
      outputs = [call("prepare_adoption", {})];
      const resumed = await host.runPending(
        scope(),
        id,
        start.execution.turn_id,
      );
      const card = resumed.confirmations.find(
        (c: any) => c.status === "pending",
      );
      expect(card?.payload.input.target.name).toBe("客服整理版");
      expect(card.id).not.toBe(oldCard.id);
      expect(
        (
          await api("POST", route(id) + "/confirmations/" + oldCard.id, {
            accept: true,
          })
        ).statusCode,
      ).toBe(409);
      const approved = await api(
        "POST",
        route(id) + "/confirmations/" + card.id,
        { accept: true },
      );
      expect(approved.statusCode, approved.body).toBe(200);
      expect(
        (
          await api("POST", route(id) + "/confirmations/" + card.id, {
            accept: true,
          })
        ).json().replayed,
      ).toBe(true);
      outputs = [{ role: "assistant", content: "已保存客服整理版。" }];
      await host.runPending(scope(), id, start.execution.turn_id);
      const final = await host.present(scope(), id);
      expect(final.results).toHaveLength(1);
      expect(final.receipts.filter((r: any) => r.acceptanceId)).toHaveLength(1);
      const after = await effects();
      expect(after.runs - before.runs).toBe(1);
      expect(after.drafts - before.drafts).toBe(1);
    },
  );

  it.each(["omitted", "noop", "compound"])(
    "RESUME CONTRACT actual SDK recovers omitted control %s",
    async (mode) => {
      const { id, plan } = await reviewCreate();
      const before = await effects();
      const start = await run(id, "清洗后保存", [
        plan,
        call("submit_processing", {}),
      ]);
      const runId = start.results[0].run_id;
      await completeRun(runId);
      await host.execution.wake();
      outputs = [call("prepare_adoption", {})];
      const ready = await host.runPending(scope(), id, start.execution.turn_id);
      const oldCard = ready.confirmations.find(
        (c: any) => c.status === "pending",
      );
      await host.stop(scope(), id);
      const saved = await host.store.get(scope(), id);
      const amendment = (revision: number) =>
        call("update_requirements", {
          expectedRevision: revision,
          changes: {
            deliveries: [
              {
                deliveryId: saved.requirements.deliveries[0].id,
                patch: {
                  saveTarget: { kind: "newDraft", name: "客服整理版补验" },
                },
              },
            ],
          },
        });
      const changed = await run(
        id,
        "先把保存名称改成“客服整理版补验”，不要继续。",
        [
          amendment(saved.requirements_revision),
          { role: "assistant", content: "已安排继续，请点击旧确认卡保存。" },
        ],
      );
      expect(changed.execution.status).toBe("paused");
      expect(changed.messages.at(-1).content).not.toContain("已安排继续");
      expect(changed.messages.at(-1).content).not.toContain("点击旧确认卡");
      const current = await host.store.get(scope(), id);
      const resumed = await run(
        id,
        mode === "compound"
          ? "请现在继续，并让我确认保存“客服整理版补验”。"
          : "继续保存已经完成的结果。",
        [
          ...(mode === "noop"
            ? [
                call("read_task_progress", {}),
                amendment(current.requirements_revision),
                call("read_task_progress", {}),
              ]
            : []),
          { role: "assistant", content: "已保存，点击旧确认卡即可。" },
        ],
      );
      expect(resumed.execution.status).toBe("pending");
      expect(resumed.execution.turn_id).toBe(start.execution.turn_id);
      expect(resumed.messages.at(-1).content).not.toContain("已保存");
      outputs = [call("prepare_adoption", {})];
      const next = await host.runPending(scope(), id, start.execution.turn_id);
      const card = next.confirmations.find((c: any) => c.status === "pending");
      expect(card.payload.input.target.name).toBe("客服整理版补验");
      expect(card.id).not.toBe(oldCard.id);
      expect(
        (
          await api("POST", route(id) + "/confirmations/" + oldCard.id, {
            accept: true,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await api("POST", route(id) + "/confirmations/" + card.id, {
            accept: true,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await api("POST", route(id) + "/confirmations/" + card.id, {
            accept: true,
          })
        ).json().replayed,
      ).toBe(true);
      outputs = [{ role: "assistant", content: "已保存。" }];
      await host.runPending(scope(), id, start.execution.turn_id);
      const after = await effects();
      expect(after.runs - before.runs).toBe(1);
      expect(after.drafts - before.drafts).toBe(1);
      expect(
        (await host.present(scope(), id)).receipts.filter(
          (r: any) => r.acceptanceId,
        ),
      ).toHaveLength(1);
    },
  );

  it.each(["missing", "unchanged", "stop"])(
    "RESUME CONTRACT cannot skip amendment or newer stop %s",
    async (mode) => {
      const { id, plan } = await reviewCreate();
      const start = await run(id, "清洗后保存", [
        plan,
        call("submit_processing", {}),
      ]);
      await completeRun(start.results[0].run_id);
      await host.execution.wake();
      outputs = [call("prepare_adoption", {})];
      await host.runPending(scope(), id, start.execution.turn_id);
      await host.stop(scope(), id);
      const current = await host.store.get(scope(), id),
        before = await effects();
      const replies =
        mode === "unchanged"
          ? [
              call("update_requirements", {
                expectedRevision: current.requirements_revision,
                changes: {
                  deliveries: [
                    {
                      deliveryId: current.requirements.deliveries[0].id,
                      patch: {
                        saveTarget:
                          current.requirements.deliveries[0].saveTarget,
                      },
                    },
                  ],
                },
              }),
            ]
          : [];
      const action = run(
        id,
        mode === "stop" ? "继续" : "继续，完成后保存成新的名字。",
        [...replies, { role: "assistant", content: "已修改并继续了。" }],
        mode === "stop"
          ? {
              hooks: {
                afterResponse: async () => {
                  await host.stop(scope(), id);
                },
              },
            }
          : {},
      );
      if (mode === "stop") await action;
      else
        await expect(action).rejects.toMatchObject({
          code: "requirements_amendment_pending",
        });
      const state = await host.present(scope(), id);
      expect(state.execution.status).toBe("paused");
      expect(
        state.confirmations.filter((c: any) => c.status === "pending"),
      ).toHaveLength(0);
      expect(await effects()).toEqual(before);
    },
  );

  it("RESUME CONTRACT newer stop cancels queued recovery even after a query", async () => {
    const id = await fresh(),
      pending = await processing(id, "rewrite");
    await host.stop(scope(), id);
    const msg = await submit(id, "继续");
    const proof = await host.execution.claim(scope(), id, msg.json().turnId);
    await host.execution.requestResume(proof);
    await host.stop(scope(), id);
    const before = await effects();
    const result = await run(id, "现在进度怎样？", [
      call("read_task_progress", {}),
      { role: "assistant", content: "已继续" },
    ]);
    expect(result.execution.status).toBe("paused");
    expect(result.execution.turn_id).toBe(pending.proof.turnId);
    expect(
      (
        await db.query(
          "SELECT resume_suspended,resume_requested FROM assistant_runtime_execution WHERE session_id=$1",
          [id],
        )
      ).rows[0],
    ).toEqual({ resume_suspended: false, resume_requested: false });
    expect(await effects()).toEqual(before);
  });
  it.each(["wrong-field", "same-target"])(
    "RESUME CONTRACT checks actual save target %s",
    async (mode) => {
      const { id, plan } = await reviewCreate();
      const start = await run(id, "清洗后保存", [
        plan,
        call("submit_processing", {}),
      ]);
      await host.stop(scope(), id);
      const current = await host.store.get(scope(), id);
      const currentTarget = current.requirements.deliveries[0].saveTarget;
      if (currentTarget?.kind !== "newDraft") throw Error("fixture_target");
      const target = mode === "same-target" ? currentTarget.name : "新名称";
      const response = run(id, `继续，完成后保存为“${target}”。`, [
        call("update_requirements", {
          expectedRevision: current.requirements_revision,
          changes: {
            deliveries: [
              {
                deliveryId: current.requirements.deliveries[0].id,
                patch:
                  mode === "same-target"
                    ? {
                        saveTarget:
                          current.requirements.deliveries[0].saveTarget,
                      }
                    : { name: target },
              },
            ],
          },
        }),
        { role: "assistant", content: "已安排继续" },
      ]);
      if (mode === "same-target")
        expect((await response).execution.status).toBe("pending");
      else
        await expect(response).rejects.toMatchObject({
          code: "requirements_amendment_pending",
        });
      await host.stop(scope(), id);
      expect((await host.present(scope(), id)).results[0].run_id).toBe(
        start.results[0].run_id,
      );
    },
  );

  it("SAVE RECOVERY rejects reuse after processing changes", async () => {
    const before = await effects();
    const { id, plan } = await reviewCreate();
    const start = await run(id, "清洗后保存", [
      plan,
      call("submit_processing", {}),
    ]);
    await completeRun(start.results[0].run_id);
    await host.execution.wake();
    outputs = [call("prepare_adoption", {})];
    await host.runPending(scope(), id, start.execution.turn_id);
    await host.stop(scope(), id);
    const saved = await host.store.get(scope(), id);
    const changed = await run(id, "先改成改写，暂不继续", [
      call("update_requirements", {
        expectedRevision: saved.requirements_revision,
        changes: {
          deliveries: [
            {
              deliveryId: saved.requirements.deliveries[0].id,
              patch: { operation: "rewrite", instructions: "改成自然问法" },
            },
          ],
        },
      }),
      { role: "assistant", content: "已修改，保持暂停。" },
    ]);
    expect(changed.results[0].isCurrent).toBe(false);
    expect(changed.execution.status).toBe("paused");
    expect(
      changed.confirmations.filter((c: any) => c.status === "pending"),
    ).toHaveLength(0);
    expect((await effects()).drafts).toBe(before.drafts);
  });

  it("AMENDMENT CONTRACT failed omission survives query and host restart until explicit cancellation", async () => {
    const { id, plan } = await reviewCreate();
    const started = await run(id, "清洗并等待确认", [
      plan,
      call("submit_processing", {}),
    ]);
    await completeRun(started.results[0].run_id);
    await host.execution.wake();
    outputs = [call("prepare_adoption", {})];
    const ready = await host.runPending(scope(), id, started.execution.turn_id);
    const card = ready.confirmations.find((c: any) => c.status === "pending");
    await host.stop(scope(), id);
    await expect(
      run(id, "只把保存名称改成“未生效名称”，先不要继续。", [
        { role: "assistant", content: "只答应，不调用。" },
        { role: "assistant", content: "仍未调用。" },
      ]),
    ).rejects.toMatchObject({ code: "requirements_amendment_pending" });
    expect((await host.present(scope(), id)).execution.status).toBe("paused");
    const pending = async () =>
      (
        await db.query(
          "SELECT detail FROM assistant_runtime_event WHERE session_id=$1 AND kind='save_target_amendment' ORDER BY id DESC LIMIT 1",
          [id],
        )
      ).rows[0].detail;
    expect((await pending()).status).toBe("pending");
    expect(
      (
        await api("POST", route(id) + "/confirmations/" + card.id, {
          accept: true,
        })
      ).statusCode,
    ).toBe(409);
    await run(id, "现在处理到哪了？", [
      call("read_task_progress", {}),
      { role: "assistant", content: "仍暂停" },
    ]);
    const other = new FormalSessionHost(db, config);
    try {
      await expect(other.execution.resume(scope(), id)).rejects.toMatchObject({
        code: "requirements_amendment_pending",
      });
    } finally {
      await other.close();
    }
    await expect(
      run(id, "继续。", [call("continue_task", {})]),
    ).rejects.toBeDefined();
    expect((await pending()).status).toBe("pending");
    expect(
      (
        await db.query(
          "SELECT count(*) FROM assistant_runtime_event WHERE session_id=$1 AND kind='save_target_recovery'",
          [id],
        )
      ).rows[0].count,
    ).toBe("1");
    await run(id, "撤销刚才的改名要求。", [
      { role: "assistant", content: "保持暂停" },
    ]);
    expect((await pending()).status).toBe("cancelled");
    expect((await host.present(scope(), id)).execution.status).toBe("paused");
  });

  it("AMENDMENT CONTRACT denial and quoted queries never create a write obligation", async () => {
    const { id, plan } = await reviewCreate();
    await run(id, "先保存要求", [plan]);
    for (const text of [
      "不要把保存名称改成X。",
      "是不是已保存为X？",
      "解释一下‘保存名称改成X’是什么意思？",
    ]) {
      await run(id, text, [{ role: "assistant", content: "仅说明" }]);
    }
    expect(
      (
        await db.query(
          "SELECT count(*) FROM assistant_runtime_event WHERE session_id=$1 AND kind='save_target_amendment'",
          [id],
        )
      ).rows[0].count,
    ).toBe("0");
  });
  it("R07 PUBLIC SDK background three plans cancel one execute 3+2 and save uniquely", async () => {
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 500; i++) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      console.log(
        "R07_LAST_EVENTS",
        JSON.stringify(
          (
            await db.query(
              "SELECT kind,detail FROM assistant_runtime_event ORDER BY id DESC LIMIT 14",
            )
          ).rows,
        ),
      );
      throw Error("R07_wait_timeout");
    };
    await db.query(
      "UPDATE assistant_runtime_turn SET status='paused',runner_token=NULL WHERE status IN('pending','running')",
    );
    const id = await fresh();
    expect(
      (
        await api("POST", route(id) + "/attachments", {
          fileName: "预约分类.md",
          contentBase64: Buffer.from(
            "# 预约说明\n咨询：询问办理条件与时间。\n预约：希望确定办理时段。",
          ).toString("base64"),
        })
      ).statusCode,
    ).toBe(200);
    const patch = (name: string, count: number, category: string) => ({
      name,
      operation: "generate",
      count,
      source: null,
      allowedFields: ["question", "expectedOutput", "metadata"],
      instructions:
        "依据附件生成语义完整的自然用户问题，期望输出描述应有行为。分类写入Metadata。",
      classifications: [
        {
          field: "metadata",
          key: "category",
          allowedValues: [category],
          requiredValues: [category],
          quotas: [{ value: category, count }],
        },
      ],
      saveTarget: {
        kind: "newDraft",
        name,
        purpose: `预约服务测试数据，${count}条。`,
      },
    });
    outputs = [
      call("create_requirements", {
        expectedRevision: 0,
        changes: {
          mode: "plan",
          objective: "按照预约说明分类制作测试数据",
          deliveries: [
            { patch: patch("咨询练习", 2, "咨询") },
            { patch: patch("预约练习", 2, "预约") },
            { patch: patch("混合练习", 2, "混合") },
          ],
        },
      }),
      { role: "assistant", content: "方案已保存，尚未执行。" },
    ];
    await isolateDispatcher(id);
    const dispatcher = await buildApp(config, {
      disableLegacyTestBootstrap: true,
    });
    const executionState = async () =>
      (
        await db.query(
          "SELECT status FROM assistant_runtime_execution WHERE session_id=$1",
          [id],
        )
      ).rows[0]?.status;
    try {
      await dispatcher.ready();
      expect(
        (
          await submit(
            id,
            "先规划咨询和预约各2条，再规划一份混合练习2条，先不执行。",
          )
        ).statusCode,
      ).toBe(202);
      await until(
        async () =>
          (await host.store.get(scope(), id)).requirements.deliveries.length ===
            3 && (await host.store.get(scope(), id)).status === "idle",
      );
      expect((await host.present(scope(), id)).results).toHaveLength(0);
      const first = await host.store.get(scope(), id),
        [a, b, c] = first.requirements.deliveries;
      outputs = [
        call("update_requirements", {
          expectedRevision: first.requirements_revision,
          changes: {
            mode: "execute",
            deliveries: [
              {
                deliveryId: a.id,
                patch: {
                  count: 3,
                  instructions: a.instructions,
                  classifications: [
                    {
                      field: "metadata",
                      key: "category",
                      allowedValues: ["咨询"],
                      requiredValues: ["咨询"],
                      quotas: [{ value: "咨询", count: 3 }],
                    },
                  ],
                },
              },
              { deliveryId: c.id, patch: { status: "cancelled" } },
            ],
          },
        }),
        call("submit_processing", { deliveryId: a.id }),
        call("prepare_adoption", { deliveryId: a.id }, "z_prepare_first"),
      ];
      const repaired = JSON.parse(outputs[0].tool_calls[0].function.arguments);
      repaired.changes.deliveries[0].patch.saveTarget = {
        ...a.saveTarget,
        purpose: "预约服务测试数据，3条。",
      };
      outputs.splice(1, 0, call("update_requirements", repaired));
      expect(
        (
          await submit(
            id,
            "混合练习不要了，咨询练习改成3条，预约2条不变，现在执行。",
          )
        ).statusCode,
      ).toBe(202);
      await until(async () => (await executionState()) === "waiting").catch(
        async (e) => {
          console.log(
            "R07_DIAGNOSTIC",
            JSON.stringify(
              (
                await db.query(
                  "SELECT kind,detail FROM assistant_runtime_event WHERE session_id=$1 AND kind IN('tool_error','requirements_feedback','parameter_feedback','execution_paused') ORDER BY id",
                  [id],
                )
              ).rows,
            ),
          );
          throw e;
        },
      );

      let state = await host.present(scope(), id);
      const runA = state.results[0].run_id;
      await completeRun(runA);
      await until(async () => (await executionState()) === "confirmation");
      state = await host.present(scope(), id);
      const cardA = state.confirmations.find(
        (x: any) => x.status === "pending",
      );
      expect(cardA.payload.input.target.name).toBe("咨询练习");
      outputs = [
        call("submit_processing", { deliveryId: b.id }),
        call("prepare_adoption", { deliveryId: b.id }, "a_prepare_second"),
      ];
      expect(
        (
          await api("POST", route(id) + "/confirmations/" + cardA.id, {
            accept: true,
          })
        ).statusCode,
      ).toBe(200);
      await until(async () => (await executionState()) === "waiting");
      state = await host.present(scope(), id);
      const runB = state.results.find((r: any) => r.run_id !== runA).run_id;
      await completeRun(runB);
      await until(async () => (await executionState()) === "confirmation");
      state = await host.present(scope(), id);
      const cardB = state.confirmations.find(
        (x: any) => x.status === "pending",
      );
      expect(cardB.payload.input.target.name).toBe("预约练习");
      outputs = [
        { role: "assistant", content: "两份已保存，取消项没有执行。" },
      ];
      expect(
        (
          await api("POST", route(id) + "/confirmations/" + cardB.id, {
            accept: true,
          })
        ).statusCode,
      ).toBe(200);
      await until(async () => (await executionState()) === "completed");
      state = await host.present(scope(), id);
      expect(state.results).toHaveLength(2);
      expect(state.receipts.filter((r: any) => r.acceptanceId)).toHaveLength(2);
      const cancelled = (
        await host.store.get(scope(), id)
      ).requirements.deliveries.find((d) => d.id === c.id);
      expect(cancelled?.status).toBe("cancelled");
      expect(
        (await host.store.get(scope(), id)).requirements.deliveries.find(
          (d) => d.id === a.id,
        )?.saveTarget,
      ).toMatchObject({ purpose: "预约服务测试数据，3条。" });
      expect(
        (
          await db.query(
            "SELECT id FROM assistant_runtime_operation WHERE session_id=$1 AND operation_key LIKE $2",
            [id, "processing:" + c.id + ":%"],
          )
        ).rowCount,
      ).toBe(0);
      const drafts = state.receipts
        .filter((r: any) => r.acceptanceId)
        .map((r: any) => r.draftId);
      expect(
        (
          await db.query(
            "SELECT count(*) n FROM collaborative_draft_record WHERE draft_id=ANY($1::text[]) AND deleted=false",
            [drafts],
          )
        ).rows[0].n,
      ).toBe("5");
      const readback = await host.present(scope(), id);
      expect(
        readback.session.requirements.deliveries.find((d: any) => d.id === c.id)
          ?.status,
      ).toBe("cancelled");
      const firstReceipt = state.receipts.find(
        (r: any) => r.acceptanceId && r.draftName === "咨询练习",
      );
      const taskId = (
        await db.query("SELECT task_id FROM processing_run WHERE id=$1", [runA])
      ).rows[0].task_id;
      const { previewTaskInput } =
        await import("../../src/processing/tasks.js");
      const input = await previewTaskInput(db, artifacts, scope(), taskId, {
        mode: "saved",
        limit: 100,
      });
      outputs = [
        call("read_draft", {
          draftId: firstReceipt.draftId,
          limit: 5,
          offset: 0,
        }),
        call("create_requirements", {
          expectedRevision: 2,
          changes: {
            mode: "execute",
            objective: "基于咨询第一条再扩充2条保存回原草稿",
            deliveries: [
              {
                patch: {
                  name: "咨询扩充",
                  operation: "augment",
                  count: 2,
                  source: {
                    kind: "draft",
                    id: firstReceipt.draftId,
                    recordIds: [input.records[0].id],
                  },
                  saveTarget: { kind: "draft", id: firstReceipt.draftId },
                  instructions:
                    "围绕咨询需求生成不同场景的完整问题，保留原标签和Metadata。",
                  allowedFields: ["question"],
                },
              },
            ],
          },
        }),
        call("submit_processing", {}),
      ];
      expect(
        (await submit(id, "从第一份保存结果中选第一条，再扩充2条，其余不动。"))
          .statusCode,
      ).toBe(202);
      await until(async () => (await executionState()) === "waiting");
      const extended = await host.present(scope(), id),
        runC = extended.results.find(
          (r: any) => ![runA, runB].includes(r.run_id),
        ).run_id;
      expect(
        (
          await db.query(
            "SELECT input_count,task_id FROM processing_run WHERE id=$1",
            [runC],
          )
        ).rows[0],
      ).toMatchObject({ input_count: 1, task_id: taskId });
      outputs = [call("prepare_adoption", {})];
      await completeRun(runC);
      await until(async () => (await executionState()) === "confirmation");
      const save = (await host.present(scope(), id)).confirmations.find(
        (card: any) => card.status === "pending",
      );
      outputs = [{ role: "assistant", content: "新增2条已经保存回原草稿。" }];
      expect(
        (
          await api("POST", route(id) + "/confirmations/" + save.id, {
            accept: true,
          })
        ).statusCode,
      ).toBe(200);
      await until(async () => (await executionState()) === "completed");
      expect(
        (
          await db.query(
            "SELECT count(*) n FROM collaborative_draft_record WHERE draft_id=$1 AND deleted=false",
            [firstReceipt.draftId],
          )
        ).rows[0].n,
      ).toBe("5");
      expect(
        (
          await db.query(
            "SELECT count(*) n FROM collaborative_draft WHERE id=ANY($1::text[])",
            [drafts],
          )
        ).rows[0].n,
      ).toBe("2");
    } finally {
      await dispatcher.close();
    }
  }, 120000);

  it("R07 task tools use real same-task rounds, save targets and frozen revisions", async () => {
    const { id, plan } = await reviewCreate();
    const started = await run(id, "清洗固定三条", [
      plan,
      call("submit_processing", {}),
    ]);
    await completeRun(started.results[0].run_id);
    await host.execution.wake();
    outputs = [call("prepare_adoption", {})];
    await host.runPending(scope(), id, started.execution.turn_id);
    const taskId = (
      await db.query("SELECT task_id FROM processing_run WHERE id=$1", [
        started.results[0].run_id,
      ])
    ).rows[0].task_id;
    const { readProcessingTask } =
      await import("../../src/processing/tasks.js");
    let task = await readProcessingTask(db, artifacts, scope(), taskId, {
      limit: "100",
    });
    const selected = [task.records[0].id];
    await host.stop(scope(), id);
    const next = await run(id, "只继续处理选中的一条，其他保留", [
      call("submit_processing_round", {
        taskId,
        expectedRevision: task.task.revision,
        mode: "continue",
        resultIds: selected,
        options: {
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      }),
    ]);
    expect(
      next.results.length,
      JSON.stringify({
        state: next,
        events: (
          await db.query(
            "SELECT kind,detail FROM assistant_runtime_event WHERE session_id=$1 ORDER BY id",
            [id],
          )
        ).rows,
      }),
    ).toBeGreaterThan(1);
    const child = next.results.find(
      (r: any) => r.run_id !== started.results[0].run_id,
    ).run_id;
    await completeRun(child);
    await host.execution.wake();
    outputs = [{ role: "assistant", content: "本轮完成" }];
    await host.runPending(scope(), id, next.execution.turn_id);
    task = await readProcessingTask(db, artifacts, scope(), taskId, {
      limit: "100",
    });
    expect(task.task.roundCount).toBe(2);
    expect(task.total).toBe(3);
    const ready = await run(id, "把当前三条保存为轮次结果，先让我确认", [
      call("prepare_processing_task_save", {
        taskId,
        expectedRevision: task.task.revision,
        resultIds: task.records.map((r) => r.id),
        target: { kind: "newDraft", name: "轮次结果", purpose: "" },
      }),
    ]);
    const card = ready.confirmations.find((c: any) => c.status === "pending");
    expect(card.payload.taskId).toBe(taskId);
    expect(
      (
        await api("POST", route(id) + "/confirmations/" + card.id, {
          accept: true,
        })
      ).statusCode,
    ).toBe(200);
    outputs = [{ role: "assistant", content: "已保存" }];
    await host.runPending(scope(), id, ready.execution.turn_id);
    task = await readProcessingTask(db, artifacts, scope(), taskId, {
      limit: "100",
    });
    expect(task.task.canContinueSaved).toBe(true);
    const savedRound = await run(id, "从已保存的草稿范围再处理一次", [
      call("submit_processing_round", {
        taskId,
        expectedRevision: task.task.revision,
        mode: "saved",
        options: {
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      }),
    ]);
    const runId = savedRound.results.find(
      (r: any) => ![child, started.results[0].run_id].includes(r.run_id),
    ).run_id;
    expect(
      (
        await db.query(
          "SELECT task_id,source FROM processing_run WHERE id=$1",
          [runId],
        )
      ).rows[0],
    ).toMatchObject({ task_id: taskId, source: { kind: "draft" } });
    await host.stop(scope(), id);
  }, 120000);
  it("R07 SDK background round modes, deduplication, paused-query fence, replay and asset save", async () => {
    const id = await fresh();
    expect(
      (
        await api("POST", route(id) + "/attachments", {
          fileName: "咨询说明.md",
          contentBase64:
            Buffer.from("咨询：请说明办理条件和所需材料。").toString("base64"),
        })
      ).statusCode,
    ).toBe(200);
    const started = await run(
      id,
      "依据文档生成三条咨询测试，执行后让我审核。",
      [
        call("create_requirements", {
          expectedRevision: 0,
          changes: {
            mode: "execute",
            deliveries: [
              {
                patch: {
                  name: "咨询",
                  operation: "generate",
                  source: null,
                  count: 3,
                  instructions:
                    "生成语义完整且不同的咨询用户问题，期望输出描述应有行为。",
                  allowedFields: ["question", "expectedOutput", "metadata"],
                  saveTarget: { kind: "newDraft", name: "咨询" },
                },
              },
            ],
          },
        }),
        call("submit_processing", {}),
      ],
    );
    const first = started.results[0].run_id;
    await completeRun(first);
    await host.stop(scope(), id);
    const taskId = (
      await db.query("SELECT task_id FROM processing_run WHERE id=$1", [first])
    ).rows[0].task_id;
    const { readProcessingTask } =
      await import("../../src/processing/tasks.js");
    let task = await readProcessingTask(db, artifacts, scope(), taskId, {
      limit: "100",
    });
    const options = {
      operation: "rewrite",
      instructions: "保留原意，改为完整自然的问句。",
      allowedFields: ["question"],
    };
    let round = await run(id, "对这三条继续处理，改写问题，其余字段保留。", [
      call("submit_processing_round", {
        taskId,
        expectedRevision: task.task.revision,
        mode: "continue",
        resultIds: task.records.map((r) => r.id),
        options,
      }),
    ]);
    let child = round.results.find((r: any) => r.run_id !== first).run_id;
    const frozen = JSON.parse(
      (
        await artifacts.readBytes(
          (
            await db.query("SELECT input_ref FROM processing_run WHERE id=$1", [
              child,
            ])
          ).rows[0].input_ref,
          1000000,
        )
      ).toString(),
    );
    expect(frozen.background.contentReviewPolicy).toBe("manual-v1");
    const workerBefore = (
      await db.query(
        "SELECT count(*) n FROM assistant_runtime_request WHERE session_id=$1 AND purpose='worker'",
        [id],
      )
    ).rows[0].n;
    try {
      r07DuplicateQuestions = true;
      await completeRun(child);
    } finally {
      r07DuplicateQuestions = false;
    }
    await host.execution.wake();
    outputs = [{ role: "assistant", content: "请审核本轮结果。" }];
    await host.runPending(scope(), id, round.execution.turn_id);
    expect(
      Number(
        (
          await db.query(
            "SELECT count(*) n FROM assistant_runtime_request WHERE session_id=$1 AND purpose='worker'",
            [id],
          )
        ).rows[0].n,
      ) - Number(workerBefore),
    ).toBe(1);
    task = await readProcessingTask(db, artifacts, scope(), taskId, {
      limit: "100",
    });
    await run(id, "查看任务、历史和重复组，先不要修改。", [
      call("list_processing_tasks", { limit: 1, offset: 0 }),
      call("read_processing_task", { taskId, limit: 2, offset: 0 }),
      call("read_processing_history", { taskId, limit: 5, offset: 0 }),
      call("deduplicate_processing_task", {
        taskId,
        resultIds: task.records.map((r) => r.id),
      }),
    ]);
    expect(
      (await host.present(scope(), id)).workspace.nativeActions.some(
        (a: any) => a.kind === "navigation" && a.href.includes(child),
      ),
    ).toBe(true);
    const originalCount = task.total;
    await run(id, "排除重复候选，保留一份。", [
      call("deduplicate_processing_task", {
        taskId,
        resultIds: task.records.map((r) => r.id),
        action: "exclude",
        expectedRevision: task.task.revision,
      }),
    ]);
    task = await readProcessingTask(db, artifacts, scope(), taskId, {
      limit: "100",
    });
    expect(task.total).toBe(1);
    await run(id, "恢复刚才排除的候选。", [
      call("deduplicate_processing_task", {
        taskId,
        action: "restore",
        expectedRevision: task.task.revision,
      }),
    ]);
    task = await readProcessingTask(db, artifacts, scope(), taskId, {
      limit: "100",
    });
    expect(task.total).toBe(originalCount);
    round = await run(id, "沿上一轮完整冻结输入重跑改写。", [
      call("submit_processing_round", {
        taskId,
        expectedRevision: task.task.revision,
        mode: "rerun",
        options,
      }),
    ]);
    child = round.results.find(
      (r: any) =>
        ![first, ...started.results.map((r: any) => r.run_id)].includes(
          r.run_id,
        ) && r.turn_id === round.execution.turn_id,
    ).run_id;
    await completeRun(child);
    await host.execution.wake();
    outputs = [{ role: "assistant", content: "已完成，未保存。" }];
    await host.runPending(scope(), id, round.execution.turn_id);
    task = await readProcessingTask(db, artifacts, scope(), taskId, {
      limit: "100",
    });
    expect(task.total).toBe(3);
    const prior = round.results.map((r: any) => r.run_id),
      body = {
        taskId,
        expectedRevision: task.task.revision,
        mode: "continue",
        resultIds: [task.records[0].id],
        options,
      };
    round = await run(id, "只继续处理第一条，改写问题，其余保留。", [
      call("submit_processing_round", body),
    ]);
    const last = round.results.find(
      (r: any) => !prior.includes(r.run_id),
    ).run_id;
    await host.stop(scope(), id);
    const countBefore = (await effects()).runs;
    for (const text of [
      "只是看看扩充结果",
      "扩充2条，先不执行",
      "先不执行，重跑原输入只做方案",
    ]) {
      await run(id, text, [
        call("submit_processing_round", body),
        { role: "assistant", content: "原任务保持暂停，未执行。" },
      ]);
      expect((await effects()).runs).toBe(countBefore);
      expect((await jobState(id)).status).toBe("paused");
    }
    expect((await effects()).runs).toBe(countBefore);
    expect((await jobState(id)).status).toBe("paused");
    expect(
      (await api("POST", route(id) + "/control", { action: "continue" }))
        .statusCode,
    ).toBe(200);
    outputs = [];
    await host.runPending(scope(), id, round.execution.turn_id);
    expect(
      (await jobState(id)).status,
      JSON.stringify({
        state: await jobState(id),
        events: (
          await db.query(
            "SELECT turn_id,kind,detail FROM assistant_runtime_event WHERE session_id=$1 AND kind IN('tool_call','tool_error','execution_error','state_feedback','execution_paused','execution_resumed') ORDER BY id DESC LIMIT 20",
            [id],
          )
        ).rows,
        operations: (
          await db.query(
            "SELECT o.turn_id,o.run_id,o.payload,j.status FROM assistant_runtime_operation o LEFT JOIN processing_run r ON r.id=o.run_id LEFT JOIN job j ON j.id=r.job_id WHERE o.session_id=$1 AND o.kind='processing'",
            [id],
          )
        ).rows,
      }),
    ).toBe("waiting");
    expect((await effects()).runs).toBe(countBefore);
    await completeRun(last);
    await host.execution.wake();
    outputs = [{ role: "assistant", content: "所选一条完成，其他记录保持。" }];
    await host.runPending(scope(), id, round.execution.turn_id);
    task = await readProcessingTask(db, artifacts, scope(), taskId, {
      limit: "100",
    });
    expect(task.total).toBe(3);
    const save = await run(id, "将第一条另存为原始数据文件，先让我确认。", [
      call("prepare_processing_task_save", {
        taskId,
        expectedRevision: task.task.revision,
        resultIds: [task.records[0].id],
        target: { kind: "asset" },
      }),
    ]);
    const card = save.confirmations.find((c: any) => c.status === "pending");
    expect(
      (
        await api("POST", route(id) + "/confirmations/" + card.id, {
          accept: true,
        })
      ).statusCode,
    ).toBe(200);
    outputs = [{ role: "assistant", content: "已另存原始数据。" }];
    const done = await host.runPending(scope(), id, save.execution.turn_id);
    const receipt = done.receipts.find((r: any) => r.acceptanceId && r.assetId);
    expect(receipt).toMatchObject({ adopted: 1 });
    expect(receipt.fileName).toBeTruthy();
  }, 120000);

  it("R07 activity separately caps generated slots and atomically counts deterministic rounds", async () => {
    const id = await fresh(),
      p = await processing(id, "rewrite");
    const cap = "r07-cap-" + randomUUID();
    await db.query(
      "INSERT INTO assistant_runtime_activity(id,request_limit,row_limit,generated_limit,max_ms) VALUES($1,10,10,1,300000)",
      [cap],
    );
    await db.query(
      "UPDATE assistant_runtime_execution SET activity_id=$2 WHERE session_id=$1",
      [id, cap],
    );
    await expect(
      host.execution.reserveWorker(p.runId, "request-" + randomUUID(), "hash", {
        rows: 2,
        generated: 2,
      }),
    ).rejects.toMatchObject({ code: "activity_budget_exhausted" });
    expect(
      (
        await db.query(
          "SELECT requests,rows_used,generated_used FROM assistant_runtime_activity WHERE id=$1",
          [cap],
        )
      ).rows[0],
    ).toEqual({ requests: 0, rows_used: 0, generated_used: 0 });
    await host.execution.reserveWorker(
      p.runId,
      "request-" + randomUUID(),
      "hash",
      { rows: 2, generated: 1 },
    );
    expect(
      (
        await db.query(
          "SELECT requests,rows_used,generated_used FROM assistant_runtime_activity WHERE id=$1",
          [cap],
        )
      ).rows[0],
    ).toEqual({ requests: 1, rows_used: 2, generated_used: 1 });
    await host.stop(scope(), id);
    const fixed = await host.store.freezeSource(scope(), {
      kind: "assets",
      assetIds: [assetId],
    });
    const plain = await createProcessingRun(
      db,
      artifacts,
      scope(),
      "manual-" + randomUUID(),
      {
        source: fixed.source,
        options: {
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      },
    );
    await completeRun(plain.run.id);
    const taskId = (
      await db.query("SELECT task_id FROM processing_run WHERE id=$1", [
        plain.run.id,
      ])
    ).rows[0].task_id;
    const { readProcessingTask } =
      await import("../../src/processing/tasks.js");
    const task = await readProcessingTask(db, artifacts, scope(), taskId, {
        limit: "100",
      }),
      sid = await fresh();
    await run(sid, "查看处理任务", [call("read_processing_task", { taskId })]);
    await db.query(
      "UPDATE assistant_runtime_execution SET activity_id=$2 WHERE session_id=$1",
      [sid, cap],
    );
    const next = await run(sid, "只继续处理选中的一条，清洗问题。", [
      call("submit_processing_round", {
        taskId,
        expectedRevision: task.task.revision,
        mode: "continue",
        resultIds: [task.records[0].id],
        options: {
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      }),
    ]);
    expect(next.results).toHaveLength(1);
    expect(
      (
        await db.query(
          "SELECT rows_used,generated_used FROM assistant_runtime_activity WHERE id=$1",
          [cap],
        )
      ).rows[0],
    ).toEqual({ rows_used: 3, generated_used: 1 });
    await host.stop(scope(), sid);
  }, 120000);

  it("R07 SDK completes only missing rewrites without another semantic review", async () => {
    const { id, plan } = await reviewCreate();
    const p = JSON.parse(plan.tool_calls[0].function.arguments);
    p.changes.deliveries[0].patch.operation = "rewrite";
    p.changes.deliveries[0].patch.instructions =
      "保留原意，改写为自然完整问法。";
    const start = await run(id, "改写这三条问题，完成后给我检查。", [
        call("create_requirements", p),
        call("submit_processing", {}),
      ]),
      rid = start.results[0].run_id;
    try {
      r07WorkerLimits = [1, 0, 0];
      await expect(completeRun(rid)).rejects.toThrow("processing_batch_failed");
      await db.query(
        "UPDATE job SET status='failed',error_code='processing_batch_failed',lease_owner=NULL,lease_expires_at=NULL WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
        [rid],
      );
    } finally {
      r07WorkerLimits = [];
    }
    await host.stop(scope(), id);
    const taskId = (
      await db.query("SELECT task_id FROM processing_run WHERE id=$1", [rid])
    ).rows[0].task_id;
    const { readProcessingTask } =
      await import("../../src/processing/tasks.js");
    let task = await readProcessingTask(db, artifacts, scope(), taskId, {
      limit: "100",
    });
    expect(task.unprocessedIds).toHaveLength(2);
    const successful = task.records.find((r: any) => !r.unprocessed)!;
    const next = await run(id, "只补齐未完成的两条，已完成的不要重跑。", [
      call("submit_processing_round", {
        taskId,
        mode: "complete",
        expectedRevision: task.task.revision,
      }),
    ]);
    const child = next.results.find((r: any) => r.run_id !== rid).run_id;
    expect(
      (
        await db.query("SELECT input_count FROM processing_run WHERE id=$1", [
          child,
        ])
      ).rows[0].input_count,
    ).toBe(2);
    await completeRun(child);
    await host.execution.wake();
    outputs = [{ role: "assistant", content: "缺少部分已完成，请审核。" }];
    await host.runPending(scope(), id, next.execution.turn_id);
    task = await readProcessingTask(db, artifacts, scope(), taskId, {
      limit: "100",
    });
    expect(task.total).toBe(3);
    expect(task.unprocessedIds).toHaveLength(0);
    expect(task.records.find((r) => r.id === successful.id)).toMatchObject({
      result: successful.result,
      runId: (successful as any).runId,
    });
  }, 120000);
  it.each(["reduced scope", "only refund", "exclude refund"])(
    "R07 SDK %s freezes the changed real range before execute and cannot continue a plan",
    async (mode) => {
      if (!r07RefundAsset) {
        const collectionId = (
          await api("GET", "/api/projects/" + projectId + "/collections")
        ).json().collections[0].id;
        const uploaded = await app.inject({
          method: "POST",
          url: "/api/projects/" + projectId + "/pending-uploads",
          headers: {
            origin,
            ...identities.get("admin"),
            "content-type": "application/octet-stream",
            "x-file-name": "refund-scope.jsonl",
          },
          payload:
            [
              { question: "  我想申请退款  ", answer: "核对退款条件" },
              { question: "  退款多久能到账  ", answer: "说明到账时间" },
              { question: "  查询快递进度  ", answer: "提供物流查询" },
              { question: "  如何修改地址  ", answer: "说明修改地址步骤" },
            ]
              .map((r) => JSON.stringify(r))
              .join("\n") + "\n",
        });
        expect(uploaded.statusCode).toBe(201);
        const imported = await api(
            "POST",
            "/api/projects/" + projectId + "/pending-upload-batches/confirm",
            {
              collectionId,
              pendingUploadIds: [uploaded.json().pendingUpload.id],
              mode: "raw",
            },
          ),
          aid = imported.json().assets[0].id;
        const mapping = (
          await api(
            "GET",
            "/api/projects/" + projectId + "/assets/" + aid + "/mapping",
          )
        ).json();
        expect(
          (
            await api(
              "PUT",
              "/api/projects/" + projectId + "/assets/" + aid + "/mapping",
              {
                parsedViewId: mapping.parsedViewId,
                expectedRevision: 0,
                mapping: {
                  question: "/question",
                  expectedOutput: "/answer",
                  metadata: [],
                },
              },
            )
          ).statusCode,
        ).toBe(200);
        r07RefundAsset = aid;
      }
      const fixed = await host.store.freezeSource(scope(), {
          kind: "assets",
          assetIds: [r07RefundAsset!],
        }),
        sid = await fresh();
      const preview = (await import("../../src/processing/store.js"))
        .previewProcessingInput;
      const records = (
        await preview(
          db,
          scope(),
          { source: fixed.source, limit: 100 },
          "write",
          true,
        )
      ).records;
      const selected =
        mode === "reduced scope"
          ? records.slice(0, 1)
          : records.filter(
              (r) => r.question.includes("退款") === (mode === "only refund"),
            );
      let state = await run(sid, "先给四条数据的清洗方案，不执行。", [
        call("create_requirements", {
          expectedRevision: 0,
          changes: {
            mode: "plan",
            deliveries: [
              {
                patch: {
                  operation: "clean",
                  count: 4,
                  source: fixed.source,
                  allowedFields: ["question"],
                  instructions: "",
                  saveTarget: { kind: "newDraft", name: "范围验收" + mode },
                },
              },
            ],
          },
        }),
      ]);
      const did = state.session.requirements.deliveries[0].id,
        before = (await effects()).runs;
      await run(
        sid,
        mode === "reduced scope"
          ? "缩小为第一条，先不执行。"
          : mode === "only refund"
            ? "只保留退款类，先不执行。"
            : "排除退款类，先不执行。",
        [
          call("update_requirements", {
            expectedRevision: 1,
            changes: {
              mode: "plan",
              deliveries: [
                {
                  deliveryId: did,
                  patch: {
                    source: {
                      ...fixed.source,
                      recordIds: selected.map((r) => r.id),
                    },
                    count: selected.length,
                  },
                },
              ],
            },
          }),
          call("submit_processing", {}),
          { role: "assistant", content: "当前范围已保存为方案，尚未执行。" },
        ],
      ).catch((e) => expect(e.code).toBe("execution_not_authorized"));
      expect((await effects()).runs).toBe(before);
      await run(sid, "继续", [
        call("submit_processing", {}),
        { role: "assistant", content: "仍是方案，需要明确执行。" },
      ]).catch((e) => expect(e.code).toBe("execution_not_authorized"));
      expect((await effects()).runs).toBe(before);
      state = await run(sid, "现在按刚才确定的范围执行清洗，完成后让我确认。", [
        call("update_requirements", {
          expectedRevision: 2,
          changes: { mode: "execute" },
        }),
        call("submit_processing", {}),
      ]);
      const rid = state.results[0].run_id,
        record = (
          await db.query(
            "SELECT input_ref,input_count FROM processing_run WHERE id=$1",
            [rid],
          )
        ).rows[0];
      expect(record.input_count).toBe(selected.length);
      const input = JSON.parse(
        (await artifacts.readBytes(record.input_ref, 1000000)).toString(),
      );
      expect(input.records.map((r: any) => r.id).sort()).toEqual(
        selected.map((r) => r.id).sort(),
      );
      await completeRun(rid);
      await host.execution.wake();
      outputs = [call("prepare_adoption", {})];
      state = await host.runPending(scope(), sid, state.execution.turn_id);
      const card = state.confirmations.find((c: any) => c.status === "pending");
      expect(
        (
          await api("POST", route(sid) + "/confirmations/" + card.id, {
            accept: true,
          })
        ).statusCode,
      ).toBe(200);
      outputs = [{ role: "assistant", content: "授权范围已保存。" }];
      state = await host.runPending(scope(), sid, state.execution.turn_id);
      expect(state.receipts.find((r: any) => r.acceptanceId)?.adopted).toBe(
        selected.length,
      );
    },
    120000,
  );

  it("R07 SDK retries the original failed run once, replays queued retry, and cancels an owned run", async () => {
    const fixed = await host.store.freezeSource(scope(), {
      kind: "assets",
      assetIds: [assetId],
    });
    const created = await createProcessingRun(
        db,
        artifacts,
        scope(),
        "retry-fixture-" + randomUUID(),
        {
          source: fixed.source,
          options: {
            operation: "rewrite",
            instructions: "保留原意，自然改写问题。",
            allowedFields: ["question"],
          },
        },
      ),
      rid = created.run.id;
    // Fault before the first batch: the real Worker may exhaust a claim without producing output.
    await db.query(
      "UPDATE job SET status='failed',error_code='infrastructure_unavailable' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
      [rid],
    );
    const sid = await fresh();
    let next = await run(sid, "只重试这个任务的失败部分，保留已完成部分。", [
      call("control_processing_run", { runId: rid, action: "retry" }),
    ]);
    expect(next.execution.status).toBe("waiting");
    expect(next.results.map((r: any) => r.run_id)).toEqual([rid]);
    await host.stop(scope(), sid);
    expect(
      (await api("POST", route(sid) + "/control", { action: "continue" }))
        .statusCode,
    ).toBe(200);
    outputs = [];
    next = await host.runPending(scope(), sid, next.execution.turn_id);
    expect(next.execution.status).toBe("waiting");
    await completeRun(rid);
    await host.execution.wake();
    outputs = [{ role: "assistant", content: "原任务失败部分已处理。" }];
    await host.runPending(scope(), sid, next.execution.turn_id);
    expect(
      (
        await db.query(
          "SELECT count(*) n FROM processing_run WHERE task_id=(SELECT task_id FROM processing_run WHERE id=$1)",
          [rid],
        )
      ).rows[0].n,
    ).toBe("1");
    const cancelled = await createProcessingRun(
      db,
      artifacts,
      scope(),
      "cancel-fixture-" + randomUUID(),
      {
        source: fixed.source,
        options: {
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      },
    );
    await run(sid, "取消刚才那项尚未执行的处理。", [
      call("control_processing_run", {
        runId: cancelled.run.id,
        action: "cancel",
      }),
    ]);
    expect(
      (
        await db.query(
          "SELECT status FROM job WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
          [cancelled.run.id],
        )
      ).rows[0].status,
    ).toBe("cancel_requested");
    expect(
      (
        await db.query(
          "SELECT count(*) n FROM processing_batch WHERE run_id=$1",
          [cancelled.run.id],
        )
      ).rows[0].n,
    ).toBe("0");
  }, 120000);
  it("R07 SDK delivery cancellation fences its queued job and creates no confirmation", async () => {
    const { id, plan } = await reviewCreate();
    const p = JSON.parse(plan.tool_calls[0].function.arguments),
      other = structuredClone(p.changes.deliveries[0]);
    other.patch.saveTarget.name = "保留交付";
    p.changes.deliveries.push(other);
    let state = await run(id, "处理两份资料，逐份让我确认。", [
      call("create_requirements", p),
      call("submit_processing", {}),
    ]);
    const first = state.session.requirements.deliveries[0].id,
      rid = state.results[0].run_id;
    await host.stop(scope(), id);
    state = await run(id, "第一份不要了，保留第二份，暂不继续执行。", [
      call("update_requirements", {
        expectedRevision: 1,
        changes: {
          deliveries: [{ deliveryId: first, patch: { status: "cancelled" } }],
        },
      }),
      { role: "assistant", content: "第一份已取消，剩余交付暂不执行。" },
    ]);
    expect(
      state.session.requirements.deliveries.find((d: any) => d.id === first)
        ?.status,
    ).toBe("cancelled");
    expect(
      (
        await db.query(
          "SELECT status FROM job WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
          [rid],
        )
      ).rows[0].status,
    ).toBe("cancel_requested");
    expect(
      state.confirmations.filter((c: any) => c.status === "pending"),
    ).toHaveLength(0);
    expect(
      (
        await db.query(
          "SELECT count(*) n FROM processing_batch WHERE run_id=$1",
          [rid],
        )
      ).rows[0].n,
    ).toBe("0");
  }, 120000);

  it("SAVE RECOVERY public dispatcher SDK performs stop rename continue and unique save", async () => {
    let forcedAfterAmendment = false;
    const state = async (id: string) =>
      (
        await db.query(
          "SELECT status FROM assistant_runtime_execution WHERE session_id=$1",
          [id],
        )
      ).rows[0];
    await db.query(
      "UPDATE assistant_runtime_turn SET status='paused',runner_token=NULL WHERE status IN('pending','running')",
    );
    const { id, plan } = await reviewCreate();
    const before = await effects();
    outputs = [
      plan,
      call("submit_processing", {}),
      call("prepare_adoption", {}),
    ];
    const restarted = await buildApp(config, {
      disableLegacyTestBootstrap: true,
    });
    try {
      await restarted.ready();
      expect(
        (await submit(id, "清洗这三条，完成后让我确认保存")).statusCode,
      ).toBe(202);
      await until(async () => (await state(id))?.status === "waiting");
      const first = await host.present(scope(), id),
        runId = first.results[0].run_id;
      await completeRun(runId);
      await until(async () => (await state(id))?.status === "confirmation");
      const ready = await host.present(scope(), id),
        oldCard = ready.confirmations.find((c: any) => c.status === "pending");
      expect(
        (await api("POST", route(id) + "/control", { action: "stop" }))
          .statusCode,
      ).toBe(200);
      outputs = [
        call("read_task_progress", {}),
        { role: "assistant", content: "已处理，尚未保存，保持暂停。" },
      ];
      const query = await submit(id, "现在做到哪了？有没有保存？");
      expect(query.statusCode).toBe(202);
      await until(
        async () =>
          (
            await db.query(
              "SELECT status FROM assistant_runtime_turn WHERE id=$1",
              [query.json().turnId],
            )
          ).rows[0]?.status === "succeeded",
      );
      expect((await state(id))?.status).toBe("paused");
      const saved = await host.store.get(scope(), id);
      outputs = [
        { role: "assistant", content: "我会修改名称，保持暂停。" },
        call("update_requirements", {
          expectedRevision: saved.requirements_revision,
          changes: {
            deliveries: [
              {
                deliveryId: saved.requirements.deliveries[0].id,
                patch: {
                  name: "客服整理版",
                  saveTarget: { kind: "newDraft", name: "客服整理版" },
                },
              },
            ],
          },
        }),
        (body: any) => {
          forcedAfterAmendment = JSON.stringify(
            body.tool_choice ?? null,
          ).includes("update_requirements");
          return { role: "assistant", content: "名称已修改，保持暂停。" };
        },
      ];
      expect(
        (await submit(id, "只把保存名称改成“客服整理版”，先不要继续。"))
          .statusCode,
      ).toBe(202);
      await until(
        async () =>
          (await host.store.get(scope(), id)).requirements_revision ===
            saved.requirements_revision + 1 &&
          (await state(id))?.status === "paused",
      );
      expect(
        (
          (await host.store.get(scope(), id)).requirements.deliveries[0]
            .saveTarget as any
        ).name,
      ).toBe("客服整理版");
      expect(forcedAfterAmendment).toBe(false);
      expect(
        (
          await db.query(
            "SELECT count(*) FROM assistant_runtime_event WHERE session_id=$1 AND kind='save_target_recovery'",
            [id],
          )
        ).rows[0].count,
      ).toBe("1");
      outputs = [call("continue_task", {}), call("prepare_adoption", {})];
      expect((await submit(id, "继续。")).statusCode).toBe(202);
      await until(async () => (await state(id))?.status === "confirmation");
      const next = await host.present(scope(), id),
        card = next.confirmations.find((c: any) => c.status === "pending");
      expect(card.payload.input.target.name).toBe("客服整理版");
      expect(next.results[0].run_id).toBe(runId);
      expect(
        (
          await api("POST", route(id) + "/confirmations/" + oldCard.id, {
            accept: true,
          })
        ).statusCode,
      ).toBe(409);
      outputs = [{ role: "assistant", content: "已保存旧名称。" }];
      const responses = await Promise.all([
        api("POST", route(id) + "/confirmations/" + card.id, { accept: true }),
        api("POST", route(id) + "/confirmations/" + card.id, { accept: true }),
      ]);
      expect(responses.every((r) => r.statusCode === 200)).toBe(true);
      await until(async () => (await state(id))?.status === "completed");
      const confirmed = await host.present(scope(), id);
      expect(confirmed.messages.at(-1).content).toContain("客服整理版");
      expect(
        confirmed.receipts.find((r: any) => r.acceptanceId).draftName,
      ).toBe("客服整理版");
      outputs = [{ role: "assistant", content: "草稿名是旧名称，共3条。" }];
      const progress = await submit(
        id,
        "刚才保存的草稿叫什么名字，有多少条记录？",
      );
      expect(progress.statusCode).toBe(202);
      await until(
        async () =>
          (
            await db.query(
              "SELECT status FROM assistant_runtime_turn WHERE id=$1",
              [progress.json().turnId],
            )
          ).rows[0]?.status === "succeeded",
      );
      const queried = await host.present(scope(), id);
      expect(queried.messages.at(-1).content).toContain("客服整理版");
      expect(queried.messages.at(-1).content).not.toContain("旧名称");
      expect(queried.confirmations).toHaveLength(
        confirmed.confirmations.length,
      );
      expect(
        queried.confirmations.filter((c: any) => c.status === "pending"),
      ).toHaveLength(0);
      expect(
        (
          await db.query(
            "SELECT resume_requested FROM assistant_runtime_execution WHERE session_id=$1",
            [id],
          )
        ).rows[0].resume_requested,
      ).toBe(false);
      const after = await effects();
      expect(after.runs - before.runs).toBe(1);
      expect(after.drafts - before.drafts).toBe(1);
      expect(
        (await host.present(scope(), id)).receipts.filter(
          (r: any) => r.acceptanceId,
        ),
      ).toHaveLength(1);
      const latest = await host.store.get(scope(), id);
      outputs = [
        call("update_requirements", {
          expectedRevision: latest.requirements_revision,
          changes: {
            deliveries: [
              {
                deliveryId: latest.requirements.deliveries[0].id,
                patch: { name: "仅改变展示名称" },
              },
            ],
          },
        }),
        { role: "assistant", content: "已更新展示名" },
      ];
      const label = await submit(id, "只修改任务的展示名称，保留保存目标");
      await until(
        async () =>
          (await host.store.get(scope(), id)).requirements_revision ===
            latest.requirements_revision + 1 &&
          (await host.store.get(scope(), id)).status === "idle",
      );
      expect(label.statusCode).toBe(202);
      const renameSaved = await submit(
        id,
        "只把保存名称改成“不能重复另存”，先不要继续。",
      );
      expect(renameSaved.statusCode).toBe(409);
      expect(renameSaved.json().error.code).toBe("result_already_saved");
    } finally {
      await restarted.close();
    }
  });

  it.each([
    "继续处理“另一份.csv”",
    "继续处理前3条",
    "继续执行之前先让我确认。",
    "继续，只查询进度，暂不执行处理",
    "继续，先只改保存名称，暂不处理。",
  ])("SAVE RECOVERY rejects misleading model resume for %s", async (text) => {
    const { id, plan } = await reviewCreate();
    const start = await run(id, "清洗后保存", [
      plan,
      call("submit_processing", {}),
    ]);
    await completeRun(start.results[0].run_id);
    await host.execution.wake();
    outputs = [call("prepare_adoption", {})];
    await host.runPending(scope(), id, start.execution.turn_id);
    await host.stop(scope(), id);
    const before = await effects();
    const result = await run(id, text, [
      call("continue_task", {}),
      { role: "assistant", content: "任务仍暂停。" },
    ]);
    expect(result.execution.status).toBe("paused");
    expect(
      result.confirmations.filter((c: any) => c.status === "pending"),
    ).toHaveLength(0);
    expect(result.results).toHaveLength(1);
    expect(await effects()).toEqual(before);
  });

  it("R04 ordinary progress queries preserve the suspended turn and ordinary continue queues the same work", async () => {
    const id = await fresh(),
      p = await processing(id, "rewrite");
    await host.stop(scope(), id);
    const before = await host.present(scope(), id);
    expect(before.execution.turn_id).toBe(p.proof.turnId);
    const query = await run(id, "现在进度怎么样？", [
      call("read_task_progress", {}),
      { role: "assistant", content: "原任务仍暂停，尚未保存。" },
    ]);
    expect(query.execution.status).toBe("paused");
    expect(query.execution.turn_id).toBe(p.proof.turnId);
    expect(query.results.map((r: any) => r.run_id)).toEqual([p.runId]);
    const resumed = await run(id, "继续吧", [
      call("continue_task", {}),
      { role: "assistant", content: "已安排原任务继续。" },
    ]);
    expect(resumed.execution.status).toBe("pending");
    expect(resumed.execution.turn_id).toBe(p.proof.turnId);
    expect(resumed.execution.requests - before.execution.requests).toBe(3);
    expect(resumed.results).toHaveLength(1);
    await host.stop(scope(), id);
  });
  it("R04 rejects stale UI source revisions before accepting a message", async () => {
    const id = await fresh();
    const state = await host.store.get(scope(), id);
    const response = await api("POST", route(id) + "/messages", {
      submissionId: "stale_" + randomUUID(),
      expectedRevision: state.revision,
      text: "只处理界面勾选的记录",
      context: { kind: "assets", assetIds: [assetId] },
      contextRevision: "0".repeat(64),
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.code).toBe("source_revision_conflict");
    expect((await host.present(scope(), id)).messages).toEqual([]);
  });
  it("R04 never projects internal summary requests as public assistant text", async () => {
    const exposed = await db.query(
      "SELECT 1 FROM assistant_runtime_event e JOIN assistant_runtime_request r ON r.id=e.detail->>'requestId' WHERE e.kind='message_delta' AND r.purpose='summary'",
    );
    expect(exposed.rowCount).toBe(0);
  });

  it("R04 browser faults: lost acceptance, refresh/reconnect, stale tab, late confirmation and narrow panels", async () => {
    const requestsBefore = requests.length;
    const address = await webAddress();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: { origin },
    });
    const cookie = identities.get("admin")!.cookie!.split("=");
    await context.addCookies([
      { name: cookie[0]!, value: cookie.slice(1).join("="), url: address },
    ]);
    const a = await fresh(),
      b = await fresh();
    await api("PATCH", route(a), { title: "受理丢失 A", expectedRevision: 1 });
    await api("PATCH", route(b), { title: "竞态会话 B", expectedRevision: 1 });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error")
        console.log("r04_browser_console", msg.text());
    });
    page.on("requestfailed", (req) =>
      console.log(
        "r04_browser_network",
        new URL(req.url()).pathname,
        req.failure()?.errorText,
      ),
    );
    let release!: () => void, seen!: () => void;
    const hold = new Promise<void>((r) => (release = r)),
      accepted = new Promise<void>((r) => (seen = r));
    let envelope: any;
    try {
      await page.goto(address + "/projects/" + projectId + "/assistant/" + a);
      await page.getByLabel("描述你的需求", { exact: true }).waitFor();
      await page.route(
        "**/assistant-runtime/sessions/" + a + "/messages",
        async (route) => {
          envelope = route.request().postDataJSON();
          const acceptedResponse = await route.fetch();
          expect(acceptedResponse.status()).toBe(202);
          seen();
          await hold;
          await route.abort("failed");
        },
      );
      await page.getByLabel("描述你的需求", { exact: true }).fill("查一下项目");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await accepted;
      await page
        .getByLabel("描述你的需求", { exact: true })
        .fill("下一条尚未发送的输入");
      await page.screenshot({
        path: ".scratch/assistant-rebuild/r04-verification/browser-before-stop.png",
      });
      console.log(
        "r04_browser_before_stop",
        await page.locator("body").innerText(),
      );
      await page.getByRole("button", { name: "停止", exact: true }).click();
      release();
      await expect
        .poll(
          async () =>
            ((await host.present(scope(), a)).execution as any).status,
        )
        .toBe("paused");
      await page.reload();
      await browserExpect(
        page.getByLabel("描述你的需求", { exact: true }),
      ).toHaveValue("下一条尚未发送的输入");
      expect(
        (await api("POST", route(a) + "/messages", envelope)).json().replayed,
      ).toBe(true);
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM assistant_runtime_turn WHERE session_id=$1",
            [a],
          )
        ).rows[0].n,
      ).toBe(1);
      await page.route("**/assistant-runtime/sessions/" + b + "/events", (r) =>
        r.abort(),
      );
      await page
        .getByRole("button", { name: "竞态会话 B", exact: true })
        .click();
      await browserExpect(
        page.getByRole("heading", { name: "竞态会话 B", exact: true }),
      ).toBeVisible();
      await api("PATCH", route(b), {
        title: "竞态会话 B 已改名",
        expectedRevision: 2,
      });
      await page
        .getByLabel("描述你的需求", { exact: true })
        .fill("保留冲突输入");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await browserExpect(page.getByRole("alert")).toContainText("其他页面");
      await browserExpect(
        page.getByLabel("描述你的需求", { exact: true }),
      ).toHaveValue("保留冲突输入");
      await page.unroute("**/assistant-runtime/sessions/" + b + "/events");
      await page.reload();
      await browserExpect(
        page.getByLabel("描述你的需求", { exact: true }),
      ).toHaveValue("保留冲突输入");
      const saved = await adoptionCard();
      await api("PATCH", route(saved.id), {
        title: "延迟确认 A",
        expectedRevision: (await host.store.get(scope(), saved.id)).revision,
      });
      await page.reload();
      await page
        .getByRole("button", { name: "延迟确认 A", exact: true })
        .click();
      await page
        .getByRole("button", { name: "确认保存", exact: true })
        .waitFor();
      let commitSeen!: () => void, releaseCommit!: () => void;
      const committed = new Promise<void>((r) => (commitSeen = r)),
        commitGate = new Promise<void>((r) => (releaseCommit = r));
      await page.route("**/confirmations/" + saved.card.id, async (route) => {
        const response = await route.fetch();
        commitSeen();
        await commitGate;
        await route.fulfill({ response });
      });
      await page.getByRole("button", { name: "确认保存", exact: true }).click();
      await committed;
      await page
        .getByRole("button", { name: "竞态会话 B 已改名", exact: true })
        .click();
      await browserExpect(
        page.getByRole("heading", { name: "竞态会话 B 已改名", exact: true }),
      ).toBeVisible();
      releaseCommit();
      await browserExpect(
        page.getByLabel("描述你的需求", { exact: true }),
      ).toHaveValue("保留冲突输入");
      await browserExpect(
        page.getByRole("heading", { name: "竞态会话 B 已改名", exact: true }),
      ).toBeVisible();
      const receipt = await host.execution.receipt(
        scope(),
        saved.id,
        saved.op.id,
      );
      await page.goto(
        address +
          "/projects/" +
          projectId +
          "/test-sets/drafts/" +
          receipt.draftId,
      );
      await browserExpect(page.locator("#draft-name")).toBeEnabled();
      await page.locator("#draft-name").fill("交接前已确认保存");
      await page
        .getByRole("button", { name: "打开项目助手", exact: true })
        .click();
      await browserExpect(
        page.getByRole("heading", { name: "项目助手", exact: true }),
      ).toBeVisible();
      expect(
        (
          await db.query("SELECT name FROM collaborative_draft WHERE id=$1", [
            receipt.draftId,
          ])
        ).rows[0].name,
      ).toBe("交接前已确认保存");
      await page.setViewportSize({ width: 420, height: 850 });
      await page
        .getByRole("button", { name: "切换工作区", exact: true })
        .click();
      await browserExpect(page.getByRole("dialog")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: "切换会话列表", exact: true })
        .click();
      await browserExpect(page.getByRole("dialog")).toHaveCount(1);
      await page.keyboard.press("Escape");
      expect(requests.length - requestsBefore).toBe(0);
    } finally {
      release?.();
      await context.close();
      await browser.close();
    }
  }, 90000);

  async function webAddress() {
    const address = app.server.address();
    return address && typeof address === "object"
      ? "http://127.0.0.1:" + address.port
      : await app.listen({
          host: "127.0.0.1",
          port: Number(new URL(origin).port),
        });
  }
  it("R04 SSE remains open for new snapshots and closes when its login session is revoked", async () => {
    const address = await webAddress(),
      id = await fresh();
    const login = await api("POST", "/api/session", {
      email: "admin@r03.example.test",
      password: "Rebuild02Pass123",
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const ctl = new AbortController();
    const response = await fetch(address + route(id) + "/events", {
      headers: { cookie },
      signal: ctl.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader(),
      decoder = new TextDecoder();
    let text = "";
    const untilText = async (predicate: (value: string) => boolean) => {
      const timeout = setTimeout(() => ctl.abort(), 7000);
      try {
        while (!predicate(text)) {
          const chunk = await reader.read();
          if (chunk.done) throw Error("stream_ended_before_update");
          text += decoder.decode(chunk.value, { stream: true });
        }
      } finally {
        clearTimeout(timeout);
      }
    };
    try {
      await untilText((v) => v.includes("event: snapshot"));
      await api("PATCH", route(id), {
        title: "SSE持续更新",
        expectedRevision: 1,
      });
      await untilText((v) => v.includes("SSE持续更新"));
      const loggedOut = await app.inject({
        method: "DELETE",
        url: "/api/session",
        headers: { origin, cookie, "x-csrf-token": login.json().csrfToken },
      });
      expect(loggedOut.statusCode).toBe(204);
      await untilText((v) => v.includes("event: access_lost"));
    } finally {
      ctl.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  it("R04 read-only progress in flight never admits a queued or retrying suspended Worker request", async () => {
    const id = await fresh(),
      p = await processing(id, "rewrite");
    await host.stop(scope(), id);
    let entered!: () => void, release!: () => void;
    const arrived = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (release = r));
    const query = run(id, "现在进度怎么样？", [
      call("read_task_progress", {}),
      async () => {
        entered();
        await gate;
        return { role: "assistant", content: "原任务仍保持暂停。" };
      },
    ]);
    try {
      await arrived;
      const task = (
        await db.query(
          "SELECT * FROM assistant_runtime_execution WHERE session_id=$1",
          [id],
        )
      ).rows[0];
      expect(task.status).toBe("running");
      expect(task.suspended.turnId).toBe(p.proof.turnId);
      const count = requests.length;
      await expect(
        host.execution.reserveWorker(
          p.runId,
          "worker_suspended_" + randomUUID(),
          "hash",
        ),
      ).rejects.toMatchObject({ code: "runtime_interrupted" });
      expect((await jobState(id)).worker_requests).toBe(task.worker_requests);
      expect(requests.length).toBe(count);
    } finally {
      release();
    }
    const result = await query;
    expect(result.execution.status).toBe("paused");
    expect(result.execution.turn_id).toBe(p.proof.turnId);
    await host.execution.resume(scope(), id);
    await host.stop(scope(), id);
  });
  it("amends scoped rules before execution and freezes only the current context through unique save", async () => {
    const id = await fresh(),
      fixed = await host.store.freezeSource(scope(), {
        kind: "assets",
        assetIds: [assetId],
      }),
      before = await effects();
    let state = await run(id, "先给前三条方案，不执行", [
      call("update_requirements", {
        expectedRevision: 0,
        changes: {
          objective: "不得出现姓名和电话号码；原目标是前三条",
          mode: "plan",
          deliveries: [
            {
              patch: {
                name: "整理",
                operation: "clean",
                count: 3,
                source: fixed.source,
                allowedFields: ["question"],
                instructions: "清洗前3条：去除空白。",
                saveTarget: { kind: "newDraft", name: "整理版" },
              },
            },
          ],
        },
      }),
    ]);
    const deliveryId = state.session.requirements.deliveries[0].id,
      source = {
        ...fixed.source,
        recordIds: fixed.source.recordIds.slice(0, 2),
      };
    state = await run(id, "改成前两条，存为两条版，现在执行", [
      call("update_requirements", {
        expectedRevision: 1,
        changes: {
          mode: "execute",
          deliveries: [
            {
              patch: {
                count: 2,
                source,
                saveTarget: { kind: "newDraft", name: "两条版" },
              },
            },
          ],
        },
      }),
      call("update_requirements", {
        expectedRevision: 1,
        changes: {
          deliveries: [
            {
              deliveryId,
              patch: { instructions: "去除问题首尾空白，保留标签和Metadata。" },
            },
          ],
        },
      }),
      call("submit_processing", {}),
      call("wait_processing", {}),
    ]);
    expect(state.session.requirements.deliveries).toHaveLength(1);
    expect(state.session.requirements.deliveries[0].id).toBe(deliveryId);
    const runId = state.results[0].run_id,
      row = (
        await db.query(
          "SELECT input_ref,options FROM processing_run WHERE id=$1",
          [runId],
        )
      ).rows[0],
      frozen = JSON.parse(
        (await artifacts.readBytes(row.input_ref, 1000000)).toString("utf8"),
      );
    expect(frozen.records).toHaveLength(2);
    expect(row.options.instructions).not.toContain("前3条");
    expect(frozen.background.requirements.join(" ")).toContain(
      "不得出现姓名和电话号码",
    );
    expect(frozen.background.requirements.join(" ")).toContain("处理 2 条");
    expect(state.session.requirements.deliveries[0].executionSummary).toContain(
      "处理 2 条",
    );
    await completeRun(runId);
    await host.execution.wake();
    outputs = [call("prepare_adoption", {}), call("wait_confirmation", {})];
    const turn = (await host.execution.projection(scope(), id)).execution
      .turn_id;
    state = await host.runPending(scope(), id, turn);
    const card = state.confirmations.find((c: any) => c.status === "pending");
    const accepted = await api(
      "POST",
      route(id) + "/confirmations/" + card.id,
      { accept: true },
    );
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().receipt.adopted).toBe(2);
    expect(
      (
        await api("POST", route(id) + "/confirmations/" + card.id, {
          accept: true,
        })
      ).json().replayed,
    ).toBe(true);
    const after = await effects();
    expect(after.runs - before.runs).toBe(1);
    expect(after.drafts - before.drafts).toBe(1);
  });

  it("cannot bypass pending amendment rules with submit_processing against the old executable plan", async () => {
    const id = await fresh(),
      fixed = await host.store.freezeSource(scope(), {
        kind: "assets",
        assetIds: [assetId],
      }),
      before = await effects();
    const state = await run(id, "仅记录可执行要求", [
      call("update_requirements", {
        expectedRevision: 0,
        changes: {
          mode: "execute",
          deliveries: [
            {
              patch: {
                name: "整理",
                operation: "clean",
                count: 3,
                source: fixed.source,
                allowedFields: ["question"],
                instructions: "清洗前3条，保持标签。",
                saveTarget: { kind: "newDraft", name: "整理版" },
              },
            },
          ],
        },
      }),
    ]);
    const deliveryId = state.session.requirements.deliveries[0].id;
    await expect(
      run(id, "只改成前两条", [
        call("update_requirements", {
          expectedRevision: 1,
          changes: {
            deliveries: [
              {
                deliveryId,
                patch: {
                  count: 2,
                  source: {
                    ...fixed.source,
                    recordIds: fixed.source.recordIds.slice(0, 2),
                  },
                },
              },
            ],
          },
        }),
        call("submit_processing", {}),
      ]),
    ).rejects.toMatchObject({ code: "correction_intent_changed" });
    expect((await host.store.get(scope(), id)).requirements_revision).toBe(1);
    expect(await effects()).toEqual(before);
  });

  it("preserves pending rule refresh and budget through pause and original-checkpoint continuation", async () => {
    const id = await fresh();
    let state = await run(id, "规划", [
      call("update_requirements", {
        expectedRevision: 0,
        changes: {
          deliveries: [
            { patch: { name: "整理", count: 5, instructions: "清洗前5条" } },
          ],
        },
      }),
    ]);
    const deliveryId = state.session.requirements.deliveries[0].id,
      a = await submit(id, "改成3条");
    let entered = false,
      release!: () => void;
    outputs = [
      call("update_requirements", {
        expectedRevision: 1,
        changes: { deliveries: [{ deliveryId, patch: { count: 3 } }] },
      }),
      async () => {
        entered = true;
        await new Promise<void>((r) => (release = r));
        return call("update_requirements", {
          expectedRevision: 1,
          changes: {
            deliveries: [
              {
                deliveryId,
                patch: { instructions: "整理问题空白，保留原意。" },
              },
            ],
          },
        });
      },
    ];
    const running = host.runPending(scope(), id, a.json().turnId);
    await until(async () => entered);
    await host.stop(scope(), id);
    release();
    await running;
    const paused = (
      await db.query(
        "SELECT feedback,requests FROM assistant_runtime_execution WHERE session_id=$1",
        [id],
      )
    ).rows[0];
    expect(paused.feedback).toMatchObject({
      kind: "requirements",
      attempts: 1,
    });
    expect((await host.store.get(scope(), id)).requirements_revision).toBe(1);
    await host.continue(scope(), id);
    outputs = [
      call("update_requirements", {
        expectedRevision: 1,
        changes: {
          deliveries: [
            { deliveryId, patch: { instructions: "整理问题空白，保留原意。" } },
          ],
        },
      }),
    ];
    state = await host.runPending(scope(), id, a.json().turnId);
    expect(state.session.requirements.deliveries[0].count).toBe(3);
    expect(state.execution.requests).toBeGreaterThan(paused.requests);
    expect(state.execution.turn_id).toBe(a.json().turnId);
  });
  it("retains a failed quantity amendment after classification validation and blocks old-plan continuation", async () => {
    const id = await fresh(),
      fixed = await host.store.freezeSource(scope(), {
        kind: "assets",
        assetIds: [assetId],
      }),
      before = await effects();
    const state = await run(id, "先保存计划", [
      call("update_requirements", {
        expectedRevision: 0,
        changes: {
          mode: "execute",
          deliveries: [
            {
              patch: {
                name: "整理",
                operation: "clean",
                count: 3,
                source: fixed.source,
                allowedFields: ["question"],
                instructions: "整理问题空白。",
                classifications: [
                  {
                    field: "expectedOutput",
                    quotas: [
                      { value: "答案1", count: 1 },
                      { value: "答案2", count: 1 },
                      { value: "答案3", count: 1 },
                    ],
                  },
                ],
                saveTarget: { kind: "newDraft", name: "整理版" },
              },
            },
          ],
        },
      }),
    ]);
    const deliveryId = state.session.requirements.deliveries[0].id;
    await expect(
      run(id, "改成两条", [
        call("update_requirements", {
          expectedRevision: 1,
          changes: {
            deliveries: [
              {
                deliveryId,
                patch: {
                  count: 2,
                  source: {
                    ...fixed.source,
                    recordIds: fixed.source.recordIds.slice(0, 2),
                  },
                  instructions: "仅整理问题首尾空白。",
                },
              },
            ],
          },
        }),
      ]),
    ).rejects.toMatchObject({ status: 422 });
    const task = (
      await db.query(
        "SELECT feedback,turn_id FROM assistant_runtime_execution WHERE session_id=$1",
        [id],
      )
    ).rows[0];
    expect(task.feedback).toMatchObject({ kind: "requirements" });
    expect(task.feedback.workingArgs.changes.deliveries[0].patch.count).toBe(2);
    expect((await host.store.get(scope(), id)).requirements_revision).toBe(1);
    await host.continue(scope(), id);
    outputs = [call("submit_processing", {})];
    await expect(
      host.runPending(scope(), id, task.turn_id),
    ).rejects.toMatchObject({ code: "assistant_plan_count_conflict" });
    expect(await effects()).toEqual(before);
  });
  it("ordinary new-message continue cannot drop a failed requirement amendment", async () => {
    const id = await fresh(),
      fixed = await host.store.freezeSource(scope(), {
        kind: "assets",
        assetIds: [assetId],
      }),
      before = await effects();
    const state = await run(id, "规划", [
      call("update_requirements", {
        expectedRevision: 0,
        changes: {
          mode: "execute",
          deliveries: [
            {
              patch: {
                name: "整理",
                operation: "clean",
                count: 3,
                source: fixed.source,
                allowedFields: ["question"],
                instructions: "整理空白",
                classifications: [
                  {
                    field: "expectedOutput",
                    quotas: [
                      { value: "答案1", count: 1 },
                      { value: "答案2", count: 1 },
                      { value: "答案3", count: 1 },
                    ],
                  },
                ],
                saveTarget: { kind: "newDraft", name: "整理版" },
              },
            },
          ],
        },
      }),
    ]);
    const deliveryId = state.session.requirements.deliveries[0].id;
    await expect(
      run(id, "改成2条", [
        call("update_requirements", {
          expectedRevision: 1,
          changes: {
            deliveries: [
              {
                deliveryId,
                patch: {
                  count: 2,
                  source: {
                    ...fixed.source,
                    recordIds: fixed.source.recordIds.slice(0, 2),
                  },
                  instructions: "仅整理问题空白，保留答案。",
                },
              },
            ],
          },
        }),
      ]),
    ).rejects.toMatchObject({ code: "assistant_plan_count_conflict" });
    await expect(
      run(id, "继续", [call("submit_processing", {})]),
    ).rejects.toMatchObject({ code: "requirements_amendment_pending" });
    const task = (
      await db.query(
        "SELECT suspended,feedback,turn_id FROM assistant_runtime_execution WHERE session_id=$1",
        [id],
      )
    ).rows[0];
    expect(task.feedback ?? task.suspended?.feedback).toMatchObject({
      kind: "requirements",
    });
    expect(task.feedback?.workingArgs.changes.deliveries[0].patch.count).toBe(
      2,
    );
    expect(await effects()).toEqual(before);
  });
  it("R08 manages legacy v1 history without enabling old execution tools", async () => {
    const id = await fresh(),
      body = {
        fileName: "需求.md",
        contentBase64: Buffer.from("保留标签").toString("base64"),
      };
    const attached = (
      await api("POST", route(id) + "/attachments", body)
    ).json();
    await db.query(
      "UPDATE assistant_runtime_session SET runtime_version='deepagents-v1' WHERE id=$1",
      [id],
    );
    const before = await host.store.get(scope(), id);
    expect(
      (await api("GET", route(id) + "/attachments/" + attached.id)).statusCode,
    ).toBe(200);
    expect(
      (await api("POST", route(id) + "/attachments", body)).json().error.code,
    ).toBe("runtime_contract_changed");
    expect(
      (
        await api("PATCH", route(id), {
          title: "管理旧会话",
          expectedRevision: before.revision,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await api("DELETE", route(id) + "/attachments/" + attached.id))
        .statusCode,
    ).toBe(200);
    expect(
      (await api("GET", route(id) + "/attachments/" + attached.id)).statusCode,
    ).toBe(404);
    expect((await host.present(scope(), id)).contentInvalidated).toBe(true);
  });

  it("automatic session titles follow saved requirements while preserving manual names and original narrative", async () => {
    const id = await fresh(),
      beforeEffects = await effects(),
      objective = "前5条仅做方案，不执行。";
    const title = async (expected: string) => {
      expect((await api("GET", route(id))).json().session.title).toBe(expected);
      expect(
        (await api("GET", route() + "?search=" + encodeURIComponent(expected)))
          .json()
          .sessions.find((s: any) => s.id === id)?.title,
      ).toBe(expected);
    };
    await title("新会话");
    let state = await run(id, "标题规划", [
      call("create_requirements", {
        expectedRevision: 0,
        changes: {
          objective,
          mode: "plan",
          deliveries: [
            { patch: { name: "旧5条名称", operation: "clean", count: 5 } },
          ],
        },
      }),
    ]);
    await title("清洗 · 5 条 · 仅方案");
    const deliveryId = state.session.requirements.deliveries[0].id;
    state = await run(id, "调整当前范围", [
      call("update_requirements", {
        expectedRevision: 1,
        changes: {
          mode: "execute",
          deliveries: [
            {
              deliveryId,
              patch: {
                count: 3,
                source: { kind: "assets", assetIds: [assetId] },
                allowedFields: ["question"],
                saveTarget: { kind: "newDraft", name: "三条整理版" },
              },
            },
          ],
        },
      }),
    ]);
    await title("清洗 · 3 条");
    expect(state.session.requirements.objective).toBe(objective);
    expect((await host.store.get(scope(), id)).title).toBe("");
    const renamed = await api("PATCH", route(id), {
      title: "我的固定标题",
      expectedRevision: state.session.revision,
    });
    expect(renamed.statusCode).toBe(200);
    await run(id, "仅修改操作", [
      call("update_requirements", {
        expectedRevision: 2,
        changes: {
          deliveries: [
            {
              deliveryId,
              patch: {
                operation: "rewrite",
                instructions: "保留原意改写为自然用户问法。",
              },
            },
          ],
        },
      }),
    ]);
    await title("我的固定标题");
    expect((await host.store.get(scope(), id)).title).toBe("我的固定标题");
    expect(await effects()).toEqual(beforeEffects);
  });
  it("automatic title projection handles incomplete, multiple and cancelled plans without changing stored titles", async () => {
    const id = await fresh();
    const cases = [
      {
        deliveries: [],
        objective: "只查询资料",
        mode: "plan",
        title: "只查询资料",
      },
      {
        deliveries: [{ id: "one", status: "active", count: 2 }],
        objective: "旧叙述",
        mode: "plan",
        title: "待确认任务 · 2 条 · 仅方案",
      },
      {
        deliveries: [
          { id: "one", status: "active" },
          { id: "two", status: "active" },
        ],
        objective: "旧叙述",
        mode: "plan",
        title: "2 项交付 · 仅方案",
      },
      {
        deliveries: [{ id: "one", status: "cancelled" }],
        objective: "旧叙述",
        mode: "plan",
        title: "已取消的任务",
      },
    ];
    for (const c of cases) {
      const { title, ...requirements } = c;
      await db.query(
        "UPDATE assistant_runtime_session SET requirements=$2 WHERE id=$1",
        [id, JSON.stringify(requirements)],
      );
      expect((await api("GET", route(id))).json().session.title).toBe(title);
      expect(
        (await api("GET", route()))
          .json()
          .sessions.find((s: any) => s.id === id)?.title,
      ).toBe(title);
    }
    expect((await host.store.get(scope(), id)).title).toBe("");
  });
  it("automatic titles stay synchronized in the real page and manual rename survives later snapshots and refresh", async () => {
    const start = requests.length,
      id = await fresh(),
      address = await webAddress(),
      browser = await chromium.launch({ headless: true }),
      context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        extraHTTPHeaders: { origin },
      });
    const cookie = identities.get("admin")!.cookie!.split("=");
    await context.addCookies([
      { name: cookie[0]!, value: cookie.slice(1).join("="), url: address },
    ]);
    const page = await context.newPage();
    const seed = async (count: number, mode: string) =>
      db.query(
        "UPDATE assistant_runtime_session SET requirements=$2,requirements_revision=requirements_revision+1,revision=revision+1 WHERE id=$1",
        [
          id,
          JSON.stringify({
            objective: "前5条仅方案，不执行",
            mode,
            deliveries: [
              {
                id: "title-fixture",
                name: "旧5条名称",
                status: "active",
                operation: "clean",
                count,
              },
            ],
          }),
        ],
      );
    try {
      await seed(5, "plan");
      await page.goto(address + "/projects/" + projectId + "/assistant/" + id);
      await browserExpect(
        page.getByRole("heading", {
          name: "清洗 · 5 条 · 仅方案",
          exact: true,
        }),
      ).toBeVisible();
      await seed(3, "execute");
      await browserExpect(
        page.getByRole("heading", { name: "清洗 · 3 条", exact: true }),
      ).toBeVisible();
      await browserExpect(
        page.locator('button[aria-current="page"]'),
      ).toHaveText("清洗 · 3 条");
      await page.getByRole("button", { name: "会话选项", exact: true }).click();
      await page
        .getByRole("menuitem", { name: "重命名会话", exact: true })
        .click();
      await page
        .getByLabel("会话名称", { exact: true })
        .fill("手动标题保持不变");
      await page.getByRole("button", { name: "保存名称", exact: true }).click();
      await browserExpect(
        page.getByRole("heading", { name: "手动标题保持不变", exact: true }),
      ).toBeVisible();
      await seed(2, "plan");
      await browserExpect(
        page.locator('button[aria-current="page"]'),
      ).toHaveText("手动标题保持不变");
      await page.reload();
      await browserExpect(
        page.getByRole("heading", { name: "手动标题保持不变", exact: true }),
      ).toBeVisible();
      expect(requests.length - start).toBe(0);
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30000);
  it("BATCH1 REVIEW repeated progress query must pause on stable business facts", async () => {
    const id = await fresh();
    const state = await run(id, "查询目前进度", [
      ...Array.from({ length: 5 }, () => call("read_task_progress", {})),
      { role: "assistant", content: "进度说明完毕" },
    ]);
    console.log(
      "REVIEW_PROGRESS",
      JSON.stringify({
        status: state.execution.status,
        reason: state.execution.reason,
        noProgress: state.execution.no_progress,
        progressVersion: state.execution.progress_version,
        requests: state.execution.requests,
      }),
    );
    expect(state.execution.status).toBe("paused");
    expect(state.execution.reason).toBe("no_progress");
  });
  const reviewCreate = async () => {
    const id = await fresh();
    const fixed = await host.store.freezeSource(scope(), {
      kind: "assets",
      assetIds: [assetId],
    });
    return {
      id,
      plan: call("create_requirements", {
        expectedRevision: 0,
        changes: {
          mode: "execute",
          deliveries: [
            {
              patch: {
                operation: "clean",
                source: fixed.source,
                count: 3,
                allowedFields: ["question"],
                instructions: "",
                saveTarget: { kind: "newDraft", name: "Review synthetic only" },
              },
            },
          ],
        },
      }),
    };
  };
  it("BATCH1 REVIEW submitted job remains resumable if model omits wait tool", async () => {
    const { id, plan } = await reviewCreate();
    const state = await run(id, "清洗这3条，确认后保存", [
      plan,
      call("submit_processing", {}),
      { role: "assistant", content: "已提交处理，请等待。" },
    ]);
    await host.execution.wake();
    const resume = await api("POST", route(id) + "/control", {
      action: "continue",
    });
    console.log(
      "REVIEW_SUBMIT",
      JSON.stringify({
        execution: state.execution.status,
        results: state.results,
        resumeStatus: resume.statusCode,
        resumeError: resume.json().error?.code,
      }),
    );
    expect(state.execution.status).toBe("waiting");
  });
  it("BATCH1 REVIEW prepared save card works if model omits wait confirmation tool", async () => {
    const { id, plan } = await reviewCreate();
    const initial = await run(id, "清洗这3条，确认后保存", [
      plan,
      call("submit_processing", {}),
      call("wait_processing", {}),
    ]);
    await completeRun(initial.results[0].run_id);
    await host.execution.wake();
    outputs = [
      call("prepare_adoption", {}),
      { role: "assistant", content: "请点击确认保存。" },
    ];
    const state = await host.runPending(scope(), id, initial.execution.turn_id);
    const card = state.confirmations.find(
      (c: any) => c.status === "pending" && c.action === "adopt",
    );
    const approval = await api(
      "POST",
      route(id) + "/confirmations/" + card.id,
      { accept: true },
    );
    console.log(
      "REVIEW_CONFIRM",
      JSON.stringify({
        execution: state.execution.status,
        cardStatus: card.status,
        approvalStatus: approval.statusCode,
        error: approval.json().error?.code,
      }),
    );
    expect(approval.statusCode, approval.body).toBe(200);
  });

  it("BATCH1 EXTRA prior results must not make a revised plan look generated", async () => {
    const id = await fresh();
    const p = await processing(id);
    await completeRun(p.runId);
    await host.store.finish(p.proof, "上一轮已生成");
    await run(id, "重新规划另一份，只给方案，不执行", [
      call("create_requirements", {
        expectedRevision: 0,
        changes: {
          mode: "plan",
          deliveries: [
            { patch: { name: "新方案", operation: "generate", count: 2 } },
          ],
        },
      }),
      { role: "assistant", content: "新的方案已记录，未执行。" },
    ]);
    const state = await host.present(scope(), id);
    console.log(
      "REVIEW_STALE_STATUS",
      JSON.stringify({
        mode: state.session.requirements.mode,
        revision: state.session.requirements_revision,
        businessStatus: state.businessStatus,
        results: state.results,
      }),
    );
    expect(state.businessStatus).toBe("not_saved");
  });
  it("BATCH1 EXTRA worker counts actual batch input rather than entire run per request", async () => {
    const originalAsset = assetId;
    const collectionId = (
      await api("GET", "/api/projects/" + projectId + "/collections")
    ).json().collections[0].id;
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/pending-uploads",
      headers: {
        origin,
        ...identities.get("admin"),
        "content-type": "application/octet-stream",
        "x-file-name": "r03-source.jsonl",
      },
      payload:
        Array.from({ length: 21 }, (_, i) => i + 1)
          .map((n) =>
            JSON.stringify({ question: " 问题" + n + " ", answer: "答案" + n }),
          )
          .join("\n") + "\n",
    });
    const confirmed = await api(
      "POST",
      "/api/projects/" + projectId + "/pending-upload-batches/confirm",
      {
        collectionId,
        pendingUploadIds: [uploaded.json().pendingUpload.id],
        mode: "raw",
      },
    );
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    assetId = confirmed.json().assets[0].id;
    const mapping = (
      await api(
        "GET",
        "/api/projects/" + projectId + "/assets/" + assetId + "/mapping",
      )
    ).json();
    expect(
      (
        await api(
          "PUT",
          "/api/projects/" + projectId + "/assets/" + assetId + "/mapping",
          {
            parsedViewId: mapping.parsedViewId,
            expectedRevision: 0,
            mapping: {
              question: "/question",
              expectedOutput: "/answer",
              metadata: [],
            },
          },
        )
      ).statusCode,
    ).toBe(200);

    const id = await fresh();
    const p = await processing(id, "rewrite");
    assetId = originalAsset;
    const activity = "review-rows-" + randomUUID();
    await db.query(
      "INSERT INTO assistant_runtime_activity(id,request_limit,row_limit,max_ms) VALUES($1,10,30,300000)",
      [activity],
    );
    await db.query(
      "UPDATE assistant_runtime_execution SET activity_id=$2 WHERE session_id=$1",
      [id, activity],
    );
    let failure = null;
    try {
      await completeRun(p.runId);
    } catch (e) {
      failure = (e as Error).message;
    }
    const activityRow = (
      await db.query(
        "SELECT requests,rows_used,row_limit FROM assistant_runtime_activity WHERE id=$1",
        [activity],
      )
    ).rows[0];
    const batches = (
      await db.query(
        "SELECT ordinal,output_count,error_code FROM processing_batch WHERE run_id=$1 ORDER BY ordinal",
        [p.runId],
      )
    ).rows;
    console.log(
      "REVIEW_BATCH_ROWS",
      JSON.stringify({ failure, activity: activityRow, batches }),
    );
    expect(activityRow.rows_used).toBe(21);
    expect(activityRow.requests).toBe(2);
    expect(batches.every((b: any) => b.output_count > 0 && !b.error_code)).toBe(
      true,
    );
  });

  it("BATCH1 COMBO confirmation replay and explanation failure retain unique saved truth", async () => {
    const { id, plan } = await reviewCreate();
    const start = await run(id, "清洗这三条，确认后保存", [
      plan,
      call("submit_processing", {}),
    ]);
    expect(start.execution.status).toBe("waiting");
    await api("POST", route(id) + "/control", { action: "stop" });
    await completeRun(start.results[0].run_id).catch(() => {});
    expect((await jobState(id)).status).toBe("paused");
    await api("POST", route(id) + "/control", { action: "continue" });
    await completeRun(start.results[0].run_id);
    await host.execution.wake();
    outputs = [call("prepare_adoption", {})];
    const ready = await host.runPending(scope(), id, start.execution.turn_id);
    const card = ready.confirmations.find(
      (c: any) => c.action === "adopt" && c.status === "pending",
    );
    expect(ready.execution.status).toBe("confirmation");
    const first = await api("POST", route(id) + "/confirmations/" + card.id, {
      accept: true,
    });
    expect(first.statusCode, first.body).toBe(200);
    const replay = await api("POST", route(id) + "/confirmations/" + card.id, {
      accept: true,
    });
    expect(replay.json().replayed).toBe(true);
    outputs = [{ httpStatus: 503 }];
    const final = await host.runPending(scope(), id, start.execution.turn_id);
    expect(final.businessStatus).toBe("saved");
    expect(final.execution.status).toBe("completed");
    expect(final.receipts.filter((r: any) => r.acceptanceId)).toHaveLength(1);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM assistant_runtime_operation WHERE session_id=$1 AND kind='processing'",
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM assistant_runtime_event WHERE session_id=$1 AND kind='tool_error' AND detail->>'code' LIKE '%interrupt%'",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("BATCH1 BUDGET refuses offers and first approval after outer activity closes", async () => {
    const id = await fresh();
    await host.execution.ensure(db, scope(), id);
    await db.query(
      "UPDATE assistant_runtime_execution SET request_limit=1 WHERE session_id=$1",
      [id],
    );
    await run(id, "查询项目", [call("read_project", {})]);
    const activity = "fix-activity-" + randomUUID();
    await db.query(
      "INSERT INTO assistant_runtime_activity(id,request_limit,row_limit,max_ms) VALUES($1,10,30,300000)",
      [activity],
    );
    await db.query(
      "UPDATE assistant_runtime_execution SET activity_id=$2 WHERE session_id=$1",
      [id, activity],
    );
    const offer = (await api("POST", route(id) + "/budget-offer", {})).json();
    await db.query(
      "UPDATE assistant_runtime_activity SET closed_at=now() WHERE id=$1",
      [activity],
    );
    const before = await jobState(id);
    expect(
      (await api("POST", route(id) + "/budget-offer", {})).json().error.code,
    ).toBe("activity_budget_exhausted");
    expect(
      (
        await api("POST", route(id) + "/confirmations/" + offer.id, {
          accept: true,
        })
      ).json().error.code,
    ).toBe("activity_budget_exhausted");
    const after = await jobState(id);
    expect(after.requests).toBe(before.requests);
    expect(after.request_limit).toBe(before.request_limit);
  });
  it("BATCH1 PAGE budget offer confirmation and refresh keep a single grant", async () => {
    const id = await fresh();
    await host.execution.ensure(db, scope(), id);
    await db.query(
      "UPDATE assistant_runtime_execution SET request_limit=1 WHERE session_id=$1",
      [id],
    );
    await run(id, "查看项目", [call("read_project", {})]);
    const address = await webAddress(),
      browser = await chromium.launch({ headless: true }),
      context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        extraHTTPHeaders: { origin },
      });
    const cookie = identities.get("admin")!.cookie!.split("=");
    await context.addCookies([
      { name: cookie[0]!, value: cookie.slice(1).join("="), url: address },
    ]);
    try {
      const page = await context.newPage();
      await page.goto(address + "/projects/" + projectId + "/assistant/" + id);
      await page
        .getByRole("button", { name: "申请追加额度", exact: true })
        .click();
      await browserExpect(
        page.getByRole("heading", { name: "确认追加任务额度", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "确认追加", exact: true }).click();
      await browserExpect(
        page.getByText("已追加 12 次请求、80 秒运行时间 · 服务端已确认", {
          exact: true,
        }),
      ).toBeVisible();
      await page.reload();
      await browserExpect(
        page.getByText("已追加 12 次请求、80 秒运行时间 · 服务端已确认", {
          exact: true,
        }),
      ).toBeVisible();
      expect((await jobState(id)).requests).toBe(1);
      expect((await jobState(id)).request_limit).toBe(13);
      await page.setViewportSize({ width: 720, height: 900 });
      await browserExpect(
        page.getByLabel("描述你的需求", { exact: true }),
      ).toBeVisible();
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30000);
  it("BATCH1 END failed Worker cannot become completed through natural text", async () => {
    const { id, plan } = await reviewCreate();
    const started = await run(id, "清洗三条后确认保存", [
      plan,
      call("submit_processing", {}),
    ]);
    await db.query(
      "UPDATE job SET status='failed' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
      [started.results[0].run_id],
    );
    await host.execution.wake();
    outputs = [{ role: "assistant", content: "处理已经结束" }];
    const ended = await host.runPending(scope(), id, started.execution.turn_id);
    expect(ended.execution.status).toBe("paused");
    expect(ended.execution.reason).toBe("processing_not_complete");
  });
  it("BATCH1 END completed result requires its save confirmation even if model omits preparation", async () => {
    const { id, plan } = await reviewCreate();
    const started = await run(id, "清洗三条后确认保存", [
      plan,
      call("submit_processing", {}),
    ]);
    await completeRun(started.results[0].run_id);
    await host.execution.wake();
    outputs = [
      { role: "assistant", content: "处理完成" },
      call("prepare_adoption", {}),
    ];
    const ended = await host.runPending(scope(), id, started.execution.turn_id);
    expect(ended.execution.status).toBe("confirmation");
    expect(
      ended.confirmations.filter((c: any) => c.status === "pending"),
    ).toHaveLength(1);
  });
  it.each(["processing", "confirmation"])(
    "BATCH1 LEGACY explicit continue recovers completed orphan %s with original budget",
    async (kind) => {
      let id: string, turn: string;
      if (kind === "processing") {
        id = await fresh();
        const p = await processing(id);
        turn = p.proof.turnId;
        await host.store.finish(p.proof, "旧版误结束");
      } else {
        const f = await adoptionCard();
        id = f.id;
        turn = f.p.proof.turnId;
        await db.query(
          "UPDATE assistant_runtime_turn SET status='succeeded',runner_token=NULL WHERE id=$1",
          [turn],
        );
        await db.query(
          "UPDATE assistant_runtime_execution SET status='completed' WHERE session_id=$1",
          [id],
        );
      }
      const before = await jobState(id);
      expect(
        (await api("POST", route(id) + "/control", { action: "continue" }))
          .statusCode,
      ).toBe(200);
      expect((await jobState(id)).requests).toBe(before.requests);
      expect((await jobState(id)).request_limit).toBe(before.request_limit);
      outputs = [
        call(
          kind === "processing" ? "wait_processing" : "wait_confirmation",
          {},
        ),
      ];
      const resumed = await host.runPending(scope(), id, turn);
      expect(resumed.execution.status).toBe(
        kind === "processing" ? "waiting" : "confirmation",
      );
    },
  );
  it("BATCH1 PAGE loaded history survives a sliding SSE window without a middle gap", async () => {
    const id = await fresh(),
      address = await webAddress(),
      browser = await chromium.launch({ headless: true }),
      context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        extraHTTPHeaders: { origin },
      });
    const cookie = identities.get("admin")!.cookie!.split("=");
    await context.addCookies([
      { name: cookie[0]!, value: cookie.slice(1).join("="), url: address },
    ]);
    const page = await context.newPage(),
      state = await host.present(scope(), id);
    const msg = (n: number) => ({
      id: String(n),
      turn_id: "synthetic-" + n,
      role: "assistant",
      content: "历史核对消息" + n,
    });
    const snapshot = {
      ...state,
      messages: Array.from({ length: 100 }, (_, i) => msg(i + 101)),
    };
    let release!: () => void;
    const update = new Promise<void>((r) => (release = r));
    await page.route("**" + route(id), (r) => r.fulfill({ json: snapshot }));
    await page.route("**" + route(id) + "/history?*", (r) =>
      r.fulfill({
        json: {
          messages: Array.from({ length: 100 }, (_, i) => msg(i + 1)),
          hasEarlier: false,
        },
      }),
    );
    await page.route("**" + route(id) + "/events", async (r) => {
      await update;
      await r
        .fulfill({
          contentType: "text/event-stream",
          body:
            "event: snapshot\ndata: " +
            JSON.stringify({
              ...snapshot,
              messages: Array.from({ length: 100 }, (_, i) => msg(i + 102)),
            }) +
            "\n\n",
        })
        .catch(() => {});
    });
    try {
      await page.goto(address + "/projects/" + projectId + "/assistant/" + id);
      await page
        .getByRole("button", { name: "加载更早消息", exact: true })
        .click();
      await browserExpect(
        page.getByText("历史核对消息1", { exact: true }),
      ).toBeVisible();
      release();
      await browserExpect(
        page.getByText("历史核对消息201", { exact: true }),
      ).toBeVisible();
      await browserExpect(
        page.getByText("历史核对消息101", { exact: true }),
      ).toBeVisible();
      await browserExpect(
        page.getByRole("button", { name: "加载更早消息", exact: true }),
      ).toHaveCount(0);
    } finally {
      release();
      await context.close();
      await browser.close();
    }
  }, 30000);
  it("BATCH1 FINAL recovery text without tools reaches no-progress before exhausting request budget", async () => {
    const { id, plan } = await reviewCreate();
    const started = await run(id, "清洗三条后保存", [
      plan,
      call("submit_processing", {}),
    ]);
    await completeRun(started.results[0].run_id);
    await host.execution.wake();
    outputs = Array.from({ length: 10 }, () => ({
      role: "assistant",
      content: "我知道了，稍后处理。",
    }));
    const ended = await host.runPending(scope(), id, started.execution.turn_id);
    expect(ended.execution.status).toBe("paused");
    expect(ended.execution.reason).toBe("no_progress");
    expect(ended.execution.requests).toBeLessThan(
      ended.execution.request_limit,
    );
  });
  it("POSTFIX saved receipt cannot hide a different new turn provider failure", async () => {
    const { id, plan } = await reviewCreate();
    const started = await run(id, "清洗三条后保存", [
      plan,
      call("submit_processing", {}),
    ]);
    await completeRun(started.results[0].run_id);
    await host.execution.wake();
    outputs = [call("prepare_adoption", {})];
    const ready = await host.runPending(scope(), id, started.execution.turn_id);
    const card = ready.confirmations.find(
      (c: any) => c.action === "adopt" && c.status === "pending",
    );
    expect(
      (
        await api("POST", route(id) + "/confirmations/" + card.id, {
          accept: true,
        })
      ).statusCode,
    ).toBe(200);
    outputs = [{ role: "assistant", content: "保存完成" }];
    const saved = await host.runPending(scope(), id, started.execution.turn_id);
    expect(saved.execution.status).toBe("completed");
    await expect(
      run(id, "现在帮我查看这个项目还有哪些原始资料", [{ httpStatus: 503 }]),
    ).rejects.toThrow();
    const next = await host.present(scope(), id);
    const latest = (
      await db.query(
        "SELECT status,error_code FROM assistant_runtime_turn WHERE id=$1",
        [next.execution.turn_id],
      )
    ).rows[0];
    expect(latest.status).toBe("failed");
    expect(next.receipts.filter((r: any) => r.acceptanceId)).toHaveLength(1);
    console.log(
      "POSTFIX_UNRELATED_QUERY",
      JSON.stringify({
        status: next.execution.status,
        reason: next.execution.reason,
        last: next.messages.slice(-1),
        receipt: next.receipts,
      }),
    );
    expect(next.execution.status).not.toBe("completed");
  });
  it("POSTFIX legacy completed successful job without confirmation remains resumable", async () => {
    const id = await fresh();
    const p = await processing(id);
    await completeRun(p.runId);
    await host.store.finish(p.proof, "旧版漏等待而结束");
    const before = await host.present(scope(), id);
    const response = await api("POST", route(id) + "/control", {
      action: "continue",
    });
    console.log(
      "POSTFIX_ORPHAN_SUCCESS",
      JSON.stringify({
        before: before.execution.status,
        results: before.results,
        confirmation: before.confirmations,
        status: response.statusCode,
        response: response.json(),
      }),
    );
    expect(response.statusCode).toBe(200);
  });

  it.each(["automatic", "manual"])(
    "POSTFIX PAGE retries an incomplete middle history gap %s",
    async (mode) => {
      const id = await fresh(),
        address = await webAddress(),
        browser = await chromium.launch({ headless: true }),
        context = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          extraHTTPHeaders: { origin },
        });
      const cookie = identities.get("admin")!.cookie!.split("=");
      await context.addCookies([
        { name: cookie[0]!, value: cookie.slice(1).join("="), url: address },
      ]);
      const page = await context.newPage(),
        state = await host.present(scope(), id);
      const msg = (n: number) => ({
        id: String(n),
        turn_id: "gap-" + n,
        role: "assistant",
        content: "Gap review " + n,
      });
      const snap = {
        ...state,
        messages: Array.from({ length: 100 }, (_, i) => msg(i + 101)),
      };
      let gapRequests = 0;
      await page.addInitScript(() => {
        (window as any).EventSource = class {
          listeners: any = {};
          onerror: any;
          constructor() {
            (window as any).__gapSource = this;
          }
          addEventListener(name: string, fn: any) {
            this.listeners[name] = fn;
          }
          close() {}
        };
      });
      await page.route("**" + route(id), (r) => r.fulfill({ json: snap }));
      await page.route("**" + route(id) + "/history?*", (r) => {
        const before = new URL(r.request().url()).searchParams.get("before");
        if (before === "101")
          return r.fulfill({
            json: {
              messages: Array.from({ length: 100 }, (_, i) => msg(i + 1)),
              hasEarlier: false,
            },
          });
        gapRequests++;
        if (gapRequests === 1)
          return r.fulfill({
            status: 503,
            json: { error: { code: "temporarily_unavailable" } },
          });
        return r.fulfill({
          json: {
            messages: Array.from({ length: 100 }, (_, i) =>
              msg(Number(before) - 100 + i),
            ),
            hasEarlier: true,
          },
        });
      });
      try {
        await page.goto(
          address + "/projects/" + projectId + "/assistant/" + id,
        );
        await page
          .getByRole("button", { name: "加载更早消息", exact: true })
          .click();
        await browserExpect(
          page.getByText("Gap review 1", { exact: true }),
        ).toBeVisible();
        await page.evaluate(
          (s) =>
            (window as any).__gapSource.listeners.snapshot({
              data: JSON.stringify(s),
            }),
          {
            ...snap,
            messages: Array.from({ length: 100 }, (_, i) => msg(i + 401)),
          },
        );
        await browserExpect.poll(() => gapRequests).toBe(1);
        if (mode === "manual")
          await page
            .getByRole("button", { name: "重试加载", exact: true })
            .click();
        await page.evaluate(
          (s) =>
            (window as any).__gapSource.listeners.snapshot({
              data: JSON.stringify(s),
            }),
          {
            ...snap,
            messages: Array.from({ length: 100 }, (_, i) => msg(i + 402)),
          },
        );
        await browserExpect(
          page.getByText("Gap review 501", { exact: true }),
        ).toBeVisible();
        console.log(
          "POSTFIX_HISTORY_GAP",
          JSON.stringify({
            gapRequests,
            missing301:
              (await page
                .getByText("Gap review 301", { exact: true })
                .count()) === 0,
            historyButton: await page
              .getByRole("button", { name: "加载更早消息", exact: true })
              .count(),
          }),
        );
        await browserExpect(
          page.getByText("Gap review 301", { exact: true }),
        ).toBeVisible({ timeout: 1500 });
      } finally {
        await context.close();
        await browser.close();
      }
    },
    30000,
  );

  it.each(["missing", "expired"])(
    "POSTFIX recover successful orphan %s confirmation to unique save",
    async (kind) => {
      const { id, plan } = await reviewCreate();
      const start = await run(id, "清洗三条后保存", [
        plan,
        call("submit_processing", {}),
      ]);
      await completeRun(start.results[0].run_id);
      await host.execution.wake();
      let oldCard: any;
      if (kind === "expired") {
        outputs = [call("prepare_adoption", {})];
        const ready = await host.runPending(
          scope(),
          id,
          start.execution.turn_id,
        );
        oldCard = ready.confirmations.find((c: any) => c.action === "adopt");
        await db.query(
          "UPDATE assistant_runtime_confirmation SET expires_at=now()-interval '1 minute' WHERE id=$1",
          [oldCard.id],
        );
      }
      await db.query(
        "UPDATE assistant_runtime_turn SET status='succeeded',runner_token=NULL WHERE id=$1",
        [start.execution.turn_id],
      );
      await db.query(
        "UPDATE assistant_runtime_execution SET status='completed' WHERE session_id=$1",
        [id],
      );
      expect((await host.present(scope(), id)).canResumeCompleted).toBe(true);
      const before = await jobState(id);
      expect(
        (await api("POST", route(id) + "/control", { action: "continue" }))
          .statusCode,
      ).toBe(200);
      outputs = [call("prepare_adoption", {})];
      const ready = await host.runPending(scope(), id, start.execution.turn_id);
      const card = ready.confirmations.find(
        (c: any) =>
          c.status === "pending" &&
          new Date(c.expires_at).getTime() > Date.now(),
      );
      expect(card).toBeTruthy();
      if (oldCard) {
        expect(card.id).not.toBe(oldCard.id);
        expect(
          (
            await api("POST", route(id) + "/confirmations/" + oldCard.id, {
              accept: true,
            })
          ).statusCode,
        ).toBe(409);
      }
      expect(
        (
          await api("POST", route(id) + "/confirmations/" + card.id, {
            accept: true,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await api("POST", route(id) + "/confirmations/" + card.id, {
            accept: true,
          })
        ).json().replayed,
      ).toBe(true);
      outputs = [{ role: "assistant", content: "保存完成" }];
      await host.runPending(scope(), id, start.execution.turn_id);
      const final = await host.present(scope(), id);
      expect(final.receipts.filter((r: any) => r.acceptanceId)).toHaveLength(1);
      expect(final.canResumeCompleted).toBe(false);
      expect(final.results).toHaveLength(1);
      expect(final.results[0].run_id).toBe(start.results[0].run_id);
      expect((await jobState(id)).request_limit).toBe(before.request_limit);
    },
  );

  it("POSTFIX new read-only turn cannot adopt previous orphan results", async () => {
    const { id, plan } = await reviewCreate();
    const start = await run(id, "清洗三条", [
      plan,
      call("submit_processing", {}),
    ]);
    await completeRun(start.results[0].run_id);
    await db.query(
      "UPDATE assistant_runtime_turn SET status='succeeded',runner_token=NULL WHERE id=$1",
      [start.execution.turn_id],
    );
    await db.query(
      "UPDATE assistant_runtime_execution SET status='completed' WHERE session_id=$1",
      [id],
    );
    await db.query(
      "UPDATE assistant_runtime_session SET status='idle' WHERE id=$1",
      [id],
    );
    const result = await run(id, "查看项目信息", [
      call("read_project", {}),
      { role: "assistant", content: "已查看项目" },
    ]);
    expect(result.execution.status).toBe("completed");
    expect(result.confirmations).toHaveLength(0);
    expect(result.receipts).toHaveLength(0);
    expect(result.messages.at(-1).content).toBe("已查看项目");
  });
  it.each(["clock", "stored"])(
    "POSTFIX standalone persisted wait renews expired card %s only on continue",
    async (expiry) => {
      const { id, p, card } = await adoptionCard();
      await db.query(
        "UPDATE assistant_runtime_turn SET status='pending' WHERE id=$1",
        [p.proof.turnId],
      );
      await db.query(
        "UPDATE assistant_runtime_execution SET status='pending' WHERE session_id=$1",
        [id],
      );
      outputs = [call("wait_confirmation", {})];
      expect(
        (await host.runPending(scope(), id, p.proof.turnId)).execution.status,
      ).toBe("confirmation");
      await db.query(
        "UPDATE assistant_runtime_confirmation SET expires_at=now()-interval '1 minute' WHERE id=$1",
        [card.id],
      );
      await db.query(
        "UPDATE assistant_runtime_turn SET status='succeeded' WHERE id=$1",
        [p.proof.turnId],
      );
      await db.query(
        "UPDATE assistant_runtime_execution SET status='completed' WHERE session_id=$1",
        [id],
      );
      expect(
        (await api("POST", route(id) + "/control", { action: "continue" }))
          .statusCode,
      ).toBe(200);
      if (expiry === "stored")
        await db.query(
          "UPDATE assistant_runtime_confirmation SET status='expired' WHERE id=$1",
          [card.id],
        );
      outputs = [];
      const resumed = await host.runPending(scope(), id, p.proof.turnId);
      expect(resumed.execution.status).toBe("confirmation");
      expect(
        resumed.confirmations.some(
          (c: any) => c.id !== card.id && c.status === "pending",
        ),
      ).toBe(true);
    },
  );

  it("POSTFIX PAGE successful orphan exposes continue and preserves the original processing run", async () => {
    const id = await fresh(),
      p = await processing(id);
    await completeRun(p.runId);
    await host.store.finish(p.proof, "旧版结束");
    const address = await webAddress(),
      browser = await chromium.launch({ headless: true }),
      context = await browser.newContext({ extraHTTPHeaders: { origin } }),
      cookie = identities.get("admin")!.cookie!.split("=");
    await context.addCookies([
      { name: cookie[0]!, value: cookie.slice(1).join("="), url: address },
    ]);
    try {
      const page = await context.newPage();
      await page.goto(address + "/projects/" + projectId + "/assistant/" + id);
      await page
        .getByRole("button", { name: "继续完成保存", exact: true })
        .click();
      await browserExpect
        .poll(async () => (await jobState(id)).status)
        .toBe("pending");
      expect((await host.present(scope(), id)).results[0].run_id).toBe(p.runId);
      expect(
        (await api("POST", route(id) + "/control", { action: "continue" }))
          .statusCode,
      ).toBe(409);
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30000);
  it.each(["revision", "budget", "no_progress"])(
    "POSTFIX orphan recovery keeps %s guard",
    async (kind) => {
      const id = await fresh(),
        p = await processing(id);
      await completeRun(p.runId);
      await host.store.finish(p.proof, "旧版结束");
      if (kind === "revision")
        await db.query(
          "UPDATE assistant_runtime_session SET requirements_revision=1 WHERE id=$1",
          [id],
        );
      if (kind === "budget")
        await db.query(
          "UPDATE assistant_runtime_execution SET requests=request_limit WHERE session_id=$1",
          [id],
        );
      if (kind === "no_progress")
        await db.query(
          "UPDATE assistant_runtime_execution SET no_progress=3,progress_revision=0 WHERE session_id=$1",
          [id],
        );
      const before = await jobState(id);
      expect(
        (await api("POST", route(id) + "/control", { action: "continue" }))
          .statusCode,
      ).toBeGreaterThanOrEqual(400);
      expect((await jobState(id)).requests).toBe(before.requests);
      expect((await jobState(id)).status).toBe("completed");
    },
  );

  it("POSTFIX PAGE access loss discards a late manual history response", async () => {
    const id = await fresh(),
      address = await webAddress(),
      browser = await chromium.launch({ headless: true }),
      context = await browser.newContext({ extraHTTPHeaders: { origin } }),
      cookie = identities.get("admin")!.cookie!.split("=");
    await context.addCookies([
      { name: cookie[0]!, value: cookie.slice(1).join("="), url: address },
    ]);
    const page = await context.newPage(),
      state = await host.present(scope(), id),
      msg = (n: number) => ({
        id: String(n),
        turn_id: "late-" + n,
        role: "assistant",
        content: "Late history " + n,
      });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let requested = false;
    await page.addInitScript(() => {
      (window as any).EventSource = class {
        listeners: any = {};
        onerror: any;
        constructor() {
          (window as any).__lateSource = this;
        }
        addEventListener(n: string, f: any) {
          this.listeners[n] = f;
        }
        close() {}
      };
    });
    await page.route("**" + route(id), (r) =>
      r.fulfill({
        json: {
          ...state,
          messages: Array.from({ length: 100 }, (_, i) => msg(i + 101)),
        },
      }),
    );
    await page.route("**" + route(id) + "/history?*", async (r) => {
      requested = true;
      await gate;
      await r.fulfill({ json: { messages: [msg(1)], hasEarlier: true } });
    });
    try {
      await page.goto(address + "/projects/" + projectId + "/assistant/" + id);
      await page
        .getByRole("button", { name: "加载更早消息", exact: true })
        .click();
      await browserExpect.poll(() => requested).toBe(true);
      await page.evaluate(() =>
        (window as any).__lateSource.listeners.access_lost(),
      );
      release();
      await browserExpect(
        page.getByText("会话访问已失效，请重新登录或核对权限。", {
          exact: true,
        }),
      ).toBeVisible();
      await page.evaluate(
        (s) =>
          (window as any).__lateSource.listeners.snapshot({
            data: JSON.stringify(s),
          }),
        { ...state, messages: [msg(201)] },
      );
      await browserExpect(
        page.getByText("Late history 201", { exact: true }),
      ).toBeVisible();
      expect(
        await page.getByText("Late history 1", { exact: true }).count(),
      ).toBe(0);
    } finally {
      release();
      await context.close();
      await browser.close();
    }
  }, 30000);
  it("RESUME SDK paused query hides write tools and repairs a wrong prepare without resuming", async () => {
    const id = await fresh(),
      p = await processing(id, "rewrite");
    await host.stop(scope(), id);
    const before = await host.present(scope(), id),
      beforeEffects = await effects();
    const checked: string[][] = [];
    const wrongPrepare = (body: any) => {
      checked.push(body.tools.map((t: any) => t.function.name));
      return call("prepare_adoption", {});
    };
    const state = await run(id, "现在进度怎么样？不要继续", [
      wrongPrepare,
      (body: any) => {
        checked.push(body.tools.map((t: any) => t.function.name));
        return call("read_task_progress", {});
      },
      { role: "assistant", content: "原任务仍暂停，查看进度没有继续或保存。" },
    ]);
    for (const names of checked) {
      expect(names).toContain("read_task_progress");
      expect(names).not.toContain("continue_task");
      expect(names).not.toEqual(expect.arrayContaining(["prepare_adoption"]));
      for (const name of [
        "submit_processing",
        "prepare_adoption",
        "wait_processing",
        "wait_confirmation",
      ])
        expect(names).not.toContain(name);
    }
    expect(state.execution.status).toBe("paused");
    expect(state.execution.turn_id).toBe(p.proof.turnId);
    expect(state.execution.requests - before.execution.requests).toBe(3);
    expect(state.results.map((r: any) => r.run_id)).toEqual([p.runId]);
    expect(await effects()).toEqual(beforeEffects);
    const events = (
      await db.query(
        "SELECT kind,detail FROM assistant_runtime_event WHERE session_id=$1 ORDER BY id",
        [id],
      )
    ).rows;
    expect(events.filter((e) => e.kind === "state_feedback")).toHaveLength(1);
    expect(
      events.some(
        (e) => e.kind === "tool_call" && e.detail.name === "continue_task",
      ),
    ).toBe(false);
    expect(events.some((e) => e.kind === "execution_error")).toBe(false);
  });

  it("RESUME SDK a query correction cannot authorize continue after a wrong prepare", async () => {
    const id = await fresh(),
      p = await processing(id, "rewrite");
    await host.stop(scope(), id);
    const before = await host.present(scope(), id),
      beforeEffects = await effects();
    await expect(
      run(id, "现在进度怎么样？不要继续", [
        call("prepare_adoption", {}),
        (body: any) => {
          expect(body.tools.map((t: any) => t.function.name)).not.toContain(
            "continue_task",
          );
          return call("continue_task", {});
        },
        { role: "assistant", content: "不应再次调用模型。" },
      ]),
    ).rejects.toMatchObject({ code: "state_reselection_exhausted" });
    const state = await host.present(scope(), id);
    expect(state.execution.status).toBe("paused");
    expect(state.execution.turn_id).toBe(p.proof.turnId);
    expect(state.execution.requests - before.execution.requests).toBe(2);
    expect(state.results.map((r: any) => r.run_id)).toEqual([p.runId]);
    expect(await effects()).toEqual(beforeEffects);
    const events = (
      await db.query(
        "SELECT kind,detail FROM assistant_runtime_event WHERE session_id=$1 ORDER BY id",
        [id],
      )
    ).rows;
    expect(events.filter((e) => e.kind === "state_feedback")).toHaveLength(1);
    expect(
      events.some(
        (e) => e.kind === "tool_call" && e.detail.name === "continue_task",
      ),
    ).toBe(false);
    expect(state.confirmations.some((c: any) => c.status === "pending")).toBe(
      false,
    );
  });

  it("RESUME SDK rejects a direct query-time continue then permits read-only recovery", async () => {
    const id = await fresh(),
      p = await processing(id, "rewrite");
    await host.stop(scope(), id);
    const before = await host.present(scope(), id),
      beforeEffects = await effects();
    const state = await run(id, "现在进度怎么样？不要继续", [
      (body: any) => {
        const names = body.tools.map((t: any) => t.function.name);
        expect(names).toContain("read_task_progress");
        expect(names).not.toContain("continue_task");
        return call("continue_task", {});
      },
      call("read_task_progress", {}),
      { role: "assistant", content: "任务仍暂停，没有继续或保存。" },
    ]);
    expect(state.execution.status).toBe("paused");
    expect(state.execution.turn_id).toBe(p.proof.turnId);
    expect(state.execution.requests - before.execution.requests).toBe(3);
    expect(state.results.map((r: any) => r.run_id)).toEqual([p.runId]);
    expect(await effects()).toEqual(beforeEffects);
    const events = (
      await db.query(
        "SELECT kind,detail FROM assistant_runtime_event WHERE session_id=$1 ORDER BY id",
        [id],
      )
    ).rows;
    expect(events.filter((e) => e.kind === "state_feedback")).toHaveLength(1);
    expect(
      events.some(
        (e) => e.kind === "tool_call" && e.detail.name === "continue_task",
      ),
    ).toBe(false);
    expect(events.some((e) => e.kind === "execution_error")).toBe(false);
    expect(state.confirmations.some((c: any) => c.status === "pending")).toBe(
      false,
    );
  });

  it("RESUME SDK bounds repeated state mistakes without spending a third request or losing the pause", async () => {
    const id = await fresh(),
      p = await processing(id, "rewrite");
    await host.stop(scope(), id);
    const before = await host.present(scope(), id),
      beforeEffects = await effects();
    await expect(
      run(id, "继续", [
        call("prepare_adoption", {}),
        call("submit_processing", {}),
        call("continue_task", {}),
      ]),
    ).rejects.toMatchObject({ code: "state_reselection_exhausted" });
    const state = await host.present(scope(), id);
    expect(state.execution.status).toBe("paused");
    expect(state.execution.turn_id).toBe(p.proof.turnId);
    expect(state.execution.requests - before.execution.requests).toBe(2);
    expect(await effects()).toEqual(beforeEffects);
    const events = (
      await db.query(
        "SELECT kind,detail FROM assistant_runtime_event WHERE session_id=$1 ORDER BY id",
        [id],
      )
    ).rows;
    expect(events.filter((e) => e.kind === "state_feedback")).toHaveLength(1);
    expect(
      events.some(
        (e) => e.kind === "tool_call" && e.detail.name === "continue_task",
      ),
    ).toBe(false);
  });

  it("RESUME SDK confirmation stop query ordinary continue repairs preparation and saves exactly once", async () => {
    const { id, plan } = await reviewCreate();
    const beforeEffects = await effects();
    const start = await run(id, "清洗三条后保存", [
      plan,
      call("submit_processing", {}),
    ]);
    const runId = start.results[0].run_id,
      originalTurn = start.execution.turn_id;
    await completeRun(runId);
    await host.execution.wake();
    outputs = [call("prepare_adoption", {})];
    const ready = await host.runPending(scope(), id, originalTurn);
    const oldCard = ready.confirmations.find(
      (c: any) => c.action === "adopt" && c.status === "pending",
    );
    expect(oldCard).toBeTruthy();
    expect(ready.execution.status).toBe("confirmation");
    const batchBefore = (
      await db.query(
        "SELECT * FROM processing_batch WHERE run_id=$1 ORDER BY ordinal",
        [runId],
      )
    ).rows;
    expect(
      (await api("POST", route(id) + "/control", { action: "stop" }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await db.query(
          "SELECT status FROM assistant_runtime_confirmation WHERE id=$1",
          [oldCard.id],
        )
      ).rows[0].status,
    ).toBe("expired");
    const queried = await run(id, "现在做到哪了？", [
      call("read_task_progress", {}),
      { role: "assistant", content: "处理结果已经保留，任务暂停且尚未保存。" },
    ]);
    expect(queried.execution.status).toBe("paused");
    expect(queried.execution.turn_id).toBe(originalTurn);
    const requestBefore = queried.execution.requests;
    const resumed = await run(id, "继续", [
      call("prepare_adoption", {}),
      (body: any) => {
        expect(body.tools.map((t: any) => t.function.name)).not.toContain(
          "prepare_adoption",
        );
        return call("continue_task", {});
      },
      { role: "assistant", content: "不应额外花费模型请求的总结" },
    ]);
    expect(resumed.execution.status).toBe("pending");
    expect(resumed.execution.turn_id).toBe(originalTurn);
    expect(resumed.execution.requests - requestBefore).toBe(2);
    expect(resumed.receipts.filter((r: any) => r.acceptanceId)).toHaveLength(0);
    outputs = [call("prepare_adoption", {})];
    const recovered = await host.runPending(scope(), id, originalTurn);
    expect(recovered.execution.status).toBe("confirmation");
    const currentCards = recovered.confirmations.filter(
      (c: any) => c.status === "pending",
    );
    expect(currentCards).toHaveLength(1);
    const card = currentCards[0];
    expect(card.id).not.toBe(oldCard.id);
    expect((await effects()).drafts).toBe(beforeEffects.drafts);
    expect(
      (
        await api("POST", route(id) + "/confirmations/" + oldCard.id, {
          accept: true,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await api("POST", route(id) + "/confirmations/" + card.id, {
          accept: true,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await api("POST", route(id) + "/confirmations/" + card.id, {
          accept: true,
        })
      ).json().replayed,
    ).toBe(true);
    outputs = [{ role: "assistant", content: "已保存" }];
    const saved = await host.runPending(scope(), id, originalTurn);
    expect(saved.receipts.filter((r: any) => r.acceptanceId)).toHaveLength(1);
    expect(saved.results.map((r: any) => r.run_id)).toEqual([runId]);
    expect(
      (
        await db.query(
          "SELECT * FROM processing_batch WHERE run_id=$1 ORDER BY ordinal",
          [runId],
        )
      ).rows,
    ).toEqual(batchBefore);
    const afterEffects = await effects();
    expect(afterEffects.runs - beforeEffects.runs).toBe(1);
    expect(afterEffects.drafts - beforeEffects.drafts).toBe(1);
    const feedback = (
      await db.query(
        "SELECT kind FROM assistant_runtime_event WHERE session_id=$1 AND kind='state_feedback'",
        [id],
      )
    ).rows;
    expect(feedback).toHaveLength(1);
  });
  it("RESUME SDK keeps the one state correction limit across an expired-owner reentry", async () => {
    const id = await fresh(),
      p = await processing(id, "rewrite");
    await host.stop(scope(), id);
    const before = await host.present(scope(), id),
      beforeEffects = await effects();
    const accepted = await submit(id, "继续");
    expect(accepted.statusCode).toBe(202);
    const followupTurn = accepted.json().turnId;
    let release!: () => void,
      entered = false,
      attempts = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    outputs = [call("prepare_adoption", {})];
    const oldRun = host.runPending(scope(), id, followupTurn, {
      hooks: {
        beforeRequest: async () => {
          if (++attempts === 2) {
            entered = true;
            await gate;
          }
        },
      },
    });
    const other = new FormalSessionHost(db, config);
    try {
      await until(async () => entered);
      const feedbackBefore = (
        await db.query(
          "SELECT count(*)::int n FROM assistant_runtime_event WHERE turn_id=$1 AND kind='state_feedback'",
          [followupTurn],
        )
      ).rows[0].n;
      expect(feedbackBefore).toBe(1);
      await db.query(
        "UPDATE assistant_runtime_execution SET lease_until=now()-interval '1 second' WHERE session_id=$1",
        [id],
      );
      outputs = [call("submit_processing", {}), call("continue_task", {})];
      await expect(
        other.runPending(scope(), id, followupTurn),
      ).rejects.toMatchObject({ code: "state_reselection_exhausted" });
      release();
      await oldRun;
      const state = await other.present(scope(), id);
      expect(state.execution.status).toBe("paused");
      expect(state.execution.turn_id).toBe(p.proof.turnId);
      expect(state.execution.requests - before.execution.requests).toBe(2);
      expect(
        (
          await db.query(
            "SELECT count(*)::int n FROM assistant_runtime_event WHERE turn_id=$1 AND kind='state_feedback'",
            [followupTurn],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(await effects()).toEqual(beforeEffects);
    } finally {
      release();
      await oldRun.catch(() => undefined);
      await other.close();
    }
  });
  it("R03-A rejects new claims after executor shutdown without spending", async () => {
    const id = await fresh(),
      accepted = await submit(id, "查看项目");
    const closed = new FormalSessionHost(db, config);
    await closed.close();
    await expect(
      closed.runPending(scope(), id, accepted.json().turnId),
    ).rejects.toMatchObject({ code: "runtime_host_closed" });
    expect(
      (
        await db.query(
          "SELECT status FROM assistant_runtime_turn WHERE id=$1",
          [accepted.json().turnId],
        )
      ).rows[0].status,
    ).toBe("pending");
    await host.stop(scope(), id);
  });

  it("R03-A drains a claim already in progress when shutdown starts without sending a model request", async () => {
    const id = await fresh(),
      accepted = await submit(id, "查看项目"),
      start = requests.length;
    const delayed = new FormalSessionHost(db, config);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      claimed = new Promise<void>((r) => {
        entered = r;
      });
    const claim = delayed.execution.claim.bind(delayed.execution);
    vi.spyOn(delayed.execution, "claim").mockImplementation(async (...args) => {
      entered();
      await gate;
      return claim(...args);
    });
    const running = delayed.runPending(scope(), id, accepted.json().turnId);
    await claimed;
    const closing = delayed.close();
    release();
    await Promise.all([running, closing]);
    expect(requests.length).toBe(start);
    const state = await host.present(scope(), id);
    expect(state.execution).toMatchObject({ status: "paused", requests: 0 });
    await delayed.close();
  });
  it("R08 PAGE clears cached conversation after background removal and confirms deletion", async () => {
    const id = await fresh(),
      address = await webAddress(),
      before = requests.length;
    const attached = (
      await api("POST", route(id) + "/attachments", {
        fileName: "页面说明.md",
        contentBase64: Buffer.from("R08_BROWSER_SECRET").toString("base64"),
      })
    ).json();
    const a = await submit(id, "R08_BROWSER_SECRET"),
      proof = await host.store.claim(scope(), id, a.json().turnId);
    await host.store.finish(proof, "R08_BROWSER_SECRET");
    const browser = await chromium.launch({ headless: true }),
      context = await browser.newContext({
        extraHTTPHeaders: { origin },
        viewport: { width: 1440, height: 900 },
      });
    const cookie = identities.get("admin")!.cookie!.split("=");
    await context.addCookies([
      { name: cookie[0]!, value: cookie.slice(1).join("="), url: address },
    ]);
    try {
      const page = await context.newPage();
      await page.goto(address + "/projects/" + projectId + "/assistant/" + id);
      await browserExpect(
        page.getByText("R08_BROWSER_SECRET", { exact: true }).first(),
      ).toBeVisible();
      const removed = await api(
        "DELETE",
        route(id) + "/attachments/" + attached.id,
      );
      expect(removed.statusCode, removed.body).toBe(200);
      await browserExpect(
        page.getByText("相关内容已清理", { exact: false }),
      ).toBeVisible();
      await browserExpect(
        page.getByText("R08_BROWSER_SECRET", { exact: true }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: "会话选项", exact: true }).click();
      await page
        .getByRole("menuitem", { name: "删除会话", exact: true })
        .click();
      await browserExpect(page.getByRole("dialog")).toContainText(
        "累计用量保留",
      );
      await page
        .getByRole("button", { name: "确认删除会话", exact: true })
        .click();
      await browserExpect(page).toHaveURL(new RegExp("/assistant$"));
      expect((await api("GET", route(id))).statusCode).toBe(404);
      expect(requests.length).toBe(before);
    } finally {
      await context.close();
      await browser.close();
    }
  });
  it("R08 PAGE manages legacy history and explicitly authorizes a fresh remainder without executing", async () => {
    const raw = "r08_page_" + randomUUID(),
      id = "legacy:" + raw,
      address = await webAddress(),
      before = requests.length;
    await db.query(
      "INSERT INTO assistant_session(id,project_id,actor_id,title,task) VALUES($1,$2,$3,'历史页面',$4)",
      [
        raw,
        projectId,
        scope().actorId,
        JSON.stringify({
          goal: "旧任务",
          budgetLedger: { version: "1", totals: { requests: 5 } },
        }),
      ],
    );
    const browser = await chromium.launch({ headless: true }),
      context = await browser.newContext({
        extraHTTPHeaders: { origin },
        viewport: { width: 1024, height: 800 },
      });
    const cookie = identities.get("admin")!.cookie!.split("=");
    await context.addCookies([
      { name: cookie[0]!, value: cookie.slice(1).join("="), url: address },
    ]);
    try {
      const page = await context.newPage();
      await page.goto(
        address +
          "/projects/" +
          projectId +
          "/assistant/" +
          encodeURIComponent(id),
      );
      await browserExpect(
        page.getByText("仅供查看和管理", { exact: false }),
      ).toBeVisible();
      await page.getByRole("button", { name: "会话选项", exact: true }).click();
      await page
        .getByRole("menuitem", { name: "重命名会话", exact: true })
        .click();
      await page.getByRole("dialog").getByRole("textbox").fill("历史改名确认");
      await page.getByRole("button", { name: "保存名称", exact: true }).click();
      await browserExpect(
        page.getByRole("heading", { name: "历史改名确认", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "会话选项", exact: true }).click();
      await page
        .getByRole("menuitem", { name: "在新会话承接", exact: true })
        .click();
      await page
        .getByLabel("尚未完成的目标", { exact: true })
        .fill("只处理尚未完成的资料，不重做已保存成果");
      await page
        .getByRole("button", { name: "确认新授权并承接", exact: true })
        .click();
      await browserExpect(page).not.toHaveURL(
        new RegExp(encodeURIComponent(id)),
      );
      expect(requests.length).toBe(before);
      expect(
        (
          await db.query(
            "SELECT task->'budgetLedger' AS budget FROM assistant_session WHERE id=$1",
            [raw],
          )
        ).rows[0].budget.totals.requests,
      ).toBe(5);
    } finally {
      await context.close();
      await browser.close();
    }
  });
  it("R08 reads only associated legacy processing results and fences deleted history", async () => {
    const id = await fresh(),
      p = await processing(id);
    await completeRun(p.runId);
    const raw = "r08_results_" + randomUUID(),
      legacy = "legacy:" + raw;
    await db.query(
      "INSERT INTO assistant_session(id,project_id,actor_id,title) VALUES($1,$2,$3,'旧成果')",
      [raw, projectId, scope().actorId],
    );
    await db.query(
      "UPDATE processing_task SET assistant_session_id=$1 WHERE id=(SELECT task_id FROM processing_run WHERE id=$2)",
      [raw, p.runId],
    );
    const before = requests.length,
      view = (await api("GET", route(legacy))).json();
    expect(
      view.results.some(
        (r: any) => r.run_id === p.runId && r.output_count === 3,
      ),
    ).toBe(true);
    const result = await api("GET", route(legacy) + "/results/" + p.runId);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().records).toHaveLength(3);
    expect(
      (await api("GET", route(legacy) + "/results/not-associated")).statusCode,
    ).toBe(404);
    expect(
      (
        await api("DELETE", route(legacy), {
          expectedRevision: view.session.revision,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await api("GET", route(legacy) + "/results/" + p.runId)).statusCode,
    ).toBe(404);
    expect(requests.length).toBe(before);
  });
  it("R08 erases a saved conversation without deleting its adopted draft or resetting accounting", async () => {
    const { id, p, card } = await adoptionCard();
    const confirmed = await api(
      "POST",
      route(id) + "/confirmations/" + card.id,
      { accept: true },
    );
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const receipt = confirmed.json().receipt;
    expect(receipt.adopted).toBe(3);
    const draftUrl =
      "/api/projects/" + projectId + "/collaborative-drafts/" + receipt.draftId;
    const beforeDraft = await api("GET", draftUrl);
    expect(beforeDraft.statusCode, beforeDraft.body).toBe(200);
    const ledgerSql =
      "SELECT requests,request_limit,worker_requests,worker_ms,active_ms,active_limit_ms,activity_id FROM assistant_runtime_execution WHERE session_id=$1";
    const ledger = (await db.query(ledgerSql, [id])).rows;
    const grants = (
      await db.query(
        "SELECT * FROM assistant_runtime_grant WHERE session_id=$1 ORDER BY id",
        [id],
      )
    ).rows;
    const view = (await api("GET", route(id))).json();
    expect(
      (
        await api("DELETE", route(id), {
          expectedRevision: view.session.revision,
        })
      ).statusCode,
    ).toBe(200);
    const afterDraft = (await api("GET", draftUrl)).json();
    const stable = (value: any) => ({
      ...value,
      records: value.records.map(
        ({ sourcePresentation: _presentation, ...record }: any) => record,
      ),
    });
    expect(stable(afterDraft)).toEqual(stable(beforeDraft.json()));
    expect(afterDraft.records).toHaveLength(3);
    expect(
      afterDraft.records.every((r: any) =>
        r.sourcePresentation.steps.every(
          (step: any) => step.kind !== "processing",
        ),
      ),
    ).toBe(true);
    expect((await db.query(ledgerSql, [id])).rows).toEqual(ledger);
    expect(
      (
        await db.query(
          "SELECT * FROM assistant_runtime_grant WHERE session_id=$1 ORDER BY id",
          [id],
        )
      ).rows,
    ).toEqual(grants);
    expect(
      (
        await db.query(
          "SELECT receipt FROM assistant_runtime_operation WHERE id=$1",
          [p.operation.id],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await api("POST", route(id) + "/confirmations/" + card.id, {
          accept: true,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await api("GET", route(id) + "/results/" + p.runId)).statusCode,
    ).toBe(404);
  });
  it("R08 PAGE discards real document and result responses delivered after erasure", async () => {
    const id = await fresh(),
      address = await webAddress();
    const doc = (
      await api("POST", route(id) + "/attachments", {
        fileName: "迟到资料.md",
        contentBase64: Buffer.from("R08_DELAYED_DOC_SECRET").toString("base64"),
      })
    ).json();
    const p = await processing(id);
    await completeRun(p.runId);
    const browser = await chromium.launch({ headless: true }),
      context = await browser.newContext({
        extraHTTPHeaders: { origin },
        viewport: { width: 1920, height: 1080 },
      });
    const cookie = identities.get("admin")!.cookie!.split("=");
    await context.addCookies([
      { name: cookie[0]!, value: cookie.slice(1).join("="), url: address },
    ]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = 0,
      delivered = 0;
    try {
      const page = await context.newPage();
      const hold = async (r: import("@playwright/test").Route) => {
        const response = await r.fetch();
        expect(response.status()).toBe(200);
        held++;
        await gate;
        await r.fulfill({ response });
        delivered++;
      };
      await page.route(
        "**/assistant-runtime/sessions/" + id + "/attachments/" + doc.id + "?*",
        hold,
      );
      await page.route(
        "**/assistant-runtime/sessions/" + id + "/results/" + p.runId + "?*",
        hold,
      );
      await page.goto(address + "/projects/" + projectId + "/assistant/" + id);
      await page
        .getByRole("button", { name: "切换工作区", exact: true })
        .click();
      await page
        .getByRole("button", { name: "迟到资料.md", exact: true })
        .first()
        .click();
      await page
        .getByRole("button", { name: "查看处理结果", exact: true })
        .first()
        .click();
      await expect.poll(() => held).toBe(2);
      expect(
        (await api("DELETE", route(id) + "/attachments/" + doc.id)).statusCode,
      ).toBe(200);
      await browserExpect(
        page.getByText("相关内容已清理", { exact: false }),
      ).toBeVisible();
      release();
      await expect.poll(() => delivered).toBe(2);
      await browserExpect(
        page.getByText("R08_DELAYED_DOC_SECRET", { exact: false }),
      ).toHaveCount(0);
      await browserExpect(
        page.getByRole("tab", { name: "迟到资料.md", exact: false }),
      ).toHaveCount(0);
      await browserExpect(
        page.getByRole("tab", { name: /处理结果/ }),
      ).toHaveCount(0);
    } finally {
      release();
      await context.close();
      await browser.close();
    }
  });
  it("R08 PAGE clears already loaded legacy text and document tabs when write access is revoked", async () => {
    const raw = "r08_revoked_" + randomUUID(),
      id = "legacy:" + raw,
      doc = "r08_background_" + randomUUID(),
      actor = scope("editor").actorId,
      address = await webAddress();
    await db.query(
      "INSERT INTO assistant_session(id,project_id,actor_id,title) VALUES($1,$2,$3,'历史清理')",
      [raw, projectId, actor],
    );
    await db.query(
      "INSERT INTO assistant_turn(id,session_id,operation_key,request_hash,user_text,assistant_text,status,expires_at) VALUES($1,$2,$1,$1,'R08_LEGACY_MESSAGE_SECRET','历史回复','succeeded',now()+interval '1 hour')",
      [randomUUID(), raw],
    );
    await db.query(
      "INSERT INTO assistant_background_document(id,session_id,project_id,actor_id,file_name,format,sha256,file_size,extractor_version,units,characters,fragments) VALUES($1,$2,$3,$4,'历史背景.md','md',$1,30,'fixture',1,30,$5)",
      [
        doc,
        raw,
        projectId,
        actor,
        JSON.stringify([{ text: "R08_LEGACY_DOC_SECRET" }]),
      ],
    );
    const browser = await chromium.launch({ headless: true }),
      context = await browser.newContext({
        extraHTTPHeaders: { origin },
        viewport: { width: 1440, height: 900 },
      }),
      before = requests.length;
    const cookie = identities.get("editor")!.cookie!.split("=");
    await context.addCookies([
      { name: cookie[0]!, value: cookie.slice(1).join("="), url: address },
    ]);
    try {
      const page = await context.newPage();
      await page.goto(
        address +
          "/projects/" +
          projectId +
          "/assistant/" +
          encodeURIComponent(id),
      );
      await browserExpect(
        page.getByText("R08_LEGACY_MESSAGE_SECRET", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "历史背景.md", exact: true })
        .first()
        .click();
      await browserExpect(
        page.getByText("R08_LEGACY_DOC_SECRET", { exact: true }),
      ).toBeVisible();
      await db.query(
        "UPDATE project_member SET role='viewer' WHERE project_id=$1 AND user_id=$2",
        [projectId, actor],
      );
      await browserExpect(
        page.getByText("相关内容已清理", { exact: false }),
      ).toBeVisible();
      await browserExpect(
        page.getByText("R08_LEGACY_MESSAGE_SECRET", { exact: true }),
      ).toHaveCount(0);
      await browserExpect(
        page.getByText("R08_LEGACY_DOC_SECRET", { exact: true }),
      ).toHaveCount(0);
      expect(requests.length).toBe(before);
    } finally {
      await db.query(
        "UPDATE project_member SET role='editor' WHERE project_id=$1 AND user_id=$2",
        [projectId, actor],
      );
      await context.close();
      await browser.close();
    }
  });
  it("RESULT WORKSPACE real saved draft preview, local retry and paged result API", async () => {
    const { id, p, card } = await adoptionCard();
    const approved = await api(
      "POST",
      route(id) + "/confirmations/" + card.id,
      { accept: true },
    );
    expect(approved.statusCode, approved.body).toBe(200);
    const receipt = approved.json().receipt;
    const draftId = receipt.draftId;
    const before = (await host.present(scope(), id)).receipts.find(
      (r: any) => r.acceptanceId,
    );
    expect(before.draftName).toBe(card.payload.input.target.name);
    await db.query(
      "UPDATE collaborative_draft SET name='预览新名称' WHERE id=$1",
      [draftId],
    );
    const view = await host.present(scope(), id);
    expect(view.receipts.find((r: any) => r.acceptanceId)).toMatchObject({
      draftName: "预览新名称",
      savedDraftName: card.payload.input.target.name,
      draftRecordCount: 3,
    });
    const page2 = await api(
      "GET",
      route(id) + "/results/" + p.runId + "?limit=1&offset=2",
    );
    expect(page2.statusCode, page2.body).toBe(200);
    expect(page2.json().records).toHaveLength(1);
    expect(page2.json().total).toBe(3);
    expect(
      (await api("GET", route(id) + "/results/" + p.runId + "?offset=-1"))
        .statusCode,
    ).toBe(422);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      extraHTTPHeaders: { origin },
      viewport: { width: 1000, height: 900 },
    });
    const cookie = identities.get("admin")!.cookie!.split("=");
    await context.addCookies([
      {
        name: cookie[0]!,
        value: cookie.slice(1).join("="),
        url: await webAddress(),
      },
    ]);
    try {
      const page = await context.newPage();
      let fail = true;
      await page.route(
        "**/collaborative-drafts/" + draftId + "?*",
        async (r) => {
          if (fail) {
            fail = false;
            await r.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({ error: "unavailable" }),
            });
          } else await r.continue();
        },
      );
      await page.goto(
        (await webAddress()) + "/projects/" + projectId + "/assistant/" + id,
      );
      await page.getByRole("button", { name: "查看草稿", exact: true }).click();
      await browserExpect(
        page.getByRole("button", { name: "重试读取", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "重试读取", exact: true }).click();
      await browserExpect(
        page.getByRole("heading", { name: "预览新名称", exact: true }),
      ).toBeVisible();
      await browserExpect(page.getByRole("table")).toBeVisible();
      await browserExpect(
        page.getByText("第 1–3 条 / 共 3 条", { exact: true }),
      ).toBeVisible();
      await browserExpect(
        page.getByRole("link", { name: "打开完整草稿", exact: true }),
      ).toHaveAttribute(
        "href",
        `/projects/${projectId}/test-sets/drafts/${draftId}`,
      );
      await page
        .getByRole("button", { name: "收起工作区", exact: true })
        .click();
      await page.getByRole("button", { name: "查看草稿", exact: true }).click();
      await browserExpect(
        page.getByRole("tab", { name: "预览新名称", exact: true }),
      ).toHaveCount(1);
    } finally {
      await context.close();
      await browser.close();
    }
    await db.query(
      "UPDATE collaborative_draft SET status='discarded' WHERE id=$1",
      [draftId],
    );
    expect(
      (await host.present(scope(), id)).receipts.find(
        (r: any) => r.acceptanceId,
      ),
    ).toMatchObject({ draftName: null, draftStatus: "unavailable" });
  }, 60000);
  it("R09 PUBLIC SDK invitation confirmation shared service and unique receipt", async () => {
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 500; i++) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error("R09_wait_timeout");
    };
    const email = "r09-" + randomUUID() + "@example.test";
    expect(
      (
        await api("POST", "/api/accounts", {
          email,
          password: "SyntheticR09Pass123",
          confirmPassword: "SyntheticR09Pass123",
        })
      ).statusCode,
    ).toBe(201);
    const id = await fresh();
    const activity = "r09-zero-" + randomUUID();
    await host.execution.ensure(db, scope(), id);
    await db.query(
      "INSERT INTO assistant_runtime_activity(id,request_limit,row_limit,generated_limit,max_ms) VALUES($1,16,0,0,1500000)",
      [activity],
    );
    await db.query(
      "UPDATE assistant_runtime_execution SET activity_id=$2 WHERE session_id=$1",
      [id, activity],
    );
    outputs = [
      call("request_project_invitation", { email, role: "viewer" }),
      { role: "assistant", content: "邀请已完成。" },
    ];
    await isolateDispatcher(id);
    const dispatcher = await buildApp(config, {
      disableLegacyTestBootstrap: true,
    });
    try {
      await dispatcher.ready();
      expect(
        (
          await submit(
            id,
            "邀请这个测试账号加入当前项目，只给查看权限：" + email,
          )
        ).statusCode,
      ).toBe(202);
      await until(async () =>
        (await host.present(scope(), id)).confirmations.some(
          (c: any) => c.action === "management" && c.status === "pending",
        ),
      );
      expect(
        (
          await db.query("SELECT id FROM project_invitation WHERE email=$1", [
            email,
          ])
        ).rowCount,
      ).toBe(0);
      const card = (await host.present(scope(), id)).confirmations.find(
        (c: any) => c.action === "management" && c.status === "pending",
      )!;
      expect(card.payload.summary.newRole).toBe("viewer");
      expect(card.payload.summary.email).toBe(email);
      const url = route(id) + "/confirmations/" + card.id;
      expect(
        (await api("POST", url, { accept: true }, "viewer")).statusCode,
      ).toBeGreaterThanOrEqual(400);
      const confirmed = await api("POST", url, { accept: true });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      const replay = await api("POST", url, { accept: true });
      expect(replay.statusCode, replay.body).toBe(200);
      await until(
        async () =>
          (await host.present(scope(), id)).execution?.status === "completed",
      );
      expect(
        (
          await db.query("SELECT role FROM project_invitation WHERE email=$1", [
            email,
          ])
        ).rows,
      ).toEqual([{ role: "viewer" }]);
      const op = (
        await db.query(
          "SELECT receipt FROM assistant_runtime_operation WHERE session_id=$1 AND kind='management'",
          [id],
        )
      ).rows;
      expect(op).toHaveLength(1);
      expect(op[0].receipt.invitation.email).toBe(email);
      const wire = JSON.stringify(requests);
      expect(wire).not.toContain("SyntheticR09Pass123");
    } finally {
      await dispatcher.close();
    }
  });

  it("R09 SDK rejects native approval fields and profile cannot change another identity", async () => {
    const id = await fresh();
    await run(id, "把我的显示名称改为R09本人", [
      call("update_my_profile", {
        displayName: "R09本人",
        actorId: actors.get("viewer"),
      }),
      call("update_my_profile", { displayName: "R09本人" }),
      { role: "assistant", content: "已修改。" },
    ]);
    expect(
      (
        await db.query("SELECT display_name FROM app_user WHERE id=$1", [
          actors.get("admin"),
        ])
      ).rows[0].display_name,
    ).toBe("R09本人");
    expect(
      (
        await db.query("SELECT display_name FROM app_user WHERE id=$1", [
          actors.get("viewer"),
        ])
      ).rows[0].display_name,
    ).toBe("viewer");
    const errors = (
      await db.query(
        "SELECT kind FROM assistant_runtime_event WHERE session_id=$1 AND kind='parameter_feedback'",
        [id],
      )
    ).rows;
    expect(errors.length).toBeGreaterThan(0);
  });

  it("R09 PUBLIC SDK recycle restore replays one receipt and denies viewer", async () => {
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 500; i++) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      console.log(
        "R09_RECYCLE_DIAGNOSTIC",
        JSON.stringify(
          (
            await db.query(
              "SELECT kind,detail FROM assistant_runtime_event WHERE kind IN('tool_error','parameter_feedback','requirements_feedback','execution_paused') ORDER BY id DESC LIMIT 4",
            )
          ).rows,
        ),
      );
      throw Error("R09_recycle_timeout");
    };
    const set = "set_" + randomUUID();
    await db.query(
      "INSERT INTO test_set(id,project_id,name,purpose,owner_id) VALUES($1,$2,'R09回收验收','合成对象',$3)",
      [set, projectId, actors.get("admin")],
    );
    const id = await fresh(),
      dispatcher = await buildApp(config, { disableLegacyTestBootstrap: true });
    try {
      await dispatcher.ready();
      outputs = [
        call("request_trash_test_set", { testSetId: set }),
        { role: "assistant", content: "已移入回收站。" },
      ];
      expect((await submit(id, "把R09回收验收移入回收站")).statusCode).toBe(
        202,
      );
      await until(async () =>
        (await host.present(scope(), id)).confirmations.some(
          (c: any) => c.status === "pending" && c.action === "management",
        ),
      );
      let card = (await host.present(scope(), id)).confirmations.find(
        (c: any) => c.status === "pending" && c.action === "management",
      )!;
      expect(
        (await db.query("SELECT status FROM test_set WHERE id=$1", [set]))
          .rows[0].status,
      ).toBe("available");
      expect(
        (
          await api("POST", route(id) + "/confirmations/" + card.id, {
            accept: true,
          })
        ).statusCode,
      ).toBe(200);
      await until(
        async () =>
          (await host.present(scope(), id)).execution?.status === "completed",
      );
      const entry = (
        await db.query(
          "SELECT id FROM test_set_trash_entry WHERE test_set_id=$1 AND status='trashed'",
          [set],
        )
      ).rows[0];
      expect(
        (
          await api(
            "GET",
            "/api/projects/" + projectId + "/solo-test-set-trash",
            undefined,
            "viewer",
          )
        ).statusCode,
      ).toBe(404);
      outputs = [
        call("request_restore_test_set", { entryId: entry.id }),
        { role: "assistant", content: "已恢复。" },
      ];
      expect((await submit(id, "恢复刚才那个测试集")).statusCode).toBe(202);
      await until(async () =>
        (await host.present(scope(), id)).confirmations.some(
          (c: any) => c.status === "pending" && c.action === "management",
        ),
      );
      card = (await host.present(scope(), id)).confirmations.find(
        (c: any) => c.status === "pending" && c.action === "management",
      )!;
      const url = route(id) + "/confirmations/" + card.id;
      expect((await api("POST", url, { accept: true })).statusCode).toBe(200);
      expect((await api("POST", url, { accept: true })).statusCode).toBe(200);
      await until(
        async () =>
          (await host.present(scope(), id)).execution?.status === "completed",
      );
      expect(
        (await db.query("SELECT status FROM test_set WHERE id=$1", [set]))
          .rows[0].status,
      ).toBe("available");
      expect(
        (
          await db.query(
            "SELECT id FROM assistant_runtime_operation WHERE session_id=$1 AND kind='management' AND receipt IS NOT NULL",
            [id],
          )
        ).rows,
      ).toHaveLength(2);
    } finally {
      await dispatcher.close();
    }
  });

  it("R09 SDK role confirmation rejects changed target and does not auto-upgrade revision", async () => {
    const id = await fresh(),
      userId = actors.get("editor");
    const state = await run(id, "把编辑成员改为查看", [
      call("request_member_role", { userId, role: "viewer" }),
    ]);
    const card = state.confirmations.find(
      (c: any) => c.action === "management" && c.status === "pending",
    )!;
    expect(card).toBeTruthy();
    await db.query(
      "UPDATE project_member SET role='viewer' WHERE project_id=$1 AND user_id=$2",
      [projectId, userId],
    );
    try {
      const result = await api(
        "POST",
        route(id) + "/confirmations/" + card.id,
        { accept: true },
      );
      expect(result.statusCode).toBe(409);
      expect(result.json().error.code).toBe("management_target_changed");
      expect(
        (
          await db.query(
            "SELECT receipt FROM assistant_runtime_operation WHERE id=$1",
            [
              (
                await db.query(
                  "SELECT operation_id FROM assistant_runtime_confirmation WHERE id=$1",
                  [card.id],
                )
              ).rows[0].operation_id,
            ],
          )
        ).rows[0].receipt,
      ).toBeNull();
    } finally {
      await db.query(
        "UPDATE project_member SET role='editor' WHERE project_id=$1 AND user_id=$2",
        [projectId, userId],
      );
    }
  });

  it("R09 SDK saved model test counts one HTTP and refuses stale revision without a request", async () => {
    const revision = (await api("GET", "/api/settings/model-connection")).json()
      .connection.revision;
    const id = await fresh();
    const state = await run(id, "测试当前已保存的模型连接", [
      call("test_saved_model_connection", { revision }),
      { role: "assistant", content: "连接测试已完成。" },
    ]);
    const ledger = (
      await db.query(
        "SELECT purpose,status FROM assistant_runtime_request WHERE session_id=$1 ORDER BY started_at",
        [id],
      )
    ).rows;
    expect(ledger.filter((r) => r.purpose === "connection_test")).toEqual([
      { purpose: "connection_test", status: 200 },
    ]);
    expect(state.execution?.status).toBe("completed");
    const testId = await fresh();
    await expect(
      run(testId, "只测试已保存的旧修订", [
        call("test_saved_model_connection", { revision: revision + 100 }),
        { role: "assistant", content: "修订已变化，请核对。" },
      ]),
    ).rejects.toThrow("model_connection_conflict");
    expect(
      (
        await db.query(
          "SELECT id FROM assistant_runtime_request WHERE session_id=$1 AND purpose='connection_test'",
          [testId],
        )
      ).rows,
    ).toHaveLength(0);
  });

  it("R09 SDK native model configuration never accepts key or approval through tool arguments", async () => {
    const id = await fresh();
    const state = await run(id, "准备一个模型配置，由我在表单输入密钥", [
      call("open_model_settings", {
        name: "合成模型",
        endpoint: "http://127.0.0.1:18099/v1",
        model: "controlled-model",
        enabled: false,
      }),
      { role: "assistant", content: "请在原生表单输入密钥并确认。" },
    ]);
    const action = state.workspace.nativeActions.find(
      (a: any) => a.kind === "model_settings",
    );
    expect(action?.configuration?.model).toBe("controlled-model");
    const declared = requests
      .at(-1)
      ?.tools?.find((t: any) => t.function.name === "open_model_settings");
    expect(Object.keys(declared.function.parameters.properties)).not.toContain(
      "apiKey",
    );
    expect(Object.keys(declared.function.parameters.properties)).not.toContain(
      "approve",
    );
    expect(
      (
        await db.query(
          "SELECT id FROM assistant_runtime_operation WHERE session_id=$1",
          [id],
        )
      ).rows,
    ).toHaveLength(0);
  });
  it("R09 PAGE native model secret fixed confirmation and conflict retain input", async () => {
    const saved = (await api("GET", "/api/settings/model-connection")).json()
      .connection;
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      extraHTTPHeaders: { origin },
      viewport: { width: 1280, height: 900 },
    });
    const cookie = identities.get("admin")!.cookie!.split("=");
    await context.addCookies([
      {
        name: cookie[0]!,
        value: cookie.slice(1).join("="),
        url: await webAddress(),
      },
    ]);
    const secret = "NativeSyntheticR09Credential";
    try {
      const page = await context.newPage();
      await page.goto(
        (await webAddress()) +
          "/settings?project=" +
          projectId +
          "&section=models",
      );
      await page.getByLabel("连接名称", { exact: true }).fill("R09原生配置");
      const key = page.locator("#model-connection-key");
      await key.fill(secret);
      await browserExpect(key).toHaveAttribute("type", "password");
      await page.getByRole("button", { name: "保存连接", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await browserExpect(
        dialog.getByRole("heading", { name: "确认保存模型连接" }),
      ).toBeVisible();
      expect(await dialog.innerText()).not.toContain(secret);
      expect(
        (await api("GET", "/api/settings/model-connection")).json().connection
          .revision,
      ).toBe(saved.revision);
      await dialog
        .getByRole("button", { name: "确认保存", exact: true })
        .click();
      await browserExpect(
        page.getByText("模型连接已保存。", { exact: true }),
      ).toBeVisible();
      await browserExpect(key).toHaveValue("");
      const next = (await api("GET", "/api/settings/model-connection")).json()
        .connection;
      expect(next.name).toBe("R09原生配置");
      expect(next.revision).toBe(saved.revision + 1);
      await page.getByLabel("连接名称", { exact: true }).fill("R09冲突保留");
      await api("PUT", "/api/settings/model-connection", {
        revision: next.revision,
        name: "并发修改",
        endpoint: next.endpoint,
        model: next.model,
        enabled: next.enabled,
      });
      await page.getByRole("button", { name: "保存连接", exact: true }).click();
      await dialog
        .getByRole("button", { name: "确认保存", exact: true })
        .click();
      await browserExpect(
        page.getByText(
          "连接已被更新。你的输入仍在，请重新载入当前配置后再保存。",
        ),
      ).toBeVisible();
      await browserExpect(
        page.getByLabel("连接名称", { exact: true }),
      ).toHaveValue("R09冲突保留");
      const viewer = await browser.newContext({ extraHTTPHeaders: { origin } }),
        vCookie = identities.get("viewer")!.cookie!.split("=");
      await viewer.addCookies([
        {
          name: vCookie[0]!,
          value: vCookie.slice(1).join("="),
          url: await webAddress(),
        },
      ]);
      const vp = await viewer.newPage();
      await vp.goto(
        (await webAddress()) +
          "/settings?project=" +
          projectId +
          "&section=models",
      );
      await browserExpect(vp.locator("#model-connection-key")).toHaveCount(0);
      expect(JSON.stringify(requests)).not.toContain(secret);
      await viewer.close();
    } finally {
      await context.close();
      await browser.close();
      const latest = (await api("GET", "/api/settings/model-connection")).json()
        .connection;
      await api("PUT", "/api/settings/model-connection", {
        revision: latest.revision,
        name: saved.name,
        endpoint: saved.endpoint,
        model: saved.model,
        enabled: saved.enabled,
        apiKey: "controlled-key",
      });
    }
  }, 60000);

  it("R09 SDK remove member freezes only real fields and commits uniquely", async () => {
    const id = await fresh(),
      userId = actors.get("editor");
    try {
      const state = await run(id, "移除这位项目编辑成员", [
        call("request_remove_member", { userId }),
        { role: "assistant", content: "已移除成员。" },
      ]);
      const card = state.confirmations.find(
        (c: any) => c.status === "pending" && c.action === "management",
      )!;
      expect(card).toBeTruthy();
      expect(card.payload.summary.oldRole).toBe("editor");
      expect(card.payload.summary).not.toHaveProperty("newRole");
      const url = route(id) + "/confirmations/" + card.id;
      expect((await api("POST", url, { accept: true })).statusCode).toBe(200);
      expect((await api("POST", url, { accept: true })).statusCode).toBe(200);
      expect(
        (
          await db.query(
            "SELECT role FROM project_member WHERE project_id=$1 AND user_id=$2",
            [projectId, userId],
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await db.query(
            "SELECT receipt FROM assistant_runtime_operation WHERE session_id=$1 AND kind='management'",
            [id],
          )
        ).rows,
      ).toEqual([{ receipt: { done: true } }]);
      await host.runPending(scope(), id, state.execution.turn_id);
    } finally {
      await db.query(
        "INSERT INTO project_member(project_id,user_id,role) VALUES($1,$2,'editor') ON CONFLICT(project_id,user_id) DO UPDATE SET role='editor'",
        [projectId, userId],
      );
    }
  });

  it("R09 native invitation repeat reflects changed role and removed membership without regrant", async () => {
    const email = "r09-repeat-" + randomUUID() + "@example.test",
      password = "SyntheticR09Repeat123";
    await api("POST", "/api/accounts", {
      email,
      password,
      confirmPassword: password,
    });
    const login = await api("POST", "/api/session", { email, password });
    identities.set("r09target", {
      cookie: login.cookies[0].name + "=" + login.cookies[0].value,
      "x-csrf-token": login.json().csrfToken,
    });
    const invitation = (
      await api("POST", "/api/projects/" + projectId + "/invitations", {
        email,
        role: "viewer",
      })
    ).json().invitation;
    const accept = "/api/me/invitations/" + invitation.id + "/accept";
    expect((await api("POST", accept, {}, "viewer")).statusCode).toBe(404);
    expect((await api("POST", accept, {}, "r09target")).json().role).toBe(
      "viewer",
    );
    const uid = (
      await db.query("SELECT id FROM app_user WHERE email=$1", [email])
    ).rows[0].id;
    await api("PATCH", "/api/projects/" + projectId + "/members/" + uid, {
      role: "editor",
    });
    expect((await api("POST", accept, {}, "r09target")).json().role).toBe(
      "editor",
    );
    await api("DELETE", "/api/projects/" + projectId + "/members/" + uid);
    expect((await api("POST", accept, {}, "r09target")).statusCode).toBe(409);
    expect(
      (
        await db.query(
          "SELECT role FROM project_member WHERE project_id=$1 AND user_id=$2",
          [projectId, uid],
        )
      ).rows,
    ).toHaveLength(0);
  });

  it("R09 SDK invalid endpoint enters bounded correction and preserves prepared fields", async () => {
    const id = await fresh();
    const state = await run(id, "准备合成模型地址，由我输入密钥", [
      call("open_model_settings", {
        name: "地址纠错",
        endpoint: "not-an-url",
        model: "controlled-model",
        enabled: false,
      }),
      call("open_model_settings", {
        name: "地址纠错",
        endpoint: "http://127.0.0.1:18099/v1",
        model: "controlled-model",
        enabled: false,
      }),
      { role: "assistant", content: "请在原生表单核对。" },
    ]);
    expect(
      state.workspace.nativeActions.find(
        (a: any) => a.kind === "model_settings",
      )?.configuration,
    ).toEqual({
      name: "地址纠错",
      endpoint: "http://127.0.0.1:18099/v1",
      model: "controlled-model",
      enabled: false,
    });
    expect(
      (
        await db.query(
          "SELECT detail FROM assistant_runtime_event WHERE session_id=$1 AND kind='parameter_feedback'",
          [id],
        )
      ).rows.length,
    ).toBeGreaterThan(0);
  });

  it("R09 SDK expired and revoked management confirmations fail closed", async () => {
    const id = await fresh(),
      userId = actors.get("editor");
    const state = await run(id, "把编辑成员改为查看", [
      call("request_member_role", { userId, role: "viewer" }),
    ]);
    const card = state.confirmations.find(
      (c: any) => c.action === "management" && c.status === "pending",
    )!;
    await db.query(
      "UPDATE assistant_runtime_confirmation SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [card.id],
    );
    expect(
      (
        await api("POST", route(id) + "/confirmations/" + card.id, {
          accept: true,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await db.query(
          "SELECT role FROM project_member WHERE project_id=$1 AND user_id=$2",
          [projectId, userId],
        )
      ).rows[0].role,
    ).toBe("editor");
    const id2 = await fresh();
    const s2 = await run(id2, "把编辑成员改为查看", [
      call("request_member_role", { userId, role: "viewer" }),
    ]);
    const c2 = s2.confirmations.find(
      (c: any) => c.action === "management" && c.status === "pending",
    )!;
    await db.query("UPDATE app_user SET role='user' WHERE id=$1", [
      actors.get("admin"),
    ]);
    try {
      expect(
        (
          await api("POST", route(id2) + "/confirmations/" + c2.id, {
            accept: true,
          })
        ).statusCode,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (
          await db.query(
            "SELECT role FROM project_member WHERE project_id=$1 AND user_id=$2",
            [projectId, userId],
          )
        ).rows[0].role,
      ).toBe("editor");
    } finally {
      await db.query("UPDATE app_user SET role='admin' WHERE id=$1", [
        actors.get("admin"),
      ]);
    }
  });

  it("R09 native form correction cannot change other valid prepared fields", async () => {
    const id = await fresh();
    await expect(
      run(id, "准备模型连接，我会输入密钥", [
        call("open_model_settings", {
          name: "原名称",
          endpoint: "bad-url",
          model: "controlled-model",
          enabled: false,
        }),
        call("open_model_settings", {
          name: "别的名称",
          endpoint: "http://127.0.0.1:18099/v1",
          model: "controlled-model",
          enabled: false,
        }),
      ]),
    ).rejects.toThrow("correction_intent_changed");
    expect(
      (await host.present(scope(), id)).workspace.nativeActions,
    ).toHaveLength(0);
  });

  it("R09 SDK revokes one fixed invitation and replays the receipt", async () => {
    const email = "r09-revoke-" + randomUUID() + "@example.test";
    await api("POST", "/api/accounts", {
      email,
      password: "SyntheticR09Revoke123",
      confirmPassword: "SyntheticR09Revoke123",
    });
    const invitation = (
      await api("POST", "/api/projects/" + projectId + "/invitations", {
        email,
        role: "viewer",
      })
    ).json().invitation;
    const id = await fresh();
    const s = await run(id, "撤销这位测试账号的邀请", [
      call("request_revoke_invitation", { invitationId: invitation.id }),
      { role: "assistant", content: "已撤销。" },
    ]);
    const c = s.confirmations.find(
      (c: any) => c.status === "pending" && c.action === "management",
    )!;
    expect(c.payload.summary.email).toBe(email);
    const url = route(id) + "/confirmations/" + c.id;
    expect((await api("POST", url, { accept: true })).statusCode).toBe(200);
    expect((await api("POST", url, { accept: true })).statusCode).toBe(200);
    expect(
      (
        await db.query("SELECT status FROM project_invitation WHERE id=$1", [
          invitation.id,
        ])
      ).rows[0].status,
    ).toBe("revoked");
    await host.runPending(scope(), id, s.execution.turn_id);
  });

  it("R09 branch impact excludes unrelated draft changes and restore identifies exact branch", async () => {
    const { createSharedDraft } = await import("../../src/drafts/create.js"),
      { draftOperations } = await import("../../src/drafts/operations.js"),
      { recycleOperations } = await import("../../src/management/recycle.js"),
      { managementSnapshot } = await import("../../src/management/snapshot.js");
    const domain = draftOperations(db, new ArtifactRepository(config.minio));
    const create = async (args: any) => {
      const d = (
        await createSharedDraft(db, scope(), args, "r09-branch-" + randomUUID())
      ).draft;
      return d.id;
    };
    const publish = async (draftId: string) =>
      domain.publishDraft(
        { ...scope(), draftId },
        {
          revision: (await domain.read({ ...scope(), draftId })).draft.revision,
        },
      );
    const root = await create({
      name: "R09分支影响" + randomUUID(),
      purpose: "合成版本",
    });
    await domain.addRecord(
      { ...scope(), draftId: root },
      { question: "预约需要什么？", expectedOutput: "说明材料", metadata: [] },
    );
    const v1 = await publish(root),
      leftDraft = await create({
        testSetId: v1.testSet.id,
        parentVersionId: v1.version.id,
      });
    const left = await publish(leftDraft);
    const rightDraft = await create({
      testSetId: v1.testSet.id,
      parentVersionId: v1.version.id,
    });
    const right = await publish(rightDraft);
    const affected = await create({
        testSetId: v1.testSet.id,
        parentVersionId: left.version.id,
      }),
      unrelated = await create({
        testSetId: v1.testSet.id,
        parentVersionId: right.version.id,
      });
    const input = {
      testSetId: v1.testSet.id,
      versionId: left.version.id,
      body: { includeDescendants: false },
    };
    const before = await managementSnapshot(db, scope(), "trashBranch", input);
    expect(before.summary.draftCount).toBe(1);
    expect(before.summary.versionCount).toBe(1);
    await domain.update(
      { ...scope(), draftId: unrelated },
      { field: "purpose", value: "无关分支修改", expectedFieldRevision: 0 },
    );
    expect(
      (await managementSnapshot(db, scope(), "trashBranch", input)).hash,
    ).toBe(before.hash);
    await domain.update(
      { ...scope(), draftId: affected },
      { field: "purpose", value: "相关分支修改", expectedFieldRevision: 0 },
    );
    expect(
      (await managementSnapshot(db, scope(), "trashBranch", input)).hash,
    ).not.toBe(before.hash);
    const recycle = recycleOperations(db),
      a = await recycle.trashBranch(scope(), input),
      b = await recycle.trashBranch(scope(), {
        testSetId: v1.testSet.id,
        versionId: right.version.id,
        body: { includeDescendants: false },
      });
    const sa = await managementSnapshot(db, scope(), "restore", {
        entryId: a.entry.id,
        body: {},
      }),
      sb = await managementSnapshot(db, scope(), "restore", {
        entryId: b.entry.id,
        body: {},
      });
    expect(sa.summary.entryType).toBe("版本分支");
    expect(sa.summary.versionCount).toBe(1);
    expect(sa.summary.rootVersion).toBe(left.version.label);
    expect(sb.summary.rootVersion).toBe(right.version.label);
    expect(sa.summary.rootVersion).not.toBe(sb.summary.rootVersion);
  });

  it("R09 SDK sealed activity cannot confirm a pending management write", async () => {
    const id = await fresh(),
      userId = actors.get("editor");
    const state = await run(id, "把编辑成员改为查看", [
      call("request_member_role", { userId, role: "viewer" }),
    ]);
    const card = state.confirmations.find(
      (c: any) => c.action === "management" && c.status === "pending",
    )!;
    const activity = "r09-sealed-" + randomUUID();
    await db.query(
      "INSERT INTO assistant_runtime_activity(id,request_limit,row_limit,generated_limit,max_ms,closed_at) VALUES($1,16,0,0,1500000,now())",
      [activity],
    );
    await db.query(
      "UPDATE assistant_runtime_execution SET activity_id=$2 WHERE session_id=$1",
      [id, activity],
    );
    const result = await api("POST", route(id) + "/confirmations/" + card.id, {
      accept: true,
    });
    expect(result.statusCode).toBe(409);
    expect(result.json().error.code).toBe("activity_budget_exhausted");
    expect(
      (
        await db.query(
          "SELECT role FROM project_member WHERE project_id=$1 AND user_id=$2",
          [projectId, userId],
        )
      ).rows[0].role,
    ).toBe("editor");
  });
  it("R10 public server retires legacy execution endpoints without creating old sessions", async () => {
    const before = Number(
      (await db.query("SELECT count(*) FROM assistant_session")).rows[0].count,
    );
    const response = await api(
      "POST",
      "/api/projects/" + projectId + "/assistant/sessions",
      {},
    );
    expect(response.statusCode, response.body).toBe(410);
    expect(response.json().error.code).toBe("assistant_runtime_retired");
    expect(
      Number(
        (await db.query("SELECT count(*) FROM assistant_session")).rows[0]
          .count,
      ),
    ).toBe(before);
  });
  it("R10 cutover fences confirmation and stale token, preserves budgets and read-only legacy history, and never resumes on enable", async () => {
    const id = await fresh();
    const state = await run(id, "把编辑成员改成查看，等我确认", [
      call("request_member_role", {
        userId: actors.get("editor"),
        role: "viewer",
      }),
    ]);
    const card = state.confirmations.find((x: any) => x.status === "pending");
    expect(card).toBeTruthy();
    const oldId = "conversation_" + randomUUID(),
      oldTurn = "old_" + randomUUID();
    const budget = { requests: 7, used: 3, closed: true };
    await db.query(
      "INSERT INTO assistant_session(id,project_id,actor_id,task,title) VALUES($1,$2,$3,$4,'切换旧历史')",
      [
        oldId,
        projectId,
        actors.get("admin"),
        JSON.stringify({ executionBudget: budget }),
      ],
    );
    await db.query(
      "INSERT INTO assistant_turn(id,session_id,operation_key,request_hash,user_text,status,expires_at,execution_token) VALUES($1,$2,$1,$1,'合成旧历史','running',now()+interval '1 hour','old-token')",
      [oldTurn, oldId],
    );
    const before = (
      await db.query(
        "SELECT requests,request_limit,active_ms,active_limit_ms FROM assistant_runtime_execution WHERE session_id=$1",
        [id],
      )
    ).rows[0];
    try {
      const switched = await changeAssistantMode(db, "manual");
      expect(switched.pausedSessions).toContain(id);
      expect((await api("POST", route(), {})).statusCode).toBe(409);
      const confirmation = await api(
        "POST",
        route(id) + "/confirmations/" + card.id,
        { accept: true },
      );
      expect(confirmation.statusCode).toBe(409);
      expect(
        (await api("POST", route(id) + "/control", { action: "continue" }))
          .statusCode,
      ).toBe(409);
      expect((await api("GET", route(id))).statusCode).toBe(200);
      expect((await api("GET", route("legacy:" + oldId))).statusCode).toBe(200);
      expect(
        (
          await db.query(
            "SELECT execution_token,status FROM assistant_turn WHERE id=$1",
            [oldTurn],
          )
        ).rows[0],
      ).toEqual({ execution_token: null, status: "interrupted" });
      expect(
        (
          await db.query("SELECT task FROM assistant_session WHERE id=$1", [
            oldId,
          ])
        ).rows[0].task.executionBudget,
      ).toEqual(budget);
      expect(
        (
          await db.query(
            "SELECT role FROM project_member WHERE project_id=$1 AND user_id=$2",
            [projectId, actors.get("editor")],
          )
        ).rows[0].role,
      ).toBe("editor");
      expect(
        (
          await db.query(
            "SELECT requests,request_limit,active_ms,active_limit_ms FROM assistant_runtime_execution WHERE session_id=$1",
            [id],
          )
        ).rows[0],
      ).toEqual(before);
      await changeAssistantMode(db, "rebuild");
      expect(
        (await host.execution.pending()).some((x) => x.session_id === id),
      ).toBe(false);
      expect((await host.present(scope(), id)).execution.status).toBe("paused");
      expect(
        (
          await api("POST", route(id) + "/confirmations/" + card.id, {
            accept: true,
          })
        ).statusCode,
      ).toBe(409);
      expect((await api("POST", route(), {})).statusCode).toBe(200);
    } finally {
      await changeAssistantMode(db, "rebuild");
    }
  });
  it("R10 manual fallback keeps public manual draft writes and immutable receipts available", async () => {
    const id = await fresh();
    await run(id, "建立合成草稿", [
      call("create_draft", { name: "切换保留草稿" }),
    ]);
    const op = (
      await db.query(
        "SELECT receipt FROM assistant_runtime_operation WHERE session_id=$1 AND receipt IS NOT NULL",
        [id],
      )
    ).rows[0];
    expect(op).toBeTruthy();
    try {
      await changeAssistantMode(db, "manual");
      const result = await api(
        "POST",
        "/api/projects/" + projectId + "/collaborative-drafts",
        { name: "人工回退草稿" },
      );
      expect(result.statusCode, result.body).toBe(201);
      const visible = await api("GET", route(id));
      expect(visible.statusCode).toBe(200);
      expect(
        (
          await db.query(
            "SELECT receipt FROM assistant_runtime_operation WHERE session_id=$1 AND receipt IS NOT NULL",
            [id],
          )
        ).rows[0],
      ).toEqual(op);
      expect(
        (
          await api(
            "GET",
            "/api/projects/" +
              projectId +
              "/collaborative-drafts/" +
              result.json().draft.id,
          )
        ).statusCode,
      ).toBe(200);
    } finally {
      await changeAssistantMode(db, "rebuild");
    }
  });
  it("R10 real SDK in-flight response is settled before disabling, late write is fenced and enable does not replay", async () => {
    const id = await fresh();
    const before = await effects();
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    outputs = [call("create_draft", { name: "不得迟到的新草稿" })];
    const accepted = await submit(id, "建立一份草稿");
    const work = host.runPending(scope(), id, accepted.json().turnId, {
      hooks: {
        afterResponse: async () => {
          entered();
          await gate;
        },
      },
    });
    try {
      await reached;
      expect(
        (
          await db.query(
            "SELECT status,ended_at FROM assistant_runtime_request WHERE session_id=$1",
            [id],
          )
        ).rows[0].status,
      ).toBe(200);
      await changeAssistantMode(db, "manual");
      release();
      await work;
      expect(await effects()).toEqual(before);
      expect((await host.present(scope(), id)).execution.status).toBe("paused");
      await changeAssistantMode(db, "rebuild");
      expect(
        (await host.execution.pending()).some((x) => x.session_id === id),
      ).toBe(false);
      expect(
        (
          await db.query(
            "SELECT requests FROM assistant_runtime_execution WHERE session_id=$1",
            [id],
          )
        ).rows[0].requests,
      ).toBe(1);
      expect(
        (
          await db.query(
            "SELECT count(*) FROM assistant_runtime_operation WHERE session_id=$1",
            [id],
          )
        ).rows[0].count,
      ).toBe("0");
    } finally {
      release();
      await work.catch(() => undefined);
      await changeAssistantMode(db, "rebuild");
    }
  });
  it("R10 PUBLIC SDK summary then amendment uses current source and target through automatic dispatch and unique save", async () => {
    const id = await fresh();
    const fixed = await host.store.freezeSource(scope(), {
      kind: "assets",
      assetIds: [assetId],
    });
    const source = {
      ...fixed.source,
      recordIds: fixed.source.recordIds.slice(0, 2),
    };
    await run(id, "先给前两条的清洗方案，不执行", [
      call("create_requirements", {
        expectedRevision: 0,
        changes: {
          objective: "只整理前两条首尾空白，保留其他字段",
          mode: "plan",
          deliveries: [
            {
              name: "旧名称",
              operation: "clean",
              source,
              count: 2,
              allowedFields: ["question"],
              instructions: "",
              saveTarget: { kind: "newDraft", name: "旧名称" },
            },
          ],
        },
      }),
    ]);
    const delivery = (await host.store.get(scope(), id)).requirements
      .deliveries[0];
    for (let n = 0; n < 8; n++) {
      const turn = "synthetic_history_" + randomUUID();
      await db.query(
        "INSERT INTO assistant_runtime_turn(id,session_id,submission_id,request_hash,payload,accepted_revision,status) VALUES($1,$2,$1,$1,'{}',1,'succeeded')",
        [turn, id],
      );
      await db.query(
        "INSERT INTO assistant_runtime_message(session_id,turn_id,role,content) VALUES($1,$2,$3,$4)",
        [
          id,
          turn,
          n % 2 ? "assistant" : "user",
          "【合成长历史，仅用于摘要，不是执行授权】".repeat(140),
        ],
      );
    }
    const until = async (check: () => Promise<boolean>) => {
      for (let n = 0; n < 800; n++) {
        try {
          if (await check()) return;
        } catch (e) {
          if ((e as any).code !== "snapshot_revision_conflict") throw e;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error("R10_public_timeout");
    };
    await isolateDispatcher(id);
    const dispatcher = await buildApp(config, {
      disableLegacyTestBootstrap: true,
      assistantRuntimeSummaryTokens: 1000,
    });
    outputs = [
      call("update_requirements", {
        expectedRevision: 1,
        changes: {
          mode: "execute",
          deliveries: [
            {
              deliveryId: delivery.id,
              patch: {
                name: "摘要后整理版",
                saveTarget: { kind: "newDraft", name: "摘要后整理版" },
              },
            },
          ],
        },
      }),
      call("submit_processing", {}),
      call("wait_processing", {}),
    ];
    try {
      await dispatcher.ready();
      expect(
        (await submit(id, "改名为摘要后整理版，现在执行。")).statusCode,
      ).toBe(202);
      await until(
        async () =>
          (await host.present(scope(), id)).execution.status === "waiting",
      );
      const waiting = await host.present(scope(), id);
      expect(
        waiting.session.requirements.deliveries[0].source?.recordIds,
      ).toEqual(source.recordIds);
      outputs = [call("prepare_adoption", {}), call("wait_confirmation", {})];
      await completeRun(waiting.results[0].run_id);
      await until(async () =>
        (await host.present(scope(), id)).confirmations.some(
          (c: any) => c.status === "pending",
        ),
      );
      const card = (await host.present(scope(), id)).confirmations.find(
        (c: any) => c.status === "pending",
      );
      const saved = await api("POST", route(id) + "/confirmations/" + card.id, {
        accept: true,
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().receipt.adopted).toBe(2);
      const replay = await api(
        "POST",
        route(id) + "/confirmations/" + card.id,
        { accept: true },
      );
      expect(replay.json().receipt).toEqual(saved.json().receipt);
      expect(replay.json().replayed).toBe(true);
      const result = await api(
        "GET",
        "/api/projects/" +
          projectId +
          "/collaborative-drafts/" +
          saved.json().receipt.draftId,
      );
      expect(result.json().draft.name).toBe("摘要后整理版");
      const ledger = (
        await db.query(
          "SELECT purpose,status FROM assistant_runtime_request WHERE session_id=$1",
          [id],
        )
      ).rows;
      expect(ledger.some((r) => r.purpose === "summary")).toBe(true);
      expect(ledger.every((r) => r.status === 200)).toBe(true);
      expect(
        (
          await db.query(
            "SELECT requests FROM assistant_runtime_execution WHERE session_id=$1",
            [id],
          )
        ).rows[0].requests,
      ).toBe(ledger.length);
    } finally {
      await dispatcher.close();
    }
  }, 60000);
  it("R10 cutover pauses a publicly accepted turn before its first execution record exists", async () => {
    const id = await fresh();
    expect((await submit(id, "建立一份尚未执行的草稿")).statusCode).toBe(202);
    expect(
      (
        await db.query(
          "SELECT session_id FROM assistant_runtime_execution WHERE session_id=$1",
          [id],
        )
      ).rowCount,
    ).toBe(0);
    try {
      const result = await changeAssistantMode(db, "manual");
      expect(result.pausedSessions).toContain(id);
      await changeAssistantMode(db, "rebuild");
      expect(
        (await host.execution.pending()).some((x) => x.session_id === id),
      ).toBe(false);
      expect((await api("GET", route(id))).json().execution.status).toBe(
        "paused",
      );
    } finally {
      await host.execution.stopped(scope(), id);
      await changeAssistantMode(db, "rebuild");
    }
  });
  it("R10 operator retirement can quiesce a revoked owner without regranting access", async () => {
    const id = await fresh("editor");
    expect((await submit(id, "只查询项目", {}, "editor")).statusCode).toBe(202);
    await db.query(
      "DELETE FROM project_member WHERE project_id=$1 AND user_id=$2",
      [projectId, actors.get("editor")],
    );
    try {
      expect((await changeAssistantMode(db, "manual")).mode).toBe("manual");
      await changeAssistantMode(db, "rebuild");
      expect(
        (await host.execution.pending()).some((x) => x.session_id === id),
      ).toBe(false);
      expect(
        (await api("GET", route(id), undefined, "editor")).statusCode,
      ).toBe(404);
    } finally {
      await db.query(
        "INSERT INTO project_member(project_id,user_id,role) VALUES($1,$2,'editor') ON CONFLICT DO NOTHING",
        [projectId, actors.get("editor")],
      );
      await changeAssistantMode(db, "rebuild");
    }
  });
  it("R10 cutover leaves a manual continuation with legacy task provenance runnable", async () => {
    const old = "conversation_" + randomUUID();
    await db.query(
      "INSERT INTO assistant_session(id,project_id,actor_id) VALUES($1,$2,$3)",
      [old, projectId, actors.get("admin")],
    );
    const source = (
      await host.store.freezeSource(scope(), {
        kind: "assets",
        assetIds: [assetId],
      })
    ).source;
    const created = await createProcessingRun(
      db,
      new ArtifactRepository(config.minio),
      scope(),
      randomUUID(),
      {
        source,
        options: {
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      },
    );
    const run = (
      await db.query("SELECT task_id,job_id FROM processing_run WHERE id=$1", [
        created.run.id,
      ])
    ).rows[0];
    await db.query(
      "UPDATE processing_task SET assistant_session_id=$2 WHERE id=$1",
      [run.task_id, old],
    );
    try {
      const result = await changeAssistantMode(db, "manual");
      expect(result.unsettledJobs).toBe(0);
      expect(
        (await db.query("SELECT status FROM job WHERE id=$1", [run.job_id]))
          .rows[0].status,
      ).toBe("queued");
      expect((await changeAssistantMode(db, "rebuild")).mode).toBe("rebuild");
    } finally {
      await db.query("UPDATE job SET status='cancelled' WHERE id=$1", [
        run.job_id,
      ]);
      await changeAssistantMode(db, "rebuild");
    }
  });
  it("R10 real network in-flight cutover refines unknown outcome exactly once without refunding requests", async () => {
    const id = await fresh();
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    outputs = [
      async () => {
        entered();
        await gate;
        return call("create_draft", { name: "迟到不可创建" });
      },
    ];
    const accepted = await submit(id, "建立草稿");
    const work = host.runPending(scope(), id, accepted.json().turnId);
    try {
      await reached;
      await changeAssistantMode(db, "manual");
      const provisional = (
        await db.query(
          "SELECT * FROM assistant_runtime_request WHERE session_id=$1",
          [id],
        )
      ).rows[0];
      expect(provisional.error_code).toBe("interrupted_outcome_unknown");
      await new Promise((r) => setTimeout(r, 40));
      release();
      await work;
      const actual = (
        await db.query("SELECT * FROM assistant_runtime_request WHERE id=$1", [
          provisional.id,
        ])
      ).rows[0];
      expect(actual.status).toBe(200);
      expect(actual.usage).toEqual({
        prompt_tokens: 3,
        completion_tokens: 3,
        total_tokens: 6,
      });
      expect(Number(actual.elapsed_ms)).toBeGreaterThan(
        Number(provisional.elapsed_ms),
      );
      const ledger = (
        await db.query(
          "SELECT requests,active_ms FROM assistant_runtime_execution WHERE session_id=$1",
          [id],
        )
      ).rows[0];
      expect(ledger.requests).toBe(1);
      expect(Number(ledger.active_ms)).toBe(Number(actual.elapsed_ms));
      await host.execution.outcome({
        id: actual.id,
        status: 200,
        usage: actual.usage,
        error: null,
      });
      expect(
        (
          await db.query(
            "SELECT requests,active_ms FROM assistant_runtime_execution WHERE session_id=$1",
            [id],
          )
        ).rows[0],
      ).toEqual(ledger);
      expect(
        (
          await db.query(
            "SELECT count(*) FROM assistant_runtime_operation WHERE session_id=$1",
            [id],
          )
        ).rows[0].count,
      ).toBe("0");
    } finally {
      release();
      await work.catch(() => undefined);
      await changeAssistantMode(db, "rebuild");
    }
  });
  it("R10 public manual retry of an assistant run transfers current execution ownership without resetting old budgets", async () => {
    const id = await fresh(),
      p = await processing(id, "rewrite");
    await host.execution.stopped(scope(), id);
    await db.query(
      "UPDATE job SET status='failed',error_code='processing_batch_failed',lease_owner=NULL,lease_expires_at=NULL WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
      [p.runId],
    );
    const before = (
      await db.query(
        "SELECT requests,request_limit FROM assistant_runtime_execution WHERE session_id=$1",
        [id],
      )
    ).rows[0];
    const result = await api(
      "POST",
      "/api/projects/" + projectId + "/processing-runs/" + p.runId + "/retry",
    );
    expect(result.statusCode, result.body).toBe(200);
    try {
      expect(
        await host.execution.reserveWorker(
          p.runId,
          "manual_no_assistant_charge",
          "hash",
          { rows: 3 },
        ),
      ).toBe(false);
      expect((await changeAssistantMode(db, "manual")).unsettledJobs).toBe(0);
      expect(
        (
          await db.query(
            "SELECT j.status FROM processing_run r JOIN job j ON j.id=r.job_id WHERE r.id=$1",
            [p.runId],
          )
        ).rows[0].status,
      ).toBe("queued");
      await completeRun(p.runId);
      expect(
        (
          await db.query(
            "SELECT requests,request_limit FROM assistant_runtime_execution WHERE session_id=$1",
            [id],
          )
        ).rows[0],
      ).toEqual(before);
    } finally {
      await db.query(
        "UPDATE job SET status='cancelled' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1) AND status<>'succeeded'",
        [p.runId],
      );
      await changeAssistantMode(db, "rebuild");
    }
  });
  it("R10 operator CLI manual fallback survives additive migration and reenables only explicit new work", async () => {
    if (!databaseName.startsWith("formal_execution_"))
      throw Error("isolated_test_database_required");
    const cli = async (mode: string) =>
      JSON.parse(
        (
          await promisify(execFile)(
            process.execPath,
            [
              "node_modules/tsx/dist/cli.mjs",
              "src/scripts/assistant-mode.ts",
              mode,
            ],
            { env: { ...process.env, DATABASE_URL: databaseUrl } },
          )
        ).stdout,
      );
    try {
      expect((await cli("manual")).mode).toBe("manual");
      await migrate(databaseUrl);
      expect((await cli("status")).mode).toBe("manual");
      expect((await api("POST", route(), {})).statusCode).toBe(409);
      expect((await cli("rebuild")).mode).toBe("rebuild");
      expect((await api("POST", route(), {})).statusCode).toBe(200);
      expect(
        (
          await api(
            "POST",
            "/api/projects/" + projectId + "/assistant-validation",
            {},
          )
        ).statusCode,
      ).toBe(410);
    } finally {
      await changeAssistantMode(db, "rebuild");
    }
  }, 60000);
});
