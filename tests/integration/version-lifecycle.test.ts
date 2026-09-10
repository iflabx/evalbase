import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { hashPassword } from "../../src/security/password.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";

async function waitFor(
  request: () => Promise<{ json: () => any }>,
  ready: (body: any) => boolean,
) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const body = await request().then((response) => response.json());
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for public version state");
}

describe("Ticket 08 version lifecycle", () => {
  let app: AgentBenchApp;
  let worker: ChildProcess;
  let db: ReturnType<typeof createPool>;
  let cookie: string;
  let csrf: string;

  beforeAll(async () => {
    app = await buildApp();
    db = createPool(loadConfig().databaseUrl);
    worker = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/worker/main.ts"],
      { stdio: "inherit" },
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    csrf = login.json().csrfToken;
  });

  afterAll(async () => {
    worker.kill("SIGTERM");
    await new Promise((resolve) => worker.once("exit", resolve));
    await app.close();
    await db.end();
  });

  async function upload(fileName: string, payload: Buffer) {
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
        "x-source-name": `Ticket 08 ${fileName}`,
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Synthetic version lifecycle test",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload,
    });
    expect(uploaded.statusCode).toBe(201);
    const assetId = uploaded.json().asset.id as string;
    const preview = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/assets/${assetId}/records`,
          headers: { cookie },
        }),
      (body) => body.parsedView?.status === "ready",
    );
    return { assetId, parsedViewId: preview.parsedView.id as string };
  }

  async function publishReadyCandidate(draftId: string, revision: number) {
    const materialized = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draftId}/candidates`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { leaseToken: currentLease, expectedRevision: revision },
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
    expect(job.job.status).toBe("succeeded");
    return job.job.result.versionId as string;
  }

  let currentLease = "";

  async function publishV1WithTwoCases() {
    const source = await upload(
      "ticket08-v1.csv",
      Buffer.from(
        [
          "question,answer,category",
          "first question,first answer,billing",
          "second question,second answer,billing",
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
        name: `Ticket 08 versions ${randomUUID()}`,
        purpose: "Synthetic version lifecycle",
        assetId: source.assetId,
      },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json().draft;
    const initialBindings = draft.sources[0].caseBindings;
    expect(initialBindings).toHaveLength(2);
    expect(initialBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRecordOrdinal: 1,
          caseId: expect.stringMatching(/^case_/),
        }),
        expect.objectContaining({
          sourceRecordOrdinal: 2,
          caseId: expect.stringMatching(/^case_/),
        }),
      ]),
    );
    currentLease = draft.leaseToken;
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
        leaseToken: currentLease,
        expectedRevision: draft.revision,
        versionDescription: "Ticket 08 synthetic v1",
        steps: [
          {
            kind: "filter",
            filter: { field: "/category", operator: "eq", value: "billing" },
          },
        ],
        mapping,
        unmappedFields: ["/category"],
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
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: currentLease,
        expectedRevision: recipe.json().draft.revision,
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
    const versionId = await publishReadyCandidate(
      draft.id,
      configured.json().draft.revision,
    );
    const version = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${created.json().testSet.id}/versions/${versionId}`,
      headers: { cookie },
    });
    return {
      testSetId: created.json().testSet.id,
      versionId,
      version: version.json().version,
      source,
    };
  }

  async function prepareDerivedDraft(v1: any) {
    const opened = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/drafts`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { baseVersionId: v1.versionId },
    });
    expect(opened.statusCode).toBe(201);
    const draft = opened.json().draft;
    currentLease = draft.leaseToken;
    const addedSource = await upload(
      "ticket08-added.jsonl",
      Buffer.from(
        '{"prompt":"new question","result":"new answer","category":"billing"}\n',
      ),
    );
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
        assetId: addedSource.assetId,
        leaseToken: currentLease,
        expectedRevision: draft.revision,
      },
    });
    expect(attached.statusCode).toBe(201);
    expect(attached.json().draft.sources[0].caseBindings).toHaveLength(1);
    const mapping = {
      input: { object: { message: { source: "/prompt" } } },
      expectedOutput: { source: "/result" },
      metadata: { object: {} },
    };
    const savedMapping = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${draft.id}/sources/${attached.json().source.id}/mapping`,
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
    expect(savedMapping.statusCode).toBe(200);
    currentLease = savedMapping.json().draft.leaseToken;
    const described = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/recipe`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: currentLease,
        expectedRevision: savedMapping.json().draft.revision,
        versionDescription: "Ticket 08 synthetic v2",
        steps: [
          {
            kind: "filter",
            filter: { field: "/category", operator: "eq", value: "billing" },
          },
        ],
        mapping,
        unmappedFields: ["/category"],
        unmappedConfirmed: true,
      },
    });
    expect(described.statusCode).toBe(200);
    currentLease = described.json().draft.leaseToken;
    const proposal = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draft.id}/mapping/schema-suggestion`,
      headers: { cookie },
    });
    expect(proposal.statusCode).toBe(200);
    const configured = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${draft.id}`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: currentLease,
        expectedRevision: described.json().draft.revision,
        proposalId: proposal.json().proposalId,
        filter: { field: "/category", operator: "eq", value: "billing" },
        mapping,
        unmappedFields: ["/category"],
        unmappedConfirmed: true,
        formalSchema: v1.version.evidence.schema,
      },
    });
    expect(configured.statusCode).toBe(200);
    return { draft, described, configured };
  }

  it("reconciles added, removed, modified, and unchanged version members", async () => {
    const v1 = await publishV1WithTwoCases();
    const derived = await prepareDerivedDraft(v1);
    const draft = derived.draft;
    const described = derived.described;
    const configured = derived.configured;

    const firstCaseId = v1.version.lineage[0].caseId;
    const secondCaseId = v1.version.lineage[1].caseId;
    const modified = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${draft.id}/cases/${firstCaseId}`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: described.json().draft.leaseToken,
        expectedRevision: configured.json().draft.revision,
        expectedOutput: "corrected answer",
        reason: "Correct synthetic gold",
      },
    });
    expect(modified.statusCode).toBe(200);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/projects/project_demo/drafts/${draft.id}/cases/${secondCaseId}`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: modified.json().draft.leaseToken,
        expectedRevision: modified.json().draft.revision,
      },
    });
    expect(deleted.statusCode).toBe(200);
    const v2Id = await publishReadyCandidate(
      draft.id,
      deleted.json().draft.revision,
    );

    const comparison = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${v1.versionId}/compare/${v2Id}`,
      headers: { cookie },
    });
    expect(comparison.statusCode).toBe(200);
    expect(comparison.json().comparison).toMatchObject({
      counts: { added: 1, removed: 1, modified: 1, unchanged: 0 },
      changes: { sources: true, recipe: true, formalSchema: false },
      recipe: {
        before: expect.anything(),
        after: expect.anything(),
      },
      sources: {
        before: expect.anything(),
        after: expect.anything(),
      },
      items: expect.arrayContaining([
        expect.objectContaining({
          status: "modified",
          caseId: firstCaseId,
          before: expect.objectContaining({ expected_output: "first answer" }),
          after: expect.objectContaining({
            expected_output: "corrected answer",
          }),
          reason: "Correct synthetic gold",
        }),
        expect.objectContaining({
          status: "added",
          after: expect.objectContaining({
            input: { message: "new question" },
          }),
        }),
        expect.objectContaining({
          status: "removed",
          caseId: secondCaseId,
          before: expect.objectContaining({
            input: { message: "second question" },
          }),
        }),
      ]),
    });
    const firstInV1 = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${v1.versionId}/cases/${firstCaseId}`,
      headers: { cookie },
    });
    expect(firstInV1.statusCode).toBe(200);
    expect(firstInV1.json().testCase).toMatchObject({
      caseId: firstCaseId,
      expected_output: "first answer",
      revisionId: comparison
        .json()
        .comparison.items.find(
          (item: any) =>
            item.status === "modified" && item.caseId === firstCaseId,
        ).before.revisionId,
    });
    const firstInV2 = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${v2Id}/cases/${firstCaseId}`,
      headers: { cookie },
    });
    expect(firstInV2.statusCode).toBe(200);
    expect(firstInV2.json().testCase).toMatchObject({
      caseId: firstCaseId,
      expected_output: "corrected answer",
      reason: "Correct synthetic gold",
      parentCaseRevisionId: firstInV1.json().testCase.revisionId,
    });
    expect(firstInV2.json().testCase.revisionId).not.toBe(
      firstInV1.json().testCase.revisionId,
    );
  });

  it("creates a new revision when only lineage changes", async () => {
    const v1 = await publishV1WithTwoCases();
    const derived = await prepareDerivedDraft(v1);
    const caseId = v1.version.lineage[0].caseId;
    const lineageOnly = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${derived.draft.id}/cases/${caseId}`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: derived.described.json().draft.leaseToken,
        expectedRevision: derived.configured.json().draft.revision,
        reason: "Record lineage changed without content change",
      },
    });
    expect(lineageOnly.statusCode).toBe(200);

    const v2Id = await publishReadyCandidate(
      derived.draft.id,
      lineageOnly.json().draft.revision,
    );
    const comparison = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${v1.versionId}/compare/${v2Id}`,
      headers: { cookie },
    });
    expect(comparison.statusCode).toBe(200);
    const changed = comparison
      .json()
      .comparison.items.find(
        (item: any) => item.caseId === caseId && item.status === "modified",
      );
    expect(changed).toMatchObject({
      before: {
        input: { message: "first question" },
        expected_output: "first answer",
      },
      after: {
        input: { message: "first question" },
        expected_output: "first answer",
      },
      reason: "Record lineage changed without content change",
    });
    expect(changed.before.revisionId).not.toBe(changed.after.revisionId);

    const previous = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${v1.versionId}/cases/${caseId}`,
      headers: { cookie },
    });
    const current = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${v2Id}/cases/${caseId}`,
      headers: { cookie },
    });
    expect(previous.statusCode).toBe(200);
    expect(current.statusCode).toBe(200);
    expect(current.json().testCase).toMatchObject({
      input: { message: "first question" },
      expected_output: "first answer",
      originKind: "manual_revision",
      parentCaseRevisionId: previous.json().testCase.revisionId,
      reason: "Record lineage changed without content change",
    });
    expect(current.json().testCase.revisionId).not.toBe(
      previous.json().testCase.revisionId,
    );
  });

  it("switches the default explicitly and archives only a non-default version", async () => {
    const v1 = await publishV1WithTwoCases();
    const derived = await prepareDerivedDraft(v1);
    const v2Id = await publishReadyCandidate(
      derived.draft.id,
      derived.configured.json().draft.revision,
    );
    const v1Before = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${v1.versionId}`,
      headers: { cookie },
    });
    expect(v1Before.json().testSet.defaultVersionId).toBe(v1.versionId);
    const history = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions`,
      headers: { cookie },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().versions).toEqual([
      expect.objectContaining({
        id: v1.versionId,
        number: 1,
        status: "published",
        isDefault: true,
      }),
      expect.objectContaining({
        id: v2Id,
        number: 2,
        status: "published",
        isDefault: false,
      }),
    ]);
    const unchangedComparison = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${v1.versionId}/compare/${v2Id}`,
      headers: { cookie },
    });
    expect(unchangedComparison.statusCode).toBe(200);
    expect(unchangedComparison.json().comparison).toMatchObject({
      counts: { added: 1, removed: 0, modified: 0, unchanged: 2 },
      items: expect.arrayContaining([
        expect.objectContaining({
          status: "unchanged",
          caseId: v1.version.lineage[0].caseId,
        }),
        expect.objectContaining({
          status: "unchanged",
          caseId: v1.version.lineage[1].caseId,
        }),
      ]),
    });
    for (const item of unchangedComparison.json().comparison.items)
      if (item.status === "unchanged")
        expect(item.before.revisionId).toBe(item.after.revisionId);

    const missingReason = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${v2Id}/default`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        expectedDefaultVersionId: v1.versionId,
        correlationId: "ticket08-missing-reason",
      },
    });
    expect(missingReason.statusCode).toBe(422);
    expect(missingReason.json()).toMatchObject({
      error: { code: "default_reason_required" },
    });
    const staleDefault = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${v2Id}/default`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        reason: "Stale synthetic request",
        expectedDefaultVersionId: v2Id,
        correlationId: "ticket08-stale-default",
      },
    });
    expect(staleDefault.statusCode).toBe(409);
    expect(staleDefault.json()).toMatchObject({
      error: { code: "default_version_conflict" },
    });

    const selectV2 = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${v2Id}/default`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        reason: "Promote synthetic v2",
        expectedDefaultVersionId: v1.versionId,
        correlationId: "ticket08-select-v2",
      },
    });
    expect(selectV2.statusCode).toBe(200);
    expect(selectV2.json().testSet.defaultVersionId).toBe(v2Id);
    const replaySelectV2 = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${v2Id}/default`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        reason: "Promote synthetic v2",
        expectedDefaultVersionId: v1.versionId,
        correlationId: "ticket08-select-v2",
      },
    });
    expect(replaySelectV2.statusCode).toBe(200);
    expect(replaySelectV2.json()).toMatchObject({
      testSet: { defaultVersionId: v2Id },
      replayed: true,
    });

    const archiveDefault = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${v2Id}/archive`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        reason: "Cannot archive default",
        expectedDefaultVersionId: v2Id,
        correlationId: "ticket08-archive-default",
      },
    });
    expect(archiveDefault.statusCode).toBe(422);
    expect(archiveDefault.json()).toMatchObject({
      error: { code: "default_version_cannot_archive" },
    });

    const restoreV1 = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${v1.versionId}/default`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        reason: "Roll back after synthetic v2 review",
        expectedDefaultVersionId: v2Id,
        correlationId: "ticket08-restore-v1",
      },
    });
    expect(restoreV1.statusCode).toBe(200);
    expect(restoreV1.json().testSet.defaultVersionId).toBe(v1.versionId);

    const mismatchedReplay = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${v2Id}/default`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        reason: "Reused correlation with a different command",
        expectedDefaultVersionId: v1.versionId,
        correlationId: "ticket08-select-v2",
      },
    });
    expect(mismatchedReplay.statusCode).toBe(409);
    expect(mismatchedReplay.json()).toMatchObject({
      error: { code: "lifecycle_command_conflict" },
    });

    const archiveV2 = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${v2Id}/archive`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        reason: "",
        expectedDefaultVersionId: v1.versionId,
        correlationId: "ticket08-archive-v2",
      },
    });
    expect(archiveV2.statusCode).toBe(200);
    expect(archiveV2.json().version).toMatchObject({
      id: v2Id,
      status: "archived",
    });

    const v1After = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/versions/${v1.versionId}`,
      headers: { cookie },
    });
    expect(v1After.json().version).toMatchObject({
      payloadHash: v1Before.json().version.payloadHash,
      manifestHash: v1Before.json().version.manifestHash,
    });
    expect(v1After.json().testSet.defaultVersionId).toBe(v1.versionId);

    const audit = await db.query(
      `SELECT action, details FROM audit_event
       WHERE project_id = 'project_demo' AND object_id = ANY($1::text[])
       ORDER BY id`,
      [[v2Id, v1.versionId]],
    );
    expect(audit.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "test_set_default_selected",
          details: expect.objectContaining({
            reason: "Promote synthetic v2",
            versionId: v2Id,
          }),
        }),
        expect.objectContaining({
          action: "test_set_default_selected",
          details: expect.objectContaining({
            reason: "Roll back after synthetic v2 review",
            versionId: v1.versionId,
          }),
        }),
        expect.objectContaining({
          action: "test_set_version_archived",
          details: expect.objectContaining({
            reason: null,
          }),
        }),
      ]),
    );
  });

  it("gives reattached source records new case identities in a future draft", async () => {
    const v1 = await publishV1WithTwoCases();
    const derived = await prepareDerivedDraft(v1);
    await publishReadyCandidate(
      derived.draft.id,
      derived.configured.json().draft.revision,
    );

    const reopened = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${v1.testSetId}/drafts`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: { baseVersionId: v1.versionId },
    });
    expect(reopened.statusCode).toBe(201);
    const draft = reopened.json().draft;
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
        assetId: v1.source.assetId,
        leaseToken: draft.leaseToken,
        expectedRevision: draft.revision,
      },
    });
    expect(attached.statusCode).toBe(201);
    const mapping = {
      input: { object: { message: { source: "/question" } } },
      expectedOutput: { source: "/answer" },
      metadata: { object: {} },
    };
    const savedMapping = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${draft.id}/sources/${attached.json().source.id}/mapping`,
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
    expect(savedMapping.statusCode).toBe(200);
    const described = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/recipe`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: savedMapping.json().draft.leaseToken,
        expectedRevision: savedMapping.json().draft.revision,
        versionDescription: "Ticket 08 reattached source identity",
        steps: [
          {
            kind: "filter",
            filter: {
              field: "/question",
              operator: "eq",
              value: "first question",
            },
          },
        ],
        mapping,
        unmappedFields: ["/category"],
        unmappedConfirmed: true,
      },
    });
    expect(described.statusCode).toBe(200);
    const proposal = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draft.id}/mapping/schema-suggestion`,
      headers: { cookie },
    });
    expect(proposal.statusCode).toBe(200);
    const configured = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${draft.id}`,
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
        filter: {
          field: "/question",
          operator: "eq",
          value: "first question",
        },
        mapping,
        unmappedFields: ["/category"],
        unmappedConfirmed: true,
        formalSchema: v1.version.evidence.schema,
      },
    });
    expect(configured.statusCode).toBe(200);
    const requestMaterialization = () =>
      app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${draft.id}/candidates`,
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
    const [firstMaterialization, replayMaterialization] = await Promise.all([
      requestMaterialization(),
      requestMaterialization(),
    ]);
    expect(firstMaterialization.statusCode).toBe(202);
    expect(replayMaterialization.statusCode).toBe(202);
    expect(replayMaterialization.json()).toMatchObject({
      replayed: true,
      candidate: { id: firstMaterialization.json().candidate.id },
    });
    await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/candidates/${firstMaterialization.json().candidate.id}`,
          headers: { cookie },
        }),
      (body) => ["ready_to_publish", "failed"].includes(body.candidate?.status),
    );
    const failed = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/candidates/${firstMaterialization.json().candidate.id}`,
      headers: { cookie },
    });
    expect(failed.json().candidate.status).toBe("failed");
    expect(failed.json().candidate.validationReport).toMatchObject({
      errorCode: "duplicate_content_requires_decision",
    });
    const originalCaseIds = new Set(
      v1.version.lineage.map((item: any) => item.caseId),
    );
    const reboundCaseId = failed
      .json()
      .candidate.validationReport.duplicateCaseIds.find(
        (caseId: string) => !originalCaseIds.has(caseId),
      );
    expect(reboundCaseId).toMatch(/^case_/);
  });

  it("rejects manual creation from an editor revoked after taking the lease", async () => {
    const editorId = `user_${randomUUID().replaceAll("-", "")}`;
    const editorName = `editor_${randomUUID()}`;
    const testSetId = `testset_${randomUUID().replaceAll("-", "")}`;
    await db.query(
      "INSERT INTO app_user (id, username, password_hash, role) VALUES ($1, $2, $3, 'editor')",
      [editorId, editorName, await hashPassword("editor-test-password")],
    );
    await db.query(
      "INSERT INTO project_member (project_id, user_id, role) VALUES ('project_demo', $1, 'editor')",
      [editorId],
    );
    await db.query(
      `INSERT INTO test_set (id, project_id, name, purpose, owner_id)
       VALUES ($1, 'project_demo', 'Ticket 08 revoked editor', 'Synthetic authorization test', 'user_owner')`,
      [testSetId],
    );
    const opened = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/test-sets/${testSetId}/drafts`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
      },
    });
    expect(opened.statusCode).toBe(201);
    const draft = opened.json().draft;
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: editorName, password: "editor-test-password" },
    });
    const editorCookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    const editorCsrf = login.json().csrfToken;
    const takeover = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/lease/takeover`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: editorCookie,
        "x-csrf-token": editorCsrf,
        "content-type": "application/json",
      },
      payload: { confirm: true, expectedRevision: draft.revision },
    });
    expect(takeover.statusCode).toBe(200);
    await db.query("DELETE FROM project_member WHERE user_id = $1", [editorId]);
    const revokedWrite = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${draft.id}/cases`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: editorCookie,
        "x-csrf-token": editorCsrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: takeover.json().draft.leaseToken,
        expectedRevision: takeover.json().draft.revision,
        input: { message: "revoked editor write" },
        expectedOutput: "blocked",
        reason: "Should require current project authorization",
      },
    });
    expect(revokedWrite.statusCode).toBe(404);
    expect(revokedWrite.json()).toMatchObject({
      error: { code: "project_not_found" },
    });
    const unchanged = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draft.id}`,
      headers: { cookie },
    });
    expect(unchanged.json().draft).toMatchObject({
      revision: takeover.json().draft.revision,
      leaseHolderId: editorId,
    });
  });
});
