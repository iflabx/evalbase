import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strFromU8, unzipSync } from "fflate";
import { parse } from "csv-parse";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { hashPassword } from "../../src/security/password.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { validatePackage } from "../../src/validator/validate.js";

async function waitFor(
  request: () => Promise<{ json: () => any }>,
  ready: (body: any) => boolean,
) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const body = await request().then((response) => response.json());
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for public package state");
}

describe("Ticket 11 package delivery", () => {
  let app: AgentBenchApp;
  let worker: ChildProcess;
  let db: ReturnType<typeof createPool>;
  let cookie: string;
  let csrf: string;
  let viewerCookie: string;
  let viewerCsrf: string;
  let tempDirectory: string;
  let versionId: string;
  let testSetId: string;
  let assetId: string;
  let artifacts: ArtifactRepository;

  beforeAll(async () => {
    app = await buildApp();
    db = createPool(loadConfig().databaseUrl);
    artifacts = new ArtifactRepository(loadConfig().minio);
    worker = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/worker/main.ts"],
      { stdio: "inherit" },
    );
    tempDirectory = await mkdtemp(join(tmpdir(), "agentbench-ticket11-"));
    await db.query(
      `INSERT INTO app_user (id, username, password_hash, role)
       VALUES ('user_ticket11_viewer', 'ticket11-viewer', $1, 'viewer')
       ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [await hashPassword("viewer-test-password")],
    );
    await db.query(
      `INSERT INTO project_member (project_id, user_id, role)
       VALUES ('project_demo', 'user_ticket11_viewer', 'viewer')
       ON CONFLICT DO NOTHING`,
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    csrf = login.json<{ csrfToken: string }>().csrfToken;
    const viewerLogin = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: {
        username: "ticket11-viewer",
        password: "viewer-test-password",
      },
    });
    viewerCookie = `${viewerLogin.cookies[0]?.name}=${viewerLogin.cookies[0]?.value}`;
    viewerCsrf = viewerLogin.json<{ csrfToken: string }>().csrfToken;
  });

  afterAll(async () => {
    worker.kill("SIGTERM");
    await new Promise((resolve) => worker.once("exit", resolve));
    await app.close();
    await db.end();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  async function publishV1(
    beforePublish?: (candidateId: string) => Promise<void>,
    expectedPublishStatus: "succeeded" | "failed" = "succeeded",
    beforeMaterialize?: () => Promise<void>,
  ) {
    assetId = await uploadSyntheticAsset(
      "ticket11.csv",
      "Ticket 11 package fixture",
      Buffer.from(
        [
          "question,answer,category",
          "How do refunds work?,Use the published policy,billing",
        ].join("\n"),
      ),
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/test-sets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        name: `Ticket 11 packages ${randomUUID()}`,
        purpose: "Synthetic package delivery",
        assetId,
      },
    });
    expect(created.statusCode).toBe(201);
    testSetId = created.json().testSet.id;
    const draft = created.json().draft;
    const mapping = {
      input: { object: { message: { source: "/question" } } },
      expectedOutput: { source: "/answer" },
      metadata: { object: {} },
    };
    const recipe = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/recipe`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: draft.revision,
        versionDescription: "Ticket 11 package source version",
        steps: [],
        mapping,
        unmappedFields: ["/category"],
        unmappedConfirmed: true,
      },
    });
    expect(recipe.statusCode).toBe(200);
    const publishedVersionId = await configureAndPublishDraft(
      draft.id,
      recipe.json().draft.leaseToken,
      recipe.json().draft.revision,
      mapping,
      beforePublish,
      expectedPublishStatus,
      beforeMaterialize,
    );
    if (publishedVersionId) versionId = publishedVersionId;
    return publishedVersionId;
  }

  async function uploadSyntheticAsset(
    fileName: string,
    sourceName: string,
    bytes: Buffer,
  ) {
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": randomUUID(),
        "content-type": "text/csv; charset=utf-8",
        "x-file-name": fileName,
        "x-source-type": "synthetic",
        "x-source-name": sourceName,
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Synthetic package delivery test",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: bytes,
    });
    expect(uploaded.statusCode).toBe(201);
    const uploadedAssetId = uploaded.json().asset.id as string;
    await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/assets/${uploadedAssetId}/records`,
          headers: { cookie },
        }),
      (body) => body.parsedView?.status === "ready",
    );
    return uploadedAssetId;
  }

  async function configureAndPublishDraft(
    draftId: string,
    leaseToken: string,
    expectedRevision: number,
    mapping: Record<string, unknown>,
    beforePublish?: (candidateId: string) => Promise<void>,
    expectedPublishStatus: "succeeded" | "failed" = "succeeded",
    beforeMaterialize?: () => Promise<void>,
  ): Promise<string | null> {
    const proposal = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draftId}/mapping/schema-suggestion`,
      headers: { cookie },
    });
    const configured = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${draftId}`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken,
        expectedRevision,
        proposalId: proposal.json().proposalId,
        filter: { field: "/category", operator: "eq", value: "billing" },
        mapping,
        unmappedFields: ["/category"],
        unmappedConfirmed: true,
        formalSchema: {
          mode: "gold_required",
          input: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false,
          },
          expectedOutput: { type: "string" },
        },
      },
    });
    expect(configured.statusCode).toBe(200);
    if (beforeMaterialize) await beforeMaterialize();
    const materialized = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draftId}/candidates`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken,
        expectedRevision: configured.json().draft.revision,
      },
    });
    expect(materialized.statusCode).toBe(202);
    const candidate = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}`,
          headers: { cookie },
        }),
      (body) => ["ready_to_publish", "failed"].includes(body.candidate?.status),
    );
    expect(candidate.candidate.status).toBe("ready_to_publish");
    if (beforePublish)
      await beforePublish(materialized.json().candidate.id as string);
    const published = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}/publish`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(published.statusCode).toBe(202);
    const job = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${published.json().job.id}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(job.job.status).toBe(expectedPublishStatus);
    if (expectedPublishStatus === "failed") return null;
    return job.job.result.versionId as string;
  }

  async function requestPackage(packageType: "standard" | "full_provenance") {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/versions/${versionId}/packages`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { packageType, formatVersion: "1.0" },
    });
    expect(response.statusCode).toBe(202);
    return waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${response.json().job.id}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
  }

  async function versionDeliveries() {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/versions/${versionId}/deliveries`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json().deliveries as any[];
  }

  async function waitForDatabaseLock(queryFragment: string) {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const result = await db.query(
        `SELECT 1
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query LIKE $1
         LIMIT 1`,
        [`%${queryFragment}%`],
      );
      if (result.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for database lock: ${queryFragment}`);
  }

  it("generates deterministic Standard and Full Provenance packages", async () => {
    await publishV1();

    const standard = await requestPackage("standard");
    expect(standard.job.status).toBe("succeeded");
    const standardReplay = await requestPackage("standard");
    expect(standardReplay.job.status).toBe("succeeded");
    expect(standardReplay.job.result).toMatchObject({
      deliveryId: standard.job.result.deliveryId,
      packageType: "standard",
      verificationLevel: "standard",
    });

    const full = await requestPackage("full_provenance");
    expect(full.job.status).toBe("succeeded");
    const fullReplay = await requestPackage("full_provenance");
    expect(fullReplay.job.result).toMatchObject({
      deliveryId: full.job.result.deliveryId,
      packageType: "full_provenance",
      verificationLevel: "full",
    });
    const standardDownload = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/versions/${versionId}/package`,
      headers: { cookie },
    });
    expect(standardDownload.statusCode).toBe(200);
    expect(
      (await versionDeliveries()).find(
        (item) => item.packageType === "standard",
      ),
    ).toMatchObject({
      status: "downloaded",
      externalCopyRecorded: true,
    });

    const firstDownload = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/deliveries/${full.job.result.deliveryId}/download`,
      headers: { cookie },
    });
    const secondDownload = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/deliveries/${fullReplay.job.result.deliveryId}/download`,
      headers: { cookie },
    });
    expect(firstDownload.statusCode).toBe(200);
    expect(secondDownload.statusCode).toBe(200);
    expect(firstDownload.rawPayload.equals(secondDownload.rawPayload)).toBe(
      true,
    );

    const archive = unzipSync(firstDownload.rawPayload);
    const names = Object.keys(archive).sort();
    expect(names).toContain("version/manifest.json");
    expect(names).toContain("version/items.jsonl");
    expect(names).toContain("filename-manifest.json");
    expect(names.some((name) => name.startsWith(`assets/${assetId}/`))).toBe(
      true,
    );
    expect(names.filter((name) => name.startsWith("assets/"))).toHaveLength(1);

    const packagePath = join(tempDirectory, "full.zip");
    await writeFile(packagePath, firstDownload.rawPayload);
    const validation = await validatePackage(packagePath);
    expect(validation).toMatchObject({
      valid: true,
      package_type: "full_provenance",
      verification_level: "full",
    });
    expect(strFromU8(archive["filename-manifest.json"])).toContain(assetId);

    const viewerVersion = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${testSetId}/versions/${versionId}`,
      headers: { cookie: viewerCookie },
    });
    expect(viewerVersion.statusCode).toBe(200);
    const caseId = viewerVersion.json().version.lineage[0].caseId;
    const viewerCase = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${testSetId}/versions/${versionId}/cases/${caseId}`,
      headers: { cookie: viewerCookie },
    });
    expect(viewerCase.statusCode).toBe(200);
    const viewerTrace = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/lineage/trace?subjectType=case_revision&subjectId=${viewerCase.json().testCase.revisionId}`,
      headers: { cookie: viewerCookie },
    });
    expect(viewerTrace.statusCode).toBe(200);
  });

  it("publishes a frozen candidate without live draft-source findings", async () => {
    let extraAssetId: string | undefined;
    let extraDraftSourceId: string | undefined;
    try {
      await publishV1(async (candidateId) => {
        const candidate = await db.query(
          "SELECT draft_id FROM candidate_snapshot WHERE id = $1",
          [candidateId],
        );
        const extra = await uploadSyntheticAsset(
          "ticket16-unattached.csv",
          "Ticket 16 unattached source",
          Buffer.from("question,answer\nUnattached,Fixture\n"),
        );
        extraAssetId = extra;
        const parsedView = await db.query(
          `SELECT id FROM parsed_view
           WHERE asset_id = $1 AND is_current ORDER BY created_at DESC LIMIT 1`,
          [extraAssetId],
        );
        extraDraftSourceId = `draftsrc_ticket16_${randomUUID().replaceAll(
          "-",
          "",
        )}`;
        await db.query(
          `INSERT INTO draft_source
             (id, draft_id, asset_id, parsed_view_id, position, created_by)
           SELECT $1, $2, $3, $4, COALESCE(max(position), 0) + 1, 'user_owner'
           FROM draft_source WHERE draft_id = $2`,
          [
            extraDraftSourceId,
            candidate.rows[0].draft_id,
            extraAssetId,
            parsedView.rows[0].id,
          ],
        );
        await db.query(
          `INSERT INTO consistency_finding
             (project_id, error_code, object_type, object_id, details)
           VALUES ('project_demo', 'object_missing', 'data_asset', $1, '{}')
           ON CONFLICT (error_code, object_type, object_id)
           DO UPDATE SET status = 'open', resolved_at = NULL, last_seen_at = now()`,
          [extraAssetId],
        );
      });
    } finally {
      if (extraDraftSourceId)
        await db.query("DELETE FROM draft_source WHERE id = $1", [
          extraDraftSourceId,
        ]);
      if (extraAssetId)
        await db.query(
          `UPDATE consistency_finding
           SET status = 'resolved', resolved_at = now(), last_seen_at = now()
           WHERE error_code = 'object_missing' AND object_type = 'data_asset'
             AND object_id = $1`,
          [extraAssetId],
        );
    }
  });

  it("publishes a legacy candidate from database attribution fallback", async () => {
    const existingVersionId = versionId;
    await publishV1(async (candidateId) => {
      await db.query(
        `UPDATE candidate_snapshot
         SET sources = NULL, draft_revision_id = NULL
         WHERE id = $1`,
        [candidateId],
      );
    });
    const standard = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/versions/${versionId}/package`,
      headers: { cookie },
    });
    expect(standard.statusCode).toBe(200);
    const archive = unzipSync(standard.rawPayload);
    const attributions = JSON.parse(
      strFromU8(archive["source-attributions.json"]),
    );
    expect([
      ...(Array.isArray(attributions) ? attributions : [attributions]),
    ]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetId,
          responsiblePerson: "Project Owner",
        }),
      ]),
    );
    versionId = existingVersionId;
  });

  it("does not include a cross-project legacy asset in Full Provenance closure", async () => {
    const existingVersionId = versionId;
    await publishV1();
    const foreignProjectId = `project_ticket11_foreign_${randomUUID().replaceAll(
      "-",
      "",
    )}`;
    const foreignAssetId = `asset_ticket11_foreign_${randomUUID().replaceAll(
      "-",
      "",
    )}`;
    const foreignBytes = Buffer.from("foreign project synthetic asset\n");
    const foreignObject = await artifacts.storeImmutable(foreignBytes);
    await db.query(
      `INSERT INTO project (id, name, owner_id)
       VALUES ($1, 'Ticket 11 foreign fixture', 'user_owner')`,
      [foreignProjectId],
    );
    await db.query(
      `INSERT INTO data_asset
       (id, project_id, blob_sha256, object_ref, size_bytes, mime_type,
        file_name, format, status, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,'text/csv','foreign.csv','csv','stored','user_owner')`,
      [
        foreignAssetId,
        foreignProjectId,
        foreignObject.sha256,
        foreignObject.objectRef,
        foreignBytes.byteLength,
      ],
    );
    const candidate = await db.query(
      "SELECT candidate_id FROM test_set_version WHERE id = $1",
      [versionId],
    );
    await db.query(
      `UPDATE candidate_snapshot
       SET asset_id = $2, parsed_view_id = NULL, sources = NULL, draft_revision_id = NULL
       WHERE id = $1`,
      [candidate.rows[0].candidate_id, foreignAssetId],
    );

    try {
      const full = await requestPackage("full_provenance");
      expect(full.job.status).toBe("failed");
      expect(full.job.errorCode).toBe("publication_project_scope_mismatch");
      expect(
        (await versionDeliveries()).some(
          (delivery) => delivery.packageType === "full_provenance",
        ),
      ).toBe(false);
    } finally {
      versionId = existingVersionId;
    }
  });

  it("rejects a cross-project frozen parsed-view reference before publication", async () => {
    const existingVersionId = versionId;
    const failedVersionId = await publishV1(async (candidateId) => {
      const candidate = await db.query(
        "SELECT sources FROM candidate_snapshot WHERE id = $1",
        [candidateId],
      );
      const originalSources = candidate.rows[0].sources as any[];
      expect(originalSources.length).toBeGreaterThan(0);
      const foreignProjectId = `project_ticket11_foreign_${randomUUID().replaceAll(
        "-",
        "",
      )}`;
      const foreignAssetId = `asset_ticket11_foreign_${randomUUID().replaceAll(
        "-",
        "",
      )}`;
      const foreignParsedViewId = `parsed_ticket11_foreign_${randomUUID().replaceAll(
        "-",
        "",
      )}`;
      const foreignBytes = Buffer.from("foreign parsed-view fixture\n");
      const foreignObject = await artifacts.storeImmutable(foreignBytes);
      const originalAsset = await db.query(
        `SELECT mime_type, format FROM data_asset WHERE id = $1`,
        [originalSources[0].assetId],
      );
      await db.query(
        `INSERT INTO project (id, name, owner_id)
           VALUES ($1, 'Ticket 11 foreign parsed-view fixture', 'user_owner')`,
        [foreignProjectId],
      );
      await db.query(
        `INSERT INTO data_asset
           (id, project_id, blob_sha256, object_ref, size_bytes, mime_type,
            file_name, format, status, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,'foreign-parsed-view.csv',$7,'stored','user_owner')`,
        [
          foreignAssetId,
          foreignProjectId,
          foreignObject.sha256,
          foreignObject.objectRef,
          foreignBytes.byteLength,
          originalAsset.rows[0].mime_type,
          originalAsset.rows[0].format,
        ],
      );
      await db.query(
        `INSERT INTO parsed_view
           (id, asset_id, format, parser_name, parser_version, parser_config,
            parser_config_hash, status, record_count, success_count, failure_count,
            boundary_trusted, draft_eligible, is_current)
           VALUES ($1,$2,'csv','foreign-parser','foreign-v1',$3::jsonb,
                   'foreign-ticket11', 'ready', 1, 1, 0, true, true, false)`,
        [
          foreignParsedViewId,
          foreignAssetId,
          JSON.stringify({ delimiter: "," }),
        ],
      );
      const corruptedSources = structuredClone(originalSources) as any[];
      corruptedSources[0].parsedViewId = foreignParsedViewId;
      delete corruptedSources[0].parserFormat;
      delete corruptedSources[0].parserConfig;
      await db.query(
        `UPDATE candidate_snapshot SET sources = $2::jsonb WHERE id = $1`,
        [candidateId, JSON.stringify(corruptedSources)],
      );
    }, "failed");
    expect(failedVersionId).toBeNull();
    versionId = existingVersionId;
  });

  it("rejects a cross-project frozen transformation run before publication", async () => {
    const existingVersionId = versionId;
    const failedVersionId = await publishV1(
      async (candidateId) => {
        const candidateRun = await db.query(
          `SELECT run_id FROM candidate_transformation_run
           WHERE candidate_id = $1`,
          [candidateId],
        );
        expect(candidateRun.rowCount).toBe(1);
        const foreignProjectId = `project_ticket11_foreign_${randomUUID().replaceAll(
          "-",
          "",
        )}`;
        await db.query(
          `INSERT INTO project (id, name, owner_id)
           VALUES ($1, 'Ticket 11 foreign transformation fixture', 'user_owner')`,
          [foreignProjectId],
        );
        await db.query(
          `UPDATE transformation_run SET project_id = $1 WHERE id = $2`,
          [foreignProjectId, candidateRun.rows[0].run_id],
        );
      },
      "failed",
      async () => {
        const inputAssetId = await uploadSyntheticAsset(
          "ticket11-transformation-input.csv",
          "Ticket 11 transformation input",
          Buffer.from("question,answer\nSynthetic input,Synthetic output\n"),
        );
        const [input, output] = await Promise.all([
          db.query("SELECT blob_sha256 FROM data_asset WHERE id = $1", [
            inputAssetId,
          ]),
          db.query(
            `SELECT da.blob_sha256, pv.record_count
             FROM data_asset da
             JOIN parsed_view pv ON pv.asset_id = da.id AND pv.is_current
             WHERE da.id = $1`,
            [assetId],
          ),
        ]);
        const registered = await app.inject({
          method: "POST",
          url: "/api/projects/project_demo/transformation-runs",
          headers: {
            origin: "http://127.0.0.1:3000",
            cookie,
            "x-csrf-token": csrf,
            "content-type": "application/json",
          },
          payload: {
            schemaVersion: "1.0",
            operationType: "agent_augmentation",
            lineageLevel: "asset_level",
            purpose: "Synthetic Ticket 11 project-scope fixture",
            tool: { name: "synthetic-tool", version: "1.0.0" },
            model: {
              provider: "synthetic-provider",
              name: "synthetic-model",
              parameters: {},
            },
            prompt: {
              version: "ticket11-project-scope",
              content: "Synthetic project-scope fixture.",
            },
            parameters: {},
            inputs: [
              {
                objectType: "data_asset",
                id: inputAssetId,
                sha256: input.rows[0].blob_sha256,
                scope: { entireAsset: true },
              },
            ],
            outputs: [
              {
                assetId,
                sha256: output.rows[0].blob_sha256,
                recordCount: Number(output.rows[0].record_count),
              },
            ],
            executedBy: "user_owner",
            startedAt: "2026-08-24T00:00:00.000Z",
            finishedAt: "2026-08-24T00:01:00.000Z",
          },
        });
        expect(registered.statusCode).toBe(201);
      },
    );
    expect(failedVersionId).toBeNull();
    versionId = existingVersionId;
  });

  it("retains frozen parent evidence and assets for a base-version draft", async () => {
    const existingVersionId = versionId;
    await publishV1();
    const parentVersionId = versionId;
    const parentAssetId = assetId;
    const revised = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/assets/${parentAssetId}/attribution`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        sourceType: "synthetic",
        sourceName: "Ticket 11 mutable attribution (must not leak)",
        responsiblePerson: "Project Owner",
        purpose: "Synthetic package delivery test",
        licenseStatus: "not_applicable",
        sensitivity: "non_sensitive",
        sourceAddress: null,
        acquiredAt: null,
        deidentificationConfirmed: false,
      },
    });
    expect(revised.statusCode).toBe(200);
    const childAssetId = await uploadSyntheticAsset(
      "ticket11-child.csv",
      "Ticket 11 child package fixture",
      Buffer.from(
        "question,answer,category\nChild question,Child answer,billing\n",
      ),
    );
    const opened = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${testSetId}/drafts`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { baseVersionId: parentVersionId },
    });
    expect(opened.statusCode).toBe(201);
    const draft = opened.json().draft;
    const mapping = {
      input: { object: { message: { source: "/question" } } },
      expectedOutput: { source: "/answer" },
      metadata: { object: {} },
    };
    const attached = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/sources`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        assetId: childAssetId,
        leaseToken: draft.leaseToken,
        expectedRevision: draft.revision,
      },
    });
    expect(attached.statusCode).toBe(201);
    const mapped = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${draft.id}/sources/${attached.json().source.id}/mapping`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        mapping,
        unmappedFields: ["/category"],
        unmappedConfirmed: true,
        leaseToken: attached.json().draft.leaseToken,
        expectedRevision: attached.json().draft.revision,
      },
    });
    expect(mapped.statusCode).toBe(200);
    const recipe = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/recipe`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: mapped.json().draft.leaseToken,
        expectedRevision: mapped.json().draft.revision,
        versionDescription: "Ticket 11 base-version evidence closure",
        steps: [],
      },
    });
    expect(recipe.statusCode).toBe(200);
    const derivedVersionId = (await configureAndPublishDraft(
      draft.id,
      recipe.json().draft.leaseToken,
      recipe.json().draft.revision,
      mapping,
    ))!;
    const standard = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/versions/${derivedVersionId}/package`,
      headers: { cookie },
    });
    expect(standard.statusCode).toBe(200);
    const standardArchive = unzipSync(standard.rawPayload);
    const attributions = JSON.parse(
      strFromU8(standardArchive["source-attributions.json"]),
    );
    expect(attributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetId: parentAssetId,
          sourceName: "Ticket 11 package fixture",
          responsiblePerson: "Project Owner",
        }),
        expect.objectContaining({
          assetId: childAssetId,
          sourceName: "Ticket 11 child package fixture",
          responsiblePerson: "Project Owner",
        }),
      ]),
    );
    expect(attributions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetId: parentAssetId,
          sourceName: "Ticket 11 mutable attribution (must not leak)",
        }),
      ]),
    );
    const full = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/versions/${derivedVersionId}/packages`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { packageType: "full_provenance", formatVersion: "1.0" },
    });
    expect(full.statusCode).toBe(202);
    const fullJob = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${full.json().job.id}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(fullJob.job.status).toBe("succeeded");
    const download = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/deliveries/${fullJob.job.result.deliveryId}/download`,
      headers: { cookie },
    });
    expect(download.statusCode).toBe(200);
    const assetPaths = Object.keys(unzipSync(download.rawPayload))
      .filter((name) => name.startsWith("assets/"))
      .sort();
    expect(assetPaths).toEqual(
      [
        `assets/${parentAssetId}/asset.bin`,
        `assets/${childAssetId}/asset.bin`,
      ].sort(),
    );
    versionId = existingVersionId;
  });

  it("includes an attached source even when its recipe selects zero records", async () => {
    const firstUploaded = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": randomUUID(),
        "content-type": "text/csv; charset=utf-8",
        "x-file-name": "ticket11-selected.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 11 selected source",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Synthetic package closure test",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: Buffer.from(
        "question,answer,category\nSelected source,Selected answer,billing\n",
      ),
    });
    expect(firstUploaded.statusCode).toBe(201);
    assetId = firstUploaded.json().asset.id as string;
    await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/assets/${assetId}/records`,
          headers: { cookie },
        }),
      (body) => body.parsedView?.status === "ready",
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/test-sets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        name: `Ticket 11 zero-selected ${randomUUID()}`,
        purpose: "Synthetic package closure test",
        assetId,
      },
    });
    expect(created.statusCode).toBe(201);
    testSetId = created.json().testSet.id as string;
    const openedDraft = created.json().draft;
    const mapping = {
      input: { object: { message: { source: "/question" } } },
      expectedOutput: { source: "/answer" },
      metadata: { object: {} },
    };
    const mappedFirst = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${openedDraft.id}/sources/${openedDraft.sources[0].id}/mapping`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: openedDraft.leaseToken,
        expectedRevision: openedDraft.revision,
        mapping,
        unmappedFields: ["/category"],
        unmappedConfirmed: true,
      },
    });
    expect(mappedFirst.statusCode).toBe(200);
    const extraBytes = Buffer.from(
      "question,answer,category\nExcluded source,Should not be selected,excluded\n",
    );
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": randomUUID(),
        "content-type": "text/csv; charset=utf-8",
        "x-file-name": "ticket11-excluded.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 11 excluded source",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Synthetic package closure test",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload: extraBytes,
    });
    expect(uploaded.statusCode).toBe(201);
    const extraAssetId = uploaded.json().asset.id as string;
    await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/assets/${extraAssetId}/records`,
          headers: { cookie },
        }),
      (body) => body.parsedView?.status === "ready",
    );

    const attached = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${openedDraft.id}/sources`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        assetId: extraAssetId,
        leaseToken: mappedFirst.json().draft.leaseToken,
        expectedRevision: mappedFirst.json().draft.revision,
      },
    });
    expect(attached.statusCode).toBe(201);
    const mapped = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${openedDraft.id}/sources/${attached.json().source.id}/mapping`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: attached.json().draft.leaseToken,
        expectedRevision: attached.json().draft.revision,
        mapping,
        unmappedFields: ["/category"],
        unmappedConfirmed: true,
      },
    });
    expect(mapped.statusCode).toBe(200);
    const described = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${openedDraft.id}/recipe`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: mapped.json().draft.leaseToken,
        expectedRevision: mapped.json().draft.revision,
        versionDescription: "Ticket 11 zero-selected source closure",
        steps: [
          {
            kind: "filter",
            filter: { field: "/category", operator: "eq", value: "billing" },
          },
        ],
      },
    });
    expect(described.statusCode).toBe(200);
    const proposal = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${openedDraft.id}/mapping/schema-suggestion`,
      headers: { cookie },
    });
    expect(proposal.statusCode).toBe(200);
    const configured = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${openedDraft.id}`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: described.json().draft.leaseToken,
        expectedRevision: described.json().draft.revision,
        proposalId: proposal.json().proposalId,
        filter: { field: "/category", operator: "eq", value: "billing" },
        mapping,
        unmappedFields: ["/category"],
        unmappedConfirmed: true,
        formalSchema: {
          mode: "gold_required",
          input: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false,
          },
          expectedOutput: { type: "string" },
        },
      },
    });
    expect(configured.statusCode).toBe(200);
    const materialized = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${openedDraft.id}/candidates`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: described.json().draft.leaseToken,
        expectedRevision: configured.json().draft.revision,
      },
    });
    expect(materialized.statusCode).toBe(202);
    const candidate = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/candidates/${materialized.json().candidate.id}`,
          headers: { cookie },
        }),
      (body) => ["ready_to_publish", "failed"].includes(body.candidate?.status),
    );
    expect(candidate.candidate.status).toBe("ready_to_publish");
    await db.query(
      "UPDATE candidate_snapshot SET sources = NULL WHERE id = $1",
      [candidate.candidate.id],
    );
    const published = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${candidate.candidate.id}/publish`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(published.statusCode).toBe(202);
    const publication = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${published.json().job.id}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(publication.job.status).toBe("succeeded");
    const version = publication.job.result.versionId as string;
    const request = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/versions/${version}/packages`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { packageType: "full_provenance", formatVersion: "1.0" },
    });
    expect(request.statusCode).toBe(202);
    const packageJob = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${request.json().job.id}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(packageJob.job.status).toBe("succeeded");
    const download = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/deliveries/${packageJob.job.result.deliveryId}/download`,
      headers: { cookie },
    });
    expect(download.statusCode).toBe(200);
    const assetPaths = Object.keys(unzipSync(download.rawPayload))
      .filter((name) => name.startsWith("assets/"))
      .sort();
    expect(assetPaths).toEqual(
      [
        `assets/${assetId}/asset.bin`,
        `assets/${extraAssetId}/asset.bin`,
      ].sort(),
    );
  });

  it("generates and attests a deterministic local Langfuse CSV", async () => {
    await publishV1();
    const full = await requestPackage("full_provenance");
    expect(full.job.status).toBe("succeeded");
    const request = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/versions/${versionId}/langfuse-csv`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(request.statusCode).toBe(202);
    const job = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${request.json().job.id}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(job.job.status).toBe("succeeded");
    const replay = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/versions/${versionId}/langfuse-csv`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(replay.statusCode).toBe(202);
    const replayJob = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${replay.json().job.id}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(replayJob.job.result.deliveryId).toBe(job.job.result.deliveryId);

    const generated = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/versions/${versionId}/deliveries`,
      headers: { cookie },
    });
    expect(generated.json().deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packageType: "langfuse_csv",
          status: "generated",
          externalCopyRecorded: false,
        }),
      ]),
    );
    const preview = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/deliveries/${job.job.result.deliveryId}/preview`,
      headers: { cookie },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-type"]).toContain("text/csv");
    expect(preview.rawPayload.toString("utf8")).toContain(
      "input,expected_output,metadata",
    );
    const afterPreview = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/versions/${versionId}/deliveries`,
      headers: { cookie },
    });
    expect(
      afterPreview
        .json()
        .deliveries.find((item: any) => item.packageType === "langfuse_csv"),
    ).toMatchObject({
      status: "generated",
      externalCopyRecorded: false,
    });
    expect(job.job.result.localValidation).toEqual({
      valid: true,
      rowCount: 1,
      errors: [],
    });

    const first = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/deliveries/${job.job.result.deliveryId}/download`,
      headers: { cookie },
    });
    const second = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/deliveries/${job.job.result.deliveryId}/download`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.headers["content-type"]).toContain("text/csv");
    expect(first.rawPayload.equals(second.rawPayload)).toBe(true);
    const viewerGenerate = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/versions/${versionId}/langfuse-csv`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: viewerCookie,
        "x-csrf-token": viewerCsrf,
      },
    });
    expect(viewerGenerate.statusCode).toBe(404);
    const viewerPreview = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/deliveries/${job.job.result.deliveryId}/preview`,
      headers: { cookie: viewerCookie },
    });
    expect(viewerPreview.statusCode).toBe(404);
    const viewerDownload = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/deliveries/${job.job.result.deliveryId}/download`,
      headers: { cookie: viewerCookie },
    });
    expect(viewerDownload.statusCode).toBe(404);
    const viewerAttestation = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/deliveries/${job.job.result.deliveryId}/imported`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: viewerCookie,
        "x-csrf-token": viewerCsrf,
      },
    });
    expect(viewerAttestation.statusCode).toBe(404);

    const rows: any[] = [];
    const parser = parse({
      columns: true,
      delimiter: ",",
      quote: '"',
    });
    parser.write(first.rawPayload.toString("utf8"));
    parser.end();
    for await (const row of parser) rows.push(row);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty("input");
    expect(rows[0]).toHaveProperty("expected_output");
    expect(rows[0]).toHaveProperty("metadata");
    const input = JSON.parse(rows[0].input);
    const expectedOutput = JSON.parse(rows[0].expected_output);
    const metadata = JSON.parse(rows[0].metadata);
    expect(input).toMatchObject({ message: "How do refunds work?" });
    expect(expectedOutput).toBe("Use the published policy");
    expect(metadata._agentbench).toMatchObject({
      case_id: expect.stringMatching(/^case_/),
      version_id: versionId,
    });

    const attestation = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/deliveries/${job.job.result.deliveryId}/imported`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(attestation.statusCode).toBe(200);
    expect(attestation.json().delivery).toMatchObject({
      status: "user_confirmed_imported",
      remoteVerified: false,
    });
    const deliveries = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/versions/${versionId}/deliveries`,
      headers: { cookie },
    });
    expect(deliveries.statusCode).toBe(200);
    const listed = deliveries.json().deliveries;
    expect(listed.map((item: any) => item.packageType)).not.toContain(
      "standard_package",
    );
    expect(
      listed.filter((item: any) => item.packageType === "standard"),
    ).toHaveLength(1);
    expect(listed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packageType: "standard",
          verificationLevel: "standard",
          status: expect.any(String),
        }),
        expect.objectContaining({
          packageType: "full_provenance",
          verificationLevel: "full",
          status: expect.any(String),
        }),
        expect.objectContaining({
          packageType: "langfuse_csv",
          verificationLevel: "local_csv",
          status: "user_confirmed_imported",
          remoteVerified: false,
        }),
      ]),
    );
  });

  it("does not create export Deliveries after the queued actor loses membership", async () => {
    await publishV1();
    const standard = await requestPackage("standard");
    expect(standard.job.status).toBe("succeeded");

    const packageJobId = `job_revoke_package_${randomUUID().replaceAll("-", "")}`;
    const csvJobId = `job_revoke_csv_${randomUUID().replaceAll("-", "")}`;
    await db.query("BEGIN");
    try {
      await db.query(
        `INSERT INTO job
         (id, project_id, actor_id, kind, payload, status, stage,
          correlation_id, idempotency_key, max_attempts, next_run_at)
         VALUES
           ($1, 'project_demo', 'user_ticket11_viewer', 'generate_package',
            $2::jsonb, 'queued', 'queued', $1, $3, 1, now()),
           ($4, 'project_demo', 'user_ticket11_viewer', 'generate_langfuse_csv',
            $5::jsonb, 'queued', 'queued', $4, $6, 1, now())`,
        [
          packageJobId,
          JSON.stringify({
            versionId,
            packageType: "full_provenance",
            formatVersion: "1.0",
          }),
          `revoke-package-${packageJobId}`,
          csvJobId,
          JSON.stringify({ versionId }),
          `revoke-csv-${csvJobId}`,
        ],
      );
      await db.query(
        `DELETE FROM project_member
         WHERE project_id = 'project_demo' AND user_id = 'user_ticket11_viewer'`,
      );
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }

    try {
      const packageJob = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${packageJobId}`,
            headers: { cookie },
          }),
        (body) => body.job?.status === "failed",
      );
      expect(packageJob.job.errorCode).toBe("job_actor_capability_revoked");
      const csvJob = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${csvJobId}`,
            headers: { cookie },
          }),
        (body) => body.job?.status === "failed",
      );
      expect(csvJob.job.errorCode).toBe("job_actor_capability_revoked");
      expect(
        (await versionDeliveries()).filter(
          (delivery) =>
            delivery.packageType === "full_provenance" ||
            delivery.packageType === "langfuse_csv",
        ),
      ).toHaveLength(0);
    } finally {
      await db.query(
        `INSERT INTO project_member (project_id, user_id, role)
         VALUES ('project_demo', 'user_ticket11_viewer', 'viewer')
         ON CONFLICT DO NOTHING`,
      );
    }
  });

  it("does not replay a Standard Package after the queued actor loses membership", async () => {
    await publishV1();
    const standard = await requestPackage("standard");
    expect(standard.job.status).toBe("succeeded");
    const jobId = `job_revoke_standard_${randomUUID().replaceAll("-", "")}`;
    await db.query(
      `INSERT INTO job
       (id, project_id, actor_id, kind, payload, status, stage,
        correlation_id, idempotency_key, max_attempts, next_run_at)
       VALUES ($1, 'project_demo', 'user_ticket11_viewer', 'generate_package',
               $2::jsonb, 'queued', 'queued', $1, $3, 1, now())`,
      [
        jobId,
        JSON.stringify({
          versionId,
          packageType: "standard",
          formatVersion: "1.0",
        }),
        `revoke-standard-${jobId}`,
      ],
    );
    await db.query(
      `DELETE FROM project_member
       WHERE project_id='project_demo' AND user_id='user_ticket11_viewer'`,
    );
    try {
      const job = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${jobId}`,
            headers: { cookie },
          }),
        (body) => body.job?.status === "failed",
      );
      expect(job.job.errorCode).toBe("job_actor_capability_revoked");
      expect(job.job.result).toBeNull();
      expect(
        (await versionDeliveries()).filter(
          (delivery) => delivery.packageType === "standard",
        ),
      ).toHaveLength(1);
      expect(
        (await versionDeliveries()).some(
          (delivery) => delivery.packageType === "full_provenance",
        ),
      ).toBe(false);
    } finally {
      await db.query(
        `INSERT INTO project_member (project_id, user_id, role)
         VALUES ('project_demo', 'user_ticket11_viewer', 'viewer')
         ON CONFLICT DO NOTHING`,
      );
    }
  });

  it("linearizes queued export against membership revocation in both lock orders", async () => {
    await publishV1();
    const standard = await requestPackage("standard");
    expect(standard.job.status).toBe("succeeded");

    const memberLock = await db.connect();
    try {
      await memberLock.query("BEGIN");
      await memberLock.query(
        `SELECT project_id, user_id FROM project_member
         WHERE project_id='project_demo' AND user_id='user_ticket11_viewer'
         FOR UPDATE`,
      );
      const revokeFirst = app.inject({
        method: "DELETE",
        url: "/api/projects/project_demo/members/user_ticket11_viewer",
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
        },
      });
      await waitForDatabaseLock("FOR UPDATE OF pm");
      const rejectedJobId = `job_lock_revoke_first_${randomUUID().replaceAll("-", "")}`;
      await db.query(
        `INSERT INTO job
         (id, project_id, actor_id, kind, payload, status, stage,
          correlation_id, idempotency_key, max_attempts, next_run_at)
         VALUES ($1, 'project_demo', 'user_ticket11_viewer', 'generate_package',
                 $2::jsonb, 'queued', 'queued', $1, $3, 1, now())`,
        [
          rejectedJobId,
          JSON.stringify({
            versionId,
            packageType: "full_provenance",
            formatVersion: "1.0",
          }),
          `lock-revoke-first-${rejectedJobId}`,
        ],
      );
      await waitForDatabaseLock("SELECT role FROM project_member");
      await memberLock.query("COMMIT");
      const revokeResult = await revokeFirst;
      expect(revokeResult.statusCode).toBe(200);
      const rejectedJob = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${rejectedJobId}`,
            headers: { cookie },
          }),
        (body) => body.job?.status === "failed",
      );
      expect(rejectedJob.job.errorCode).toBe("job_actor_capability_revoked");
      expect(
        (await versionDeliveries()).some(
          (delivery) => delivery.packageType === "full_provenance",
        ),
      ).toBe(false);
    } finally {
      await memberLock.query("ROLLBACK").catch(() => undefined);
      memberLock.release();
      await db.query(
        `INSERT INTO project_member (project_id, user_id, role)
         VALUES ('project_demo', 'user_ticket11_viewer', 'viewer')
         ON CONFLICT DO NOTHING`,
      );
    }

    const versionLock = await db.connect();
    try {
      await versionLock.query("BEGIN");
      await versionLock.query(
        "SELECT id FROM test_set_version WHERE id=$1 FOR UPDATE",
        [versionId],
      );
      const acceptedJobId = `job_lock_worker_first_${randomUUID().replaceAll("-", "")}`;
      await db.query(
        `INSERT INTO job
         (id, project_id, actor_id, kind, payload, status, stage,
          correlation_id, idempotency_key, max_attempts, next_run_at)
         VALUES ($1, 'project_demo', 'user_ticket11_viewer', 'generate_package',
                 $2::jsonb, 'queued', 'queued', $1, $3, 1, now())`,
        [
          acceptedJobId,
          JSON.stringify({
            versionId,
            packageType: "full_provenance",
            formatVersion: "1.0",
          }),
          `lock-worker-first-${acceptedJobId}`,
        ],
      );
      await waitForDatabaseLock("FOR UPDATE OF v");
      const revokeAfterWorkerLock = app.inject({
        method: "DELETE",
        url: "/api/projects/project_demo/members/user_ticket11_viewer",
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
        },
      });
      await waitForDatabaseLock("FOR UPDATE OF pm");
      await versionLock.query("COMMIT");
      const acceptedJob = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${acceptedJobId}`,
            headers: { cookie },
          }),
        (body) => body.job?.status === "succeeded",
      );
      expect(acceptedJob.job.result.packageType).toBe("full_provenance");
      expect((await revokeAfterWorkerLock).statusCode).toBe(200);
      expect(
        (await versionDeliveries()).filter(
          (delivery) => delivery.packageType === "full_provenance",
        ),
      ).toHaveLength(1);
    } finally {
      await versionLock.query("ROLLBACK").catch(() => undefined);
      versionLock.release();
      await db.query(
        `INSERT INTO project_member (project_id, user_id, role)
         VALUES ('project_demo', 'user_ticket11_viewer', 'viewer')
         ON CONFLICT DO NOTHING`,
      );
    }
  });

  it("does not let a Viewer queued CSV job bypass the write capability", async () => {
    await publishV1();
    const standard = await requestPackage("standard");
    expect(standard.job.status).toBe("succeeded");
    const jobId = `job_viewer_csv_${randomUUID().replaceAll("-", "")}`;
    await db.query(
      `INSERT INTO job
       (id, project_id, actor_id, kind, payload, status, stage,
        correlation_id, idempotency_key, max_attempts, next_run_at)
       VALUES ($1, 'project_demo', 'user_ticket11_viewer',
               'generate_langfuse_csv', $2::jsonb, 'queued', 'queued',
               $1, $3, 1, now())`,
      [jobId, JSON.stringify({ versionId }), `viewer-csv-${jobId}`],
    );
    const job = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${jobId}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "failed",
    );
    expect(job.job.errorCode).toBe("job_actor_capability_revoked");
    expect(
      (await versionDeliveries()).some(
        (delivery) => delivery.packageType === "langfuse_csv",
      ),
    ).toBe(false);
  });

  it("cancels queued Full Provenance and CSV jobs before Delivery visibility", async () => {
    await publishV1();
    process.kill(worker.pid!, "SIGSTOP");
    const request = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/versions/${versionId}/packages`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { packageType: "full_provenance", formatVersion: "1.0" },
    });
    expect(request.statusCode).toBe(202);
    const jobId = request.json().job.id;
    const cancel = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/jobs/${jobId}/cancel`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(cancel.statusCode).toBe(202);
    const csvRequest = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/versions/${versionId}/langfuse-csv`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(csvRequest.statusCode).toBe(202);
    const csvJobId = csvRequest.json().job.id;
    const csvCancel = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/jobs/${csvJobId}/cancel`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(csvCancel.statusCode).toBe(202);
    const visible = await versionDeliveries();
    expect(
      visible.filter(
        (item) =>
          item.packageType === "full_provenance" ||
          item.packageType === "langfuse_csv",
      ),
    ).toHaveLength(0);
    process.kill(worker.pid!, "SIGCONT");
    const job = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${jobId}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "cancelled",
    );
    expect(job.job).toMatchObject({
      id: jobId,
      status: "cancelled",
      stage: "cancelled",
    });
    const csvJob = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${csvJobId}`,
          headers: { cookie },
        }),
      (body) => body.job?.status === "cancelled",
    );
    expect(csvJob.job).toMatchObject({
      id: csvJobId,
      status: "cancelled",
      stage: "cancelled",
    });
    const replay = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/versions/${versionId}/packages`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { packageType: "full_provenance", formatVersion: "1.0" },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().job.id).toBe(jobId);

    const replayJob = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${jobId}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(replayJob.job.status).toBe("succeeded");

    const csvReplay = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/versions/${versionId}/langfuse-csv`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(csvReplay.statusCode).toBe(202);
    expect(csvReplay.json().job.id).toBe(csvJobId);
    const csvReplayJob = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${csvJobId}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(csvReplayJob.job.status).toBe("succeeded");
    expect(csvReplayJob.job.result.deliveryId).toBeTruthy();
    expect(
      (await versionDeliveries()).filter(
        (item) =>
          item.packageType === "full_provenance" ||
          item.packageType === "langfuse_csv",
      ),
    ).toHaveLength(2);
  });

  it("retries a Full Provenance object-storage interruption without duplicate Delivery", async () => {
    await publishV1();
    const standard = await db.query(
      `SELECT object_ref, delivery_hash FROM delivery_record
       WHERE version_id = $1 AND package_type = 'standard'`,
      [versionId],
    );
    const objectRef = standard.rows[0].object_ref as string;
    const bytes = await artifacts.readBytes(objectRef, 120_000_000);
    process.kill(worker.pid!, "SIGSTOP");
    await artifacts.remove(objectRef);
    const request = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/versions/${versionId}/packages`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { packageType: "full_provenance", formatVersion: "1.0" },
    });
    expect(request.statusCode).toBe(202);
    const jobId = request.json().job.id;
    process.kill(worker.pid!, "SIGCONT");
    await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${jobId}`,
          headers: { cookie },
        }),
      (body) => ["retry_wait", "failed"].includes(body.job?.status),
    );
    await artifacts.client.putObject(
      artifacts.bucket,
      objectRef,
      bytes,
      bytes.byteLength,
    );
    const job = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${jobId}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(job.job.status).toBe("succeeded");
    const deliveries = await versionDeliveries();
    expect(
      deliveries.filter((item) => item.packageType === "full_provenance"),
    ).toHaveLength(1);
    const download = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/deliveries/${job.job.result.deliveryId}/download`,
      headers: { cookie },
    });
    expect(download.statusCode).toBe(200);
  });
});
