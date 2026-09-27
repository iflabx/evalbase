import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";

describe("Ticket 23 solo test set v1", () => {
  let app!: AgentBenchApp;
  let db!: ReturnType<typeof createPool>;
  let cookie: string;
  let csrf: string;
  let projectId: string;
  let collectionId: string;

  beforeAll(async () => {
    app = await buildApp({ soloOwnerMode: true });
    db = createPool(loadConfig().databaseUrl);
    const session = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: {
        origin: "http://127.0.0.1:3000",
        "content-type": "application/json",
      },
      payload: {},
    });
    cookie = `${session.cookies[0]?.name}=${session.cookies[0]?.value}`;
    csrf = session.json().csrfToken;
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: mutationHeaders(),
      payload: { name: `Ticket 23 ${randomUUID()}` },
    });
    projectId = project.json().project.id;
    const collections = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/collections?limit=10&offset=0`,
      headers: { cookie },
    });
    collectionId = collections.json().collections[0].id;
  });

  afterAll(async () => {
    if (projectId && db) {
      await db.query("DELETE FROM upload_idempotency WHERE project_id = $1", [
        projectId,
      ]);
      await db.query(
        `DELETE FROM version_member vm USING test_set_version v, test_set ts
         WHERE vm.version_id = v.id AND v.test_set_id = ts.id AND ts.project_id = $1`,
        [projectId],
      );
      await db.query(
        `DELETE FROM candidate_item ci USING candidate_snapshot cs, working_draft wd, test_set ts
         WHERE ci.candidate_id = cs.id AND cs.draft_id = wd.id
           AND wd.test_set_id = ts.id AND ts.project_id = $1`,
        [projectId],
      );
      await db.query(
        `UPDATE candidate_snapshot cs SET base_version_id = NULL
           FROM working_draft wd, test_set ts
          WHERE cs.draft_id = wd.id AND wd.test_set_id = ts.id AND ts.project_id = $1`,
        [projectId],
      );
      await db.query(
        `UPDATE working_draft wd SET base_version_id = NULL
           FROM test_set ts
          WHERE wd.test_set_id = ts.id AND ts.project_id = $1`,
        [projectId],
      );
      await db.query(
        `DELETE FROM test_set_version v USING test_set ts
         WHERE v.test_set_id = ts.id AND ts.project_id = $1`,
        [projectId],
      );
      await db.query(
        `DELETE FROM candidate_snapshot cs USING working_draft wd, test_set ts
         WHERE cs.draft_id = wd.id AND wd.test_set_id = ts.id AND ts.project_id = $1`,
        [projectId],
      );
      await db.query(
        `DELETE FROM case_revision cr USING test_case tc, test_set ts
         WHERE cr.case_id = tc.id AND tc.test_set_id = ts.id AND ts.project_id = $1`,
        [projectId],
      );
      await db.query(
        `DELETE FROM test_case tc USING test_set ts
         WHERE tc.test_set_id = ts.id AND ts.project_id = $1`,
        [projectId],
      );
      await db.query(
        `DELETE FROM formal_schema_revision fs USING test_set ts
         WHERE fs.test_set_id = ts.id AND ts.project_id = $1`,
        [projectId],
      );
      await db.query(
        `DELETE FROM working_draft wd USING test_set ts
         WHERE wd.test_set_id = ts.id AND ts.project_id = $1`,
        [projectId],
      );
      await db.query("DELETE FROM test_set WHERE project_id = $1", [projectId]);
      await db.query(
        `DELETE FROM source_record sr USING parsed_view pv, data_asset da
         WHERE sr.parsed_view_id = pv.id AND pv.asset_id = da.id
           AND da.project_id = $1`,
        [projectId],
      );
      await db.query(
        `DELETE FROM parsed_view pv USING data_asset da
         WHERE pv.asset_id = da.id AND da.project_id = $1`,
        [projectId],
      );
      await db.query(
        `DELETE FROM source_attribution_revision sar USING data_asset da
         WHERE sar.asset_id = da.id AND da.project_id = $1`,
        [projectId],
      );
      await db.query("DELETE FROM data_asset WHERE project_id = $1", [
        projectId,
      ]);
      await db.query("DELETE FROM audit_event WHERE project_id = $1", [
        projectId,
      ]);
      await db.query("DELETE FROM job WHERE project_id = $1", [projectId]);
      await db.query("DELETE FROM project_member WHERE project_id = $1", [
        projectId,
      ]);
      await db.query("DELETE FROM project WHERE id = $1", [projectId]);
    }
    await db?.end();
    await app?.close();
  });

  it("selects real records from two files, edits them, publishes once, and reopens v1", async () => {
    const csv = await uploadSource(
      "questions.csv",
      "question,answer,tag\nCSV question,CSV answer,alpha\nUnused,Ignored,beta\n",
      { question: "/question", expectedOutput: "/answer", metadata: ["/tag"] },
    );
    const json = await uploadSource(
      "questions.json",
      JSON.stringify([
        { prompt: "JSON question", expected: "JSON answer", tag: "gamma" },
      ]),
      { question: "/prompt", expectedOutput: "/expected", metadata: ["/tag"] },
    );
    const sources = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-set-sources`,
      headers: { cookie },
    });
    expect(sources.statusCode, sources.body).toBe(200);
    expect(sources.json()).toEqual({
      datasets: [
        expect.objectContaining({
          files: expect.arrayContaining([
            expect.objectContaining({
              id: csv,
              records: expect.arrayContaining([expect.any(Object)]),
            }),
            expect.objectContaining({
              id: json,
              records: expect.arrayContaining([expect.any(Object)]),
            }),
          ]),
        }),
      ],
    });
    const sourceFiles = sources
      .json()
      .datasets.flatMap(
        (dataset: {
          files: Array<{ id: string; records: Array<{ ordinal: number }> }>;
        }) => dataset.files,
      );
    const csvOrdinal = sourceFiles.find(
      (file: { id: string }) => file.id === csv,
    )?.records[0]?.ordinal;
    const jsonOrdinal = sourceFiles.find(
      (file: { id: string }) => file.id === json,
    )?.records[0]?.ordinal;
    expect(csvOrdinal).toEqual(expect.any(Number));
    expect(jsonOrdinal).toEqual(expect.any(Number));
    const key = randomUUID();
    const payload = {
      name: "合成回归集",
      purpose: "Ticket 23",
      selections: [
        { assetId: csv, ordinal: csvOrdinal },
        { assetId: json, ordinal: jsonOrdinal },
      ],
      records: [
        {
          question: "已编辑的 CSV 问题",
          expectedOutput: "CSV answer",
          metadata: [{ key: "Metadata", value: "alpha" }],
          source: { assetId: csv, ordinal: csvOrdinal },
        },
        {
          question: "",
          expectedOutput: "JSON answer",
          metadata: [{ key: "Metadata", value: "gamma" }],
          source: { assetId: json, ordinal: jsonOrdinal },
        },
        {
          question: "手工新增",
          expectedOutput: "手工期望输出",
          metadata: [{ key: "Metadata", value: "synthetic" }],
        },
        {
          question: "手工新增",
          expectedOutput: "手工期望输出",
          metadata: [{ key: "Metadata", value: "synthetic" }],
        },
      ],
    };
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets`,
      headers: { ...mutationHeaders(), "idempotency-key": key },
      payload: {
        ...payload,
        records: undefined,
        operations: addOperations(payload.records),
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toEqual({
      testSet: {
        id: expect.any(String),
        name: "合成回归集",
        purpose: "Ticket 23",
      },
      version: {
        id: expect.any(String),
        label: "v1",
        recordCount: 4,
      },
      dataCheck: {
        missingQuestionCount: 1,
        exactDuplicateCount: 1,
        traceableRecordCount: 2,
      },
    });
    const created = response.json();
    const replay = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets`,
      headers: { ...mutationHeaders(), "idempotency-key": key },
      payload: {
        ...payload,
        records: undefined,
        operations: addOperations(payload.records),
      },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual({ ...created, replayed: true });

    const reopened = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSet.id}/versions/${created.version.id}`,
      headers: { cookie },
    });
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect(reopened.json()).toMatchObject({
      testSet: { name: "合成回归集", purpose: "Ticket 23" },
      version: { label: "v1", recordCount: 4 },
    });
    expect(reopened.json()).not.toHaveProperty("records");
    const reopenedRecords = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSet.id}/versions/${created.version.id}/records?limit=10&offset=0`,
      headers: { cookie },
    });
    expect(reopenedRecords.statusCode, reopenedRecords.body).toBe(200);
    expect(reopenedRecords.json()).toMatchObject({
      pagination: { total: 4, limit: 10, offset: 0 },
      records: expect.arrayContaining([
        expect.objectContaining({
          metadata: [{ key: "Metadata", value: "alpha" }],
        }),
      ]),
    });
    expect(JSON.stringify(reopened.json())).not.toMatch(
      /draft|lease|candidate|schema/i,
    );

    const listed = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets?limit=100&offset=0`,
      headers: { cookie },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const listedTestSets = listed.json().testSets as Array<
      Record<string, unknown>
    >;
    expect(
      listedTestSets.find((item) => item.id === created.testSet.id),
    ).toMatchObject({
      source: "questions.csv、questions.json",
      status: "已发布",
    });
    expect(
      listedTestSets.find((item) => item.id === created.testSet.id),
    ).not.toHaveProperty("sourceCount");

    const linear = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSet.id}/versions/${created.version.id}/derived-versions`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: { operations: [] },
    });
    expect(linear.statusCode, linear.body).toBe(201);
    expect(linear.json().version).toMatchObject({
      label: "v2",
      recordCount: 4,
    });

    const branch = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSet.id}/versions/${created.version.id}/derived-versions`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: { operations: [] },
    });
    expect(branch.statusCode, branch.body).toBe(201);
    expect(branch.json().version).toMatchObject({
      label: "v2-b1",
      recordCount: 4,
    });

    const version = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSet.id}/versions/${branch.json().version.id}`,
      headers: { cookie },
    });
    expect(version.statusCode, version.body).toBe(200);
    expect(version.json()).toMatchObject({
      version: { label: "v2-b1", parentVersionId: created.version.id },
      graph: {
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: created.version.id, label: "v1" }),
          expect.objectContaining({
            id: linear.json().version.id,
            label: "v2",
          }),
          expect.objectContaining({
            id: branch.json().version.id,
            label: "v2-b1",
          }),
        ]),
      },
    });
    const branchRecordsResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSet.id}/versions/${branch.json().version.id}/editing-records?limit=10&offset=0`,
      headers: { cookie },
    });
    expect(branchRecordsResponse.statusCode, branchRecordsResponse.body).toBe(
      200,
    );
    const branchRecords = branchRecordsResponse
      .json()
      .records.map(
        ({
          id: _id,
          ordinal: _ordinal,
          source,
          ...record
        }: Record<string, unknown>) => ({
          ...record,
          ...(source && typeof source === "object"
            ? {
                source: {
                  assetId: (source as { assetId: string }).assetId,
                  ordinal: (source as { ordinal: number }).ordinal,
                },
              }
            : {}),
        }),
      );

    const duplicateParent = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSet.id}/versions/${branch.json().version.id}/derived-versions`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: {
        operations: [branchRecords[0], branchRecords[0]].map((record) => ({
          operation: "delete",
          caseId: record.caseId,
          beforeRevisionId: record.revisionId,
        })),
      },
    });
    expect(duplicateParent.statusCode, duplicateParent.body).toBe(422);
    expect(duplicateParent.json()).toEqual({
      error: { code: "parent_record_invalid" },
    });

    const branchContinuation = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSet.id}/versions/${branch.json().version.id}/derived-versions`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: {
        operations: [
          {
            operation: "delete",
            caseId: branchRecords[0].caseId,
            beforeRevisionId: branchRecords[0].revisionId,
          },
        ],
      },
    });
    expect(branchContinuation.statusCode, branchContinuation.body).toBe(201);
    expect(branchContinuation.json().version.label).toBe("v3-b1");
    const shortened = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSet.id}/versions/${branchContinuation.json().version.id}`,
      headers: { cookie },
    });
    expect(shortened.statusCode, shortened.body).toBe(200);
    const shortenedRecords = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSet.id}/versions/${branchContinuation.json().version.id}/editing-records?limit=10&offset=0`,
      headers: { cookie },
    });
    expect(shortenedRecords.statusCode, shortenedRecords.body).toBe(200);
    expect(shortenedRecords.json().records[0].parentOrdinal).toBe(1);

    const concurrent = await Promise.all(
      [randomUUID(), randomUUID()].map((idempotencyKey) =>
        app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/solo-test-sets/${created.testSet.id}/versions/${created.version.id}/derived-versions`,
          headers: { ...mutationHeaders(), "idempotency-key": idempotencyKey },
          payload: { operations: [] },
        }),
      ),
    );
    expect(concurrent.map((response) => response.statusCode)).toEqual([
      201, 201,
    ]);
    expect(
      concurrent.map((response) => response.json().version.label).sort(),
    ).toEqual(["v2-b2", "v2-b3"]);
    const failed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSet.id}/versions/${created.version.id}/derived-versions`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: { operations: [{ operation: "unknown" }] },
    });
    expect(failed.statusCode).toBe(422);
    const afterFailure = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSet.id}/versions/${created.version.id}/derived-versions`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: { operations: [] },
    });
    expect(afterFailure.statusCode, afterFailure.body).toBe(201);
    expect(afterFailure.json().version.label).toBe("v2-b4");

    const retired = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.testSet.id}`,
      headers: { cookie },
    });
    expect(retired.statusCode).toBe(404);
  });

  it("rejects over-capacity creation without publishing and keeps wide workbench paths unavailable", async () => {
    const before = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets?limit=10&offset=0`,
      headers: { cookie },
    });
    const empty = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: {
        name: "空测试集",
        purpose: "",
        selections: [],
        operations: [],
      },
    });
    expect(empty.statusCode, empty.body).toBe(422);
    expect(empty.json()).toEqual({
      error: { code: "test_set_records_required" },
    });
    const result = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: {
        name: "过大测试集",
        purpose: "",
        selections: [],
        operations: addOperations(
          Array.from({ length: 10_001 }, () => ({
            question: "synthetic",
            expectedOutput: "synthetic",
            metadata: [],
          })),
        ),
      },
    });
    expect(result.statusCode, result.body).toBe(422);
    expect(result.json()).toEqual({
      error: { code: "test_set_capacity_exceeded" },
    });
    const listed = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets?limit=10&offset=0`,
      headers: { cookie },
    });
    expect(listed.json().pagination.total).toBe(before.json().pagination.total);
    for (const path of [
      `/api/projects/${projectId}/drafts`,
      `/api/projects/${projectId}/candidates`,
      `/api/projects/${projectId}/test-sets`,
      `/internal/retired/api/projects/${projectId}/test-sets`,
    ]) {
      const retired = await app.inject({
        method: "GET",
        url: path,
        headers: { cookie },
      });
      expect(retired.statusCode).toBe(404);
    }
    expect(app.printRoutes()).not.toContain(
      "/api/projects/:projectId/test-sets",
    );
  });

  it("shows direct changes and downloads version-bound safe CSV files", async () => {
    const initialAsset = await uploadSource(
      "provenance-initial.csv",
      "question,answer,tag\nfirst,before,alpha\nsame,before,alpha\n",
      { question: "/question", expectedOutput: "/answer", metadata: ["/tag"] },
    );
    const addedAsset = await uploadSource(
      "provenance-added.csv",
      "question,answer,tag\nsecond,after,beta\n",
      { question: "/question", expectedOutput: "/answer", metadata: ["/tag"] },
    );
    const movedAsset = await uploadSource(
      "provenance-moved.csv",
      "question,answer,tag\nsame,before,alpha\n",
      { question: "/question", expectedOutput: "/answer", metadata: ["/tag"] },
    );
    const sources = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-set-sources`,
      headers: { cookie },
    });
    const files = sources
      .json()
      .datasets.flatMap(
        (dataset: {
          files: Array<{ id: string; records: Array<{ ordinal: number }> }>;
        }) => dataset.files,
      );
    const initialOrdinal = files.find(
      (file: { id: string }) => file.id === initialAsset,
    )?.records[0]?.ordinal;
    const addedOrdinal = files.find(
      (file: { id: string }) => file.id === addedAsset,
    )?.records[0]?.ordinal;
    const initialSecondOrdinal = files.find(
      (file: { id: string }) => file.id === initialAsset,
    )?.records[1]?.ordinal;
    const movedOrdinal = files.find(
      (file: { id: string }) => file.id === movedAsset,
    )?.records[0]?.ordinal;
    expect(initialOrdinal).toEqual(expect.any(Number));
    expect(addedOrdinal).toEqual(expect.any(Number));
    expect(initialSecondOrdinal).toEqual(expect.any(Number));
    expect(movedOrdinal).toEqual(expect.any(Number));

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: {
        name: "来源与下载回归集",
        purpose: "Ticket 25",
        selections: [
          { assetId: initialAsset, ordinal: initialOrdinal },
          { assetId: initialAsset, ordinal: initialSecondOrdinal },
        ],
        operations: addOperations([
          {
            question: "=SUM(1,1)",
            expectedOutput: "before",
            metadata: [{ key: "Metadata", value: "中文,初始" }],
            source: { assetId: initialAsset, ordinal: initialOrdinal },
          },
          {
            question: "will be removed",
            expectedOutput: "old",
            metadata: [{ key: "Metadata", value: "manual" }],
          },
          {
            question: "same",
            expectedOutput: "before",
            metadata: [{ key: "Metadata", value: "alpha" }],
            source: { assetId: initialAsset, ordinal: initialSecondOrdinal },
          },
        ]),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const v1 = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.json().testSet.id}/versions/${created.json().version.id}`,
      headers: { cookie },
    });
    expect(v1.statusCode, v1.body).toBe(200);
    expect(v1.json()).not.toHaveProperty("records");
    const v1RecordsResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.json().testSet.id}/versions/${created.json().version.id}/editing-records?limit=10&offset=0`,
      headers: { cookie },
    });
    expect(v1RecordsResponse.statusCode, v1RecordsResponse.body).toBe(200);
    const v1Records = v1RecordsResponse
      .json()
      .records.map(
        ({
          id: _id,
          ordinal: _ordinal,
          source,
          ...record
        }: Record<string, unknown>) => ({
          ...record,
          ...(source && typeof source === "object"
            ? {
                source: {
                  assetId: (source as { assetId: string }).assetId,
                  ordinal: (source as { ordinal: number }).ordinal,
                },
              }
            : {}),
        }),
      );
    const derived = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.json().testSet.id}/versions/${created.json().version.id}/derived-versions`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: {
        operations: [
          {
            operation: "update",
            caseId: v1Records[0].caseId,
            beforeRevisionId: v1Records[0].revisionId,
            after: {
              question: "=SUM(1,1)",
              expectedOutput: 'changed\nwith "quotes"',
              metadata: [{ key: "Metadata", value: "中文,更新" }],
              source: { assetId: initialAsset, ordinal: initialOrdinal },
            },
          },
          {
            operation: "delete",
            caseId: v1Records[1].caseId,
            beforeRevisionId: v1Records[1].revisionId,
          },
          {
            operation: "update",
            caseId: v1Records[2].caseId,
            beforeRevisionId: v1Records[2].revisionId,
            after: {
              question: "same",
              expectedOutput: "before",
              metadata: [{ key: "Metadata", value: "alpha" }],
              source: { assetId: movedAsset, ordinal: movedOrdinal },
            },
          },
          {
            operation: "add",
            after: {
              question: "manual added",
              expectedOutput: "",
              metadata: [],
            },
          },
          {
            operation: "add",
            after: {
              question: "second",
              expectedOutput: "+formula",
              metadata: [{ key: "Metadata", value: "beta" }],
              source: { assetId: addedAsset, ordinal: addedOrdinal },
            },
          },
        ],
      },
    });
    expect(derived.statusCode, derived.body).toBe(201);
    const versionId = derived.json().version.id as string;

    const versionDetail = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.json().testSet.id}/versions/${versionId}`,
      headers: { cookie },
    });
    expect(versionDetail.statusCode, versionDetail.body).toBe(200);
    expect(versionDetail.json()).toMatchObject({
      versionSummary: {
        sourceFiles: [
          "provenance-initial.csv",
          "provenance-moved.csv",
          "provenance-added.csv",
        ],
        manualRecordCount: 1,
        changes: { modified: 2, added: 2, removed: 1 },
      },
    });

    const changes = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.json().testSet.id}/versions/${versionId}/provenance?status=changed&limit=10&offset=0`,
      headers: { cookie },
    });
    expect(changes.statusCode, changes.body).toBe(200);
    expect(changes.json()).toMatchObject({
      summary: {
        currentVersion: { id: versionId, label: "v2" },
        counts: { unchanged: 0, modified: 2, added: 2, removed: 1 },
        addedFiles: expect.arrayContaining([
          expect.objectContaining({
            assetId: addedAsset,
            fileName: "provenance-added.csv",
            recordCount: 1,
          }),
        ]),
        manualAddedCount: 1,
      },
      pagination: { total: 5, limit: 10, offset: 0 },
      changes: expect.arrayContaining([
        expect.objectContaining({
          changeType: "modified",
          changedFields: ["expectedOutput", "metadata"],
        }),
        expect.objectContaining({
          changeType: "modified",
          changedFields: ["source"],
        }),
        expect.objectContaining({
          changeType: "removed",
          previous: expect.objectContaining({ question: "will be removed" }),
        }),
        expect.objectContaining({ changeType: "added", source: null }),
      ]),
    });
    const modified = changes
      .json()
      .changes.find(
        (change: { changeType: string }) => change.changeType === "modified",
      );
    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.json().testSet.id}/versions/${versionId}/provenance/${modified.id}`,
      headers: { cookie },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({
      change: expect.objectContaining({
        changeType: "modified",
        previous: expect.any(Object),
      }),
    });
    const sourceOnly = changes
      .json()
      .changes.find(
        (change: { changedFields: string[] }) =>
          change.changedFields.length === 1 &&
          change.changedFields[0] === "source",
      );
    const sourceOnlyDetail = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.json().testSet.id}/versions/${versionId}/provenance/${sourceOnly.id}`,
      headers: { cookie },
    });
    expect(sourceOnlyDetail.statusCode, sourceOnlyDetail.body).toBe(200);
    expect(sourceOnlyDetail.json().change).toMatchObject({
      changedFields: ["source"],
      current: { source: { fileName: "provenance-moved.csv" } },
      previous: { source: { fileName: "provenance-initial.csv" } },
    });

    const filtered = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.json().testSet.id}/versions/${versionId}/provenance?status=all&search=manual&limit=1&offset=1`,
      headers: { cookie },
    });
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(filtered.json().pagination).toEqual({
      total: 2,
      limit: 1,
      offset: 1,
    });

    const dataCsv = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.json().testSet.id}/versions/${versionId}/data.csv`,
      headers: { cookie },
    });
    expect(dataCsv.statusCode, dataCsv.body).toBe(200);
    expect(dataCsv.headers["content-type"]).toContain("text/csv");
    expect(dataCsv.body).toContain("manual added,,\r\n");
    expect(dataCsv.body).toContain("'=SUM(1,1)");
    expect(dataCsv.body).toContain('"changed\nwith ""quotes"""');
    expect(dataCsv.body).toContain("Metadata：中文,更新");
    const provenanceCsv = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.json().testSet.id}/versions/${versionId}/provenance.csv`,
      headers: { cookie },
    });
    expect(provenanceCsv.statusCode, provenanceCsv.body).toBe(200);
    expect(provenanceCsv.body).toContain("change_type");
    expect(provenanceCsv.body).toContain("removed");

    const v1Csv = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.json().testSet.id}/versions/${created.json().version.id}/data.csv`,
      headers: { cookie },
    });
    expect(v1Csv.statusCode, v1Csv.body).toBe(200);
    expect(v1Csv.body).toContain("before");
    expect(v1Csv.body).not.toContain('changed\nwith "quotes"');

    const branch = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${created.json().testSet.id}/versions/${created.json().version.id}/derived-versions`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: { operations: [] },
    });
    expect(branch.statusCode, branch.body).toBe(201);
    expect(branch.json().version.label).toBe("v2-b1");
    const branchCsv = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${created.json().testSet.id}/versions/${branch.json().version.id}/data.csv`,
      headers: { cookie },
    });
    expect(branchCsv.statusCode, branchCsv.body).toBe(200);
    expect(branchCsv.body).toContain("before");
    expect(branchCsv.body).not.toContain('changed\nwith "quotes"');

    const crossProject = await app.inject({
      method: "GET",
      url: `/api/projects/project_not_this_one/solo-test-sets/${created.json().testSet.id}/versions/${versionId}/provenance`,
      headers: { cookie },
    });
    expect(crossProject.statusCode).toBe(404);

    const retired = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/versions/${versionId}/packages`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: { packageType: "standard" },
    });
    expect(retired.statusCode).toBe(404);
    expect(retired.json()).toEqual({ error: { code: "route_not_found" } });

    for (const url of [
      `/api/projects/${projectId}/versions/${versionId}/package`,
      `/api/projects/${projectId}/versions/${versionId}/langfuse-csv`,
      `/api/projects/${projectId}/versions/${versionId}/deliveries`,
      `/api/projects/${projectId}/deliveries`,
      `/api/projects/${projectId}/lineage/trace?subjectType=test_set_version&subjectId=${versionId}`,
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: { code: "route_not_found" } });
    }
    const retiredRun = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/transformation-runs`,
      headers: mutationHeaders(),
      payload: {},
    });
    expect(retiredRun.statusCode).toBe(404);
    expect(retiredRun.json()).toEqual({ error: { code: "route_not_found" } });
  });

  it("queries structured version records with fixed AND filters", async () => {
    const sourceA = await uploadSource(
      "filters-a.csv",
      "question,answer,channel,topic\n,answer A,公开,预约\n",
      {
        question: "/question",
        expectedOutput: "/answer",
        metadata: ["/channel", "/topic"],
      },
    );
    const sourceB = await uploadSource(
      "filters-b.csv",
      "question,answer,channel,topic\nfilled,answer B,公开,其他\n",
      {
        question: "/question",
        expectedOutput: "/answer",
        metadata: ["/channel", "/topic"],
      },
    );
    const sources = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-set-sources`,
      headers: { cookie },
    });
    const files = sources
      .json()
      .datasets.flatMap(
        (dataset: {
          files: Array<{ id: string; records: Array<{ ordinal: number }> }>;
        }) => dataset.files,
      );
    const ordinalA = files.find((file: { id: string }) => file.id === sourceA)
      ?.records[0]?.ordinal;
    const ordinalB = files.find((file: { id: string }) => file.id === sourceB)
      ?.records[0]?.ordinal;
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: {
        name: "结构化筛选回归集",
        purpose: "Ticket 30",
        selections: [
          { assetId: sourceA, ordinal: ordinalA },
          { assetId: sourceB, ordinal: ordinalB },
        ],
        operations: addOperations([
          {
            question: "",
            expectedOutput: "answer A",
            metadata: [
              { key: "渠道", value: "公开" },
              { key: "主题", value: "预约" },
            ],
            source: { assetId: sourceA, ordinal: ordinalA },
          },
          {
            question: "filled",
            expectedOutput: "answer B",
            metadata: [
              { key: "渠道", value: "公开" },
              { key: "主题", value: "其他" },
            ],
            source: { assetId: sourceB, ordinal: ordinalB },
          },
          {
            question: "manual",
            expectedOutput: "",
            metadata: [{ key: "来源", value: "手工" }],
          },
        ]),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { testSet, version } = created.json();
    const query = new URLSearchParams({
      sourceAssetId: sourceA,
      question: "missing",
      origin: "source",
      metadataField: "渠道",
      metadata: "公开",
      limit: "10",
      offset: "0",
    });
    const filtered = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${testSet.id}/versions/${version.id}/records?${query}`,
      headers: { cookie },
    });
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(filtered.json()).toMatchObject({
      records: [
        {
          ordinal: 1,
          metadata: [
            { key: "渠道", value: "公开" },
            { key: "主题", value: "预约" },
          ],
        },
      ],
      pagination: { total: 1, limit: 10, offset: 0 },
    });
    expect(filtered.json().records[0]).not.toHaveProperty("parentRevisionId");
    expect(filtered.json().records[0].source).not.toHaveProperty("assetId");
    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${testSet.id}/versions/${version.id}/records/1`,
      headers: { cookie },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({
      record: {
        ordinal: 1,
        metadata: expect.arrayContaining([{ key: "渠道", value: "公开" }]),
      },
    });
    expect(detail.json().record).not.toHaveProperty("parentRevisionId");
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/project_not_this_one/solo-test-sets/${testSet.id}/versions/${version.id}/records/1`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/solo-test-sets/${testSet.id}/versions/${version.id}/records/99`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);
    const mismatch = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/solo-test-sets/${testSet.id}/versions/${version.id}/records?${new URLSearchParams(
        {
          ...Object.fromEntries(query),
          sourceAssetId: sourceB,
        },
      )}`,
      headers: { cookie },
    });
    expect(mismatch.statusCode, mismatch.body).toBe(200);
    expect(mismatch.json().pagination.total).toBe(0);

    const duplicateMetadata = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets/${testSet.id}/versions/${version.id}/derived-versions`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: {
        operations: addOperations([
          {
            question: "duplicate metadata key",
            expectedOutput: "",
            metadata: [
              { key: "Channel", value: "公开" },
              { key: "channel", value: "重复" },
            ],
          },
        ]),
      },
    });
    expect(duplicateMetadata.statusCode, duplicateMetadata.body).toBe(422);
    expect(duplicateMetadata.json()).toEqual({
      error: { code: "test_record_invalid" },
    });
    const legacyMetadata = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/solo-test-sets`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: {
        name: "旧文本不得新写入",
        selections: [],
        operations: addOperations([
          { question: "", expectedOutput: "", metadata: "legacy" },
        ]),
      },
    });
    expect(legacyMetadata.statusCode, legacyMetadata.body).toBe(422);
    expect(legacyMetadata.json()).toEqual({
      error: { code: "test_record_invalid" },
    });
  });

  async function uploadSource(
    fileName: string,
    content: string,
    mapping: { question: string; expectedOutput: string; metadata: string[] },
  ) {
    const pending = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-uploads`,
      headers: {
        ...mutationHeaders(),
        "content-type": fileName.endsWith(".csv")
          ? "text/csv"
          : "application/octet-stream",
        "x-file-name": fileName,
        "idempotency-key": randomUUID(),
      },
      payload: content,
    });
    expect(pending.statusCode, pending.body).toBe(201);
    const preview = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/pending-uploads/${pending.json().pendingUpload.id}/preview`,
      headers: mutationHeaders(),
      payload: { mapping },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/pending-upload-batches/confirm`,
      headers: { ...mutationHeaders(), "idempotency-key": randomUUID() },
      payload: {
        collectionId,
        pendingUploadIds: [pending.json().pendingUpload.id],
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    return confirmed.json().assets[0].id as string;
  }

  function mutationHeaders() {
    return {
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    };
  }

  function addOperations(records: unknown[]) {
    return records.map((after) => ({ operation: "add", after }));
  }
});
