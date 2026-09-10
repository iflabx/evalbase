import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp, type AgentBenchApp } from "../../src/server/app.js";

const contract = JSON.parse(
  readFileSync(
    new URL("../fixtures/source-attribution-contract-v1.json", import.meta.url),
    "utf8",
  ),
);

describe("Ticket 03 Source Attribution", () => {
  let app: AgentBenchApp;
  let worker: ChildProcess;

  beforeAll(async () => {
    app = await buildApp();
    worker = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/worker/main.ts"],
      { stdio: "inherit" },
    );
  });

  afterAll(async () => {
    worker.kill("SIGTERM");
    await new Promise((resolve) => worker.once("exit", resolve));
    await app.close();
  });

  it("keeps revisions immutable and blocks an explicit unknown license from draft attachment", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    const cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    const csrf = login.json().csrfToken;
    const headers = {
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
      "idempotency-key": randomUUID(),
      "content-type": "text/csv; charset=utf-8",
      "x-file-name": "unknown-license.csv",
      "x-source-type": "synthetic",
      "x-source-name": "Synthetic fixture pending license review",
      "x-responsible-person": "Project Owner",
      "x-source-purpose": "Verify attachment block",
      "x-license-status": "unknown",
      "x-sensitivity": "non_sensitive",
    };
    const upload = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers,
      payload: "question,answer,category\nQ,A,billing\n",
    });
    expect(upload.statusCode).toBe(201);
    const assetId = upload.json().asset.id;
    const firstAttributionId = upload.json().attribution.id;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const preview = await app.inject({
        method: "GET",
        url: `/api/projects/project_demo/assets/${assetId}/records`,
        headers: { cookie },
      });
      if (preview.json().parsedView?.status === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/test-sets",
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        name: "Blocked attribution",
        purpose: "Verify block",
        assetId,
      },
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({
      error: { code: "data_classification_not_allowed" },
    });

    const revised = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/assets/${assetId}/attribution`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        sourceType: "synthetic",
        sourceName: "Synthetic fixture approved for development",
        responsiblePerson: "Project Owner",
        purpose: "Verify immutable revisions",
        licenseStatus: "not_applicable",
        sensitivity: "non_sensitive",
        sourceAddress: null,
        acquiredAt: null,
        deidentificationConfirmed: false,
      },
    });
    expect(revised.statusCode).toBe(200);
    expect(revised.json().attribution.id).not.toBe(firstAttributionId);
    const history = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${assetId}/attributions`,
      headers: { cookie },
    });
    expect(history.json().attributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstAttributionId,
          licenseStatus: "unknown",
        }),
        expect.objectContaining({ licenseStatus: "not_applicable" }),
      ]),
    );
    const audit = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${assetId}/audit`,
      headers: { cookie },
    });
    expect(audit.json().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "source_attribution_revised" }),
      ]),
    );

    const archived = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/assets/${assetId}/archive`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {},
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().asset.status).toBe("archived");
    const archiveReplay = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/assets/${assetId}/archive`,
      headers: { ...headers, "content-type": "application/json" },
      payload: {},
    });
    expect(archiveReplay.statusCode).toBe(200);
    const archivedAudit = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${assetId}/audit`,
      headers: { cookie },
    });
    expect(
      archivedAudit
        .json()
        .events.filter((event: any) => event.action === "asset_archived"),
    ).toHaveLength(1);
    const download = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${assetId}/download`,
      headers: { cookie },
    });
    expect(download.rawPayload).toEqual(
      Buffer.from("question,answer,category\nQ,A,billing\n"),
    );
  });

  it.each(contract.requiredFields)(
    "rejects a missing required attribution field: %s",
    async (...[field]: any[]) => {
      const login = await app.inject({
        method: "POST",
        url: "/api/session",
        headers: { origin: "http://127.0.0.1:3000" },
        payload: { username: "owner", password: "owner-test-password" },
      });
      const cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
      const csrf = login.json().csrfToken;
      const headers = {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": randomUUID(),
        "content-type": "text/csv; charset=utf-8",
        "x-file-name": "incomplete-attribution.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Complete source",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Required field validation",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      };
      const upload = await app.inject({
        method: "POST",
        url: "/api/projects/project_demo/assets",
        headers,
        payload: "question,answer\nQ,A\n",
      });
      expect(upload.statusCode).toBe(201);
      const invalid = {
        sourceType: "synthetic",
        sourceName: "Complete source",
        responsiblePerson: "Project Owner",
        purpose: "Required field validation",
        licenseStatus: "not_applicable",
        sensitivity: "non_sensitive",
        sourceAddress: null,
        acquiredAt: null,
        deidentificationConfirmed: false,
        [field]: "",
      };
      const revised = await app.inject({
        method: "PUT",
        url: `/api/projects/project_demo/assets/${upload.json().asset.id}/attribution`,
        headers: { ...headers, "content-type": "application/json" },
        payload: invalid,
      });
      expect(revised.statusCode).toBe(422);
      expect(revised.json()).toMatchObject({
        error: { code: "source_attribution_incomplete" },
      });
    },
  );

  it.each([
    ...contract.blocked.licenseStatus.map((licenseStatus: string) => ({
      licenseStatus,
      sensitivity: "non_sensitive",
    })),
    ...contract.blocked.sensitivity.map((sensitivity: string) => ({
      licenseStatus: "not_applicable",
      sensitivity,
    })),
  ])(
    "blocks prohibited $licenseStatus/$sensitivity attribution from draft attachment",
    async (...[classification]: any[]) => {
      const login = await app.inject({
        method: "POST",
        url: "/api/session",
        headers: { origin: "http://127.0.0.1:3000" },
        payload: { username: "owner", password: "owner-test-password" },
      });
      const cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
      const csrf = login.json().csrfToken;
      const headers = {
        origin: "http://127.0.0.1:3000",
        cookie,
        "x-csrf-token": csrf,
        "idempotency-key": randomUUID(),
        "content-type": "text/csv; charset=utf-8",
        "x-file-name": "prohibited-attribution.csv",
        "x-source-type": "synthetic",
        "x-source-name": "Synthetic prohibited fixture",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Classification enforcement",
        "x-license-status": classification.licenseStatus,
        "x-sensitivity": classification.sensitivity,
      };
      const upload = await app.inject({
        method: "POST",
        url: "/api/projects/project_demo/assets",
        headers,
        payload: "question,answer\nQ,A\n",
      });
      expect(upload.statusCode).toBe(201);
      const attach = await app.inject({
        method: "POST",
        url: "/api/projects/project_demo/test-sets",
        headers: { ...headers, "content-type": "application/json" },
        payload: {
          name: `Blocked ${randomUUID()}`,
          purpose: "Classification enforcement",
          assetId: upload.json().asset.id,
        },
      });
      expect(attach.statusCode).toBe(422);
      expect(attach.json()).toMatchObject({
        error: { code: "data_classification_not_allowed" },
      });
    },
  );

  it.each(contract.allowed)(
    "registers allowed $sourceType non-sensitive source attribution",
    async (...[classification]: any[]) => {
      const login = await app.inject({
        method: "POST",
        url: "/api/session",
        headers: { origin: "http://127.0.0.1:3000" },
        payload: { username: "owner", password: "owner-test-password" },
      });
      const cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
      const csrf = login.json().csrfToken;

      const upload = await app.inject({
        method: "POST",
        url: "/api/projects/project_demo/assets",
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-csrf-token": csrf,
          "idempotency-key": randomUUID(),
          "content-type": "text/csv; charset=utf-8",
          "x-file-name": `${classification.sourceType}-fixture.csv`,
          "x-source-type": classification.sourceType,
          "x-source-name": `${classification.sourceType} synthetic fixture`,
          "x-responsible-person": "Project Owner",
          "x-source-purpose": "Non-production parser verification",
          "x-license-status": classification.licenseStatus,
          "x-sensitivity": classification.sensitivity,
          "x-source-address": "https://example.test/public-fixture",
          "x-acquired-at": "2026-08-19T00:00:00.000Z",
          ...(classification.deidentificationConfirmed
            ? { "x-deidentification-confirmed": "true" }
            : {}),
        },
        payload: "question,answer\nQ,A\n",
      });

      expect(upload.statusCode).toBe(201);
      expect(upload.json()).toMatchObject({
        attribution: {
          sourceType: classification.sourceType,
          licenseStatus: classification.licenseStatus,
          sensitivity: "non_sensitive",
          responsiblePerson: "Project Owner",
        },
      });
    },
  );

  it("keeps same-byte registrations and their lifecycle independent", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    const cookie = `${login.cookies[0]?.name}=${login.cookies[0]?.value}`;
    const csrf = login.json().csrfToken;
    const body = "question,answer\nQ,A\n";
    const headers = (sourceName: string, purpose: string) => ({
      origin: "http://127.0.0.1:3000",
      cookie,
      "x-csrf-token": csrf,
      "idempotency-key": randomUUID(),
      "content-type": "text/csv; charset=utf-8",
      "x-file-name": "shared-synthetic.csv",
      "x-source-type": "synthetic",
      "x-source-name": sourceName,
      "x-responsible-person": "Project Owner",
      "x-source-purpose": purpose,
      "x-license-status": "not_applicable",
      "x-sensitivity": "non_sensitive",
    });
    const first = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: headers("First registration", "First lifecycle"),
      payload: body,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: headers("Second registration", "Second lifecycle"),
      payload: body,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().asset).toMatchObject({
      sha256: first.json().asset.sha256,
    });
    expect(second.json().asset.id).not.toBe(first.json().asset.id);

    const archived = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/assets/${first.json().asset.id}/archive`,
      headers: {
        ...headers("ignored", "ignored"),
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(archived.statusCode).toBe(200);
    const independent = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/assets/${second.json().asset.id}`,
      headers: { cookie },
    });
    expect(independent.json()).toMatchObject({
      asset: { status: "stored" },
      attribution: {
        sourceName: "Second registration",
        purpose: "Second lifecycle",
      },
    });
  });
});
