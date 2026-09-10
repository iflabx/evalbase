import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp, type AgentBenchApp } from "../../src/server/app.js";

const contract = JSON.parse(
  readFileSync(
    new URL("../fixtures/curation-recipe-contract-v1.json", import.meta.url),
    "utf8",
  ),
);

async function waitFor(
  request: () => Promise<{ json: () => any }>,
  ready: (body: any) => boolean,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request();
    const body = response.json();
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for public resource state");
}

describe("S-HTTP Curation Recipe contract", () => {
  let app: AgentBenchApp;
  let worker: ChildProcess;

  beforeAll(async () => {
    app = await buildApp();
    worker = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/worker/main.ts"],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
  });

  afterAll(async () => {
    worker.kill("SIGTERM");
    await new Promise((resolve) => worker.once("exit", resolve));
    await app.close();
  });

  async function ownerSession() {
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { username: "owner", password: "owner-test-password" },
    });
    return {
      cookie: `${login.cookies[0]?.name}=${login.cookies[0]?.value}`,
      csrf: login.json().csrfToken as string,
    };
  }

  async function uploadReady(
    session: { cookie: string; csrf: string },
    fileName: string,
    contentType: string,
    payload: Buffer,
  ) {
    const upload = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/assets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "idempotency-key": randomUUID(),
        "content-type": contentType,
        "x-file-name": fileName,
        "x-source-type": "synthetic",
        "x-source-name": "Ticket 04 synthetic recipe fixture",
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Ticket 04 public contract evidence",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      payload,
    });
    expect(upload.statusCode).toBe(201);
    const assetId = upload.json().asset.id as string;
    const ready = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/assets/${assetId}/records`,
          headers: { cookie: session.cookie },
        }),
      (body) => body.parsedView?.status === "ready",
    );
    return { assetId, parsedViewId: ready.parsedView.id as string };
  }

  async function createDraft(
    session: { cookie: string; csrf: string },
    assetId: string,
  ) {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/project_demo/test-sets",
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      payload: {
        name: `Ticket 04 fixture ${randomUUID()}`,
        purpose: "Synthetic recipe contract",
        assetId,
      },
    });
    expect(created.statusCode).toBe(201);
    return created.json();
  }

  it("consumes the frozen G-06 cases through save and evaluate", async () => {
    const session = await ownerSession();
    const jsonl = Buffer.from(
      contract.records
        .map((record: any) => JSON.stringify(record.fields))
        .join("\n"),
    );
    const { assetId, parsedViewId } = await uploadReady(
      session,
      "recipe-contract.jsonl",
      "application/x-ndjson",
      jsonl,
    );
    const created = await createDraft(session, assetId);
    let draft = created.draft;
    const sourceId = (fixtureId: string) => {
      const record = contract.records.find(
        (candidate: any) => candidate.id === fixtureId,
      );
      return `${parsedViewId}:${record.ordinal}`;
    };

    for (const fixture of contract.cases) {
      const steps = structuredClone(fixture.steps);
      for (const step of steps) {
        if (step.kind !== "manual") continue;
        for (const decisions of [step.include ?? [], step.exclude ?? []]) {
          for (const decision of decisions) {
            decision.id = sourceId(decision.id);
            decision.actorId = "forged-client-actor";
          }
        }
      }
      const saved = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${draft.id}/recipe`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: session.cookie,
          "x-csrf-token": session.csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: draft.leaseToken,
          expectedRevision: draft.revision,
          versionDescription: "Synthetic Ticket 04 contract",
          steps,
        },
      });
      expect(saved.statusCode).toBe(200);
      draft = saved.json().draft;

      const manual = draft.recipe.steps.find(
        (step: any) => step.kind === "manual",
      );
      for (const decision of [
        ...(manual?.include ?? []),
        ...(manual?.exclude ?? []),
      ]) {
        expect(decision.actorId).toBe("user_owner");
      }

      const evaluated = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${draft.id}/evaluate`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: session.cookie,
          "x-csrf-token": session.csrf,
        },
      });
      expect(evaluated.statusCode).toBe(200);
      const evaluation = evaluated.json().evaluation;
      expect(evaluation.records.map((record: any) => record.id)).toEqual(
        fixture.expected.recordIds.map(sourceId),
      );
      expect(evaluation.steps).toEqual(fixture.expected.steps);
      if (fixture.expected.exits) {
        expect(evaluation.exits).toEqual(
          Object.fromEntries(
            Object.entries(fixture.expected.exits).map(([id, exit]) => [
              sourceId(id),
              exit,
            ]),
          ),
        );
      }
    }

    const restored = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${draft.id}`,
      headers: { cookie: session.cookie },
    });
    expect(restored.json().draft).toMatchObject({
      leaseToken: draft.leaseToken,
      versionDescription: "Synthetic Ticket 04 contract",
    });

    for (const steps of [
      [{ kind: "filter", filter: { field: "/kind", operator: "script" } }],
      [{ kind: "filter", filter: { all: "not-an-array" } }],
    ]) {
      const invalid = await app.inject({
        method: "POST",
        url: `/api/projects/project_demo/drafts/${draft.id}/recipe`,
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie: session.cookie,
          "x-csrf-token": session.csrf,
          "content-type": "application/json",
        },
        payload: {
          leaseToken: draft.leaseToken,
          expectedRevision: draft.revision,
          steps,
        },
      });
      expect(invalid.statusCode).toBe(422);
      expect(invalid.json()).toEqual({ error: { code: "recipe_invalid" } });
    }
  });

  it("returns all unmapped fields and samples before confirmation", async () => {
    const session = await ownerSession();
    const { assetId } = await uploadReady(
      session,
      "nested-unmapped.jsonl",
      "application/x-ndjson",
      Buffer.from(
        [
          JSON.stringify({
            question: "First",
            answer: "A",
            category: "billing",
          }),
          JSON.stringify({
            question: "Second",
            answer: "B",
            profile: { name: "Later" },
          }),
        ].join("\n"),
      ),
    );
    const created = await createDraft(session, assetId);
    const preview = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${created.draft.id}/mapping/preview`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      payload: {
        mapping: {
          input: { source: "/question" },
          expectedOutput: { source: "/answer" },
        },
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().unmappedFields).toEqual([
      { path: "/category", sample: "billing" },
      { path: "/profile/name", sample: "Later" },
    ]);
  });

  it("supersedes a ready Candidate without deleting immutable evidence", async () => {
    const session = await ownerSession();
    const csv = await new Promise<Buffer>((resolve, reject) =>
      readFile(
        new URL("../fixtures/owner.csv", import.meta.url),
        (error, data) => (error ? reject(error) : resolve(data)),
      ),
    );
    const { assetId, parsedViewId } = await uploadReady(
      session,
      "owner.csv",
      "text/csv; charset=utf-8",
      csv,
    );
    const created = await createDraft(session, assetId);
    const savedRecipe = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${created.draft.id}/recipe`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: created.draft.leaseToken,
        expectedRevision: created.draft.revision,
        versionDescription: "Preserve this complete Recipe",
        mapping: { input: { message: "question" }, expectedOutput: "answer" },
        steps: [
          {
            kind: "filter",
            filter: {
              field: "/category",
              operator: "contains",
              value: "billing",
            },
          },
          { kind: "sample", mode: "count", value: 1, seed: "preserve" },
          {
            kind: "manual",
            include: [{ id: `${parsedViewId}:1`, reason: "Control row" }],
            exclude: [
              { id: `${parsedViewId}:2`, reason: "Synthetic exclusion" },
              { id: `${parsedViewId}:3`, reason: "Synthetic exclusion" },
            ],
          },
        ],
      },
    });
    expect(savedRecipe.statusCode).toBe(200);
    const configuration = {
      leaseToken: created.draft.leaseToken,
      expectedRevision: savedRecipe.json().draft.revision,
      filter: { field: "category", operator: "eq" as const, value: "billing" },
      mapping: { input: { message: "question" }, expectedOutput: "answer" },
      unmappedFields: ["category", "internal_note"],
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
    };
    const missingProposal = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${created.draft.id}`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      payload: configuration,
    });
    expect(missingProposal.statusCode).toBe(422);
    expect(missingProposal.json()).toEqual({
      error: { code: "schema_proposal_required" },
    });
    const proposal = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${created.draft.id}/mapping/schema-suggestion`,
      headers: { cookie: session.cookie },
    });
    expect(proposal.statusCode).toBe(200);
    const configured = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${created.draft.id}`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      payload: { ...configuration, proposalId: proposal.json().proposalId },
    });
    expect(configured.statusCode).toBe(200);
    const restored = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/drafts/${created.draft.id}`,
      headers: { cookie: session.cookie },
    });
    expect(restored.json().draft).toMatchObject({
      versionDescription: "Preserve this complete Recipe",
      recipe: {
        steps: [
          expect.objectContaining({ kind: "filter" }),
          expect.objectContaining({ kind: "sample", seed: "preserve" }),
          expect.objectContaining({ kind: "manual" }),
        ],
      },
    });
    const materialized = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${created.draft.id}/candidates`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: created.draft.leaseToken,
        expectedRevision: configured.json().draft.revision,
      },
    });
    const candidateId = materialized.json().candidate.id as string;
    const ready = await waitFor(
      () =>
        app.inject({
          method: "GET",
          url: `/api/projects/project_demo/candidates/${candidateId}`,
          headers: { cookie: session.cookie },
        }),
      (body) => body.candidate?.status === "ready_to_publish",
    );
    const evidence = ready.candidate;
    expect(evidence).toMatchObject({
      itemCount: 1,
      recipe: {
        steps: [
          expect.objectContaining({ kind: "filter" }),
          expect.objectContaining({ kind: "sample", seed: "preserve" }),
          expect.objectContaining({ kind: "manual" }),
        ],
      },
    });

    const unmappedFieldsEdited = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${created.draft.id}/recipe`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: created.draft.leaseToken,
        expectedRevision: configured.json().draft.revision,
        steps: savedRecipe.json().draft.recipe.steps,
        unmappedFields: ["category"],
      },
    });
    expect(unmappedFieldsEdited.statusCode).toBe(200);
    const blockedAfterUnmappedFieldsEdit = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${created.draft.id}/candidates`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: created.draft.leaseToken,
        expectedRevision: unmappedFieldsEdited.json().draft.revision,
      },
    });
    expect(blockedAfterUnmappedFieldsEdit.statusCode).toBe(422);
    expect(blockedAfterUnmappedFieldsEdit.json()).toMatchObject({
      error: { code: "draft_not_ready" },
    });

    const edited = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${created.draft.id}/recipe`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: created.draft.leaseToken,
        expectedRevision: unmappedFieldsEdited.json().draft.revision,
        steps: [
          {
            kind: "filter",
            filter: { field: "/category", operator: "neq", value: "support" },
          },
        ],
      },
    });
    expect(edited.statusCode).toBe(200);
    const superseded = await app.inject({
      method: "GET",
      url: `/api/projects/project_demo/candidates/${candidateId}`,
      headers: { cookie: session.cookie },
    });
    expect(superseded.json().candidate).toEqual({
      ...evidence,
      status: "superseded",
    });
    const staleProposal = await app.inject({
      method: "PUT",
      url: `/api/projects/project_demo/drafts/${created.draft.id}`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      payload: {
        ...configuration,
        expectedRevision: edited.json().draft.revision,
        proposalId: proposal.json().proposalId,
      },
    });
    expect(staleProposal.statusCode).toBe(422);
    expect(staleProposal.json()).toEqual({
      error: { code: "schema_proposal_stale" },
    });
    const blocked = await app.inject({
      method: "POST",
      url: `/api/projects/project_demo/drafts/${created.draft.id}/candidates`,
      headers: {
        origin: "http://127.0.0.1:3000",
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      payload: {
        leaseToken: created.draft.leaseToken,
        expectedRevision: edited.json().draft.revision,
      },
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({
      error: { code: "draft_not_ready" },
    });
  });
});
