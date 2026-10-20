import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cleanupProcessingObjects } from "../../src/processing/cleanup.js";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";

import { runProcessing as executeProcessing } from "../../src/processing/execute.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import { acceptProcessingResults } from "../../src/processing/accept.js";
import { createRefinementRun } from "../../src/processing/refine.js";
import {
  processingNameRepairs,
  applyProcessingNameRepairs,
} from "../../src/processing/names.js";

const origin = "http://127.0.0.1:4217";
const databaseName = `processing_${randomUUID().replaceAll("-", "")}`;
const baseUrl = loadConfig().databaseUrl;
const databaseUrl = baseUrl.replace(/\/[^/]+$/, `/${databaseName}`);

describe("durable data processing", () => {
  let app: AgentBenchApp;
  let headers: Record<string, string>;
  let projectId: string;
  let collectionId: string;
  let opt31Recipe = false;
  let fixtureDb: ReturnType<typeof createPool>;
  async function runProcessing(...args: Parameters<typeof executeProcessing>) {
    if (!opt31Recipe)
      await args[0].query(
        "UPDATE processing_run SET execution_config=jsonb_set(execution_config,'{recipeVersion}','\"processing-v7\"') WHERE id=$1 AND execution_config->>'recipeVersion'='processing-v11'",
        [args[3].payload.runId],
      );
    return executeProcessing(...args);
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
    fixtureDb = createPool(databaseUrl);
    // Older fixed relays exercise their original frozen recipe; OPT31 covers the new default.
    app.addHook("onSend", async (request, reply, payload) => {
      if (
        !opt31Recipe &&
        request.method === "POST" &&
        reply.statusCode === 201 &&
        typeof payload === "string"
      ) {
        const run = JSON.parse(payload).run;
        if (run?.id)
          await fixtureDb.query(
            "UPDATE processing_run SET execution_config=jsonb_set(execution_config,'{recipeVersion}','\"processing-v7\"') WHERE id=$1 AND options->>'operation'<>'generate'",
            [run.id],
          );
      }
      return payload;
    });
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
    await fixtureDb?.end();
    const root = createPool(baseUrl);
    try {
      await root.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await root.end();
    }
  });
  it("paginates bounded task summaries and searches the full visible history", async () => {
    const upload = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-uploads`,
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "x-file-name": "loading-origin.jsonl",
      },
      payload: '{"question":"Q","answer":"A"}\n',
    });
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-upload-batches/confirm`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        collectionId,
        pendingUploadIds: [upload.json().pendingUpload.id],
        mode: "raw",
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    const assetId = confirmed.json().assets[0].id;
    const mappingUrl = `/api/projects/${projectId}/assets/${assetId}/mapping`;
    const mapping = await app.inject({
      method: "GET",
      url: mappingUrl,
      headers,
    });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: mappingUrl,
          headers,
          payload: {
            parsedViewId: mapping.json().parsedViewId,
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
    const path = `/api/projects/${projectId}/processing-runs`;
    const db = createPool(databaseUrl);
    const ids: string[] = [];
    try {
      for (let i = 0; i < 25; i++) {
        const created = await app.inject({
          method: "POST",
          url: path,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            source: {
              kind: "assets",
              assetIds: [assetId],
              recordIds: [`${assetId}:1`],
            },
            options: {
              operation: "clean",
              instructions: "",
              allowedFields: ["question"],
            },
          },
        });
        expect(created.statusCode, created.body).toBe(201);
        ids.push(created.json().run.id);
        await db.query(
          "UPDATE processing_run SET created_at=now()-($2*interval '1 second'),options=jsonb_set(options,'{instructions}',to_jsonb($3::text)) WHERE id=$1",
          [
            ids[i],
            i,
            `${i === 24 ? "最后一项关键词" : "整理"}${"说明".repeat(2000)}`,
          ],
        );
        await db.query(
          "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
          [
            created.json().run.jobId,
            { privateBody: "not-for-list".repeat(2000) },
          ],
        );
      }
      const first = await app.inject({
        method: "GET",
        url: `${path}?limit=20&offset=0`,
        headers,
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().runs).toHaveLength(20);
      expect(first.json().pagination).toMatchObject({
        total: 25,
        limit: 20,
        offset: 0,
      });
      expect(first.json().hasActive).toBe(false);
      expect(first.json().runs[0].source).not.toHaveProperty("recordIds");
      expect(first.json().runs[0]).not.toHaveProperty("execution");
      expect(first.json().runs[0]).not.toHaveProperty("result");
      expect(
        first.json().runs[0].options.instructions.length,
      ).toBeLessThanOrEqual(241);
      expect(first.body).not.toContain("not-for-list");
      const second = await app.inject({
        method: "GET",
        url: `${path}?limit=20&offset=20`,
        headers,
      });
      expect(second.json().runs.map((run: { id: string }) => run.id)).toEqual(
        ids.slice(20),
      );
      const matching = await app.inject({
        method: "GET",
        url: `${path}?search=${encodeURIComponent("最后一项关键词")}&status=succeeded`,
        headers,
      });
      expect(matching.json().pagination.total).toBe(1);
      expect(matching.json().runs[0].id).toBe(ids[24]);
      const empty = await app.inject({
        method: "GET",
        url: `${path}?status=failed`,
        headers,
      });
      expect(empty.json().pagination.total).toBe(0);
      await db.query(
        "UPDATE job SET status='queued' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
        [ids[24]],
      );
      expect(
        (await app.inject({ method: "GET", url: path, headers })).json()
          .hasActive,
      ).toBe(true);
      for (const query of [
        "limit=21",
        "limit=0",
        "offset=-1",
        "offset=1.5",
        "status=unknown",
        `search=${"a".repeat(201)}`,
      ])
        expect(
          (
            await app.inject({
              method: "GET",
              url: `${path}?${query}`,
              headers,
            })
          ).statusCode,
        ).toBe(422);
      await db.query("UPDATE data_asset SET status='archived' WHERE id=$1", [
        assetId,
      ]);
      const inaccessible = await app.inject({
        method: "GET",
        url: path,
        headers,
      });
      expect(inaccessible.json().runs).toEqual([]);
      expect(inaccessible.json().pagination.total).toBe(0);
      expect(inaccessible.json().hasActive).toBe(false);
    } finally {
      await db.end();
    }
  });
  it("filters processing input across pages and retains source identity in saved results", async () => {
    const upload = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-uploads`,
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "x-file-name": "selection-origin.jsonl",
      },
      payload:
        Array.from({ length: 45 }, (_, i) =>
          JSON.stringify({
            question: i === 44 ? "" : `  Q ${i + 1}  `,
            answer: "Protected",
            category: i % 2 ? "B" : "A",
          }),
        ).join("\n") + "\n",
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-upload-batches/confirm`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        collectionId,
        pendingUploadIds: [upload.json().pendingUpload.id],
        mode: "raw",
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    const assetId = confirmed.json().assets[0].id;
    const mapping = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/assets/${assetId}/mapping`,
      headers,
    });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/projects/${projectId}/assets/${assetId}/mapping`,
          headers,
          payload: {
            parsedViewId: mapping.json().parsedViewId,
            expectedRevision: 0,
            mapping: {
              question: "/question",
              expectedOutput: "/answer",
              metadata: ["/category"],
            },
          },
        })
      ).statusCode,
    ).toBe(200);
    const source = { kind: "assets", assetIds: [assetId] };
    const preview = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/processing-inputs`,
      headers,
      payload: {
        source,
        offset: 20,
        limit: 20,
        conditions: [
          {
            field: "metadata",
            key: "category",
            operator: "equals",
            value: "A",
          },
        ],
        selectedIds: [`${assetId}:1`, `${assetId}:2`],
      },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      total: 23,
      metadataKeys: ["category"],
      sourceTotal: 45,
      hiddenSelected: 1,
      sourceSummary: { name: "selection-origin.jsonl" },
    });
    expect(preview.json().sourceRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.json().records.map((row: any) => row.id)).toEqual([
      `${assetId}:41`,
      `${assetId}:43`,
      `${assetId}:45`,
    ]);
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/processing-runs`,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        source: {
          ...source,
          recordIds: Array.from(
            { length: 45 },
            (_, i) => `${assetId}:${i + 1}`,
          ),
        },
        options: {
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const run = created.json().run,
      db = createPool(databaseUrl),
      config = { ...loadConfig(), databaseUrl };
    try {
      const claimed = await db.query(
        "UPDATE job SET status='running',attempt=attempt+1,lease_owner='processing-test',lease_expires_at=now()+interval '60 seconds' WHERE id=$1 RETURNING *",
        [run.jobId],
      );
      const result = await runProcessing(
        db,
        new ArtifactRepository(config.minio),
        config,
        claimed.rows[0],
      );
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [run.jobId, result],
      );
      const path = `/api/projects/${projectId}/processing-runs/${run.id}`;
      const changed = await app.inject({
        method: "GET",
        url: `${path}?view=changed&limit=20`,
        headers,
      });
      expect(changed.json()).toMatchObject({
        total: 44,
        stats: { all: 45, changed: 44, needsReview: 45 },
        run: {
          sourceSummary: { name: "selection-origin.jsonl" },
          actorName: "管理员",
        },
      });
      expect(changed.json().run.executionComplete).toBe(true);
      const bySource = await app.inject({
        method: "GET",
        url: `${path}?view=all&search=selection-origin.jsonl&offset=40&limit=2`,
        headers,
      });
      expect(bySource.statusCode, bySource.body).toBe(200);
      expect(bySource.json()).toMatchObject({
        total: 45,
        stats: { all: 45, changed: 44, needsReview: 45 },
      });
      expect(bySource.json().records).toHaveLength(2);
      expect(bySource.json().allIds).toHaveLength(45);
      const noMatch = await app.inject({
        method: "GET",
        url: `${path}?view=all&search=no-such-field-value`,
        headers,
      });
      expect(noMatch.json()).toMatchObject({
        total: 0,
        allIds: [],
        records: [],
        stats: { all: 0, changed: 0, needsReview: 0 },
      });
      const warning = await app.inject({
        method: "GET",
        url: `${path}?view=issues&limit=100`,
        headers,
      });
      expect(warning.json().records).toHaveLength(45);
      expect(
        warning
          .json()
          .records.find((row: any) =>
            row.issues.some((issue: any) => issue.code === "empty_question"),
          ).original.id,
      ).toBe(`${assetId}:45`);
      const accepted = await app.inject({
        method: "POST",
        url: `${path}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          resultIds: [changed.json().records[0].id],
          target: { kind: "newDraft", name: "Origin draft", purpose: "" },
        },
      });
      expect(accepted.statusCode, accepted.body).toBe(201);
      const refreshed = await app.inject({
        method: "GET",
        url: `${path}?view=all`,
        headers,
      });
      expect(refreshed.json().receipts).toContainEqual(
        expect.objectContaining({
          adopted: 1,
          draftId: accepted.json().receipt.draftId,
        }),
      );
      const draft = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/collaborative-drafts/${accepted.json().receipt.draftId}`,
        headers,
      });
      expect(draft.json().records[0].sourcePresentation).toMatchObject({
        label: "selection-origin.jsonl · 第 1 条",
        badges: ["已清洗"],
      });
      expect(draft.json().records[0].source.assetId).toBe(
        accepted.json().receipt.assetId,
      );
    } finally {
      await db.end();
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
  it("keeps active runs in progress despite validation issues and marks terminal partial outcomes", async () => {
    const base = `/api/projects/${projectId}/collaborative-drafts`;
    const draft = await app.inject({
      method: "POST",
      url: base,
      headers,
      payload: {},
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const row = await app.inject({
      method: "POST",
      url: `${base}/${draft.json().draft.id}/records`,
      headers,
      payload: { question: "", expectedOutput: "保留原标签", metadata: [] },
    });
    expect(row.statusCode, row.body).toBe(201);
    const path = `/api/projects/${projectId}/processing-runs`;
    const submitted = await app.inject({
      method: "POST",
      url: path,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        source: {
          kind: "draft",
          id: draft.json().draft.id,
          recordIds: [row.json().record.id],
        },
        options: {
          operation: "clean",
          instructions: "",
          allowedFields: ["question"],
        },
      },
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const run = submitted.json().run;
    const db = createPool(databaseUrl),
      config = { ...loadConfig(), databaseUrl };
    const artifacts = new ArtifactRepository(config.minio);
    try {
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=attempt+1,lease_owner='active-status-test',lease_expires_at=now()+interval '30 seconds' WHERE id=$1 RETURNING *",
          [run.jobId],
        )
      ).rows[0];
      const result = await runProcessing(db, artifacts, config, job);
      const detail = await app.inject({
        method: "GET",
        url: `${path}/${run.id}`,
        headers,
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().issues).toContainEqual(
        expect.objectContaining({ code: "empty_question" }),
      );
      expect(detail.json().run).toMatchObject({
        status: "running",
        partial: false,
      });
      const active = await app.inject({
        method: "GET",
        url: `${path}/${run.id}/status`,
        headers,
      });
      expect(active.statusCode, active.body).toBe(200);
      expect(active.json()).toMatchObject({
        run: { status: "running", partial: false, errorCode: null },
        total: 1,
      });
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, result],
      );
      const terminal = await app.inject({
        method: "GET",
        url: `${path}/${run.id}/status`,
        headers,
      });
      expect(terminal.statusCode, terminal.body).toBe(200);
      expect(terminal.json()).toMatchObject({
        run: { status: "succeeded", partial: true, missingCount: 0 },
        total: 1,
      });
      const finished = await app.inject({
        method: "GET",
        url: `${path}/${run.id}`,
        headers,
      });
      expect(finished.json().run).toMatchObject({
        status: "succeeded",
        partial: true,
        executionComplete: true,
      });
      // Legacy partial-only evidence must not be presented as proven completion.
      await db.query(
        "UPDATE processing_batch SET issues='[]' WHERE run_id=$1",
        [run.id],
      );
      await db.query("UPDATE job SET result=$2 WHERE id=$1", [
        job.id,
        { partial: true },
      ]);
      const uncertain = await app.inject({
        method: "GET",
        url: `${path}/${run.id}`,
        headers,
      });
      expect(uncertain.json().run).toMatchObject({
        status: "succeeded",
        missingCount: 0,
        executionComplete: false,
      });
    } finally {
      await db.end();
    }
  });

  it("preserves legacy v6 field protection, failed-batch recovery and stale-field adoption", async () => {
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
      // Frozen pre-OPT18 runs keep their original correction behavior.
      await db.query(
        "UPDATE processing_run SET execution_config=jsonb_set(execution_config,'{recipeVersion}','\"processing-v6\"') WHERE id=$1",
        [run.id],
      );
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

  it("traces per-record refinements and generated-then-cleaned origins without leaking inaccessible sources", async () => {
    const db = createPool(databaseUrl),
      config = {
        ...loadConfig(),
        databaseUrl,
        modelEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
      },
      artifacts = new ArtifactRepository(config.minio);
    const server = createServer(async (request, response) => {
      let text = "";
      for await (const chunk of request) text += chunk;
      const instruction = JSON.parse(JSON.parse(text).messages.at(-1).content);
      const inputs =
        instruction.operation === "augment"
          ? Array.from(
              { length: instruction.outputCount },
              (_, i) => instruction.records[i % instruction.records.length],
            )
          : instruction.records;
      const records = inputs.map((row: any, index: number) => ({
        sourceId: row.id,
        question:
          instruction.operation === "augment"
            ? `  新问题 ${index}  `
            : row.question,
        expectedOutput: "FORGED",
        metadata: [
          ...row.metadata.filter((entry: any) => entry.key !== "gbRisk"),
          { key: "gbRisk", value: "A.1" },
        ],
      }));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "synthetic",
          object: "chat.completion",
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
    try {
      const revision = Number(
        (
          await db.query(
            "SELECT coalesce(max(revision),0) AS revision FROM model_connection",
          )
        ).rows[0].revision,
      );
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/settings/model-connection",
            headers,
            payload: {
              revision,
              name: "可控模型",
              endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
              model: "synthetic",
              apiKey: "synthetic-key",
              enabled: true,
            },
          })
        ).statusCode,
      ).toBe(200);
      const upload = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/pending-uploads`,
        headers: {
          ...headers,
          "content-type": "application/octet-stream",
          "x-file-name": "original-basis.jsonl",
        },
        payload:
          Array.from({ length: 12 }, (_, i) =>
            JSON.stringify({
              question: `Q${i}`,
              answer: "Protected",
              category: "normal",
            }),
          ).join("\n") + "\n",
      });
      const confirmed = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/pending-upload-batches/confirm`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          collectionId,
          pendingUploadIds: [upload.json().pendingUpload.id],
          mode: "raw",
        },
      });
      expect(confirmed.statusCode, confirmed.body).toBe(201);
      const assetId = confirmed.json().assets[0].id;
      const mapping = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/assets/${assetId}/mapping`,
        headers,
      });
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/api/projects/${projectId}/assets/${assetId}/mapping`,
            headers,
            payload: {
              parsedViewId: mapping.json().parsedViewId,
              expectedRevision: 0,
              mapping: {
                question: "/question",
                expectedOutput: "/answer",
                metadata: ["/category"],
              },
            },
          })
        ).statusCode,
      ).toBe(200);
      const path = `/api/projects/${projectId}/processing-runs`;
      async function finish(run: any) {
        const job = (
          await db.query(
            "UPDATE job SET status='running',attempt=1,lease_owner='origin-test',lease_expires_at=now()+interval '30 seconds' WHERE id=$1 RETURNING *",
            [run.jobId],
          )
        ).rows[0];
        const result = await runProcessing(db, artifacts, config, job);
        await db.query(
          "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
          [job.id, result],
        );
      }
      const expanded = await app.inject({
        method: "POST",
        url: path,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          source: {
            kind: "assets",
            assetIds: [assetId],
            recordIds: [1, 2, 3].map((n) => `${assetId}:${n}`),
          },
          options: {
            operation: "augment",
            instructions: "参考三条新增七条",
            allowedFields: ["question"],
            outputCount: 7,
          },
        },
      });
      expect(expanded.statusCode, expanded.body).toBe(201);
      await finish(expanded.json().run);
      const initial = await app.inject({
        method: "GET",
        url: `${path}/${expanded.json().run.id}?view=all`,
        headers,
      });
      expect(initial.json().records).toHaveLength(7);
      async function follow(
        parent: string,
        resultIds: string[],
        operation: string,
        outputCount?: number,
      ) {
        const key = randomUUID();
        const payload = {
          mode: "continue",
          resultIds,
          options: {
            operation,
            instructions: operation === "clean" ? "" : "处理所选记录",
            allowedFields:
              operation === "rewrite" ? ["metadata"] : ["question"],
            ...(outputCount ? { outputCount } : {}),
          },
        };
        const response = await app.inject({
          method: "POST",
          url: `${path}/${parent}/followups`,
          headers: { ...headers, "idempotency-key": key },
          payload,
        });
        expect(response.statusCode, response.body).toBe(201);
        const replay = await app.inject({
          method: "POST",
          url: `${path}/${parent}/followups`,
          headers: { ...headers, "idempotency-key": key },
          payload,
        });
        expect(replay.statusCode, replay.body).toBe(200);
        expect(replay.json().run.id).toBe(response.json().run.id);
        await finish(response.json().run);
        const data = await app.inject({
          method: "GET",
          url: `${path}/${response.json().run.id}?view=all`,
          headers,
        });
        expect(data.statusCode, data.body).toBe(200);
        return data.json();
      }
      const parentId = expanded.json().run.id;
      const beforeCount = (
        await db.query(
          "SELECT count(*)::int AS count FROM processing_run WHERE project_id=$1",
          [projectId],
        )
      ).rows[0].count;
      const originalHash = (
        await db.query("SELECT input_hash FROM processing_run WHERE id=$1", [
          parentId,
        ])
      ).rows[0].input_hash;
      await db.query(
        "UPDATE processing_run SET input_hash='corrupt-test-snapshot' WHERE id=$1",
        [parentId],
      );
      const corrupt = await app.inject({
        method: "POST",
        url: `${path}/${parentId}/followups`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          mode: "rerun",
          options: {
            operation: "clean",
            instructions: "",
            allowedFields: ["question"],
          },
        },
      });
      expect(corrupt.statusCode, corrupt.body).toBe(409);
      expect(corrupt.json().error.code).toBe("processing_input_corrupt");
      await db.query("UPDATE processing_run SET input_hash=$2 WHERE id=$1", [
        parentId,
        originalHash,
      ]);
      const invalidSelection = await app.inject({
        method: "POST",
        url: `${path}/${parentId}/followups`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          mode: "continue",
          resultIds: ["99:0"],
          options: {
            operation: "clean",
            instructions: "",
            allowedFields: ["question"],
          },
        },
      });
      expect(invalidSelection.statusCode, invalidSelection.body).toBe(422);
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS count FROM processing_run WHERE project_id=$1",
            [projectId],
          )
        ).rows[0].count,
      ).toBe(beforeCount);
      const previewChild = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/processing-inputs`,
        headers,
        payload: {
          source: {
            kind: "results",
            id: expanded.json().run.id,
            resultIds: ["0:0", "0:2"],
          },
          offset: 0,
          limit: 20,
        },
      });
      expect(previewChild.statusCode, previewChild.body).toBe(200);
      expect(
        previewChild.json().records.map((row: any) => row.question),
      ).toEqual(["  新问题 0  ", "  新问题 2  "]);
      const childClean = await follow(
        expanded.json().run.id,
        ["0:0", "0:2"],
        "clean",
      );
      expect(childClean.records.map((row: any) => row.result.question)).toEqual(
        ["新问题 0", "新问题 2"],
      );
      expect(childClean.run.modelRevision).toBeNull();
      const childRewrite = await follow(
        childClean.run.id,
        [childClean.allIds[0]],
        "rewrite",
      );
      expect(childRewrite.records).toHaveLength(1);
      expect(childRewrite.records[0].result.expectedOutput).toBe("Protected");
      const childAugment = await follow(
        childRewrite.run.id,
        childRewrite.allIds,
        "augment",
        2,
      );
      expect(childAugment.records).toHaveLength(2);
      const finalChild = await follow(
        childAugment.run.id,
        childAugment.allIds,
        "clean",
      );
      expect(finalChild.rootOperation).toBe("augment");
      expect(finalChild.records.map((row: any) => row.result.question)).toEqual(
        ["新问题 0", "新问题 1"],
      );
      const rerunPreview = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/processing-inputs`,
        headers,
        payload: {
          source: { kind: "rerun", id: finalChild.run.id },
          offset: 0,
          limit: 20,
        },
      });
      expect(
        rerunPreview.json().records.map((row: any) => row.question),
      ).toEqual(["  新问题 0  ", "  新问题 1  "]);
      const repeated = await app.inject({
        method: "POST",
        url: `${path}/${finalChild.run.id}/followups`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          mode: "rerun",
          options: {
            operation: "clean",
            instructions: "",
            allowedFields: ["question"],
          },
        },
      });
      expect(repeated.statusCode, repeated.body).toBe(201);
      await finish(repeated.json().run);
      const concurrentSaves = await Promise.all(
        ["手动连续处理", "并发另存"].map((name) =>
          app.inject({
            method: "POST",
            url: `${path}/${finalChild.run.id}/accept`,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: {
              resultIds: finalChild.allIds,
              target: { kind: "newDraft", name, purpose: "" },
            },
          }),
        ),
      );
      expect(
        concurrentSaves.map((response) => response.statusCode).sort(),
      ).toEqual([201, 409]);
      const savedChild = concurrentSaves.find(
        (response) => response.statusCode === 201,
      )!;
      expect(
        concurrentSaves.find((response) => response.statusCode === 409)!.json()
          .error.code,
      ).toBe("processing_already_adopted");
      expect(savedChild.statusCode, savedChild.body).toBe(201);
      const parentSaveAfterChild = await app.inject({
        method: "POST",
        url: `${path}/${childAugment.run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { resultIds: childAugment.allIds, target: { kind: "asset" } },
      });
      expect(parentSaveAfterChild.statusCode, parentSaveAfterChild.body).toBe(
        409,
      );
      expect(parentSaveAfterChild.json().error.code).toBe(
        "processing_already_adopted",
      );
      const savedAgain = await app.inject({
        method: "POST",
        url: `${path}/${childAugment.run.id}/followups`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          mode: "continue",
          resultIds: childAugment.allIds,
          options: {
            operation: "clean",
            instructions: "",
            allowedFields: ["question"],
          },
        },
      });
      expect(savedAgain.statusCode, savedAgain.body).toBe(409);
      expect(savedAgain.json().error.code).toBe("processing_already_adopted");
      const adoptedChild = await app.inject({
        method: "GET",
        url: `${path}/${childAugment.run.id}?view=all`,
        headers,
      });
      expect(adoptedChild.json().adoptedIds).toEqual(childAugment.allIds);
      const sourceDraftId = savedChild.json().receipt.draftId;
      const draftRead = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/collaborative-drafts/${sourceDraftId}`,
        headers,
      });
      const sourceRun = await app.inject({
        method: "POST",
        url: path,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          source: {
            kind: "draft",
            id: sourceDraftId,
            recordIds: draftRead.json().records.map((row: any) => row.id),
          },
          options: {
            operation: "clean",
            instructions: "",
            allowedFields: ["question"],
          },
        },
      });
      expect(sourceRun.statusCode, sourceRun.body).toBe(201);
      await finish(sourceRun.json().run);
      const sourceResult = await app.inject({
        method: "GET",
        url: `${path}/${sourceRun.json().run.id}?view=all`,
        headers,
      });
      const draftChild = await follow(
        sourceRun.json().run.id,
        [sourceResult.json().allIds[0]],
        "rewrite",
      );
      expect(draftChild.rootOperation).toBe("rewrite");
      expect(draftChild.adoptionFields).toEqual(["question", "metadata"]);
      const saveBack = await app.inject({
        method: "POST",
        url: `${path}/${draftChild.run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          resultIds: draftChild.allIds,
          target: {
            kind: "draft",
            id: sourceDraftId,
            expectedRevision: draftRead.json().draft.revision,
          },
        },
      });
      expect(saveBack.statusCode, saveBack.body).toBe(201);
      const savedDraft = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/collaborative-drafts/${sourceDraftId}`,
        headers,
      });
      expect(savedDraft.json().records).toHaveLength(2);
      expect(savedDraft.json().records[0].metadata).toContainEqual({
        key: "gbRisk",
        value: "A.1",
      });
      const sourceAugment = await app.inject({
        method: "POST",
        url: path,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          source: {
            kind: "draft",
            id: sourceDraftId,
            recordIds: savedDraft.json().records.map((row: any) => row.id),
          },
          options: {
            operation: "augment",
            instructions: "原草稿扩写",
            allowedFields: ["question"],
            outputCount: 2,
          },
        },
      });
      expect(sourceAugment.statusCode, sourceAugment.body).toBe(201);
      await finish(sourceAugment.json().run);
      const rerunAsClean = await app.inject({
        method: "POST",
        url: `${path}/${sourceAugment.json().run.id}/followups`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          mode: "rerun",
          options: {
            operation: "clean",
            instructions: "",
            allowedFields: ["question"],
          },
        },
      });
      expect(rerunAsClean.statusCode, rerunAsClean.body).toBe(201);
      await finish(rerunAsClean.json().run);
      const rerunCleanResults = await app.inject({
        method: "GET",
        url: `${path}/${rerunAsClean.json().run.id}?view=all`,
        headers,
      });
      expect(rerunCleanResults.json().rootOperation).toBe("clean");
      const rerunSave = await app.inject({
        method: "POST",
        url: `${path}/${rerunAsClean.json().run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          resultIds: rerunCleanResults.json().allIds,
          target: {
            kind: "draft",
            id: sourceDraftId,
            expectedRevision: savedDraft.json().draft.revision,
          },
        },
      });
      expect(rerunSave.statusCode, rerunSave.body).toBe(201);
      const rerunDraft = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/collaborative-drafts/${sourceDraftId}`,
        headers,
      });
      expect(rerunDraft.json().records).toHaveLength(2);
      expect(rerunDraft.json().records.map((row: any) => row.id)).toEqual(
        savedDraft.json().records.map((row: any) => row.id),
      );
      expect(
        rerunDraft
          .json()
          .records[0].sourcePresentation.steps.filter(
            (step: any) => step.kind === "saved",
          )
          .at(-1).href,
      ).toBe(`/projects/${projectId}/test-sets/drafts/${sourceDraftId}`);
      const malformedAsset = savedChild.json().receipt.assetId;
      // Arrange a proven system naming defect; assertions read the public file projection.
      await db.query("UPDATE data_asset SET file_name=$2 WHERE id=$1", [
        malformedAsset,
        `鎵╁厖结果-${finalChild.run.id.slice(-8)}.jsonl`,
      ]);
      // This result was cleaned, so it is deliberately outside the augment-only repair.
      expect(
        (await processingNameRepairs(db)).some(
          (row) => row.assetId === malformedAsset,
        ),
      ).toBe(false);
      const generatedSaved = await app.inject({
        method: "POST",
        url: `${path}/${repeated.json().run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { resultIds: ["0:0"], target: { kind: "asset" } },
      });
      expect(generatedSaved.statusCode, generatedSaved.body).toBe(201);
      for (const row of initial.json().records)
        expect(
          row.sourcePresentation.steps.filter((step: any) =>
            step.href?.endsWith(`run=${expanded.json().run.id}`),
          ),
        ).toHaveLength(1);
      const freshInput = await app.inject({
        method: "POST",
        url: `${path}/${expanded.json().run.id}/followups`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          mode: "rerun",
          options: {
            operation: "augment",
            instructions: "新增独立来源核对",
            allowedFields: ["question"],
            outputCount: 7,
          },
        },
      });
      expect(freshInput.statusCode, freshInput.body).toBe(201);
      await finish(freshInput.json().run);
      const refined = await app.inject({
        method: "POST",
        url: `${path}/${freshInput.json().run.id}/followups`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          mode: "continue",
          resultIds: Array.from({ length: 7 }, (_, i) => `0:${i}`),
          options: {
            operation: "rewrite",
            instructions: "只为选中七条新增 gbRisk",
            allowedFields: ["metadata"],
          },
        },
      });
      expect(refined.statusCode, refined.body).toBe(201);
      await finish(refined.json().run);
      const review = await app.inject({
        method: "GET",
        url: `${path}/${refined.json().run.id}?view=all`,
        headers,
      });
      expect(review.statusCode, review.body).toBe(200);
      expect(review.json().records[0].sourcePresentation).toMatchObject({
        label: "模型扩写 · 参考 original-basis.jsonl",
        badges: ["模型扩写", "已改写"],
        generated: true,
      });
      expect(review.json().records[1].sourcePresentation.badges).toEqual([
        "模型扩写",
        "已改写",
      ]);
      expect(
        review
          .json()
          .records.every(
            (row: any) => row.result.expectedOutput === "Protected",
          ),
      ).toBe(true);
      const adopted = await app.inject({
        method: "POST",
        url: `${path}/${refined.json().run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          resultIds: review.json().allIds,
          target: { kind: "newDraft", name: "生成来源核对", purpose: "" },
        },
      });
      expect(adopted.statusCode, adopted.body).toBe(201);
      // Only a real augment asset is eligible; an identically named user upload is not.
      const expandSaved = await app.inject({
        method: "POST",
        url: `${path}/${expanded.json().run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { resultIds: ["0:6"], target: { kind: "asset" } },
      });
      expect(expandSaved.statusCode, expandSaved.body).toBe(201);
      const corruptId = expandSaved.json().receipt.assetId;
      await db.query("UPDATE data_asset SET file_name=$2 WHERE id=$1", [
        corruptId,
        `鎵╁厖结果-${expanded.json().run.id.slice(-8)}.jsonl`,
      ]);
      const repairs = (await processingNameRepairs(db)).filter(
        (row) => row.assetId === corruptId,
      );
      expect(repairs).toHaveLength(1);
      expect(await applyProcessingNameRepairs(db, repairs)).toBe(1);
      expect(await applyProcessingNameRepairs(db, repairs)).toBe(0);
      const repairedList = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/collections/${collectionId}/assets`,
        headers,
      });
      expect(repairedList.statusCode, repairedList.body).toBe(200);
      expect(
        repairedList.json().assets.find((row: any) => row.id === corruptId)
          .fileName,
      ).toBe(`扩充结果-${expanded.json().run.id.slice(-8)}.jsonl`);
      expect(await applyProcessingNameRepairs(db, repairs, true)).toBe(1);
      expect(await applyProcessingNameRepairs(db, repairs)).toBe(1);
      const clean = await app.inject({
        method: "POST",
        url: path,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          source: {
            kind: "assets",
            assetIds: [adopted.json().receipt.assetId],
            recordIds: [1, 2, 3, 4, 5, 6, 7].map(
              (n) => `${adopted.json().receipt.assetId}:${n}`,
            ),
          },
          options: {
            operation: "clean",
            instructions: "",
            allowedFields: ["question"],
          },
        },
      });
      expect(clean.statusCode, clean.body).toBe(201);
      await finish(clean.json().run);
      const result = await app.inject({
        method: "GET",
        url: `${path}/${clean.json().run.id}?view=all`,
        headers,
      });
      const saveBody = {
        resultIds: result.json().allIds,
        target: { kind: "newDraft", name: "连续来源核对", purpose: "" },
      };
      const saved = await app.inject({
        method: "POST",
        url: `${path}/${clean.json().run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: saveBody,
      });
      expect(saved.statusCode, saved.body).toBe(201);
      const replay = await app.inject({
        method: "POST",
        url: `${path}/${clean.json().run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: saveBody,
      });
      expect(replay.json().replayed).toBe(true);
      const receiptPage = await app.inject({
        method: "GET",
        url: `${path}/${clean.json().run.id}?view=all`,
        headers,
      });
      expect(receiptPage.json().receipts).toHaveLength(1);
      expect(receiptPage.body).not.toContain("candidateOrigins");
      const draftPath = `/api/projects/${projectId}/collaborative-drafts/${saved.json().receipt.draftId}`;
      const draft = await app.inject({
        method: "GET",
        url: draftPath,
        headers,
      });
      expect(draft.json().records[0].sourcePresentation.badges).toEqual([
        "模型扩写",
        "已改写",
        "已清洗",
      ]);
      expect(draft.json().records[1].sourcePresentation.badges).toEqual([
        "模型扩写",
        "已改写",
        "已清洗",
      ]);
      expect(draft.json().records[0].sourcePresentation.label).toBe(
        "模型扩写 · 参考 original-basis.jsonl",
      );
      expect(
        draft
          .json()
          .records[0].sourcePresentation.steps.some(
            (step: any) => step.kind === "reference" && step.href,
          ),
      ).toBe(true);
      const published = await app.inject({
        method: "POST",
        url: `${draftPath}/publish`,
        headers,
        payload: { revision: draft.json().draft.revision },
      });
      expect(published.statusCode, published.body).toBe(201);
      const traceUrl = `/api/projects/${projectId}/solo-test-sets/${published.json().testSet.id}/versions/${published.json().version.id}/provenance?status=all`;
      const trace = await app.inject({ method: "GET", url: traceUrl, headers });
      expect(trace.statusCode, trace.body).toBe(200);
      expect(trace.json().changes[0].source.presentation.label).toBe(
        "模型扩写 · 参考 original-basis.jsonl",
      );
      const secondUpload = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/pending-uploads`,
        headers: {
          ...headers,
          "content-type": "application/octet-stream",
          "x-file-name": "second-basis.jsonl",
        },
        payload:
          Array.from({ length: 11 }, (_, i) =>
            JSON.stringify({
              question: `Second reference ${i}`,
              answer: "Protected",
            }),
          ).join("\n") + "\n",
      });
      expect(secondUpload.statusCode, secondUpload.body).toBe(201);
      const secondConfirm = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/pending-upload-batches/confirm`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          collectionId,
          pendingUploadIds: [secondUpload.json().pendingUpload.id],
          mode: "raw",
        },
      });
      expect(secondConfirm.statusCode, secondConfirm.body).toBe(201);
      const secondAsset = secondConfirm.json().assets[0].id;
      const secondMapping = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/assets/${secondAsset}/mapping`,
        headers,
      });
      const secondMapped = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/assets/${secondAsset}/mapping`,
        headers,
        payload: {
          parsedViewId: secondMapping.json().parsedViewId,
          expectedRevision: 0,
          mapping: {
            question: "/question",
            expectedOutput: "/answer",
            metadata: [],
          },
        },
      });
      expect(secondMapped.statusCode, secondMapped.body).toBe(200);
      const twoFileRun = await app.inject({
        method: "POST",
        url: path,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          source: {
            kind: "assets",
            assetIds: [assetId, secondAsset],
            recordIds: [`${assetId}:1`, `${secondAsset}:1`],
          },
          options: {
            operation: "augment",
            instructions: "使用两份参考",
            allowedFields: ["question"],
            outputCount: 2,
          },
        },
      });
      expect(twoFileRun.statusCode, twoFileRun.body).toBe(201);
      await finish(twoFileRun.json().run);
      const twoFileRead = await app.inject({
        method: "GET",
        url: `${path}/${twoFileRun.json().run.id}?view=all`,
        headers,
      });
      for (const row of twoFileRead.json().records) {
        expect(row.sourcePresentation.label).toBe(
          "模型扩写 · 参考 2 份原始数据",
        );
        const references = row.sourcePresentation.steps.filter(
          (step: any) => step.kind === "reference",
        );
        expect(references).toHaveLength(2);
        expect(references.map((step: any) => step.label)).toEqual(
          expect.arrayContaining([
            expect.stringContaining("original-basis.jsonl"),
            expect.stringContaining("second-basis.jsonl"),
          ]),
        );
      }
      const twoFileClean = await follow(
        twoFileRun.json().run.id,
        twoFileRead.json().allIds,
        "clean",
      );
      expect(twoFileClean.records[0].sourcePresentation.label).toBe(
        "模型扩写 · 参考 2 份原始数据",
      );
      const savedTwoFileChild = await app.inject({
        method: "POST",
        url: `${path}/${twoFileClean.run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { resultIds: twoFileClean.allIds, target: { kind: "asset" } },
      });
      expect(savedTwoFileChild.statusCode, savedTwoFileChild.body).toBe(201);
      const savedOriginalRoot = await app.inject({
        method: "POST",
        url: `${path}/${twoFileRun.json().run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          resultIds: twoFileRead.json().allIds,
          target: { kind: "asset" },
        },
      });
      expect(savedOriginalRoot.statusCode, savedOriginalRoot.body).toBe(409);
      expect(savedOriginalRoot.json().error.code).toBe(
        "processing_already_adopted",
      );
      const [firstBasis, lastBasis] = [assetId, secondAsset].sort();
      const mixedClean = await app.inject({
        method: "POST",
        url: path,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          source: {
            kind: "assets",
            assetIds: [firstBasis, lastBasis],
            recordIds: [
              ...Array.from({ length: 11 }, (_, i) => `${firstBasis}:${i + 1}`),
              `${lastBasis}:1`,
            ],
          },
          options: {
            operation: "clean",
            instructions: "",
            allowedFields: ["question"],
          },
        },
      });
      expect(mixedClean.statusCode, mixedClean.body).toBe(201);
      await finish(mixedClean.json().run);
      const actorId = (
        await db.query("SELECT actor_id FROM processing_run WHERE id=$1", [
          mixedClean.json().run.id,
        ])
      ).rows[0].actor_id;
      const legacyChild = await createRefinementRun(
        db,
        artifacts,
        { projectId, actorId },
        mixedClean.json().run.id,
        randomUUID(),
        {
          resultIds: ["0:0"],
          instructions: "调整 Metadata",
          allowedFields: ["metadata"],
        },
      );
      await finish(legacyChild.run);
      const firstSaved = await app.inject({
        method: "POST",
        url: `${path}/${mixedClean.json().run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { resultIds: ["0:0"], target: { kind: "asset" } },
      });
      expect(firstSaved.statusCode, firstSaved.body).toBe(201);
      // Domain commit boundary: a group may ignore only its own same-round receipt, never another group's receipt.
      await expect(
        acceptProcessingResults(
          db,
          artifacts,
          {
            projectId,
            actorId,
            acceptanceGroups: [
              { runId: mixedClean.json().run.id, resultIds: ["0:1"] },
              { runId: legacyChild.run.id, resultIds: ["0:0"] },
            ],
          },
          mixedClean.json().run.id,
          randomUUID(),
          {
            resultIds: ["0:1"],
            target: {
              kind: "newDraft",
              name: "不能重复采用跨轮候选",
              purpose: "",
            },
          },
        ),
      ).rejects.toMatchObject({ code: "processing_already_adopted" });
      const mixedRows = (
        await app.inject({
          method: "GET",
          url: `${path}/${mixedClean.json().run.id}?view=all`,
          headers,
        })
      ).json();
      const mixedSaved = await app.inject({
        method: "POST",
        url: `${path}/${mixedClean.json().run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { resultIds: mixedRows.allIds, target: { kind: "asset" } },
      });
      expect(mixedSaved.statusCode, mixedSaved.body).toBe(201);
      const mixedAsset = mixedSaved.json().receipt.assetId;
      const mixedAugment = await app.inject({
        method: "POST",
        url: path,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          source: {
            kind: "assets",
            assetIds: [mixedAsset],
            recordIds: Array.from(
              { length: 12 },
              (_, i) => `${mixedAsset}:${i + 1}`,
            ),
          },
          options: {
            operation: "augment",
            instructions: "参考混合文件",
            allowedFields: ["question"],
            outputCount: 1,
          },
        },
      });
      expect(mixedAugment.statusCode, mixedAugment.body).toBe(201);
      await finish(mixedAugment.json().run);
      const mixedResult = (
        await app.inject({
          method: "GET",
          url: `${path}/${mixedAugment.json().run.id}?view=all`,
          headers,
        })
      ).json();
      expect(mixedResult.records[0].sourcePresentation.label).toBe(
        "模型扩写 · 参考 2 份原始数据",
      );
      expect(
        mixedResult.records[0].sourcePresentation.steps
          .filter((step: any) => step.kind === "reference")
          .map((step: any) => step.label)
          .join("\n"),
      ).toContain("second-basis.jsonl");
      expect(
        mixedResult.records[0].sourcePresentation.steps
          .filter((step: any) => step.kind === "reference")
          .map((step: any) => step.label)
          .join("\n"),
      ).toContain("original-basis.jsonl");
      expect(
        mixedResult.records[0].sourcePresentation.referenceGroups
          .map((group: any) => group.recordCount)
          .sort((a: number, b: number) => a - b),
      ).toEqual([1, 11]);
      expect(
        mixedResult.records[0].sourcePresentation.referenceGroups.find(
          (group: any) => group.recordCount === 11,
        ).positions,
      ).toHaveLength(10);
      const mixedDraftSave = await app.inject({
        method: "POST",
        url: `${path}/${mixedAugment.json().run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          resultIds: mixedResult.allIds,
          target: { kind: "newDraft", name: "完整混合来源", purpose: "" },
        },
      });
      expect(mixedDraftSave.statusCode, mixedDraftSave.body).toBe(201);
      const mixedDraft = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/collaborative-drafts/${mixedDraftSave.json().receipt.draftId}`,
        headers,
      });
      for (const record of mixedDraft.json().records) {
        expect(record.sourcePresentation.label).toBe(
          "模型扩写 · 参考 2 份原始数据",
        );
        const references = record.sourcePresentation.steps
          .filter((step: any) => step.kind === "reference")
          .map((step: any) => step.label)
          .join("\n");
        expect(references).toContain("original-basis.jsonl");
        expect(references).toContain("second-basis.jsonl");
        expect(
          record.sourcePresentation.steps
            .filter((step: any) => step.kind === "saved")
            .at(-1).label,
        ).toBe("草稿：完整混合来源");
      }
      await db.query(
        "UPDATE data_asset SET status='archived' WHERE project_id=$1 AND id=$2",
        [projectId, assetId],
      );
      const hidden = await app.inject({
        method: "GET",
        url: traceUrl,
        headers,
      });
      expect(hidden.statusCode, hidden.body).toBe(200);
      expect(hidden.body).not.toContain("original-basis.jsonl");
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

  it.each(["run", "workspace"])(
    "OPT31 never reviews or repairs an entirely unselected batch: %s",
    async (entry) => {
      opt31Recipe = true;
      const db = createPool(databaseUrl),
        config = {
          ...loadConfig(),
          databaseUrl,
          modelEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
        },
        artifacts = new ArtifactRepository(config.minio);
      const calls: any[] = [];
      const server = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        const prompt = JSON.parse(JSON.parse(body).messages.at(-1).content);
        calls.push(prompt);
        const value = prompt.candidates
          ? {
              reviews: prompt.candidates.map((row: any) => ({
                id: row.id,
                checks: {
                  question: "conforms",
                  category: "conforms",
                  expectedBehavior: "conforms",
                  facts: "conforms",
                },
                reason: "符合当前要求",
              })),
            }
          : {
              records: prompt.records.map((row: any) => ({
                sourceId: row.id,
                question: row.question + "，请说明。",
                expectedOutput: row.expectedOutput,
                metadata: row.metadata,
              })),
            };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "opt31-local",
            object: "chat.completion",
            created: 1,
            model: "synthetic",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: JSON.stringify(value) },
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
      try {
        const draft = (
          await app.inject({
            method: "POST",
            url: `/api/projects/${projectId}/collaborative-drafts`,
            headers,
            payload: {},
          })
        ).json().draft;
        const ids = [];
        for (let i = 0; i < 21; i++)
          ids.push(
            (
              await app.inject({
                method: "POST",
                url: `/api/projects/${projectId}/collaborative-drafts/${draft.id}/records`,
                headers,
                payload: {
                  question: `完整问题${i}`,
                  expectedOutput: "Protected",
                  metadata: [],
                },
              })
            ).json().record.id,
          );
        const revision =
          (
            await app.inject({
              method: "GET",
              url: "/api/settings/model-connection",
              headers,
            })
          ).json().connection?.revision ?? 0;
        expect(
          (
            await app.inject({
              method: "PUT",
              url: "/api/settings/model-connection",
              headers,
              payload: {
                revision,
                name: "OPT31 local",
                endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
                model: "synthetic",
                apiKey: "synthetic-test",
                enabled: true,
              },
            })
          ).statusCode,
        ).toBe(200);
        const base = `/api/projects/${projectId}/processing-runs`;
        const parent = (
          await app.inject({
            method: "POST",
            url: base,
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: {
              source: { kind: "draft", id: draft.id, recordIds: ids },
              options: {
                operation: "clean",
                instructions: "保持当前语义与字段，仅整理问法",
                allowedFields: ["question"],
              },
            },
          })
        ).json().run;
        async function finish(run: { id: string; jobId: string }) {
          const job = (
            await db.query(
              "UPDATE job SET status='running',attempt=1,lease_owner='opt31-local',lease_expires_at=now()+interval '120 seconds' WHERE id=$1 RETURNING *",
              [run.jobId],
            )
          ).rows[0];
          const result = await runProcessing(db, artifacts, config, job);
          await db.query(
            "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
            [job.id, result],
          );
        }
        // Replay a native legacy parent; upgrading a selected child must not invalidate its neighbours.
        const frozenParent = (
          await db.query("SELECT input_ref FROM processing_run WHERE id=$1", [
            parent.id,
          ])
        ).rows[0];
        const oldInput = JSON.parse(
          (
            await artifacts.readBytes(frozenParent.input_ref, 100000000)
          ).toString("utf8"),
        );
        delete oldInput.background;
        const oldBytes = Buffer.from(JSON.stringify(oldInput));
        const oldRef = await artifacts.storeProcessing(
          oldBytes,
          parent.id,
          "input",
        );
        const { sha256 } = await import("../../src/package/contract.js");
        await db.query(
          "UPDATE processing_run SET input_ref=$2,input_hash=$3 WHERE id=$1",
          [parent.id, oldRef.objectRef, sha256(oldBytes)],
        );
        await finish(parent);
        const scope = {
          projectId,
          actorId: (
            await db.query("SELECT actor_id FROM processing_run WHERE id=$1", [
              parent.id,
            ])
          ).rows[0].actor_id,
        };
        const { readProcessingRun } =
          await import("../../src/processing/store.js");
        const before = await readProcessingRun(
          db,
          artifacts,
          scope,
          parent.id,
          { limit: "100" },
          true,
        );
        const child =
          entry === "run"
            ? await createRefinementRun(
                db,
                artifacts,
                scope,
                parent.id,
                randomUUID(),
                {
                  resultIds: ["0:0"],
                  instructions: "将问题改为完整自然问法",
                  allowedFields: ["question"],
                },
              )
            : (
                await (
                  await import("../../src/processing/refine.js")
                ).createRefinementGroups(
                  db,
                  artifacts,
                  scope,
                  [{ runId: parent.id, resultIds: ["0:0"] }],
                  randomUUID(),
                  {
                    instructions: "将问题改为完整自然问法",
                    allowedFields: ["question"],
                  },
                )
              )[0]!;
        await finish(child.run);
        const after = await readProcessingRun(
          db,
          artifacts,
          scope,
          child.run.id,
          { limit: "100" },
          true,
        );
        expect(calls).toHaveLength(6);
        expect(calls[5].candidates).toHaveLength(1);
        expect(
          before.records.every(
            (row) => row.contentReview?.verdict === "conforms",
          ),
        ).toBe(true);
        expect(
          after.records.every(
            (row) => row.contentReview?.verdict === "conforms",
          ),
        ).toBe(true);
        const { selectedProcessingGroup } =
          await import("../../src/processing/accept.js");
        const selectedAgain = await selectedProcessingGroup(
          db,
          artifacts,
          scope,
          child.run.id,
          after.allIds,
        );
        expect(
          selectedAgain.selected.every(
            (row) => row.contentReview.verdict === "conforms",
          ),
        ).toBe(true);
        expect(after.records).toHaveLength(21);
        expect(after.records[0]!.result.question).toBe(
          before.records[0]!.result.question + "，请说明。",
        );
        expect(
          after.records.slice(1).map((row) => row.result.question),
        ).toEqual(before.records.slice(1).map((row) => row.result.question));
        expect(
          after.records.slice(1).map((row) => row.candidateOrigin),
        ).toEqual(before.records.slice(1).map((row) => row.candidateOrigin));
      } finally {
        opt31Recipe = false;
        await db.end();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
  it.each([
    [0, false],
    [1, false],
    [1, true],
    [0, false, true],
  ] as const)(
    "recovers only missing rewrite outputs without replacing successful candidates on the legacy recipe (retained %i, legacy %s)",
    async (retainedIndex, legacy, malformed: boolean = false) => {
      const draft = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts`,
        headers,
        payload: {},
      });
      const draftId = draft.json().draft.id,
        ids: string[] = [];
      const firstQuestion = malformed
        ? "First source " + "长题目".repeat(1000)
        : "First source";
      for (const question of [firstQuestion, "Second source"]) {
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
          await db.query(
            "UPDATE processing_run SET execution_config=jsonb_set(execution_config,'{recipeVersion}',to_jsonb('processing-v5'::text)) WHERE id=$1",
            [run.id],
          );
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
            expect.objectContaining({
              code: "duplicate_source",
              batch: 0,
              inputOrdinal: 1,
              sourceQuestion: firstQuestion.slice(0, 160),
            }),
          );
          expect(malformedRead.json().records[0].original.question).toBe(
            firstQuestion,
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
  it("OPT16 deduplicates cross-batch augmentation, preserves survivors, and never resets completion budgets", async () => {
    const db = createPool(databaseUrl),
      config = {
        ...loadConfig(),
        databaseUrl,
        modelEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
      },
      artifacts = new ArtifactRepository(config.minio);
    const draft = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/collaborative-drafts`,
      headers,
      payload: {},
    });
    const draftId = draft.json().draft.id;
    const seed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/collaborative-drafts/${draftId}/records`,
      headers,
      payload: {
        question: "Seed",
        expectedOutput: "Protected",
        metadata: [
          { key: "a", value: "" },
          { key: "b", value: "1" },
        ],
      },
    });
    const targetOnly = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/collaborative-drafts/${draftId}/records`,
      headers,
      payload: {
        question: "TargetOnly",
        expectedOutput: "Protected",
        metadata: seed.json().record.metadata ?? [
          { key: "a", value: "" },
          { key: "b", value: "1" },
        ],
      },
    });
    expect(targetOnly.statusCode, targetOnly.body).toBe(201);
    let calls = 0,
      sequence = 0,
      stuck = false,
      recovering = false;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const prompt = JSON.parse(JSON.parse(body).messages.at(-1).content);
      calls++;
      const rows = Array.from({ length: prompt.outputCount }, (_, index) => ({
        sourceId: prompt.records[0].id,
        question:
          recovering && index === 0 && prompt.outputCount > 1
            ? "LaterPreserved"
            : stuck
              ? "Seed"
              : calls === 2 && index === 0
                ? "New0"
                : calls === 2 && index === 1
                  ? "TargetOnly"
                  : calls === 2 && index === 2
                    ? ""
                    : `New${sequence++}`,
        metadata: [...prompt.records[0].metadata].reverse(),
      }));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "controlled",
          object: "chat.completion",
          created: 1,
          model: "synthetic",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({ records: rows }),
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
    const path = `/api/projects/${projectId}/processing-runs`;
    async function finish(run: { id: string; jobId: string }) {
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=attempt+1,lease_owner='opt16',lease_expires_at=now()+interval '60 seconds' WHERE id=$1 RETURNING *",
          [run.jobId],
        )
      ).rows[0];
      try {
        const result = await runProcessing(db, artifacts, config, job);
        await db.query(
          "UPDATE job SET status='succeeded',result=$2,error_code=NULL WHERE id=$1",
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
          name: "OPT16",
          endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
          model: "synthetic",
          apiKey: "synthetic-test",
          enabled: true,
        },
      });
      expect(configured.statusCode, configured.body).toBe(200);
      async function create(count: number) {
        const response = await app.inject({
          method: "POST",
          url: path,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            source: {
              kind: "draft",
              id: draftId,
              recordIds: [seed.json().record.id],
            },
            options: {
              operation: "augment",
              instructions: "Generate distinct cases",
              allowedFields: ["question", "metadata"],
              outputCount: count,
            },
          },
        });
        expect(response.statusCode, response.body).toBe(201);
        return response.json().run;
      }
      const run = await create(21);
      await finish(run);
      const read = await app.inject({
        method: "GET",
        url: `${path}/${run.id}?limit=100&view=all`,
        headers,
      });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().total).toBe(21);
      expect(
        new Set(read.json().records.map((row: any) => row.result.question))
          .size,
      ).toBe(21);
      expect(
        read.json().records.some((row: any) => row.result.question === "Seed"),
      ).toBe(false);
      expect(read.json().usableCount).toBe(21);
      expect(
        read
          .json()
          .records.some(
            (row: any) =>
              !row.result.question.trim() ||
              row.result.question === "TargetOnly",
          ),
      ).toBe(false);
      expect(calls).toBe(4); // three initial batches plus only the missing three records.
      const view = await app.inject({
        method: "GET",
        url: `${path}/${run.id}?limit=20&view=all`,
        headers,
      });
      expect(view.statusCode, view.body).toBe(200);
      expect(view.json().records[0].sourcePresentation.generated).toBe(true);
      expect(view.json().records[0].sourcePresentation.referenceGroups).toEqual(
        [],
      );
      expect(view.json().records[0].sourcePresentation.steps).toContainEqual(
        expect.objectContaining({ label: "部分来源未记录" }),
      );
      stuck = true;
      const partial = await create(2);
      const start = calls;
      await finish(partial);
      expect(calls - start).toBe(3);
      await finish(partial);
      expect(calls - start).toBe(3);
      expect(
        (
          await db.query(
            "SELECT model_attempts FROM processing_batch WHERE run_id=$1",
            [partial.id],
          )
        ).rows[0].model_attempts,
      ).toBe(3);
      const attention = await app.inject({
        method: "GET",
        url: `${path}?status=attention`,
        headers,
      });
      expect(
        attention.json().runs.some((row: any) => row.id === partial.id),
      ).toBe(true);
      const complete = await app.inject({
        method: "GET",
        url: `${path}?status=complete`,
        headers,
      });
      expect(
        complete.json().runs.some((row: any) => row.id === partial.id),
      ).toBe(false);
      const child = await app.inject({
        method: "POST",
        url: `${path}/${partial.id}/followups`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { mode: "complete" },
      });
      expect(child.statusCode, child.body).toBe(201);
      expect(child.json().run.options.outputCount).toBe(2);
      // Resume an earlier batch with two calls left; a later batch is already fixed.
      stuck = false;
      recovering = true;
      const resumed = await create(21);
      const persistedRow = {
        sourceId: seed.json().record.id,
        question: "LaterPreserved",
        expectedOutput: "Protected",
        metadata: [
          { key: "b", value: "1" },
          { key: "a", value: "" },
        ],
      };
      const preserved = await artifacts.storeProcessing(
        Buffer.from(JSON.stringify({ records: [persistedRow], issues: [] })),
        resumed.id,
        "batch-2",
      );
      await db.query(
        "INSERT INTO processing_batch(run_id,ordinal,error_code,model_attempts,model_started_at) VALUES($1,0,'processing_batch_failed',1,now())",
        [resumed.id],
      );
      await db.query(
        "INSERT INTO processing_batch(run_id,ordinal,result_ref,output_count,result_indices) VALUES($1,2,$2,1,ARRAY[0])",
        [resumed.id, preserved.objectRef],
      );
      await finish(resumed);
      const recovered = await app.inject({
        method: "GET",
        url: `${path}/${resumed.id}?limit=100&view=all`,
        headers,
      });
      expect(recovered.statusCode, recovered.body).toBe(200);
      expect(recovered.json().total).toBe(21);
      expect(
        new Set(recovered.json().records.map((row: any) => row.result.question))
          .size,
      ).toBe(21);
      expect(
        recovered.json().records.find((row: any) => row.id === "2:0").result,
      ).toEqual(persistedRow);
    } finally {
      await db.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("OPT16 previews full-scope duplicate removals and commits only explicit, conflict-safe draft deletions", async () => {
    const db = createPool(databaseUrl),
      config = { ...loadConfig(), databaseUrl },
      artifacts = new ArtifactRepository(config.minio);
    try {
      const draft = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts`,
        headers,
        payload: {},
      });
      const draftId = draft.json().draft.id,
        ids: string[] = [];
      for (const question of [" Q ", "Q", "Unique"]) {
        const row = await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/collaborative-drafts/${draftId}/records`,
          headers,
          payload: { question, expectedOutput: "A", metadata: [] },
        });
        ids.push(row.json().record.id);
      }
      const path = `/api/projects/${projectId}/processing-runs`,
        submitted = await app.inject({
          method: "POST",
          url: path,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            source: { kind: "draft", id: draftId, recordIds: ids },
            options: {
              operation: "clean",
              instructions: "",
              allowedFields: ["question"],
            },
          },
        });
      const run = submitted.json().run,
        job = (
          await db.query(
            "UPDATE job SET status='running',attempt=1,lease_owner='dedup',lease_expires_at=now()+interval '60 seconds' WHERE id=$1 RETURNING *",
            [run.jobId],
          )
        ).rows[0];
      const result = await runProcessing(db, artifacts, config, job);
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, result],
      );
      const preview = await app.inject({
        method: "POST",
        url: `${path}/${run.id}/deduplication`,
        headers,
        payload: { resultIds: ["0:2", "0:1", "0:0"] },
      });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json()).toMatchObject({
        keptIds: ["0:0", "0:2"],
        excludedIds: ["0:1"],
        removedRecordIds: [ids[1]],
      });
      const current = (
        await db.query("SELECT revision FROM collaborative_draft WHERE id=$1", [
          draftId,
        ])
      ).rows[0];
      const body = {
          resultIds: preview.json().keptIds,
          deduplication: { checkedIds: preview.json().checkedIds },
          target: {
            kind: "draft",
            id: draftId,
            expectedRevision: Number(current.revision),
          },
        },
        key = randomUUID();
      await db.query(
        "UPDATE collaborative_draft_record SET metadata_revision=metadata_revision+1 WHERE draft_id=$1 AND id=$2",
        [draftId, ids[1]],
      );
      const conflict = await app.inject({
        method: "POST",
        url: `${path}/${run.id}/accept`,
        headers: { ...headers, "idempotency-key": key },
        payload: body,
      });
      expect(conflict.statusCode, conflict.body).toBe(409);
      expect(conflict.json().error.code).toBe("draft_field_conflict");
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM collaborative_draft_record WHERE draft_id=$1 AND deleted=false",
            [draftId],
          )
        ).rows[0].n,
      ).toBe(3);
      await db.query(
        "UPDATE collaborative_draft_record SET metadata_revision=metadata_revision-1 WHERE draft_id=$1 AND id=$2",
        [draftId, ids[1]],
      );
      const saved = await app.inject({
        method: "POST",
        url: `${path}/${run.id}/accept`,
        headers: { ...headers, "idempotency-key": key },
        payload: body,
      });
      expect(saved.statusCode, saved.body).toBe(201);
      expect(saved.json().receipt.removed).toBe(1);
      const replay = await app.inject({
        method: "POST",
        url: `${path}/${run.id}/accept`,
        headers: { ...headers, "idempotency-key": key },
        payload: body,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().receipt).toEqual(saved.json().receipt);
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM collaborative_draft_record WHERE draft_id=$1 AND deleted=false",
            [draftId],
          )
        ).rows[0].n,
      ).toBe(2);
    } finally {
      await db.end();
    }
  });
  it.each([
    "normal",
    "invalid",
    "interrupted",
    "exhausted",
    "collision",
    "cancelled",
    "revoked",
  ])("OPT31 bounded batch review: %s", async (scenario) => {
    opt31Recipe = true;
    const db = createPool(databaseUrl),
      config = {
        ...loadConfig(),
        databaseUrl,
        modelEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
      },
      artifacts = new ArtifactRepository(config.minio);
    const draft = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts`,
        headers,
        payload: {},
      })
    ).json().draft;
    const seed = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/collaborative-drafts/${draft.id}/records`,
        headers,
        payload: {
          question: "参考问题",
          expectedOutput: "Protected",
          metadata: [{ key: "keep", value: "yes" }],
        },
      })
    ).json().record;
    let calls = 0,
      activeRun = "";
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const prompt = JSON.parse(JSON.parse(body).messages.at(-1).content);
      calls++;
      if (scenario === "cancelled" && prompt.candidates)
        await db.query(
          "UPDATE job SET status='cancel_requested' WHERE id=(SELECT job_id FROM processing_run WHERE id=$1)",
          [activeRun],
        );
      if (scenario === "revoked" && prompt.candidates)
        await db.query(
          "UPDATE app_user SET role='user' WHERE id=(SELECT actor_id FROM processing_run WHERE id=$1)",
          [activeRun],
        );
      const output =
        scenario === "invalid" && prompt.candidates
          ? {
              reviews: [
                { id: "unknown", verdict: "conforms", reason: "not real" },
              ],
            }
          : prompt.candidates
            ? {
                reviews: prompt.candidates.map((row: any) => ({
                  checks: {
                    question:
                      row.question === "错误问法"
                        ? "nonconforms"
                        : row.question === "边界问法"
                          ? "uncertain"
                          : "conforms",
                    category: "conforms",
                    expectedBehavior: "conforms",
                    facts: "conforms",
                  },
                  id: row.id,
                  verdict:
                    row.question === "错误问法"
                      ? "nonconforms"
                      : row.question === "边界问法"
                        ? "uncertain"
                        : "conforms",
                  reason:
                    row.question === "边界问法"
                      ? "背景不足"
                      : "已依据当前要求核对",
                  ...(row.question === "错误问法"
                    ? {
                        replacement: {
                          question:
                            scenario === "collision"
                              ? "正常问法"
                              : "完整自然的修复问法",
                          expectedOutput: "不得覆盖",
                          metadata: [],
                        },
                      }
                    : {}),
                })),
              }
            : {
                records: ["正常问法", "错误问法", "边界问法"].map(
                  (question) => ({
                    sourceId: prompt.records[0].id,
                    question,
                    expectedOutput: "Protected",
                    metadata: prompt.records[0].metadata,
                  }),
                ),
              };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "opt31",
          object: "chat.completion",
          created: 1,
          model: "synthetic",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: JSON.stringify(output) },
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
    try {
      const revision =
        (
          await app.inject({
            method: "GET",
            url: "/api/settings/model-connection",
            headers,
          })
        ).json().connection?.revision ?? 0;
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/settings/model-connection",
            headers,
            payload: {
              revision,
              name: "OPT31",
              endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
              model: "synthetic",
              apiKey: "synthetic-test",
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
          source: { kind: "draft", id: draft.id, recordIds: [seed.id] },
          options: {
            operation: "augment",
            instructions: "生成自然完整的问题，保持原标签",
            allowedFields: ["question"],
            outputCount: 3,
          },
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const run = created.json().run;
      activeRun = run.id;
      // This regression intentionally replays the pre-OPT41 frozen review contract.
      const frozen = (
        await db.query("SELECT input_ref FROM processing_run WHERE id=$1", [
          run.id,
        ])
      ).rows[0];
      const legacy = JSON.parse(
        (await artifacts.readBytes(frozen.input_ref, 100000000)).toString(
          "utf8",
        ),
      );
      if (legacy.background) {
        delete legacy.background.contentReviewPolicy;
        delete legacy.background.questionPolicy;
        if (
          !legacy.background.documents.length &&
          !legacy.background.requirements.length &&
          !legacy.background.questionPolicy
        )
          delete legacy.background;
      }
      const legacyBytes = Buffer.from(JSON.stringify(legacy));
      const legacyStored = await artifacts.storeProcessing(
        legacyBytes,
        run.id,
        "input",
      );
      const { sha256 } = await import("../../src/package/contract.js");
      await db.query(
        "UPDATE processing_run SET input_ref=$2,input_hash=$3 WHERE id=$1",
        [run.id, legacyStored.objectRef, sha256(legacyBytes)],
      );
      if (["interrupted", "exhausted"].includes(scenario)) {
        const options = created.json().run.options;
        const { reviewRulesHash } =
          await import("../../src/processing/content-review.js");
        const result = {
          records: ["正常问法", "错误问法", "边界问法"].map((question) => ({
            sourceId: seed.id,
            question,
            expectedOutput: "Protected",
            metadata: seed.metadata,
          })),
          issues: [],
          ...(scenario === "interrupted"
            ? {
                contentReview: {
                  version: 1,
                  rulesHash: reviewRulesHash(options, undefined),
                  initialAttempted: true,
                  items: [],
                  pendingReason: "核对中断",
                },
              }
            : {}),
        };
        const stored = await artifacts.storeProcessing(
          Buffer.from(JSON.stringify(result)),
          run.id,
          "batch-0",
        );
        await db.query(
          "INSERT INTO processing_batch(run_id,ordinal,result_ref,output_count,issues,error_code,output_bytes,result_indices,model_attempts,model_started_at) VALUES($1,0,$2,3,'[]','content_review_in_progress',100,ARRAY[0,1,2],$3,now())",
          [run.id, stored.objectRef, scenario === "exhausted" ? 3 : 2],
        );
      }
      const job = (
        await db.query(
          "UPDATE job SET status='running',attempt=1,lease_owner='opt31',lease_expires_at=now()+interval '120 seconds' WHERE id=$1 RETURNING *",
          [run.jobId],
        )
      ).rows[0];
      if (["cancelled", "revoked"].includes(scenario)) {
        await expect(
          runProcessing(db, artifacts, config, job),
        ).rejects.toThrow();
        const retained = (
          await db.query(
            "SELECT result_ref,model_attempts FROM processing_batch WHERE run_id=$1",
            [run.id],
          )
        ).rows[0];
        expect(retained.result_ref).toBeTruthy();
        expect(retained.model_attempts).toBe(2);
        const frozen = JSON.parse(
          (await artifacts.readBytes(retained.result_ref, 100000000)).toString(
            "utf8",
          ),
        );
        expect(frozen.records.map((row: any) => row.question)).toEqual([
          "正常问法",
          "错误问法",
          "边界问法",
        ]);
        expect(frozen.contentReview.items).toEqual([]);
        return;
      }
      const result = await runProcessing(db, artifacts, config, job);
      await db.query(
        "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
        [job.id, result],
      );
      const page = (
        await app.inject({
          method: "GET",
          url: `${path}/${run.id}?view=all`,
          headers,
        })
      ).json();
      if (scenario === "collision") {
        expect(calls).toBe(2);
        expect(page.records.map((row: any) => row.result.question)).toEqual([
          "正常问法",
          "错误问法",
          "边界问法",
        ]);
        expect(page.records[1].contentReview.verdict).toBe("nonconforms");
        expect(page.stats.autoRepaired).toBe(0);
        return;
      }
      if (scenario !== "normal") {
        expect(calls).toBe(scenario === "invalid" ? 2 : 0);
        expect(page.stats).toMatchObject({
          contentChecked: 0,
          contentPending: 3,
        });
        await db.query("UPDATE job SET status='running' WHERE id=$1", [job.id]);
        await runProcessing(db, artifacts, config, job);
        expect(calls).toBe(scenario === "invalid" ? 2 : 0);
        return;
      }
      expect(calls).toBe(3);
      expect(page.records.map((row: any) => row.id)).toEqual([
        "0:0",
        "0:1",
        "0:2",
      ]);
      expect(page.records.map((row: any) => row.result.question)).toEqual([
        "正常问法",
        "完整自然的修复问法",
        "边界问法",
      ]);
      expect(
        page.records.every(
          (row: any) =>
            row.result.expectedOutput === "Protected" &&
            row.result.metadata[0].value === "yes",
        ),
      ).toBe(true);
      expect(page.stats).toMatchObject({
        all: 3,
        contentChecked: 3,
        contentPending: 0,
        contentProblems: 1,
        autoRepaired: 1,
      });
      expect(page.records[1].contentReview).toMatchObject({
        verdict: "conforms",
        repaired: true,
      });
      expect(page.records[2].contentReview.verdict).toBe("uncertain");
      const persisted = (
        await db.query(
          "SELECT model_attempts,diagnostics FROM processing_batch WHERE run_id=$1",
          [run.id],
        )
      ).rows[0];
      expect(persisted.model_attempts).toBe(3);
      const { generationBudget } =
        await import("../../src/processing/generation.js");
      const frozenRun = (
        await db.query(
          "SELECT options,execution_config FROM processing_run WHERE id=$1",
          [run.id],
        )
      ).rows[0];
      for (const recipe of ["processing-v10", "processing-v9"]) {
        await db.query(
          "UPDATE processing_run SET options=$2,execution_config=$3 WHERE id=$1",
          [
            run.id,
            { ...frozenRun.options, operation: "generate", outputCount: 50 },
            { ...frozenRun.execution_config, recipeVersion: recipe },
          ],
        );
        expect(await generationBudget(db, run.id)).toMatchObject({
          targetCount: 50,
          limit: 15,
          used: 3,
          remaining: 12,
        });
      }
      await db.query(
        "UPDATE processing_run SET options=$2,execution_config=$3 WHERE id=$1",
        [run.id, frozenRun.options, frozenRun.execution_config],
      );
      expect(
        persisted.diagnostics.calls.map((c: any) => c.purpose).filter(Boolean),
      ).toEqual(["content_initial", "content_recheck"]);
      const refreshed = (
        await app.inject({
          method: "GET",
          url: `${path}/${run.id}?view=issues`,
          headers,
        })
      ).json();
      expect(refreshed.total).toBe(1);
      const saved = await app.inject({
        method: "POST",
        url: `${path}/${run.id}/accept`,
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: {
          resultIds: ["0:2"],
          target: { kind: "newDraft", name: "OPT31 存疑部分采用", purpose: "" },
        },
      });
      expect(saved.statusCode, saved.body).toBe(201);
      expect(saved.json().receipt.adopted).toBe(1);
      await db.query("UPDATE job SET status='running' WHERE id=$1", [job.id]);
      await runProcessing(db, artifacts, config, job);
      expect(calls).toBe(3);
    } finally {
      opt31Recipe = false;
      await db.query("UPDATE app_user SET role='admin'");
      await db.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
