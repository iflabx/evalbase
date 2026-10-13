import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";
import { runProcessing } from "../../src/processing/execute.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";

const origin = "http://127.0.0.1:4217";
const baseUrl = loadConfig().databaseUrl;
const databaseName = `rounds_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = baseUrl.replace(/\/[^/]+$/, `/${databaseName}`);

describe("single processing task with durable rounds", () => {
  let app: AgentBenchApp;
  let headers: Record<string, string>;
  let editorHeaders: Record<string, string>;
  let projectId: string;
  let source: { kind: string; assetIds: string[]; recordIds: string[] };
  let model: Server;
  let generation = 0;
  let partialGeneration = false;
  let replies: string[] = [];
  const requests: any[] = [];
  const config = {
    ...loadConfig(),
    databaseUrl,
    modelEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
  };
  const tasks = () => `/api/projects/${projectId}/processing-tasks`;
  const runs = () => `/api/projects/${projectId}/processing-runs`;
  async function get(url: string) {
    const response = await app.inject({ method: "GET", url, headers });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function post(
    url: string,
    payload: unknown,
    key = randomUUID(),
    identity = headers,
  ) {
    const response = await app.inject({
      method: "POST",
      url,
      headers: {
        ...identity,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      payload: JSON.stringify(payload),
    });
    return response;
  }
  async function finish(run: { jobId: string }, allowPartial = false) {
    const db = createPool(databaseUrl);
    try {
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=attempt+1,lease_owner='opt17',lease_expires_at=now()+interval '60 seconds' WHERE id=$1 RETURNING *",
          [run.jobId],
        )
      ).rows[0];
      const result = await runProcessing(
        db,
        new ArtifactRepository(config.minio),
        config,
        job,
      ).catch((error) => {
        if (!allowPartial || error.message !== "processing_batch_failed")
          throw error;
        return null;
      });
      await db.query(
        "UPDATE job SET status=$3,result=$2,progress=100,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",
        [run.jobId, result, result ? "succeeded" : "failed"],
      );
    } finally {
      await db.end();
    }
  }
  beforeAll(async () => {
    const root = createPool(baseUrl);
    try {
      await root.query(`CREATE DATABASE ${databaseName}`);
    } finally {
      await root.end();
    }
    await migrate(databaseUrl);
    app = await buildApp(
      {
        databaseUrl,
        appOrigin: origin,
        soloOwnerMode: false,
        allowTestIdentity: false,
        modelEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
      },
      { disableLegacyTestBootstrap: true },
    );
    const account = {
      email: "rounds@example.test",
      password: "Rounds123",
      confirmPassword: "Rounds123",
      displayName: "管理员",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/installation/administrator",
          headers: { origin },
          payload: account,
        })
      ).statusCode,
    ).toBe(201);
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin },
      payload: account,
    });
    headers = {
      origin,
      cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
      "x-csrf-token": login.json().csrfToken,
    };
    projectId = (await post("/api/projects", { name: "轮次隔离测试" })).json()
      .project.id;
    const editor = {
      email: "round-editor@example.test",
      password: "Rounds123",
      confirmPassword: "Rounds123",
    };
    const registered = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: { origin },
      payload: editor,
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const editorLogin = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin },
      payload: editor,
    });
    editorHeaders = {
      origin,
      cookie: `${editorLogin.cookies[0].name}=${editorLogin.cookies[0].value}`,
      "x-csrf-token": editorLogin.json().csrfToken,
    };
    const fixtureDb = createPool(databaseUrl);
    try {
      await fixtureDb.query(
        "INSERT INTO project_member(project_id,user_id,role) SELECT $1,id,'editor' FROM app_user WHERE email=$2",
        [projectId, editor.email],
      );
    } finally {
      await fixtureDb.end();
    }
    const collectionId = (await get(`/api/projects/${projectId}/collections`))
      .collections[0].id;
    const upload = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-uploads`,
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "x-file-name": "rounds.jsonl",
      },
      payload:
        Array.from({ length: 100 }, (_, i) =>
          JSON.stringify({ question: ` Q${i} `, answer: ` A${i} ` }),
        ).join("\n") + "\n",
    });
    const confirmed = await post(
      `/api/projects/${projectId}/pending-upload-batches/confirm`,
      {
        collectionId,
        pendingUploadIds: [upload.json().pendingUpload.id],
        mode: "raw",
      },
    );
    const assetId = confirmed.json().assets[0].id;
    const mapping = await get(
      `/api/projects/${projectId}/assets/${assetId}/mapping`,
    );
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/projects/${projectId}/assets/${assetId}/mapping`,
          headers,
          payload: {
            parsedViewId: mapping.parsedViewId,
            expectedRevision: 0,
            mapping: {
              question: "/question",
              expectedOutput: "/answer",
              metadata: [],
            },
          },
        })
      ).statusCode,
    ).toBe(200);
    source = {
      kind: "assets",
      assetIds: [assetId],
      recordIds: Array.from({ length: 100 }, (_, i) => `${assetId}:${i + 1}`),
    };
    model = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      const instruction = JSON.parse(JSON.parse(text).messages.at(-1).content);
      requests.push(instruction);
      const reply = replies.shift();
      if (reply === "temporary") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { message: "private-provider-detail" } }),
        );
        return;
      }
      const inputs =
        instruction.operation === "augment"
          ? Array.from(
              { length: instruction.outputCount },
              (_, i) => instruction.records[i % instruction.records.length],
            )
          : instruction.records;
      const records = (
        partialGeneration && instruction.operation === "augment"
          ? inputs.slice(0, 2)
          : inputs
      ).map((r: any, index: number) => ({
        sourceId: r.id,
        question:
          instruction.operation === "augment"
            ? `Generated ${generation} ${index}`
            : `Changed ${r.question}`,
        expectedOutput: r.expectedOutput,
        metadata: r.metadata,
      }));
      if (reply === "partial") records.splice(1);
      if (reply === "empty") records.splice(0);
      if (reply === "identity" && records[0])
        records[0].sourceId = "invalid-source";
      if (reply === "duplicate")
        for (const row of records)
          row.question = instruction.records[0].question;
      generation++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "synthetic",
          object: "chat.completion",
          created: 1,
          model: "synthetic",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content:
                  reply === "json"
                    ? "private-invalid-json"
                    : JSON.stringify({ records }),
              },
              finish_reason: reply === "truncated" ? "length" : "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings/model-connection",
          headers,
          payload: {
            revision: 0,
            name: "轮次测试模型",
            endpoint: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
            model: "synthetic",
            apiKey: "synthetic",
            enabled: true,
          },
        })
      ).statusCode,
    ).toBe(200);
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => model?.close(() => resolve()));
    await app?.close();
    const root = createPool(baseUrl);
    try {
      await root.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await root.end();
    }
  });
  it("OPT18 recovers temporary and JSON failures inside one persisted budget", async () => {
    replies = ["temporary", "json"];
    const start = requests.length;
    const created = await post(runs(), {
      source: { ...source, recordIds: source.recordIds.slice(0, 2) },
      options: {
        operation: "rewrite",
        instructions: "rewrite",
        allowedFields: ["question"],
      },
    });
    await finish(created.json().run);
    const data = await get(`${runs()}/${created.json().run.id}`);
    expect(data.run.executionComplete).toBe(true);
    expect(requests.length - start).toBe(3);
    expect(data.diagnostics[0].calls.map((c: any) => c.code)).toEqual([
      "temporary_service",
      "invalid_json",
      "ok",
    ]);
    expect(data.diagnostics[0].accepted).toBe(2);
    expect(JSON.stringify(data.diagnostics)).not.toContain("private-");
    expect(requests.at(-1).lastFailure).toBe("invalid_json");
    expect(data.records[0].result.expectedOutput).toBe(" A0 ");
  });
  it("OPT18 identifies truncation and identity errors and rejects exhausted retries", async () => {
    replies = ["truncated", "identity", "empty"];
    const created = await post(runs(), {
      source: { ...source, recordIds: source.recordIds.slice(0, 1) },
      options: {
        operation: "rewrite",
        instructions: "rewrite",
        allowedFields: ["question"],
      },
    });
    await finish(created.json().run, true);
    const data = await get(`${runs()}/${created.json().run.id}`);
    expect(data.run.outputCount).toBe(0);
    expect(data.diagnostics[0].calls.map((c: any) => c.code)).toEqual([
      "output_truncated",
      "invalid_fields",
      "insufficient_output",
    ]);
    expect(data.recovery).toMatchObject({
      canRetry: false,
      canContinue: true,
      reason: "budget_exhausted",
    });
    const retry = await post(`${runs()}/${created.json().run.id}/retry`, {});
    expect(retry.statusCode, retry.body).toBe(409);
    expect(retry.json().error.code).toBe("processing_retry_unavailable");
  });
  it("OPT18 continues only missing rewrite inputs and preserves successful identities", async () => {
    replies = ["partial", "empty", "empty"];
    const created = await post(runs(), {
      source: { ...source, recordIds: source.recordIds.slice(0, 3) },
      options: {
        operation: "rewrite",
        instructions: "rewrite",
        allowedFields: ["question"],
      },
    });
    await finish(created.json().run, true);
    const id = created.json().run.id;
    const before = await get(`${tasks()}/${id}`);
    expect(before.run.partial).toBe(true);
    const successful = before.records.find((r: any) =>
      r.result.question.startsWith("Changed"),
    );
    const payload = {
      expectedRevision: before.task.revision,
      mode: "complete",
    };
    const key = randomUUID();
    const next = await post(`${tasks()}/${id}/rounds`, payload, key);
    expect(next.statusCode, next.body).toBe(201);
    expect(next.json().run.inputCount).toBe(2);
    expect(
      (await post(`${tasks()}/${id}/rounds`, payload, key)).json().run.id,
    ).toBe(next.json().run.id);
    expect((await post(`${tasks()}/${id}/rounds`, payload)).statusCode).toBe(
      409,
    );
    const start = requests.length;
    await finish(next.json().run);
    const after = await get(`${tasks()}/${id}`);
    expect(after.task.currentCount).toBe(3);
    expect(
      after.records.find((r: any) => r.id === successful.id),
    ).toMatchObject({ runId: successful.runId, result: successful.result });
    expect(requests[start].records.map((r: any) => r.id)).toEqual(
      source.recordIds.slice(1, 3),
    );
    expect(
      after.records.every((r: any) => r.result.question.startsWith("Changed")),
    ).toBe(true);
  });
  it("OPT18 retains budget-aware recovery after infrastructure and lease failures", async () => {
    for (const code of ["infrastructure_unavailable", "job_lease_expired"]) {
      const created = await post(runs(), {
        source: { ...source, recordIds: source.recordIds.slice(0, 1) },
        options: {
          operation: "rewrite",
          instructions: "rewrite",
          allowedFields: ["question"],
        },
      });
      const db = createPool(databaseUrl);
      try {
        await db.query(
          "UPDATE job SET status='failed',error_code=$2 WHERE id=$1",
          [created.json().run.jobId, code],
        );
      } finally {
        await db.end();
      }
      const data = await get(`${runs()}/${created.json().run.id}`);
      expect(data.recovery).toMatchObject({
        canRetry: true,
        reason: "remaining_budget",
      });
      expect(
        (await post(`${runs()}/${created.json().run.id}/retry`, {})).statusCode,
      ).toBe(200);
      await finish(created.json().run);
      expect(
        (await get(`${runs()}/${created.json().run.id}`)).run.executionComplete,
      ).toBe(true);
    }
  });
  it("OPT18 marks only missing rewrites of previous candidates unfinished", async () => {
    const created = await post(runs(), {
      source: { ...source, recordIds: source.recordIds.slice(0, 3) },
      options: {
        operation: "clean",
        instructions: "",
        allowedFields: ["question"],
      },
    });
    await finish(created.json().run);
    const id = created.json().run.id,
      initial = await get(`${tasks()}/${id}`);
    const round = await post(`${tasks()}/${id}/rounds`, {
      mode: "continue",
      expectedRevision: initial.task.revision,
      resultIds: initial.allIds,
      options: {
        operation: "rewrite",
        instructions: "rewrite",
        allowedFields: ["question"],
      },
    });
    replies = ["partial", "empty", "empty"];
    await finish(round.json().run, true);
    const partial = await get(`${tasks()}/${id}`);
    expect(partial.unprocessedIds).toEqual(initial.allIds.slice(1));
    expect(partial.records.slice(1).map((r: any) => r.result)).toEqual(
      initial.records.slice(1).map((r: any) => r.result),
    );
    expect(partial.records.map((r: any) => r.unprocessed)).toEqual([
      false,
      true,
      true,
    ]);
    const completion = await post(`${tasks()}/${id}/rounds`, {
      mode: "complete",
      expectedRevision: partial.task.revision,
    });
    expect(completion.statusCode, completion.body).toBe(201);
    await finish(completion.json().run);
    const final = await get(`${tasks()}/${id}`);
    expect(final.unprocessedIds).toEqual([]);
    expect(final.records[0].result).toEqual(partial.records[0].result);
    expect(final.task.currentCount).toBe(3);
  });
  it("OPT18 supplies bounded duplicate feedback and refuses an expired time budget", async () => {
    replies = ["duplicate"];
    const created = await post(runs(), {
      source: { ...source, recordIds: source.recordIds.slice(0, 1) },
      options: {
        operation: "augment",
        instructions: "generate",
        outputCount: 2,
        allowedFields: ["question"],
      },
    });
    await finish(created.json().run);
    const data = await get(`${runs()}/${created.json().run.id}`);
    expect(data.run.outputCount).toBe(2);
    expect(data.diagnostics[0].calls[0].duplicates).toBe(2);
    expect(requests.at(-1).rejectedDuplicates[0].question).toBe(" Q0 ");
    expect(Buffer.byteLength(JSON.stringify(requests.at(-1)))).toBeLessThan(
      40000,
    );
    const stale = await post(runs(), {
      source: { ...source, recordIds: source.recordIds.slice(0, 1) },
      options: {
        operation: "rewrite",
        instructions: "rewrite",
        allowedFields: ["question"],
      },
    });
    const db = createPool(databaseUrl);
    try {
      await db.query(
        "INSERT INTO processing_batch(run_id,ordinal,model_attempts,model_started_at) VALUES($1,0,1,now()-interval '2 minutes')",
        [stale.json().run.id],
      );
      await db.query(
        "UPDATE job SET status='failed',counts=jsonb_build_object('processingBatches',1) WHERE id=$1",
        [stale.json().run.jobId],
      );
    } finally {
      await db.end();
    }
    const state = await get(`${runs()}/${stale.json().run.id}`);
    expect(state.recovery).toMatchObject({
      canRetry: false,
      reason: "budget_exhausted",
    });
    expect(
      (await post(`${runs()}/${stale.json().run.id}/retry`, {})).statusCode,
    ).toBe(409);
  });
  it("appends augmentation once, reruns only the last effect and saves the aggregate", async () => {
    const initial = await post(runs(), {
      source: { ...source, recordIds: source.recordIds.slice(0, 10) },
      options: {
        operation: "clean",
        instructions: "",
        allowedFields: ["question"],
      },
    });
    await finish(initial.json().run);
    const id = initial.json().run.id;
    const first = await get(`${tasks()}/${id}?limit=100`);
    const expansion = await post(`${tasks()}/${id}/rounds`, {
      expectedRevision: first.task.revision,
      mode: "continue",
      resultIds: first.allIds,
      options: {
        operation: "augment",
        instructions: "新增二十条",
        allowedFields: ["question"],
        outputCount: 20,
      },
    });
    expect(expansion.statusCode, expansion.body).toBe(201);
    await finish(expansion.json().run);
    const expanded = await get(`${tasks()}/${id}?limit=100`);
    expect(expanded.task.currentCount).toBe(30);
    const rerun = await post(`${tasks()}/${id}/rounds`, {
      expectedRevision: expanded.task.revision,
      mode: "rerun",
      options: expansion.json().run.options,
    });
    expect(rerun.statusCode, rerun.body).toBe(201);
    await finish(rerun.json().run);
    const current = await get(`${tasks()}/${id}?limit=100`);
    expect(current.task.currentCount).toBe(30);
    expect(
      current.records.filter((r: any) =>
        r.result.question.startsWith("Generated"),
      ),
    ).toHaveLength(20);
    const key = randomUUID(),
      body = {
        expectedRevision: current.task.revision,
        resultIds: current.allIds,
        target: { kind: "newDraft", name: "本轮成果", purpose: "" },
      };
    const saved = await post(`${tasks()}/${id}/accept`, body, key);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().receipt.adopted).toBe(30);
    expect(
      (await post(`${tasks()}/${id}/accept`, body, key)).json().receipt
        .acceptanceId,
    ).toBe(saved.json().receipt.acceptanceId);
    const after = await get(`${tasks()}/${id}?limit=100`);
    expect(after.task.savedCount).toBe(30);
    expect(after.task.unsavedCount).toBe(0);
    const continuation = await post(`${tasks()}/${id}/rounds`, {
      expectedRevision: after.task.revision,
      mode: "saved",
      options: {
        operation: "clean",
        instructions: "",
        allowedFields: ["question"],
      },
    });
    expect(continuation.statusCode, continuation.body).toBe(201);
    await finish(continuation.json().run);
    const continued = await get(`${tasks()}/${id}?limit=100`);
    expect(continued.task.currentCount).toBe(30);
    expect(continued.task.unsavedCount).toBe(30);
    const draftId = saved.json().receipt.draftId,
      draft = await get(
        `/api/projects/${projectId}/collaborative-drafts/${draftId}`,
      );
    const resaved = await post(`${tasks()}/${id}/accept`, {
      expectedRevision: continued.task.revision,
      resultIds: continued.allIds,
      target: {
        kind: "draft",
        id: draftId,
        expectedRevision: draft.draft.revision,
      },
    });
    expect(resaved.statusCode, resaved.body).toBe(200);
    expect(resaved.json().receipt).toMatchObject({ updated: 30, added: 0 });
    const settled = await get(`${tasks()}/${id}?limit=100`);
    const competing = await Promise.all([
      post(`${tasks()}/${id}/rounds`, {
        mode: "saved",
        expectedRevision: settled.task.revision,
        options: {
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      }),
      post(`${tasks()}/${id}/accept`, {
        expectedRevision: settled.task.revision,
        resultIds: settled.allIds,
        target: { kind: "asset" },
      }),
    ]);
    expect(
      competing.filter((r) => r.statusCode < 300),
      competing.map((r) => r.body).join("\n"),
    ).toHaveLength(1);
    expect(competing.filter((r) => r.statusCode === 409)).toHaveLength(1);
    if (competing[0]!.statusCode === 201)
      await finish(competing[0]!.json().run);
  });
  it("keeps unselected records, a stable workspace and read-only round outputs", async () => {
    const initial = await post(runs(), {
      source,
      options: {
        operation: "clean",
        instructions: "",
        allowedFields: ["question"],
      },
    });
    expect(initial.statusCode, initial.body).toBe(201);
    const rootId = initial.json().run.id;
    await finish(initial.json().run);
    const first = await get(`${tasks()}/${rootId}?limit=100&view=all`);
    expect(first.records).toHaveLength(100);
    const selected = first.allIds.slice(0, 10);
    const request = {
      expectedRevision: first.task.revision,
      mode: "continue",
      resultIds: selected,
      options: {
        operation: "clean",
        instructions: "",
        allowedFields: ["expectedOutput"],
      },
    };
    const key = randomUUID();
    const next = await post(`${tasks()}/${rootId}/rounds`, request, key);
    expect(next.statusCode, next.body).toBe(201);
    expect(
      (await post(`${tasks()}/${rootId}/rounds`, request, key)).json().run.id,
    ).toBe(next.json().run.id);
    const running = await get(`${tasks()}/${rootId}?limit=100&view=all`);
    expect(running.records).toHaveLength(100);
    expect(
      (
        await post(`${tasks()}/${rootId}/rounds`, {
          ...request,
          expectedRevision: running.task.revision,
        })
      ).statusCode,
    ).toBe(409);
    await finish(next.json().run);
    const current = await get(`${tasks()}/${rootId}?limit=100&view=all`);
    expect(current.records).toHaveLength(100);
    expect(
      current.records.slice(0, 10).map((row: any) => row.result.expectedOutput),
    ).toEqual(Array.from({ length: 10 }, (_, i) => `A${i}`));
    expect(
      current.records.slice(10).map((row: any) => row.result.expectedOutput),
    ).toEqual(Array.from({ length: 90 }, (_, i) => ` A${i + 10} `));
    const listing = await get(tasks());
    expect(listing.runs.filter((row: any) => row.id === rootId)).toHaveLength(
      1,
    );
    expect(listing.runs.find((row: any) => row.id === rootId)).toMatchObject({
      id: rootId,
      roundCount: 2,
      currentCount: 100,
    });
    const history = await get(`${tasks()}/${rootId}/history`);
    expect(history.rounds.map((round: any) => round.roundNumber)).toEqual([
      2, 1,
    ]);
    const old = await get(`${runs()}/${rootId}?limit=100`);
    expect(old.records[0].result.expectedOutput).toBe(" A0 ");
    const stale = await post(`${tasks()}/${rootId}/rounds`, request);
    expect(stale.statusCode).toBe(409);
  });
  it("serializes administrator and editor submissions and retains previous values after failed batches", async () => {
    const initial = await post(runs(), {
      source: { ...source, recordIds: source.recordIds.slice(0, 10) },
      options: {
        operation: "clean",
        instructions: "",
        allowedFields: ["question"],
      },
    });
    await finish(initial.json().run);
    const id = initial.json().run.id;
    const first = await get(`${tasks()}/${id}?limit=100`),
      body = {
        mode: "continue",
        expectedRevision: first.task.revision,
        resultIds: first.allIds.slice(0, 3),
        options: {
          operation: "clean",
          instructions: "",
          allowedFields: ["expectedOutput"],
        },
      };
    const responses = await Promise.all([
      post(`${tasks()}/${id}/rounds`, body),
      post(`${tasks()}/${id}/rounds`, body, randomUUID(), editorHeaders),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const round = responses.find((r) => r.statusCode === 201)!.json().run;
    const db = createPool(databaseUrl);
    try {
      await db.query(
        "UPDATE job SET status='failed',error_code='processing_batch_failed' WHERE id=$1",
        [round.jobId],
      );
    } finally {
      await db.end();
    }
    const failed = await get(`${tasks()}/${id}?limit=100`);
    expect(failed.task).toMatchObject({
      currentCount: 10,
      incomplete: true,
      roundCount: 2,
    });
    expect(failed.records.map((r: any) => r.result)).toEqual(
      first.records.map((r: any) => r.result),
    );
    expect((await post(`${runs()}/${id}/retry`, {})).statusCode).toBe(409);
    expect((await post(`${runs()}/${round.id}/retry`, {})).statusCode).toBe(
      200,
    );
    await finish(round);
    const recovered = await get(`${tasks()}/${id}?limit=100`);
    expect(recovered.task).toMatchObject({
      currentCount: 10,
      incomplete: false,
      roundCount: 2,
    });
  });
  it("counts only this round for missing generation and keeps previous results", async () => {
    const created = await post(runs(), {
      source: { ...source, recordIds: source.recordIds.slice(0, 10) },
      options: {
        operation: "clean",
        instructions: "",
        allowedFields: ["question"],
      },
    });
    await finish(created.json().run);
    const id = created.json().run.id,
      first = await get(`${tasks()}/${id}?limit=100`);
    const next = await post(`${tasks()}/${id}/rounds`, {
      mode: "continue",
      expectedRevision: first.task.revision,
      resultIds: first.allIds,
      options: {
        operation: "augment",
        instructions: "生成八条",
        outputCount: 8,
        allowedFields: ["question"],
      },
    });
    partialGeneration = true;
    try {
      await finish(next.json().run, true);
    } finally {
      partialGeneration = false;
    }
    const partial = await get(`${tasks()}/${id}?limit=100`);
    expect(partial.task.currentCount).toBeGreaterThan(10);
    expect(partial.task.latestUsableCount).toBeLessThan(8);
    const completion = await post(`${tasks()}/${id}/rounds`, {
      mode: "complete",
      expectedRevision: partial.task.revision,
    });
    expect(completion.statusCode, completion.body).toBe(201);
    expect(completion.json().run.options.outputCount).toBe(
      8 - partial.task.latestUsableCount,
    );
    await finish(completion.json().run);
    expect((await get(`${tasks()}/${id}?limit=100`)).task.currentCount).toBe(
      18,
    );
  });
  it("saves deduplicated source removals once across partial confirmations", async () => {
    const base = `/api/projects/${projectId}/collaborative-drafts`;
    const draft = (
      await post(base, { name: "部分保存去重", purpose: "" })
    ).json();
    const draftId = draft.draft.id,
      recordIds = [];
    for (const question of ["Same", "Same", "Other"])
      recordIds.push(
        (
          await post(`${base}/${draftId}/records`, {
            question,
            expectedOutput: "A",
            metadata: [],
          })
        ).json().record.id,
      );
    const created = await post(runs(), {
      source: { kind: "draft", id: draftId, recordIds },
      options: {
        operation: "clean",
        instructions: "",
        allowedFields: ["question"],
      },
    });
    await finish(created.json().run);
    const id = created.json().run.id,
      first = await get(`${tasks()}/${id}?limit=100`);
    const excluded = await post(`${tasks()}/${id}/deduplication`, {
      action: "exclude",
      expectedRevision: first.task.revision,
      resultIds: first.allIds,
    });
    expect(excluded.statusCode, excluded.body).toBe(200);
    const current = await get(`${tasks()}/${id}?limit=100`);
    expect(current.saveDisposition.removeCount).toBe(1);
    const target = {
      kind: "draft",
      id: draftId,
      expectedRevision: (await get(`${base}/${draftId}`)).draft.revision,
    };
    const a = await post(`${tasks()}/${id}/accept`, {
      expectedRevision: current.task.revision,
      resultIds: [current.allIds[0]],
      target,
    });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json().receipt.removed).toBe(1);
    const remaining = await get(`${tasks()}/${id}?limit=100`);
    expect(remaining.saveDisposition.removeCount).toBe(0);
    const b = await post(`${tasks()}/${id}/accept`, {
      expectedRevision: remaining.task.revision,
      resultIds: remaining.unsavedIds,
      target: { ...target, expectedRevision: a.json().receipt.revision },
    });
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json().receipt.removed).toBe(0);
    expect((await get(`${base}/${draftId}`)).total).toBe(2);
  });
  it("protects current sources and rejects unknown task fields", async () => {
    const initial = await post(runs(), {
      source: { ...source, recordIds: source.recordIds.slice(0, 2) },
      options: {
        operation: "clean",
        instructions: "",
        allowedFields: ["question"],
      },
    });
    await finish(initial.json().run);
    const id = initial.json().run.id,
      current = await get(`${tasks()}/${id}`);
    expect(
      (
        await post(`${tasks()}/${id}/rounds`, {
          mode: "continue",
          expectedRevision: current.task.revision,
          resultIds: current.allIds,
          records: [],
          options: {
            operation: "clean",
            instructions: "",
            allowedFields: ["question"],
          },
        })
      ).statusCode,
    ).toBe(422);
    const signup = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: { origin },
      payload: {
        email: "outsider@example.test",
        password: "Rounds123",
        confirmPassword: "Rounds123",
      },
    });
    expect(signup.statusCode, signup.body).toBe(201);
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin },
      payload: { email: "outsider@example.test", password: "Rounds123" },
    });
    const outsider = {
      origin,
      cookie: `${login.cookies[0].name}=${login.cookies[0].value}`,
    };
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${tasks()}/${id}`,
          headers: outsider,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: tasks(), headers: outsider }))
        .statusCode,
    ).toBe(404);
    const db = createPool(databaseUrl);
    try {
      await db.query("UPDATE processing_run SET input_ref=NULL WHERE id=$1", [
        id,
      ]);
      expect(
        (
          await db.query(
            "SELECT current_refs,excluded_refs FROM processing_task WHERE id=$1",
            [id],
          )
        ).rows[0],
      ).toEqual({ current_refs: [], excluded_refs: [] });
    } finally {
      await db.end();
    }
    expect(
      (await app.inject({ method: "GET", url: `${tasks()}/${id}`, headers }))
        .statusCode,
    ).toBe(404);
  });
  it("backfills only proven chains in parent order and leaves forked history independent", async () => {
    const options = {
      operation: "clean",
      instructions: "",
      allowedFields: ["question"],
    };
    async function initial() {
      const created = await post(runs(), {
        source: { ...source, recordIds: source.recordIds.slice(0, 1) },
        options,
      });
      await finish(created.json().run);
      return created.json().run.id as string;
    }
    const root = await initial(),
      first = await get(`${tasks()}/${root}`);
    const child = await post(`${tasks()}/${root}/rounds`, {
      mode: "continue",
      expectedRevision: first.task.revision,
      resultIds: first.allIds,
      options,
    });
    await finish(child.json().run);
    const fork = await initial(),
      a = await initial(),
      b = await initial();
    const db = createPool(databaseUrl);
    try {
      const before = (
        await db.query(
          "SELECT id,input_hash,input_ref FROM processing_run ORDER BY id",
        )
      ).rows;
      await db.query(
        "UPDATE processing_run SET parent_run_id=$2 WHERE id=ANY($1::text[])",
        [[a, b], fork],
      );
      // Parent identity, rather than timestamps or opaque ID sorting, determines the round order.
      await db.query(
        "UPDATE processing_run SET created_at=now()-interval '1 day' WHERE id=$1",
        [child.json().run.id],
      );
      await db.query(
        "UPDATE processing_run SET task_id=NULL,round_number=NULL,task_before=NULL",
      );
      await db.query("DELETE FROM processing_task");
      await db.query(
        "DELETE FROM schema_migration WHERE id='processing-task-rounds-v1'",
      );
      await migrate(databaseUrl);
      expect(
        (
          await db.query(
            "SELECT id,input_hash,input_ref FROM processing_run ORDER BY id",
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await db.query(
            "SELECT id,task_id,round_number FROM processing_run WHERE id=ANY($1::text[]) ORDER BY round_number",
            [[root, child.json().run.id]],
          )
        ).rows,
      ).toEqual([
        { id: root, task_id: root, round_number: 1 },
        { id: child.json().run.id, task_id: root, round_number: 2 },
      ]);
      for (const id of [fork, a, b])
        expect(
          (
            await db.query(
              "SELECT task_id,round_number FROM processing_run WHERE id=$1",
              [id],
            )
          ).rows[0],
        ).toEqual({ task_id: id, round_number: 1 });
      const tasksBefore = (
        await db.query(
          "SELECT id,latest_run_id FROM processing_task ORDER BY id",
        )
      ).rows;
      await migrate(databaseUrl);
      expect(
        (
          await db.query(
            "SELECT id,latest_run_id FROM processing_task ORDER BY id",
          )
        ).rows,
      ).toEqual(tasksBefore);
      const read = app.inject({
        method: "GET",
        url: `${tasks()}/${root}`,
        headers,
      });
      await db.query("UPDATE processing_run SET input_ref=NULL WHERE id=$1", [
        root,
      ]);
      expect([200, 404, 409]).toContain((await read).statusCode);
      expect(
        (
          await db.query(
            "SELECT current_refs FROM processing_task WHERE id=$1",
            [root],
          )
        ).rows[0].current_refs,
      ).toEqual([]);
    } finally {
      await db.end();
    }
  });
});
