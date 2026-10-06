import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cleanupProcessingObjects } from "../../src/processing/cleanup.js";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";

import { runProcessing } from "../../src/processing/execute.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";

const origin = "http://127.0.0.1:4217";
const databaseName = `processing_${randomUUID().replaceAll("-", "")}`;
const baseUrl = loadConfig().databaseUrl;
const databaseUrl = baseUrl.replace(/\/[^/]+$/, `/${databaseName}`);

describe("durable data processing", () => {
  let app: AgentBenchApp;
  let headers: Record<string, string>;
  let projectId: string;
  let collectionId: string;
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
      email: "admin@example.test",
      password: "Processing123",
      confirmPassword: "Processing123",
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
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: { name: "原件整理测试" },
    });
    projectId = project.json().project.id;
    const collections = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections`,
      headers,
    });
    collectionId = collections.json().collections[0].id;
  });
  afterAll(async () => {
    await app?.close();
    const root = createPool(baseUrl);
    try {
      await root.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await root.end();
    }
  });
  it("freezes explicit input, queues once, saves fenced batches, and retains results across retry", async () => {
    const upload = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-uploads`,
      headers: {
        ...headers,
        "content-type": "text/csv",
        "x-file-name": "processing.csv",
      },
      payload: "question,answer\n  First  ,Yes\nSecond,No\n",
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const confirmation = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-upload-batches/confirm`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        collectionId,
        pendingUploadIds: [upload.json().pendingUpload.id],
        mode: "raw",
      },
    });
    expect(confirmation.statusCode, confirmation.body).toBe(201);
    const assetId = confirmation.json().assets[0].id;
    const mappingUrl = `/api/projects/${projectId}/assets/${assetId}/mapping`;
    const raw = await app.inject({ method: "GET", url: mappingUrl, headers });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: mappingUrl,
          headers,
          payload: {
            parsedViewId: raw.json().parsedViewId,
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
    const path = `/api/projects/${projectId}/processing-runs`,
      idempotencyKey = randomUUID();
    const payload = {
      source: {
        kind: "assets",
        assetIds: [assetId],
        recordIds: [`${assetId}:1`, `${assetId}:2`],
      },
      options: {
        operation: "clean",
        instructions: "",
        allowedFields: ["question"],
      },
    };
    const request = {
      method: "POST" as const,
      url: path,
      headers: { ...headers, "idempotency-key": idempotencyKey },
      payload,
    };
    const [created, replayed] = await Promise.all([
      app.inject(request),
      app.inject(request),
    ]);
    expect([created.statusCode, replayed.statusCode].sort()).toEqual([
      200, 201,
    ]);
    expect(created.json().run.id).toBe(replayed.json().run.id);
    expect(
      (
        await app.inject({
          ...request,
          payload: {
            ...payload,
            options: { ...payload.options, instructions: "different" },
          },
        })
      ).statusCode,
    ).toBe(409);
    const run = created.json().run,
      db = createPool(databaseUrl),
      config = { ...loadConfig(), databaseUrl };
    const artifacts = new ArtifactRepository(config.minio);
    try {
      const claim = await db.query(
        "UPDATE job SET status='running',attempt=attempt+1,lease_owner='processing-test',lease_expires_at=now()+interval '30 seconds' WHERE id=$1 RETURNING *",
        [run.jobId],
      );
      const job = claim.rows[0];
      await expect(
        runProcessing(db, artifacts, config, {
          ...job,
          attempt: job.attempt - 1,
        }),
      ).rejects.toThrow("processing_lease_lost");
      const result = await runProcessing(db, artifacts, config, job);
      expect(result.counts).toMatchObject({ input: 2, output: 2, batches: 1 });
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, result],
      );
      const read = await app.inject({
        method: "GET",
        url: `${path}/${run.id}?offset=0&limit=20`,
        headers,
      });
      expect(read.statusCode, read.body).toBe(200);
      expect(
        read
          .json()
          .records.map((r: any) => [
            r.result.question,
            r.result.expectedOutput,
          ]),
      ).toEqual([
        ["First", "Yes"],
        ["Second", "No"],
      ]);
      expect(read.json().records[0].original.question).toBe("  First  ");
      expect(read.json().run.status).toBe("succeeded");
      const draft = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts`,
        headers,
        payload: {},
      });
      const draftId = draft.json().draft.id;
      const accept = {
        method: "POST" as const,
        url: `${path}/${run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          resultIds: ["0:0"],
          target: { kind: "draft", id: draftId, expectedRevision: 0 },
        },
      };
      const [accepted, acceptedReplay] = await Promise.all([
        app.inject(accept),
        app.inject(accept),
      ]);
      expect([accepted.statusCode, acceptedReplay.statusCode].sort()).toEqual([
        200, 201,
      ]);
      expect(accepted.json().receipt).toEqual(acceptedReplay.json().receipt);
      const adopted = await db.query(
        "SELECT question,source FROM collaborative_draft_record WHERE draft_id=$1",
        [draftId],
      );
      expect(adopted.rows).toHaveLength(1);
      expect(adopted.rows[0].question).toBe("First");
      expect(adopted.rows[0].source.assetId).toBe(
        accepted.json().receipt.assetId,
      );
      expect(
        (
          await app.inject({
            ...accept,
            payload: { ...accept.payload, resultIds: ["0:1"] },
          })
        ).statusCode,
      ).toBe(409);
      // A lost-response retry never duplicates a successful batch.
      await db.query(
        "UPDATE job SET status='running',attempt=attempt+1,lease_expires_at=now()+interval '30 seconds' WHERE id=$1",
        [job.id],
      );
      await runProcessing(db, artifacts, config, {
        ...job,
        attempt: job.attempt + 1,
      });
      expect(
        Number(
          (
            await db.query(
              "SELECT count(*) FROM processing_batch WHERE run_id=$1",
              [run.id],
            )
          ).rows[0].count,
        ),
      ).toBe(1);
      const cancel = await app.inject({
        method: "POST",
        url: `${path}/${run.id}/cancel`,
        headers,
        payload: {},
      });
      expect(cancel.statusCode, cancel.body).toBe(200);
      await expect(
        runProcessing(db, artifacts, config, {
          ...job,
          attempt: job.attempt + 1,
        }),
      ).rejects.toThrow("processing_lease_lost");
    } finally {
      await db.end();
    }
  });
  it("uses the configured model, preserves protected fields, retries only failed batches, and rejects stale-field adoption", async () => {
    const draft = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/collaborative-drafts`,
      headers,
      payload: {},
    });
    const draftId = draft.json().draft.id,
      rowIds: string[] = [];
    for (let i = 0; i < 21; i++) {
      const row = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts/${draftId}/records`,
        headers,
        payload: {
          question: `Input ${i}`,
          expectedOutput: "protected",
          metadata: [{ key: "empty", value: "" }],
        },
      });
      expect(row.statusCode, row.body).toBe(201);
      rowIds.push(row.json().record.id);
    }
    const calls: number[] = [],
      failBatches = new Set([1]);
    const server = createServer(async (request, response) => {
      let text = "";
      for await (const chunk of request) text += chunk;
      const messages = JSON.parse(text).messages;
      const instruction = JSON.parse(messages.at(-1).content),
        count = instruction.records.length;
      calls.push(count);
      if (failBatches.has(count)) {
        response.writeHead(503);
        response.end();
        return;
      }
      const inputs =
        instruction.operation === "augment"
          ? Array.from(
              { length: instruction.outputCount },
              (_, i) => instruction.records[i % instruction.records.length],
            )
          : instruction.records;
      const records = inputs.map((r: any, index: number) => ({
        sourceId: r.id,
        question: `${instruction.operation === "augment" ? `New ${index}` : "Rewritten"} ${r.question}`,
        expectedOutput: "FORGED",
        metadata: [{ key: "forged", value: "bad" }],
      }));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "test",
          object: "chat.completion",
          created: 1,
          model: "synthetic",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({ records }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const db = createPool(databaseUrl),
      config = {
        ...loadConfig(),
        databaseUrl,
        modelEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
      },
      artifacts = new ArtifactRepository(config.minio);
    try {
      const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/settings/model-connection",
            headers,
            payload: {
              revision: 0,
              name: "测试",
              endpoint,
              model: "synthetic",
              apiKey: "synthetic-test-key",
              enabled: true,
            },
          })
        ).statusCode,
      ).toBe(200);
      const path = `/api/projects/${projectId}/processing-runs`;
      const created = await app.inject({
        method: "POST",
        url: path,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          source: { kind: "draft", id: draftId, recordIds: rowIds },
          options: {
            operation: "rewrite",
            instructions: "Rewrite questions",
            allowedFields: ["question"],
          },
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const preview = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/processing-inputs`,
        headers,
        payload: {
          source: { kind: "draft", id: draftId },
          offset: 20,
          limit: 20,
        },
      });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json().records).toHaveLength(1);
      expect(preview.json().allIds).toHaveLength(21);
      const run = created.json().run;
      let job = (
        await db.query(
          "UPDATE job SET status='running',attempt=1,lease_owner='model-test',lease_expires_at=now()+interval '60 seconds' WHERE id=$1 RETURNING *",
          [run.jobId],
        )
      ).rows[0];
      await expect(runProcessing(db, artifacts, config, job)).rejects.toThrow(
        "processing_batch_failed",
      );
      expect(calls).toEqual([20, 1]);
      expect(
        (
          await db.query(
            "SELECT output_count FROM processing_batch WHERE run_id=$1 AND result_ref IS NOT NULL",
            [run.id],
          )
        ).rows.map((r) => r.output_count),
      ).toEqual([20]);
      failBatches.clear();
      job = (
        await db.query("UPDATE job SET attempt=2 WHERE id=$1 RETURNING *", [
          job.id,
        ])
      ).rows[0];
      const result = await runProcessing(db, artifacts, config, job);
      expect(calls).toEqual([20, 1, 1]);
      expect(result.counts).toMatchObject({
        input: 21,
        output: 21,
        batches: 2,
      });
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, result],
      );
      const read = await app.inject({
        method: "GET",
        url: `${path}/${run.id}`,
        headers,
      });
      expect(read.json().records[0].result).toMatchObject({
        expectedOutput: "protected",
        metadata: [{ key: "empty", value: "" }],
      });
      const first = read.json().records[0].result.sourceId;
      // A collaborator changes a protected field: adopting question-only output must keep it.
      await db.query(
        "UPDATE collaborative_draft_record SET expected_output='Collaborator answer',expected_output_revision=1 WHERE draft_id=$1 AND id=$2",
        [draftId, first],
      );
      const accepted = await app.inject({
        method: "POST",
        url: `${path}/${run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          resultIds: ["0:0"],
          target: { kind: "draft", id: draftId, expectedRevision: 21 },
        },
      });
      expect(accepted.statusCode, accepted.body).toBe(201);
      expect(
        (
          await db.query(
            "SELECT question,expected_output FROM collaborative_draft_record WHERE draft_id=$1 AND id=$2",
            [draftId, first],
          )
        ).rows[0],
      ).toMatchObject({
        expected_output: "Collaborator answer",
        question: expect.stringContaining("Rewritten"),
      });
      // The same baseline cannot overwrite an already changed question in another adoption.
      const conflict = await app.inject({
        method: "POST",
        url: `${path}/${run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          resultIds: ["0:0"],
          target: { kind: "draft", id: draftId, expectedRevision: 22 },
        },
      });
      expect(conflict.statusCode, conflict.body).toBe(409);
      expect(conflict.json().error.code).toBe("draft_field_conflict");
      const expanded = await app.inject({
        method: "POST",
        url: path,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          source: { kind: "draft", id: draftId, recordIds: [first] },
          options: {
            operation: "augment",
            instructions: "Create three variations",
            allowedFields: ["question"],
            outputCount: 3,
          },
        },
      });
      expect(expanded.statusCode, expanded.body).toBe(201);
      const expansionStatus = await app.inject({
        method: "GET",
        url: `${path}/${expanded.json().run.id}/status`,
        headers,
      });
      expect(expansionStatus.json().run).toMatchObject({
        inputCount: 1,
        options: { operation: "augment", outputCount: 3 },
      });
      const expandJob = (
        await db.query(
          "UPDATE job SET status='running',attempt=1,lease_owner='augment-test',lease_expires_at=now()+interval '60 seconds' WHERE id=$1 RETURNING *",
          [expanded.json().run.jobId],
        )
      ).rows[0];
      const expandResult = await runProcessing(
        db,
        artifacts,
        config,
        expandJob,
      );
      expect(expandResult.counts).toMatchObject({ output: 3 });
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [expandJob.id, expandResult],
      );
      const adoptedExpansion = await app.inject({
        method: "POST",
        url: `${path}/${expanded.json().run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          resultIds: ["0:0", "0:1", "0:2"],
          target: { kind: "draft", id: draftId, expectedRevision: 22 },
        },
      });
      expect(adoptedExpansion.statusCode, adoptedExpansion.body).toBe(201);
      expect(adoptedExpansion.json().receipt.fileName).toMatch(
        /^扩充结果-[a-f0-9]+\.jsonl$/u,
      );
      expect(
        Number(
          (
            await db.query(
              "SELECT count(*) FROM collaborative_draft_record WHERE draft_id=$1 AND NOT deleted",
              [draftId],
            )
          ).rows[0].count,
        ),
      ).toBe(24);
      const stored = (
        await db.query("SELECT input_ref FROM processing_run WHERE id=$1", [
          run.id,
        ])
      ).rows[0].input_ref;
      const discarded = await app.inject({
        method: "DELETE",
        url: `/api/projects/${projectId}/collaborative-drafts/${draftId}`,
        headers,
      });
      expect(discarded.statusCode, discarded.body).toBe(204);
      expect(
        (await app.inject({ method: "GET", url: `${path}/${run.id}`, headers }))
          .statusCode,
      ).toBe(404);
      await cleanupProcessingObjects(db, artifacts, projectId);
      expect(
        (
          await db.query(
            "SELECT input_ref,options FROM processing_run WHERE id=$1",
            [run.id],
          )
        ).rows[0],
      ).toMatchObject({ input_ref: null, options: { instructions: "" } });
      await expect(artifacts.size(stored)).rejects.toThrow();
      // Accepted asset is independent and keeps its own bytes after the source draft is discarded.
      const asset = (
        await db.query("SELECT object_ref FROM data_asset WHERE id=$1", [
          accepted.json().receipt.assetId,
        ])
      ).rows[0];
      expect(await artifacts.size(asset.object_ref)).toBeGreaterThan(0);
    } finally {
      await db.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("executes a submitted task through the real model worker and reports persisted completion", async () => {
    const db = createPool(databaseUrl);
    let worker: ReturnType<typeof spawn> | undefined;
    try {
      const asset = (
        await db.query(
          "SELECT da.id FROM data_asset da JOIN parsed_view pv ON pv.asset_id=da.id AND pv.is_current WHERE da.project_id=$1 AND da.status='stored' AND pv.mapping_ready ORDER BY da.uploaded_at LIMIT 1",
          [projectId],
        )
      ).rows[0];
      const created = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/processing-runs`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          source: {
            kind: "assets",
            assetIds: [asset.id],
            recordIds: [`${asset.id}:1`],
          },
          options: {
            operation: "clean",
            instructions: "",
            allowedFields: ["question"],
          },
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const run = created.json().run;
      let logs = "";
      worker = spawn(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), "src/worker/main.ts"],
        {
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl,
            WORKER_TASK_GROUP: "model",
            WORKER_HEALTH_PORT: "0",
            RUNTIME_METRICS_ENABLED: "false",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      worker.stdout?.on("data", (chunk) => {
        logs += String(chunk);
      });
      worker.stderr?.on("data", (chunk) => {
        logs += String(chunk);
      });
      await expect
        .poll(
          async () => {
            if (worker?.exitCode !== null)
              throw new Error(`Worker exited: ${logs}`);
            return (
              await db.query("SELECT status FROM job WHERE id=$1", [run.jobId])
            ).rows[0].status;
          },
          { timeout: 20000 },
        )
        .toBe("succeeded");
      const read = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/processing-runs/${run.id}`,
        headers,
      });
      expect(read.json().total).toBe(1);
      expect(read.json().allIds).toEqual(["0:0"]);
      expect(read.json().run.status).toBe("succeeded");
    } finally {
      if (worker && worker.exitCode === null) {
        worker.kill("SIGTERM");
        await new Promise<void>((resolve) =>
          worker!.once("exit", () => resolve()),
        );
      }
      await db.end();
    }
  });

  it("isolates run bodies and preserves per-record Metadata through adoption, publication and receipt replay", async () => {
    const base = `/api/projects/${projectId}/collaborative-drafts`,
      path = `/api/projects/${projectId}/processing-runs`;
    const draft = await app.inject({
        method: "POST",
        url: base,
        headers,
        payload: {},
      }),
      draftId = draft.json().draft.id;
    const rowIds: string[] = [];
    for (const key of ["Tag", "tag"]) {
      const row = await app.inject({
        method: "POST",
        url: `${base}/${draftId}/records`,
        headers,
        payload: {
          question: `  ${key}  `,
          expectedOutput: "keep",
          metadata: [{ key, value: "" }],
        },
      });
      expect(row.statusCode, row.body).toBe(201);
      rowIds.push(row.json().record.id);
    }
    const payload = {
      source: { kind: "draft", id: draftId, recordIds: rowIds },
      options: {
        operation: "clean",
        instructions: "",
        allowedFields: ["question"],
      },
    };
    const submit = () =>
      app.inject({
        method: "POST",
        url: path,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload,
      });
    const a = await submit(),
      b = await submit();
    expect(a.statusCode, a.body).toBe(201);
    expect(b.statusCode, b.body).toBe(201);
    const db = createPool(databaseUrl),
      config = { ...loadConfig(), databaseUrl },
      artifacts = new ArtifactRepository(config.minio);
    try {
      const refs = (
        await db.query(
          "SELECT input_ref FROM processing_run WHERE id=ANY($1::text[])",
          [[a.json().run.id, b.json().run.id]],
        )
      ).rows.map((r) => r.input_ref);
      expect(new Set(refs).size).toBe(2);
      const run = a.json().run,
        job = (
          await db.query(
            "UPDATE job SET status='running',attempt=1,lease_owner='review-test',lease_expires_at=now()+interval '30 seconds' WHERE id=$1 RETURNING *",
            [run.jobId],
          )
        ).rows[0];
      const result = await runProcessing(db, artifacts, config, job);
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, result],
      );
      const accept = {
        method: "POST" as const,
        url: `${path}/${run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          resultIds: ["0:0", "0:1"],
          target: { kind: "draft", id: draftId, expectedRevision: 2 },
        },
      };
      const adopted = await app.inject(accept);
      expect(adopted.statusCode, adopted.body).toBe(201);
      const filePreview = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/processing-inputs`,
        headers,
        payload: {
          source: {
            kind: "assets",
            assetIds: [adopted.json().receipt.assetId],
          },
        },
      });
      expect(filePreview.statusCode, filePreview.body).toBe(200);
      expect(filePreview.json().records.map((r: any) => r.metadata)).toEqual([
        [{ key: "Tag", value: "" }],
        [{ key: "tag", value: "" }],
      ]);
      const name = await app.inject({
        method: "PATCH",
        url: `${base}/${draftId}`,
        headers,
        payload: {
          field: "name",
          value: "处理来源验证",
          expectedFieldRevision: 0,
        },
      });
      expect(name.statusCode, name.body).toBe(200);
      const snapshot = await app.inject({
        method: "GET",
        url: `${base}/${draftId}`,
        headers,
      });
      const published = await app.inject({
        method: "POST",
        url: `${base}/${draftId}/publish`,
        headers,
        payload: { revision: snapshot.json().draft.revision },
      });
      expect(published.statusCode, published.body).toBe(201);
      const provenance = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/solo-test-sets/${published.json().testSet.id}/versions/${published.json().version.id}/provenance?status=all&limit=20&offset=0`,
        headers,
      });
      expect(provenance.statusCode, provenance.body).toBe(200);
      expect(provenance.json().changes[0].source).toMatchObject({
        ordinal: 1,
        fileName: expect.stringMatching(/^清洗结果-[a-f0-9]+\.jsonl$/),
        processing: { runId: run.id, operation: "clean", inputKind: "draft" },
      });
      const replay = await app.inject(accept);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json().receipt).toEqual(adopted.json().receipt);
      const history = await app.inject({
        method: "GET",
        url: `${path}/${run.id}`,
        headers,
      });
      expect(history.statusCode, history.body).toBe(200);
    } finally {
      await db.end();
    }
  });

  it("does not persist a late model response after the source was discarded", async () => {
    const base = `/api/projects/${projectId}/collaborative-drafts`,
      path = `/api/projects/${projectId}/processing-runs`;
    const d = await app.inject({
        method: "POST",
        url: base,
        headers,
        payload: {},
      }),
      id = d.json().draft.id;
    const row = await app.inject({
      method: "POST",
      url: `${base}/${id}/records`,
      headers,
      payload: { question: "private input", expectedOutput: "", metadata: [] },
    });
    let entered!: () => void, release!: () => void;
    const received = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (release = r));
    const server = createServer(async (req, res) => {
      for await (const chunk of req) {
        void chunk;
      }
      entered();
      await gate;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "test",
          object: "chat.completion",
          created: 1,
          model: "synthetic",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  records: [
                    {
                      sourceId: row.json().record.id,
                      question: "private output",
                      expectedOutput: "",
                      metadata: [],
                    },
                  ],
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const db = createPool(databaseUrl),
      config = {
        ...loadConfig(),
        databaseUrl,
        modelEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
      },
      artifacts = new ArtifactRepository(config.minio);
    try {
      const revision =
        (
          await db.query(
            "SELECT max(revision) AS revision FROM model_connection",
          )
        ).rows[0].revision ?? 0;
      const model = await app.inject({
        method: "PUT",
        url: "/api/settings/model-connection",
        headers,
        payload: {
          revision: Number(revision),
          name: "延迟响应测试",
          endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
          model: "synthetic",
          apiKey: "synthetic-test-key",
          enabled: true,
        },
      });
      expect(model.statusCode, model.body).toBe(200);
      const created = await app.inject({
        method: "POST",
        url: path,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          source: { kind: "draft", id, recordIds: [row.json().record.id] },
          options: {
            operation: "rewrite",
            instructions: "Rewrite",
            allowedFields: ["question"],
          },
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const run = created.json().run,
        job = (
          await db.query(
            "UPDATE job SET status='running',attempt=1,lease_owner='late-test',lease_expires_at=now()+interval '30 seconds' WHERE id=$1 RETURNING *",
            [run.jobId],
          )
        ).rows[0];
      const writes = vi.spyOn(artifacts, "storeProcessing");
      const pending = runProcessing(db, artifacts, config, job).then(
        () => null,
        (e) => e,
      );
      await received;
      const deletion = await app.inject({
        method: "DELETE",
        url: `${base}/${id}`,
        headers,
      });
      expect(deletion.statusCode, deletion.body).toBe(204);
      release();
      expect(await pending).toBeInstanceOf(Error);
      expect(writes).not.toHaveBeenCalled();
      expect(await artifacts.list(`processing/${run.id}/`)).toHaveLength(0);
    } finally {
      release();
      await db.end();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("checks the resulting source set when replacing a five-file draft", async () => {
    const base = `/api/projects/${projectId}/collaborative-drafts`,
      path = `/api/projects/${projectId}/processing-runs`,
      db = createPool(databaseUrl),
      config = { ...loadConfig(), databaseUrl },
      artifacts = new ArtifactRepository(config.minio);
    try {
      const source = (
        await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: { name: "容量测试来源" },
        })
      ).json().draft.id;
      const recordIds: string[] = [];
      for (let index = 0; index < 5; index++)
        recordIds.push(
          (
            await app.inject({
              method: "POST",
              url: `${base}/${source}/records`,
              headers,
              payload: {
                question: `不同的容量测试问题 ${index + 1}`,
                expectedOutput: "",
                metadata: [],
              },
            })
          ).json().record.id,
        );
      const submittedSource = await app.inject({
        method: "POST",
        url: path,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          source: { kind: "draft", id: source, recordIds },
          options: {
            operation: "clean",
            instructions: "",
            allowedFields: ["question"],
          },
        },
      });
      expect(submittedSource.statusCode, submittedSource.body).toBe(201);
      const sourceRun = submittedSource.json().run;
      const sourceJob = (
        await db.query(
          "UPDATE job SET status='running',attempt=1,lease_owner='capacity-test',lease_expires_at=now()+interval '30 seconds' WHERE id=$1 RETURNING *",
          [sourceRun.jobId],
        )
      ).rows[0];
      const sourceResult = await runProcessing(
        db,
        artifacts,
        config,
        sourceJob,
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [sourceJob.id, sourceResult],
      );
      const previous = {
        id: sourceRun.id,
        ordinal: 0,
        result_indices: [] as number[],
      };
      const d = await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: {},
        }),
        id = d.json().draft.id;
      await db.query(
        "UPDATE job SET status='succeeded' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
        [previous.id],
      );
      for (let revision = 0; revision < 5; revision++) {
        const response = await app.inject({
          method: "POST",
          url: `${path}/${previous.id}/accept`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            resultIds: [
              `${previous.ordinal}:${previous.result_indices?.[revision] ?? revision}`,
            ],
            target: { kind: "draft", id, expectedRevision: revision },
          },
        });
        expect(response.statusCode, response.body).toBe(201);
      }
      const rows = (
        await db.query(
          "SELECT id,source FROM collaborative_draft_record WHERE draft_id=$1",
          [id],
        )
      ).rows;
      expect(new Set(rows.map((r) => r.source.assetId)).size).toBe(5);
      const submitted = await app.inject({
        method: "POST",
        url: path,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          source: { kind: "draft", id, recordIds: rows.map((r) => r.id) },
          options: {
            operation: "clean",
            instructions: "",
            allowedFields: ["question"],
          },
        },
      });
      expect(submitted.statusCode, submitted.body).toBe(201);
      const run = submitted.json().run,
        job = (
          await db.query(
            "UPDATE job SET status='running',attempt=1,lease_owner='capacity-test',lease_expires_at=now()+interval '30 seconds' WHERE id=$1 RETURNING *",
            [run.jobId],
          )
        ).rows[0];
      const result = await runProcessing(db, artifacts, config, job);
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, result],
      );
      const accepted = await app.inject({
        method: "POST",
        url: `${path}/${run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          resultIds: rows.map((_, i) => `0:${i}`),
          target: { kind: "draft", id, expectedRevision: 5 },
        },
      });
      expect(accepted.statusCode, accepted.body).toBe(201);
      expect(
        (
          await db.query(
            "SELECT count(DISTINCT source->>'assetId')::int AS count FROM collaborative_draft_record WHERE draft_id=$1",
            [id],
          )
        ).rows[0].count,
      ).toBe(1);
    } finally {
      await db.end();
    }
  });

  it.each([
    [0, false],
    [1, false],
    [1, true],
    [0, false, true],
  ] as const)(
    "recovers only missing rewrite outputs without replacing successful candidates (retained %i, legacy %s)",
    async (retainedIndex, legacy, malformed: boolean = false) => {
      const draft = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts`,
        headers,
        payload: {},
      });
      const draftId = draft.json().draft.id,
        ids: string[] = [];
      for (const question of ["First source", "Second source"]) {
        const row = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/collaborative-drafts/${draftId}/records`,
          headers,
          payload: { question, expectedOutput: "Protected", metadata: [] },
        });
        expect(row.statusCode, row.body).toBe(201);
        ids.push(row.json().record.id);
      }
      let recovering = malformed;
      const calls: string[][] = [];
      const server = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        const instruction = JSON.parse(
          JSON.parse(body).messages.at(-1).content,
        );
        calls.push(instruction.records.map((row: { id: string }) => row.id));
        // The first response is valid but incomplete; bounded corrections cannot fix it yet.
        const chosen = recovering
          ? instruction.records
          : calls.length === 1
            ? [instruction.records[retainedIndex]]
            : [];
        const records = chosen.map((row: { id: string; question: string }) => ({
          sourceId: row.id,
          question: `${recovering ? "Recovered" : "Accepted"} ${row.question}`,
        }));
        if (malformed)
          records.push(
            { sourceId: "unknown", question: "Invalid source" },
            records[0],
            { sourceId: ids[0], question: 42 as unknown as string },
          );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "missing-output",
            object: "chat.completion",
            created: 1,
            model: "synthetic",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify({ records }),
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const db = createPool(databaseUrl),
        config = {
          ...loadConfig(),
          databaseUrl,
          modelEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
        },
        artifacts = new ArtifactRepository(config.minio);
      try {
        const connection = await app.inject({
          method: "GET",
          url: "/api/settings/model-connection",
          headers,
        });
        const configured = await app.inject({
          method: "PUT",
          url: "/api/settings/model-connection",
          headers,
          payload: {
            revision: connection.json().connection?.revision ?? 0,
            name: "缺失恢复测试",
            endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
            model: "synthetic",
            apiKey: "synthetic-test-key",
            enabled: true,
          },
        });
        expect(configured.statusCode, configured.body).toBe(200);
        const path = `/api/projects/${projectId}/processing-runs`;
        const submitted = await app.inject({
          method: "POST",
          url: path,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            source: { kind: "draft", id: draftId, recordIds: ids },
            options: {
              operation: "rewrite",
              instructions: "Rewrite both questions",
              allowedFields: ["question"],
            },
          },
        });
        expect(submitted.statusCode, submitted.body).toBe(201);
        const run = submitted.json().run;
        async function execute() {
          const job = (
            await db.query(
              "UPDATE job SET status='running',attempt=attempt+1,lease_owner='missing-test',lease_expires_at=now()+interval '60 seconds' WHERE id=$1 RETURNING *",
              [run.jobId],
            )
          ).rows[0];
          try {
            const result = await runProcessing(db, artifacts, config, job);
            await db.query(
              "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
              [job.id, result],
            );
          } catch (error) {
            expect((error as Error).message).toBe("processing_batch_failed");
            await db.query(
              "UPDATE job SET status='failed',error_code='processing_batch_failed' WHERE id=$1",
              [job.id],
            );
          }
        }
        await execute();
        if (malformed) {
          const malformedRead = await app.inject({
            method: "GET",
            url: `${path}/${run.id}`,
            headers,
          });
          expect(malformedRead.statusCode, malformedRead.body).toBe(200);
          expect(malformedRead.json().total).toBe(2);
          expect(malformedRead.json().run.partial).toBe(true);
          expect(malformedRead.json().issues).toContainEqual(
            expect.objectContaining({ code: "unknown_source" }),
          );
          expect(malformedRead.json().issues).toContainEqual(
            expect.objectContaining({ code: "duplicate_source" }),
          );
          return;
        }
        if (legacy) {
          // Fixture for an old binary that persisted incomplete output as succeeded, with compact IDs.
          await db.query(
            "UPDATE processing_batch SET error_code=NULL,result_indices=ARRAY[0] WHERE run_id=$1",
            [run.id],
          );
          await db.query(
            "UPDATE job SET status='succeeded',error_code=NULL WHERE id=$1",
            [run.jobId],
          );
        }
        const before = await app.inject({
          method: "GET",
          url: `${path}/${run.id}`,
          headers,
        });
        expect(before.json().total).toBe(1);
        expect(before.json().run.partial).toBe(true);
        expect(before.json().run.missingCount).toBe(1);
        const status = await app.inject({
          method: "GET",
          url: `${path}/${run.id}/status`,
          headers,
        });
        expect(status.statusCode, status.body).toBe(200);
        expect(status.json().run.missingCount).toBe(1);
        const retry = await app.inject({
          method: "POST",
          url: `${path}/${run.id}/retry`,
          headers,
          payload: {},
        });
        expect(retry.statusCode, retry.body).toBe(200);
        expect(retry.json().run.status).toBe("queued");
        recovering = true;
        const recoveryStart = calls.length;
        await execute();
        const missingIndex = 1 - retainedIndex;
        expect(calls.slice(recoveryStart)).toEqual([[ids[missingIndex]]]);
        const after = await app.inject({
          method: "GET",
          url: `${path}/${run.id}`,
          headers,
        });
        expect(after.json().run.status).toBe("succeeded");
        expect(after.json().total).toBe(2);
        expect(after.json().run.missingCount).toBe(0);
        expect(
          after
            .json()
            .records.find(
              (row: { id: string }) => row.id === before.json().records[0].id,
            ),
        ).toEqual(before.json().records[0]);
        expect(after.json().allIds).toEqual(
          legacy ? ["0:1", "0:0"] : ["0:0", "0:1"],
        );
        expect(after.json().records[missingIndex].result).toMatchObject({
          sourceId: ids[missingIndex],
          question: `Recovered ${missingIndex ? "Second" : "First"} source`,
          expectedOutput: "Protected",
        });
        expect(after.json().issues).not.toContainEqual(
          expect.objectContaining({ code: "missing_output" }),
        );
      } finally {
        await db.end();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
