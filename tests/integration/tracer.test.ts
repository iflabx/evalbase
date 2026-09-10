import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/config.js";
import { createPool } from "../../src/db/pool.js";
import { hashPassword } from "../../src/security/password.js";

const allowedAttributions = [
  {
    sourceType: "synthetic",
    sourceName: "Ticket 03 synthetic contract fixture",
    licenseStatus: "not_applicable",
    sensitivity: "non_sensitive",
  },
  {
    sourceType: "public",
    sourceName: "Ticket 03 public contract fixture",
    licenseStatus: "clear",
    sensitivity: "non_sensitive",
    sourceAddress: "https://example.test/public-fixture",
    acquiredAt: "2026-08-19T00:00:00.000Z",
  },
  {
    sourceType: "deidentified",
    sourceName: "Ticket 03 deidentified contract fixture",
    licenseStatus: "confirmed",
    sensitivity: "non_sensitive",
    sourceAddress: "https://example.test/deidentified-fixture",
    acquiredAt: "2026-08-19T00:00:00.000Z",
    deidentificationConfirmed: true,
    formalMode: "input_only",
  },
];

async function waitFor(
  request: () => Promise<{ statusCode: number; json: () => any }>,
  ready: (body: any) => boolean,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request();
    const body = response.json();
    if (ready(body)) return { response, body };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for public resource state");
}

describe("Ticket 01 Scenario A tracer", () => {
  let app: AgentBenchApp;
  let worker: ChildProcess;
  let tempDirectory: string;

  beforeAll(async () => {
    app = await buildApp();
    worker = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/worker/main.ts"],
      {
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    tempDirectory = await mkdtemp(join(tmpdir(), "agentbench-ticket01-"));
  });

  afterAll(async () => {
    worker.kill("SIGTERM");
    await new Promise((resolve) => worker.once("exit", resolve));
    await app.close();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  it("exposes the running build identity in health", async () => {
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      status: "ok",
      git_sha: expect.any(String),
    });
  });

  it.each(allowedAttributions)(
    "publishes a filtered, mapped CSV with $sourceType attribution as default v1",
    async (...[classification]: any[]) => {
      const login = await app.inject({
        method: "POST",
        url: "/api/session",
        headers: { origin: "http://127.0.0.1:3000" },
        payload: { username: "owner", password: "owner-test-password" },
      });
      const cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
      const csrf = login.json().csrfToken;
      const csv = await readFile(
        new URL("../fixtures/owner.csv", import.meta.url),
      );
      const upload = await app.inject({
        method: "POST",
        url: "/api/projects/project_demo/assets",
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "idempotency-key": randomUUID(),
          "content-type": "text/csv; charset=utf-8",
          "x-file-name": "owner.csv",
          "x-source-type": classification.sourceType,
          "x-source-name": classification.sourceName,
          "x-responsible-person": "Project Owner",
          "x-source-purpose": "Non-production tracer test",
          "x-license-status": classification.licenseStatus,
          "x-sensitivity": classification.sensitivity,
          ...(classification.sourceAddress
            ? { "x-source-address": classification.sourceAddress }
            : {}),
          ...(classification.acquiredAt
            ? { "x-acquired-at": classification.acquiredAt }
            : {}),
          ...(classification.deidentificationConfirmed
            ? { "x-deidentification-confirmed": "true" }
            : {}),
        },
        payload: csv,
      });
      const assetId = upload.json().asset.id;
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
          name: `Billing tracer ${randomUUID()}`,
          purpose: "Synthetic regression",
          assetId,
        },
      });
      expect(created.statusCode).toBe(201);
      const { testSet, draft } = created.json();
      const savedRecipe = await app.inject({
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
          versionDescription: "Ticket 01 synthetic tracer version",
          mapping: {
            input: {
              object: {
                message: { source: "/question" },
                context: { object: { origin: { constant: "synthetic" } } },
              },
            },
            expectedOutput: { source: "/answer" },
            metadata: { object: { source: { constant: "owner-fixture" } } },
          },
          steps: [
            {
              kind: "filter",
              filter: {
                field: "category",
                operator: "eq",
                value: "billing",
              },
            },
          ],
        },
      });
      expect(savedRecipe.statusCode).toBe(200);
      const schemaProposal = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/drafts/${draft.id}/mapping/schema-suggestion`,
        headers: { cookie },
      });
      expect(schemaProposal.statusCode).toBe(200);
      const proposalId = schemaProposal.json().proposalId;

      const unsupportedSchema = await app.inject({
        method: "PUT",
        url: `/api/projects/project_demo/drafts/${draft.id}`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: draft.leaseToken,
          expectedRevision: savedRecipe.json().draft.revision,
          proposalId,
          filter: { field: "category", operator: "eq", value: "billing" },
          mapping: {
            input: {
              object: {
                message: { source: "/question" },
                context: { object: { origin: { constant: "synthetic" } } },
              },
            },
            expectedOutput: { source: "/answer" },
            metadata: { object: { source: { constant: "owner-fixture" } } },
          },
          unmappedFields: ["category", "internal_note"],
          unmappedConfirmed: true,
          formalSchema: {
            mode: classification.formalMode ?? "gold_required",
            input: { type: "string", pattern: "(a+)+$" },
            expectedOutput: { type: "string" },
          },
        },
      });
      expect(unsupportedSchema.statusCode).toBe(422);
      expect(unsupportedSchema.json()).toMatchObject({
        error: { code: "formal_schema_unsupported" },
      });

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
          leaseToken: draft.leaseToken,
          expectedRevision: savedRecipe.json().draft.revision,
          proposalId,
          filter: { field: "category", operator: "eq", value: "billing" },
          mapping: {
            input: {
              object: {
                message: { source: "/question" },
                context: { object: { origin: { constant: "synthetic" } } },
              },
            },
            expectedOutput: { source: "/answer" },
            metadata: { object: { source: { constant: "owner-fixture" } } },
          },
          unmappedFields: ["category", "internal_note"],
          unmappedConfirmed: true,
          formalSchema: {
            mode: classification.formalMode ?? "gold_required",
            input: {
              type: "object",
              properties: {
                message: { type: "string" },
                context: {
                  type: "object",
                  properties: { origin: { const: "synthetic" } },
                  required: ["origin"],
                  additionalProperties: false,
                },
              },
              required: ["message", "context"],
              additionalProperties: false,
            },
            expectedOutput: { type: "string" },
          },
        },
      });
      expect(configured.statusCode).toBe(200);
      let expectedItemCount = 2;
      let clearedCaseId: string | undefined;
      let materializeRevision = configured.json().draft.revision;
      if (classification.formalMode === "input_only") {
        const manual = await app.inject({
          method: "POST",
          url: `/api/projects/project_demo/drafts/${draft.id}/cases`,
          headers: {
            origin: "http://127.0.0.1:3000",
            cookie,
            "x-csrf-token": csrf,
            "content-type": "application/json",
          },
          payload: {
            leaseToken: draft.leaseToken,
            expectedRevision: configured.json().draft.revision,
            input: {
              message: "Input only manual case",
              context: { origin: "synthetic" },
            },
            expectedOutput: "temporary gold",
            metadata: { origin: "synthetic" },
            reason: "Create an input-only synthetic case",
          },
        });
        expect(manual.statusCode).toBe(201);
        const cleared = await app.inject({
          method: "PUT",
          url: `/api/projects/project_demo/drafts/${draft.id}/cases/${manual.json().case.id}`,
          headers: {
            origin: "http://127.0.0.1:3000",
            cookie,
            "x-csrf-token": csrf,
            "content-type": "application/json",
          },
          payload: {
            leaseToken: draft.leaseToken,
            expectedRevision: manual.json().draft.revision,
            expectedOutput: null,
            reason: "Clear optional expected output",
          },
        });
        expect(cleared.statusCode).toBe(200);
        clearedCaseId = manual.json().case.id;
        materializeRevision = cleared.json().draft.revision;
        const metadataUpdated = await app.inject({
          method: "PUT",
          url: `/api/projects/project_demo/drafts/${draft.id}/cases/${clearedCaseId}`,
          headers: {
            origin: "http://127.0.0.1:3000",
            cookie,
            "x-csrf-token": csrf,
            "content-type": "application/json",
          },
          payload: {
            leaseToken: draft.leaseToken,
            expectedRevision: materializeRevision,
            metadata: { origin: "synthetic-updated" },
          },
        });
        expect(metadataUpdated.statusCode).toBe(200);
        materializeRevision = metadataUpdated.json().draft.revision;
        expectedItemCount += 1;
      }

      const mappingPreview = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${draft.id}/mapping/preview`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {},
      });
      expect(mappingPreview.statusCode).toBe(200);
      expect(mappingPreview.json().pairs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ordinal: 2,
            locator: expect.any(Object),
            item: {
              input: {
                message: "Can I get a refund?",
                context: { origin: "synthetic" },
              },
              expected_output: "Contact support",
              metadata: { source: "owner-fixture" },
            },
            errors: [],
          }),
        ]),
      );
      expect(JSON.stringify(mappingPreview.json().pairs[0])).not.toContain(
        '"question"',
      );

      const mappingValidation = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/drafts/${draft.id}/mapping/validation`,
        headers: { cookie },
      });
      expect(mappingValidation.statusCode).toBe(200);
      expect(mappingValidation.json()).toEqual({ valid: true, errors: [] });

      const suggestion = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/drafts/${draft.id}/mapping/schema-suggestion`,
        headers: { cookie },
      });
      expect(suggestion.statusCode).toBe(200);
      expect(suggestion.json()).toMatchObject({
        scannedRecordCount: 2,
        suggestion: {
          input: {
            type: "object",
            properties: { message: { type: "string" } },
          },
          expectedOutput: { type: "string" },
        },
      });

      const outsiderId = `user_${randomUUID().replaceAll("-", "")}`;
      const outsiderName = `outsider_${randomUUID()}`;
      const setupDb = createPool(loadConfig().databaseUrl);
      await setupDb.query(
        `INSERT INTO app_user (id, username, password_hash, role)
       VALUES ($1, $2, $3, 'editor')`,
        [outsiderId, outsiderName, await hashPassword("outsider-password")],
      );
      await setupDb.end();
      const outsiderLogin = await app.inject({
        method: "POST",
        url: "/api/session",
        headers: { origin: "http://127.0.0.1:3000" },
        payload: { username: outsiderName, password: "outsider-password" },
      });
      const outsiderCookie = `${outsiderLogin.cookies[0]?.name}=${outsiderLogin.cookies[0]?.value}`;
      const outsiderCsrf = outsiderLogin.json().csrfToken;
      const unauthorizedUpload = await app.inject({
        method: "POST",
        url: "/api/projects/project_demo/assets",
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: outsiderCookie,
          "x-csrf-token": outsiderCsrf,
          "idempotency-key": randomUUID(),
          "content-type": "text/csv; charset=utf-8",
          "x-file-name": "outsider.csv",
          "x-source-type": "synthetic",
          "x-source-name": "Unauthorized fixture",
          "x-source-purpose": "Authorization test",
          "x-license-status": "not_applicable",
          "x-sensitivity": "non_sensitive",
        },
        payload: csv,
      });
      expect(unauthorizedUpload.statusCode).toBe(404);
      expect(unauthorizedUpload.json()).toMatchObject({
        error: { code: "project_not_found" },
      });

      const unauthorizedTestSet = await app.inject({
        method: "POST",
        url: "/api/projects/project_demo/test-sets",
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: outsiderCookie,
          "x-csrf-token": outsiderCsrf,
          "content-type": "application/json",
        },
        payload: { name: "Unauthorized", purpose: "Denied", assetId },
      });
      expect(unauthorizedTestSet.statusCode).toBe(404);
      expect(unauthorizedTestSet.json()).toMatchObject({
        error: { code: "project_not_found" },
      });

      const unauthorizedConfigure = await app.inject({
        method: "PUT",
        url: `/api/projects/project_demo/drafts/${draft.id}`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: outsiderCookie,
          "x-csrf-token": outsiderCsrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: draft.leaseToken,
          expectedRevision: draft.revision,
          filter: { field: "category", operator: "eq", value: "billing" },
          mapping: { input: { message: "question" }, expectedOutput: "answer" },
          unmappedFields: [],
          unmappedConfirmed: true,
          formalSchema: {
            mode: "gold_required",
            input: { type: "string" },
            expectedOutput: { type: "string" },
          },
        },
      });
      expect(unauthorizedConfigure.statusCode).toBe(404);
      expect(unauthorizedConfigure.json()).toMatchObject({
        error: { code: "project_not_found" },
      });

      const unauthorizedMaterialize = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${draft.id}/candidates`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: outsiderCookie,
          "x-csrf-token": outsiderCsrf,
        },
      });
      expect(unauthorizedMaterialize.statusCode).toBe(404);

      const materialize = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${draft.id}/candidates`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: draft.leaseToken,
          expectedRevision: materializeRevision,
        },
      });
      expect(materialize.statusCode).toBe(202);
      const candidateId = materialize.json().candidate.id;
      const candidate = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/candidates/${candidateId}`,
            headers: { cookie },
          }),
        (body) => body.candidate?.status === "ready_to_publish",
      );
      expect(candidate.body.candidate).toMatchObject({
        itemCount: expectedItemCount,
        payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });

      const unauthorizedPublish = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/candidates/${candidateId}/publish`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: outsiderCookie,
          "x-csrf-token": outsiderCsrf,
        },
      });
      expect(unauthorizedPublish.statusCode).toBe(404);

      const publish = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/candidates/${candidateId}/publish`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
        },
      });
      expect(publish.statusCode).toBe(202);
      const jobId = publish.json().job.id;
      const published = await waitFor(
        () =>
          app.inject({
            method: "GET",
            url: `/api/projects/project_demo/jobs/${jobId}`,
            headers: { cookie },
          }),
        (body) => body.job?.status === "succeeded",
      );
      const versionId = published.body.job.result.versionId;

      const publishReplay = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/candidates/${candidateId}/publish`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
        },
      });
      expect(publishReplay.statusCode).toBe(200);
      expect(publishReplay.json()).toMatchObject({
        version: { id: versionId, status: "published" },
        replayed: true,
      });

      const version = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/test-sets/${testSet.id}/versions/${versionId}`,
        headers: { cookie },
      });
      expect(version.json().version.payloadHash).toBe(
        candidate.body.candidate.payloadHash,
      );
      expect(version.json().version.evidenceHash).toBe(
        candidate.body.candidate.evidenceHash,
      );
      expect(version.json()).toMatchObject({
        testSet: { id: testSet.id, defaultVersionId: versionId },
        version: {
          id: versionId,
          number: 1,
          itemCount: expectedItemCount,
          manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          lineage: expect.arrayContaining([
            expect.objectContaining({
              level: "record_level",
              assetId,
              parsedViewId: expect.stringMatching(/^view_/),
              sourceRecordOrdinal: 2,
              locator: expect.objectContaining({ physicalLine: 3 }),
              rawAssetDownloadUrl: `/api/projects/project_demo/assets/${assetId}/download`,
            }),
          ]),
          evidence: {
            attribution: expect.objectContaining({
              sourceType: classification.sourceType,
              licenseStatus: classification.licenseStatus,
              sensitivity: classification.sensitivity,
            }),
            recipe: expect.objectContaining({
              filter: { field: "category", operator: "eq", value: "billing" },
            }),
            schema: expect.objectContaining({
              mode: classification.formalMode ?? "gold_required",
            }),
            validationReport: {
              valid: true,
              errors: [],
              mode: classification.formalMode ?? "gold_required",
            },
          },
        },
      });

      const ordinaryDelete = await app.inject({
        method: "DELETE",
        url: `/api/projects/project_demo/assets/${assetId}`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
        },
      });
      expect(ordinaryDelete.statusCode).toBe(409);
      expect(ordinaryDelete.json()).toMatchObject({
        error: {
          code: "asset_referenced_by_published_version",
          retry: expect.stringContaining("Controlled Deletion"),
        },
      });

      const packageResponse = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/versions/${versionId}/package`,
        headers: { cookie },
      });
      expect(packageResponse.statusCode).toBe(200);
      const packagePath = join(tempDirectory, "standard.zip");
      await writeFile(packagePath, packageResponse.rawPayload);
      const packageFiles = unzipSync(packageResponse.rawPayload);
      if (clearedCaseId) {
        const items = strFromU8(packageFiles["items.jsonl"])
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(
          items.find((item) => item.case_id === clearedCaseId)?.expected_output,
        ).toBeNull();
      }
      expect(
        JSON.parse(strFromU8(packageFiles["parse-views.json"])),
      ).toMatchObject({ assetId });
      expect(
        JSON.parse(strFromU8(packageFiles["source-attributions.json"])),
      ).toMatchObject({ assetId });

      const validator = spawn(
        process.execPath,
        [
          "node_modules/tsx/dist/cli.mjs",
          "src/validator/cli.ts",
          packagePath,
          "--json",
        ],
        { env: {}, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      validator.stdout?.on("data", (chunk) => (stdout += chunk));
      validator.stderr?.on("data", (chunk) => (stderr += chunk));
      const exitCode = await new Promise<number | null>((resolve) =>
        validator.once("exit", resolve),
      );
      const validationReport = JSON.parse(stdout);
      expect(validationReport.errors, stderr).toEqual([]);
      expect(validationReport).toMatchObject({
        valid: true,
        package_type: "standard",
        verification_level: "standard",
      });
      expect(exitCode, stderr).toBe(0);
    },
  );
});
