import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";

type Asset = {
  id: string;
  sha256: string;
  parsedViewId: string;
  recordHash: string;
  recordCount: number;
};

async function waitFor(
  request: () => Promise<{ json: () => any }>,
  ready: (body: any) => boolean,
) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const body = await request().then((response) => response.json());
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for public controlled-deletion fixture");
}

describe("Ticket 14 complete lineage and unaffected-version closure", () => {
  let app: AgentBenchApp;
  let worker: ChildProcess;
  let cookie = "";
  let csrf = "";
  const suffix = randomUUID().replaceAll("-", "");
  const testSetName = `Ticket 14 public lineage ${suffix}`;
  let testSetId = "";
  let affectedVersionId = "";
  let unaffectedVersionId = "";
  let sourceAsset: Asset;
  let unaffectedAsset: Asset;
  let derivedAsset: Asset;
  let indirectAsset: Asset;
  const db = createPool(loadConfig().databaseUrl);
  const artifacts = new ArtifactRepository(loadConfig().minio);

  const writeHeaders = {
    origin: "http://127.0.0.1:3000",
    get cookie() {
      return cookie;
    },
    get "x-csrf-token"() {
      return csrf;
    },
    "content-type": "application/json",
  };

  async function login() {
    const response = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    expect(response.statusCode).toBe(200);
    cookie = `${response.cookies[0]?.name}=${response.cookies[0]?.value}`;
    csrf = response.json<{ csrfToken: string }>().csrfToken;
  }

  async function upload(fileName: string, payload: Buffer): Promise<Asset> {
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        ...writeHeaders,
        "idempotency-key": `ticket14-public-${randomUUID()}`,
        "content-type": "text/csv; charset=utf-8",
        "x-file-name": fileName,
        "x-source-type": "synthetic",
        "x-source-name": `Ticket 14 ${fileName}`,
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Synthetic controlled deletion lineage",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const assetId = uploaded.json().asset.id as string;
    const ready = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/assets/${assetId}/records`,
          headers: { cookie },
        }),
      (body) => body.parsedView?.status === "ready",
    );
    expect(ready.records).toHaveLength(1);
    return {
      id: assetId,
      sha256: uploaded.json().asset.sha256,
      parsedViewId: ready.parsedView.id,
      recordHash: ready.records[0].recordHash,
      recordCount: Number(ready.parsedView.recordCount),
    };
  }

  const mapping = {
    input: { object: { message: { source: "/question" } } },
    expectedOutput: { source: "/answer" },
    metadata: { object: {} },
  };
  const formalSchema = {
    mode: "gold_required",
    input: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    expectedOutput: { type: "string" },
  };

  async function configureAndPublish(
    draft: Record<string, any>,
    filterValue: string,
  ) {
    const recipe = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/recipe`,
      headers: writeHeaders,
      payload: {
        leaseToken: draft.leaseToken,
        expectedRevision: draft.revision,
        versionDescription: "Synthetic controlled deletion version",
        steps: [],
        mapping,
        unmappedFields: [],
        unmappedConfirmed: true,
      },
    });
    expect(recipe.statusCode).toBe(200);
    const proposal = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draft.id}/mapping/schema-suggestion`,
      headers: { cookie },
    });
    expect(proposal.statusCode).toBe(200);
    const configured = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${draft.id}`,
      headers: writeHeaders,
      payload: {
        leaseToken: recipe.json().draft.leaseToken,
        expectedRevision: recipe.json().draft.revision,
        proposalId: proposal.json().proposalId,
        filter: { field: "/question", operator: "eq", value: filterValue },
        mapping,
        unmappedFields: [],
        unmappedConfirmed: true,
        formalSchema,
      },
    });
    expect(configured.statusCode).toBe(200);
    const refreshed = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draft.id}`,
      headers: { cookie },
    });
    expect(refreshed.statusCode).toBe(200);
    const materialized = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/candidates`,
      headers: writeHeaders,
      payload: {
        leaseToken: refreshed.json().draft.leaseToken,
        expectedRevision: refreshed.json().draft.revision,
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
    const published = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/candidates/${candidate.candidate.id}/publish`,
      headers: writeHeaders,
      payload: {},
    });
    expect(published.statusCode).toBe(202);
    const completed = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${published.json().job.id}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(completed.job.status).toBe("succeeded");
    return completed.job.result.versionId as string;
  }

  async function downloadStandardPackage(versionId: string) {
    const generated = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/versions/${versionId}/packages`,
      headers: writeHeaders,
      payload: { packageType: "standard", formatVersion: "1.0" },
    });
    expect(generated.statusCode).toBe(202);
    const completed = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/jobs/${generated.json().job.id}`,
          headers: { cookie },
        }),
      (body) => ["succeeded", "failed"].includes(body.job?.status),
    );
    expect(completed.job.status).toBe("succeeded");
    const downloaded = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/versions/${versionId}/package`,
      headers: { cookie },
    });
    expect(downloaded.statusCode).toBe(200);
  }

  async function deleteAsset(assetId: string) {
    const preview = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/deletions/preview",
      headers: writeHeaders,
      payload: { targetType: "data_asset", targetId: assetId },
    });
    expect(preview.statusCode).toBe(201);
    const deletion = preview.json().deletion;
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/deletions/${deletion.id}/confirm`,
      headers: writeHeaders,
      payload: {
        previewHash: deletion.previewHash,
        reasonCode: "nonproduction_test",
        reasonNote: "Synthetic lineage cleanup",
      },
    });
    expect(confirmed.statusCode).toBe(202);
    return waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/deletions/${deletion.id}/outcome`,
          headers: { cookie },
        }),
      (body) => ["completed", "failed"].includes(body.deletion?.status),
    );
  }

  async function registerRun(
    operationType: "code_rule" | "agent_generation",
    lineageLevel: "record_level" | "asset_level",
    input: Asset,
    output: Asset,
  ) {
    const manifest: Record<string, unknown> = {
      schemaVersion: "1.0",
      operationType,
      lineageLevel,
      purpose: "Synthetic controlled deletion lineage run",
      tool: {
        name: "ticket14-synthetic-transform",
        version: "1.0.0",
        ...(operationType === "code_rule" ? { codeRef: "git:ticket14" } : {}),
      },
      parameters: { seed: suffix },
      inputs: [
        {
          objectType: "data_asset",
          id: input.id,
          sha256: input.sha256,
          scope: { entireAsset: true },
        },
      ],
      outputs: [
        {
          assetId: output.id,
          sha256: output.sha256,
          recordCount: output.recordCount,
        },
      ],
      executedBy: "user_owner",
      startedAt: "2026-08-22T02:10:00.000Z",
      finishedAt: "2026-08-22T02:14:00.000Z",
    };
    if (operationType === "agent_generation") {
      const prompt = "Synthetic controlled deletion prompt";
      manifest.model = {
        provider: "synthetic-provider",
        name: "synthetic-model",
        parameters: { temperature: 0 },
      };
      manifest.prompt = {
        version: "ticket14-v1",
        content: prompt,
        sha256: createHash("sha256").update(prompt).digest("hex"),
      };
    } else {
      manifest.recordEdges = [
        {
          outputOrdinal: 1,
          inputs: [
            {
              objectType: "source_record",
              parsedViewId: input.parsedViewId,
              ordinal: 1,
              recordHash: input.recordHash,
            },
          ],
        },
      ];
    }
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/transformation-runs",
      headers: writeHeaders,
      payload: manifest,
    });
    expect(response.statusCode).toBe(201);
    return response.json().run;
  }

  async function createPublicFixture() {
    sourceAsset = await upload(
      "ticket14-lineage-source.csv",
      Buffer.from(`question,answer\nlineage source,lineage answer ${suffix}\n`),
    );
    unaffectedAsset = await upload(
      "ticket14-lineage-unaffected.csv",
      Buffer.from(
        `question,answer\nunaffected source,unaffected answer ${suffix}\n`,
      ),
    );
    derivedAsset = await upload(
      "ticket14-lineage-derived.csv",
      Buffer.from(`question,answer\nderived source,derived answer ${suffix}\n`),
    );
    indirectAsset = await upload(
      "ticket14-lineage-indirect.csv",
      Buffer.from(
        `question,answer\nindirect source,indirect answer ${suffix}\n`,
      ),
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/test-sets",
      headers: writeHeaders,
      payload: {
        name: testSetName,
        purpose: "Synthetic controlled deletion lineage",
        assetId: sourceAsset.id,
      },
    });
    expect(created.statusCode).toBe(201);
    testSetId = created.json().testSet.id;
    affectedVersionId = await configureAndPublish(
      created.json().draft,
      "lineage source",
    );
    await registerRun("code_rule", "record_level", sourceAsset, derivedAsset);
    await registerRun(
      "agent_generation",
      "asset_level",
      derivedAsset,
      indirectAsset,
    );

    const blank = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${testSetId}/drafts`,
      headers: writeHeaders,
      payload: {},
    });
    expect(blank.statusCode).toBe(201);
    const attached = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${blank.json().draft.id}/sources`,
      headers: writeHeaders,
      payload: {
        assetId: unaffectedAsset.id,
        leaseToken: blank.json().draft.leaseToken,
        expectedRevision: blank.json().draft.revision,
      },
    });
    expect(attached.statusCode).toBe(201);
    const mapped = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${blank.json().draft.id}/sources/${attached.json().source.id}/mapping`,
      headers: writeHeaders,
      payload: {
        mapping,
        unmappedFields: [],
        unmappedConfirmed: true,
        leaseToken: attached.json().draft.leaseToken,
        expectedRevision: attached.json().draft.revision,
      },
    });
    expect(mapped.statusCode).toBe(200);
    unaffectedVersionId = await configureAndPublish(
      mapped.json().draft,
      "unaffected source",
    );
    await downloadStandardPackage(affectedVersionId);
  }

  beforeAll(async () => {
    app = await buildApp();
    worker = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/worker/main.ts"],
      { stdio: "inherit" },
    );
    await login();
    await createPublicFixture();
  });

  afterAll(async () => {
    worker.kill("SIGTERM");
    await new Promise((resolve) => worker.once("exit", resolve));
    await app.close();
    await db.end();
  });

  it("captures direct/indirect derived assets and record/asset lineage without absorbing an unaffected version", async () => {
    const preview = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/deletions/preview",
      headers: writeHeaders,
      payload: { targetType: "data_asset", targetId: sourceAsset.id },
    });
    expect(preview.statusCode).toBe(201);
    const closure = preview.json().deletion.closure;
    expect(closure.assets.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining([
        sourceAsset.id,
        derivedAsset.id,
        indirectAsset.id,
      ]),
    );
    expect(closure.parsedViews.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining([
        sourceAsset.parsedViewId,
        derivedAsset.parsedViewId,
        indirectAsset.parsedViewId,
      ]),
    );
    expect(closure.sourceRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ parsedViewId: sourceAsset.parsedViewId }),
      ]),
    );
    expect(closure.transformationRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationType: "code_rule",
          lineageLevel: "record_level",
        }),
        expect.objectContaining({
          operationType: "agent_generation",
          lineageLevel: "asset_level",
        }),
      ]),
    );
    expect(closure.candidates.length).toBeGreaterThan(0);
    expect(closure.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ draftId: expect.any(String) }),
      ]),
    );
    const draftIds = closure.drafts.map((item: { id: string }) => item.id);
    const draftRevisionRows = await db.query(
      `SELECT dr.id FROM draft_revision dr
       JOIN working_draft wd ON wd.id = dr.draft_id
       JOIN test_set ts ON ts.id = wd.test_set_id
       WHERE dr.draft_id = ANY($1::text[]) AND ts.project_id = $2`,
      [draftIds, "project_demo"],
    );
    expect(
      closure.draftRevisions.map((item: { id: string }) => item.id),
    ).toEqual(
      expect.arrayContaining(draftRevisionRows.rows.map((row) => row.id)),
    );
    expect(closure.caseRevisions.length).toBeGreaterThan(0);
    expect(closure.caseRevisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ caseId: expect.any(String) }),
      ]),
    );
    expect(closure.versions.map((item: { id: string }) => item.id)).toContain(
      affectedVersionId,
    );
    expect(
      closure.versions.map((item: { id: string }) => item.id),
    ).not.toContain(unaffectedVersionId);
    expect(closure.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          versionId: affectedVersionId,
          status: "downloaded",
        }),
      ]),
    );
    expect(closure.sharedBlobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sha256: sourceAsset.sha256,
          deleteObject: true,
        }),
        expect.objectContaining({
          sha256: derivedAsset.sha256,
          deleteObject: true,
        }),
        expect.objectContaining({
          sha256: indirectAsset.sha256,
          deleteObject: true,
        }),
      ]),
    );
    expect(closure.externalCopies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          versionId: affectedVersionId,
          status: "not_recalled_or_verified",
        }),
      ]),
    );

    const versionPreview = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/deletions/preview",
      headers: writeHeaders,
      payload: {
        targetType: "test_set_version",
        targetId: affectedVersionId,
      },
    });
    expect(versionPreview.statusCode).toBe(201);
    const versionClosure = versionPreview.json().deletion.closure;
    expect(versionClosure.assets).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: sourceAsset.id })]),
    );
    expect(versionClosure.drafts).toEqual(
      expect.arrayContaining([expect.objectContaining({ testSetId })]),
    );

    const testSetPreview = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/deletions/preview",
      headers: writeHeaders,
      payload: { targetType: "test_set", targetId: testSetId },
    });
    expect(testSetPreview.statusCode).toBe(201);
    const testSetClosure = testSetPreview.json().deletion.closure;
    expect(testSetClosure.drafts).toEqual(
      expect.arrayContaining([expect.objectContaining({ testSetId })]),
    );
    expect(testSetClosure.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: sourceAsset.id }),
        expect.objectContaining({ id: unaffectedAsset.id }),
      ]),
    );
  });

  it("keeps the unaffected version available and permits an explicit Owner default selection after deletion", async () => {
    await downloadStandardPackage(unaffectedVersionId);
    const affectedCandidate = await db.query(
      `SELECT cs.id, cs.object_ref, cs.evidence_object_ref
       FROM candidate_snapshot cs JOIN test_set_version v ON v.candidate_id = cs.id
       WHERE v.id = $1`,
      [affectedVersionId],
    );
    const affectedRunIds = await db.query(
      `SELECT run_id FROM candidate_transformation_run WHERE candidate_id = $1`,
      [affectedCandidate.rows[0]?.id],
    );
    const unaffectedCandidate = await db.query(
      `SELECT cs.id, cs.object_ref, cs.evidence_object_ref
       FROM candidate_snapshot cs JOIN test_set_version v ON v.candidate_id = cs.id
       WHERE v.id = $1`,
      [unaffectedVersionId],
    );
    const affectedDelivery = await db.query(
      `SELECT dr.object_ref FROM delivery_record dr WHERE dr.version_id = $1`,
      [affectedVersionId],
    );
    const unaffectedDelivery = await db.query(
      `SELECT dr.id, dr.object_ref FROM delivery_record dr WHERE dr.version_id = $1`,
      [unaffectedVersionId],
    );
    const affectedManifest = await db.query(
      `SELECT manifest_object_ref FROM test_set_version WHERE id = $1`,
      [affectedVersionId],
    );
    const unaffectedManifest = await db.query(
      `SELECT manifest_object_ref FROM test_set_version WHERE id = $1`,
      [unaffectedVersionId],
    );
    expect(affectedCandidate.rows[0]).toBeDefined();
    expect(unaffectedCandidate.rows[0]).toBeDefined();
    expect(affectedDelivery.rows[0]).toBeDefined();
    expect(unaffectedDelivery.rows[0]).toBeDefined();
    expect(affectedManifest.rows[0]).toBeDefined();
    expect(unaffectedManifest.rows[0]).toBeDefined();
    const evidenceDescriptor = JSON.parse(
      (
        await artifacts.readBytes(
          affectedCandidate.rows[0].evidence_object_ref,
          1_000_000,
        )
      ).toString("utf8"),
    ) as { objects?: Array<{ objectRef?: string }> };
    const evidenceChildRefs = (evidenceDescriptor.objects ?? [])
      .map((object) => object.objectRef)
      .filter((objectRef): objectRef is string => Boolean(objectRef));
    const candidateId = unaffectedCandidate.rows[0].id as string;
    const originalCandidateRefs = unaffectedCandidate.rows[0];
    const originalDeliveryRef = unaffectedDelivery.rows[0].object_ref as string;
    const originalManifestRef = unaffectedManifest.rows[0]
      .manifest_object_ref as string;
    await db.query(
      `UPDATE candidate_snapshot
       SET object_ref = $2, evidence_object_ref = $3 WHERE id = $1`,
      [
        candidateId,
        affectedCandidate.rows[0].object_ref,
        affectedCandidate.rows[0].evidence_object_ref,
      ],
    );
    await db.query(`UPDATE delivery_record SET object_ref = $2 WHERE id = $1`, [
      unaffectedDelivery.rows[0].id,
      affectedDelivery.rows[0].object_ref,
    ]);
    await db.query(
      `UPDATE test_set_version SET manifest_object_ref = $2 WHERE id = $1`,
      [unaffectedVersionId, affectedManifest.rows[0].manifest_object_ref],
    );
    let completed: Awaited<ReturnType<typeof deleteAsset>>;
    try {
      completed = await deleteAsset(sourceAsset.id);
      expect(completed.deletion.status).toBe("completed");
      await expect(
        artifacts.readBytes(affectedCandidate.rows[0].object_ref, 100_000_000),
      ).resolves.toBeInstanceOf(Buffer);
      await expect(
        artifacts.readBytes(
          affectedCandidate.rows[0].evidence_object_ref,
          1_000_000,
        ),
      ).resolves.toBeInstanceOf(Buffer);
      for (const objectRef of evidenceChildRefs)
        await expect(
          artifacts.readBytes(objectRef, 1_000_000),
        ).resolves.toBeInstanceOf(Buffer);
      await expect(
        artifacts.readBytes(affectedDelivery.rows[0].object_ref, 100_000_000),
      ).resolves.toBeInstanceOf(Buffer);
      await expect(
        artifacts.readBytes(
          affectedManifest.rows[0].manifest_object_ref,
          1_000_000,
        ),
      ).resolves.toBeInstanceOf(Buffer);
    } finally {
      await db.query(
        `UPDATE candidate_snapshot SET object_ref = $2, evidence_object_ref = $3 WHERE id = $1`,
        [
          candidateId,
          originalCandidateRefs.object_ref,
          originalCandidateRefs.evidence_object_ref,
        ],
      );
      await db.query(
        `UPDATE delivery_record SET object_ref = $2 WHERE id = $1`,
        [unaffectedDelivery.rows[0].id, originalDeliveryRef],
      );
      await db.query(
        `UPDATE test_set_version SET manifest_object_ref = $2 WHERE id = $1`,
        [unaffectedVersionId, originalManifestRef],
      );
    }
    expect(completed.deletion.status).toBe("completed");
    const outputRows = await db.query(
      `SELECT tro.run_id FROM transformation_run_output tro
       JOIN transformation_run tr ON tr.id = tro.run_id
       WHERE tro.asset_id = ANY($1::text[]) AND tr.project_id = $2`,
      [[derivedAsset.id, indirectAsset.id], "project_demo"],
    );
    expect(outputRows.rows).toEqual([]);
    const residualRunEvidence = affectedRunIds.rows.length
      ? await db.query(
          `SELECT candidate_id, run_id, evidence
           FROM candidate_transformation_run
           WHERE run_id = ANY($1::text[])`,
          [affectedRunIds.rows.map((row) => row.run_id)],
        )
      : { rows: [] };
    expect(residualRunEvidence.rows).toEqual([]);
    expect(completed.deletion.closure.externalCopies).toEqual([
      expect.objectContaining({
        status: "not_recalled_or_verified",
      }),
    ]);
    const lineage = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/lineage/trace?subjectType=test_set_version&subjectId=${affectedVersionId}`,
      headers: { cookie },
    });
    expect(lineage.statusCode).toBe(409);
    const compare = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${testSetId}/versions/${affectedVersionId}/compare/${unaffectedVersionId}`,
      headers: { cookie },
    });
    expect(compare.statusCode).toBe(409);

    const versions = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${testSetId}/versions`,
      headers: { cookie },
    });
    expect(versions.statusCode).toBe(200);
    expect(versions.json()).toMatchObject({
      testSet: { availability: "available", defaultVersionId: null },
      versions: expect.arrayContaining([
        expect.objectContaining({
          id: affectedVersionId,
          status: "degraded_by_deletion",
        }),
        expect.objectContaining({
          id: unaffectedVersionId,
          status: "published",
        }),
      ]),
    });

    const tombstoneVersion = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${testSetId}/versions/${affectedVersionId}`,
      headers: { cookie },
    });
    expect(tombstoneVersion.statusCode).toBe(200);
    expect(tombstoneVersion.json()).toMatchObject({
      tombstoneOnly: true,
      version: { id: affectedVersionId, status: "degraded_by_deletion" },
    });
    const tombstoneCases = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${testSetId}/versions/${affectedVersionId}/cases`,
      headers: { cookie },
    });
    expect(tombstoneCases.statusCode).toBe(409);

    const blockedPackage = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/versions/${affectedVersionId}/packages`,
      headers: writeHeaders,
      payload: { packageType: "standard", formatVersion: "1.0" },
    });
    expect(blockedPackage.statusCode).toBe(409);

    const selected = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${testSetId}/versions/${unaffectedVersionId}/default`,
      headers: writeHeaders,
      payload: {
        reason: "Select unaffected synthetic version",
        expectedDefaultVersionId: null,
        correlationId: `ticket14-lineage-default-${suffix}`,
      },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({
      testSet: { defaultVersionId: unaffectedVersionId },
      version: { id: unaffectedVersionId, status: "published" },
    });

    const allDegraded = await deleteAsset(unaffectedAsset.id);
    expect(allDegraded.deletion.status).toBe("completed");
    const unavailable = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${testSetId}/versions`,
      headers: { cookie },
    });
    expect(unavailable.statusCode).toBe(200);
    expect(unavailable.json()).toMatchObject({
      testSet: {
        availability: "unavailable_by_deletion",
        defaultVersionId: null,
      },
    });
  });
});
