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
const origin = "http://127.0.0.1:4217",
  base = loadConfig(),
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
        name,
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
async function effects() {
  return (
    await db.query(
      "SELECT (SELECT count(*) FROM collaborative_draft WHERE project_id=$1)::int AS drafts,(SELECT count(*) FROM processing_run WHERE project_id=$1)::int AS runs",
      [projectId],
    )
  ).rows[0];
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
    app = await buildApp(config, {
      disableLegacyTestBootstrap: true,
      disableAssistantRuntimeDispatch: true,
    });
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
            m.content.includes("You transform test data"),
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
          if (!Array.isArray(data.records))
            throw Error("controlled_worker_records_missing");
          message = {
            role: "assistant",
            content: JSON.stringify({
              records: data.records.map((r: any) => ({
                sourceId: r.id,
                question: r.question.trim() + "（自然问法）",
                expectedOutput: r.expectedOutput,
                metadata: r.metadata,
              })),
            }),
          };
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
        if (message.bodyDelayMs) {
          res.writeHead(200, { "content-type": "application/json" });
          res.flushHeaders();
          await new Promise((r) => setTimeout(r, message.bodyDelayMs));
        } else res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "response_" + randomUUID(),
            object: "chat.completion",
            created: 1,
            model: "synthetic",
            choices: [
              {
                index: 0,
                message,
                finish_reason: message.tool_calls?.length
                  ? "tool_calls"
                  : "stop",
              },
            ],
            ...(omitUsage
              ? {}
              : {
                  usage: {
                    prompt_tokens: 3,
                    completion_tokens: 3,
                    total_tokens: 6,
                  },
                }),
          }),
        );
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
      await expect(host.store.change(proof, plan())).rejects.toMatchObject({
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
      ).toContain("unknown");
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
    const request = formalWorkerFetch(
      db,
      p.runId,
    )(async () => {
      invoked++;
      return new Response(
        JSON.stringify({ choices: [], usage: { total_tokens: 2 } }),
        { status: 200 },
      );
    });
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
      changes: { deliveries: [{ patch: { name: "第一份", count: "50" } }] },
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
  it("reclaims an expired owner, preserves its unknown sent request, and fences its late response", async () => {
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
      ).toBe("request_outcome_unknown");
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
    const send = formalWorkerFetch(db, p.runId)(fetch);
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
    await expect(
      host.runPending(scope(), f.id, f.p.proof.turnId),
    ).rejects.toBeDefined();
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
      changes: { deliveries: [{ patch: { name: "第一份", count: "50" } }] },
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
    expect(amended.execution.status).toBe("completed");
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
});
