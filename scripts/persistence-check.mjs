import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const origin = process.env.APP_ORIGIN ?? baseUrl;
const defaultProjectId = process.env.PERSISTENCE_PROJECT_ID ?? "project_demo";
const statePath = process.argv[3];
const transcriptPath =
  process.env.PERSISTENCE_TRANSCRIPT ??
  (statePath ? `${statePath}.transcript.jsonl` : undefined);

async function recordTranscript(entry) {
  if (!transcriptPath) return;
  await appendFile(
    transcriptPath,
    `${JSON.stringify({
      observedAt: new Date().toISOString(),
      nodeVersion: process.version,
      ...entry,
    })}\n`,
  );
}

async function request(
  path,
  { method = "GET", cookie, body, headers = {} } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...headers,
      origin: headers.origin ?? origin,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(headers.csrf ? { "x-csrf-token": headers.csrf } : {}),
      ...(cookie ? { cookie } : {}),
      ...(body ? {} : { accept: "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `${method} ${path}: ${response.status} ${await response.text()}`,
    );
  }
  return response;
}

async function waitFor(check, description) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function login() {
  const response = await request("/api/session", {
    method: "POST",
    body: {
      username: "owner",
      password: process.env.OWNER_PASSWORD ?? "owner-test-password",
    },
  });
  const setCookie = response.headers.get("set-cookie") ?? "";
  return {
    cookie: setCookie.split(";")[0],
    csrf: (await response.json()).csrfToken,
  };
}

async function createFixture() {
  const session = await login();
  const projectId = defaultProjectId;
  const headers = {
    cookie: session.cookie,
    csrf: session.csrf,
  };
  const sourceName = `Persistence fixture ${randomUUID()}`;
  const uploadResponse = await fetch(
    `${baseUrl}/api/projects/${projectId}/assets`,
    {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin,
        "x-csrf-token": session.csrf,
        "idempotency-key": randomUUID(),
        "content-type": "text/csv; charset=utf-8",
        "x-file-name": "persistence-fixture.csv",
        "x-source-type": "synthetic",
        "x-source-name": sourceName,
        "x-responsible-person": "Project Owner",
        "x-source-purpose": "Normal persistence verification",
        "x-license-status": "not_applicable",
        "x-sensitivity": "non_sensitive",
      },
      body: "question,answer,category\nPersisted question,Persisted answer,billing\n",
    },
  );
  if (!uploadResponse.ok)
    throw new Error(`upload failed: ${await uploadResponse.text()}`);
  const uploaded = await uploadResponse.json();
  const parsedView = await waitFor(async () => {
    const preview = await request(
      `/api/projects/${projectId}/assets/${uploaded.asset.id}/records`,
      { cookie: session.cookie },
    );
    const body = await preview.json();
    return body.parsedView?.status === "ready" ? body.parsedView : undefined;
  }, "Parsed View");

  const createdResponse = await request(
    `/api/projects/${projectId}/test-sets`,
    {
      method: "POST",
      headers: { origin, ...headers },
      body: {
        name: sourceName,
        purpose: "Normal persistence verification",
        assetId: uploaded.asset.id,
      },
    },
  );
  const created = await createdResponse.json();
  const mapping = {
    input: { object: { message: { source: "/question" } } },
    expectedOutput: { source: "/answer" },
    metadata: { object: {} },
  };
  const recipeResponse = await request(
    `/api/projects/${projectId}/drafts/${created.draft.id}/recipe`,
    {
      method: "POST",
      headers: { origin, ...headers },
      body: {
        leaseToken: created.draft.leaseToken,
        expectedRevision: created.draft.revision,
        versionDescription: "Normal persistence verification",
        mapping,
        unmappedFields: ["category"],
        unmappedConfirmed: true,
        steps: [
          {
            kind: "filter",
            filter: { field: "category", operator: "eq", value: "billing" },
          },
        ],
      },
    },
  );
  const recipe = await recipeResponse.json();
  const proposalResponse = await request(
    `/api/projects/${projectId}/drafts/${created.draft.id}/mapping/schema-suggestion`,
    { cookie: session.cookie },
  );
  const proposal = await proposalResponse.json();
  const configuredResponse = await request(
    `/api/projects/${projectId}/drafts/${created.draft.id}`,
    {
      method: "PUT",
      headers: { origin, ...headers },
      body: {
        leaseToken: created.draft.leaseToken,
        expectedRevision: recipe.draft.revision,
        proposalId: proposal.proposalId,
        filter: { field: "category", operator: "eq", value: "billing" },
        mapping,
        unmappedFields: ["category"],
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
    },
  );
  const configured = await configuredResponse.json();
  const materializationResponse = await request(
    `/api/projects/${projectId}/drafts/${created.draft.id}/candidates`,
    {
      method: "POST",
      headers: { origin, ...headers },
      body: {
        leaseToken: created.draft.leaseToken,
        expectedRevision: configured.draft.revision,
      },
    },
  );
  const materialization = await materializationResponse.json();
  await waitFor(async () => {
    const candidate = await request(
      `/api/projects/${projectId}/candidates/${materialization.candidate.id}`,
      { cookie: session.cookie },
    );
    return (await candidate.json()).candidate?.status === "ready_to_publish";
  }, "Candidate");
  const publishResponse = await request(
    `/api/projects/${projectId}/candidates/${materialization.candidate.id}/publish`,
    { method: "POST", headers: { origin, ...headers }, body: {} },
  );
  const publish = await publishResponse.json();
  const job = await waitFor(async () => {
    const result = await request(
      `/api/projects/${projectId}/jobs/${publish.job.id}`,
      { cookie: session.cookie },
    );
    const body = (await result.json()).job;
    return body?.status === "succeeded" ? body : undefined;
  }, "publication");
  const fixture = {
    projectId,
    assetId: uploaded.asset.id,
    parsedViewId: parsedView.id,
    draftId: created.draft.id,
    testSetId: created.testSet.id,
    candidateId: materialization.candidate.id,
    versionId: job.result.versionId,
  };
  const snapshot = await snapshotFixture(fixture, session);
  await writeFile(
    statePath,
    `${JSON.stringify({ fixture, snapshot }, null, 2)}\n`,
  );
  await recordTranscript({
    operation: "create",
    status: "created",
    fixture,
    snapshot,
  });
  console.log(JSON.stringify({ status: "created", ...fixture, ...snapshot }));
}

async function snapshotFixture(fixture, session) {
  const projectId = fixture.projectId ?? defaultProjectId;
  const [asset, draft, candidate, versionResponse] = await Promise.all([
    request(`/api/projects/${projectId}/assets/${fixture.assetId}`, {
      cookie: session.cookie,
    }).then((response) => response.json()),
    request(`/api/projects/${projectId}/drafts/${fixture.draftId}`, {
      cookie: session.cookie,
    }).then((response) => response.json()),
    request(`/api/projects/${projectId}/candidates/${fixture.candidateId}`, {
      cookie: session.cookie,
    }).then((response) => response.json()),
    request(
      `/api/projects/${projectId}/test-sets/${fixture.testSetId}/versions/${fixture.versionId}`,
      { cookie: session.cookie },
    ).then((response) => response.json()),
  ]);
  const assetDownload = await request(
    `/api/projects/${projectId}/assets/${fixture.assetId}/download`,
    { cookie: session.cookie },
  );
  const assetBytes = Buffer.from(await assetDownload.arrayBuffer());
  const assetDownloadHash = createHash("sha256")
    .update(assetBytes)
    .digest("hex");
  if (assetDownloadHash !== asset.asset.sha256)
    throw new Error(
      "downloaded Data Asset hash differs from its public metadata",
    );
  const parsedViewResponse = await request(
    `/api/projects/${projectId}/assets/${fixture.assetId}/records?parsedViewId=${encodeURIComponent(fixture.parsedViewId)}&limit=1`,
    { cookie: session.cookie },
  ).then((response) => response.json());
  if (
    parsedViewResponse.parsedView?.id !== fixture.parsedViewId ||
    parsedViewResponse.parsedView?.status !== "ready"
  )
    throw new Error("Parsed View is not ready after persistence verification");
  const deliveries = await request(
    `/api/projects/${projectId}/versions/${fixture.versionId}/deliveries`,
    { cookie: session.cookie },
  ).then((response) => response.json());
  const packageResponse = await request(
    `/api/projects/${projectId}/versions/${fixture.versionId}/package`,
    { cookie: session.cookie },
  );
  const packageBytes = Buffer.from(await packageResponse.arrayBuffer());
  return {
    assetHash: asset.asset.sha256,
    assetDownloadHash: createHash("sha256").update(assetBytes).digest("hex"),
    assetStatus: asset.asset.status,
    parsedView: {
      id: parsedViewResponse.parsedView.id,
      status: parsedViewResponse.parsedView.status,
      recordCount: parsedViewResponse.parsedView.recordCount,
      parserConfigHash: parsedViewResponse.parsedView.parserConfigHash,
      firstRecordHash: parsedViewResponse.records[0]?.recordHash ?? null,
    },
    draftStatus: draft.draft.status,
    candidateStatus: candidate.candidate.status,
    candidateHashes: {
      payload: candidate.candidate.payloadHash,
      evidence: candidate.candidate.evidenceHash,
    },
    versionHashes: {
      payload: versionResponse.version.payloadHash,
      evidence: versionResponse.version.evidenceHash,
      manifest: versionResponse.version.manifestHash,
    },
    itemCount: versionResponse.version.itemCount,
    deliveryCount: deliveries.deliveries.length,
    packageHash: createHash("sha256").update(packageBytes).digest("hex"),
  };
}

async function verifyFixture() {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const session = await login();
  const actual = await snapshotFixture(state.fixture, session);
  const unchanged = JSON.stringify(actual) === JSON.stringify(state.snapshot);
  await recordTranscript({
    operation: "verify",
    status: unchanged ? "unchanged" : "changed",
    fixture: state.fixture,
    snapshot: actual,
  });
  console.log(
    JSON.stringify({ status: unchanged ? "unchanged" : "changed", ...actual }),
  );
  if (!unchanged) process.exitCode = 1;
}

if (process.argv[2] === "create") await createFixture();
else if (process.argv[2] === "verify") await verifyFixture();
else {
  console.error(
    "Usage: node scripts/persistence-check.mjs create|verify <state.json>",
  );
  process.exitCode = 2;
}
