import { expect, test, type APIRequestContext } from "@playwright/test";
import { Pool } from "pg";

const database = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://evalbase_phase1a:synthetic-nonproduction-only@postgres:5432/evalbase_phase1a",
});

async function login(request: APIRequestContext) {
  const login = await request.post("/api/session", {
    headers: { origin: "http://web:3000" },
    data: { username: "owner", password: "owner-test-password" },
  });
  expect(login.ok()).toBeTruthy();
  return login.json() as Promise<{ csrfToken: string }>;
}

async function prepareConfiguredDraft(
  request: APIRequestContext,
  csrf: string,
) {
  const uploaded = await request.post("/api/projects/project_demo/assets", {
    headers: {
      origin: "http://web:3000",
      "x-csrf-token": csrf,
      "idempotency-key": crypto.randomUUID(),
      "content-type": "text/csv; charset=utf-8",
      "x-file-name": "scenario-h.csv",
      "x-source-type": "synthetic",
      "x-source-name": "Scenario H synthetic fixture",
      "x-responsible-person": "Project Owner",
      "x-source-purpose": "Synthetic failure and recovery test",
      "x-license-status": "not_applicable",
      "x-sensitivity": "non_sensitive",
    },
    data: Buffer.from(
      "question,answer\nSynthetic failure question,Synthetic recovered answer\n",
    ),
  });
  if (!uploaded.ok())
    throw new Error(`Scenario H upload failed: ${await uploaded.text()}`);
  const upload = await uploaded.json();

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const preview = await request.get(
      `/api/projects/project_demo/assets/${upload.asset.id}/records`,
    );
    const body = await preview.json();
    if (body.parsedView?.status === "ready") break;
    if (attempt === 99)
      throw new Error("Scenario H parse did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const created = await request.post("/api/projects/project_demo/test-sets", {
    headers: {
      origin: "http://web:3000",
      "x-csrf-token": csrf,
      "content-type": "application/json",
    },
    data: {
      name: `Scenario H ${crypto.randomUUID()}`,
      purpose: "Synthetic job recovery",
      assetId: upload.asset.id,
    },
  });
  expect(created.ok()).toBeTruthy();
  const { testSet, draft } = await created.json();
  const mapping = {
    input: { object: { message: { source: "/question" } } },
    expectedOutput: { source: "/answer" },
    metadata: { object: {} },
  };
  const recipe = await request.post(
    `/api/projects/project_demo/drafts/${draft.id}/recipe`,
    {
      headers: {
        origin: "http://web:3000",
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      data: {
        leaseToken: draft.leaseToken,
        expectedRevision: draft.revision,
        versionDescription: "Scenario H synthetic version",
        steps: [
          {
            kind: "filter",
            filter: {
              field: "question",
              operator: "eq",
              value: "Synthetic failure question",
            },
          },
        ],
        mapping,
        unmappedFields: [],
        unmappedConfirmed: true,
      },
    },
  );
  expect(recipe.ok()).toBeTruthy();
  const proposal = await request.get(
    `/api/projects/project_demo/drafts/${draft.id}/mapping/schema-suggestion`,
  );
  expect(proposal.ok()).toBeTruthy();
  const configured = await request.put(
    `/api/projects/project_demo/drafts/${draft.id}`,
    {
      headers: {
        origin: "http://web:3000",
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      data: {
        leaseToken: draft.leaseToken,
        expectedRevision: (await recipe.json()).draft.revision,
        proposalId: (await proposal.json()).proposalId,
        filter: {
          field: "question",
          operator: "eq",
          value: "Synthetic failure question",
        },
        mapping,
        unmappedFields: [],
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
  expect(configured.ok()).toBeTruthy();
  return {
    testSetId: testSet.id,
    draftId: draft.id,
    leaseToken: draft.leaseToken,
    configuredRevision: (await configured.json()).draft.revision,
  };
}

async function createReadyCandidate(request: APIRequestContext, csrf: string) {
  const fixture = await prepareConfiguredDraft(request, csrf);
  const materialized = await request.post(
    `/api/projects/project_demo/drafts/${fixture.draftId}/candidates`,
    {
      headers: {
        origin: "http://web:3000",
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      data: {
        leaseToken: fixture.leaseToken,
        expectedRevision: fixture.configuredRevision,
      },
    },
  );
  expect(materialized.ok()).toBeTruthy();
  const started = await materialized.json();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = await request.get(
      `/api/projects/project_demo/candidates/${started.candidate.id}`,
    );
    const body = await candidate.json();
    if (body.candidate?.status === "ready_to_publish")
      return {
        ...fixture,
        candidateId: started.candidate.id,
      };
    if (body.candidate?.status === "failed")
      throw new Error("Scenario H candidate failed validation");
    if (attempt === 99) throw new Error("Scenario H candidate timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Unreachable Scenario H candidate state");
}

test.afterAll(async () => {
  await database.end();
});

test("Owner sees storage failure recovery and cancels publication through the UI", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const { csrfToken } = await login(request);
  const failure = await createReadyCandidate(request, csrfToken);
  const original = await database.query(
    "SELECT object_ref FROM candidate_snapshot WHERE id = $1",
    [failure.candidateId],
  );
  await database.query(
    "UPDATE candidate_snapshot SET object_ref = 'blobs/sha256/scenario-h-missing' WHERE id = $1",
    [failure.candidateId],
  );
  const failedPublish = await request.post(
    `/api/projects/project_demo/candidates/${failure.candidateId}/publish`,
    { headers: { origin: "http://web:3000", "x-csrf-token": csrfToken } },
  );
  expect(failedPublish.ok()).toBeTruthy();
  const failedJob = (await failedPublish.json()).job;
  await page.addInitScript((job) => {
    sessionStorage.setItem("agentbench-active-job", JSON.stringify(job));
  }, failedJob);
  await page.goto(`/workbench/${failure.draftId}`);
  await page.getByRole("button", { name: "进入 AgentBench" }).click();
  const jobPanel = page.getByRole("status", { name: "后台任务状态" });
  await expect(jobPanel).toContainText("publish_version", { timeout: 30_000 });
  await expect(jobPanel).toContainText("failed", { timeout: 30_000 });
  await expect(jobPanel).toContainText("infrastructure_unavailable");
  await expect(jobPanel).toContainText(`correlation ID ${failedJob.id}`);

  await database.query(
    "UPDATE candidate_snapshot SET object_ref = $2 WHERE id = $1",
    [failure.candidateId, original.rows[0].object_ref],
  );
  await page.getByRole("button", { name: "重试后台任务" }).click();
  await expect(jobPanel).toContainText("succeeded", { timeout: 30_000 });
  await expect(jobPanel).toContainText(/尝试 [0-9]+\/3/);

  const materialization = await prepareConfiguredDraft(request, csrfToken);
  const materializationResponse = await request.post(
    `/api/projects/project_demo/drafts/${materialization.draftId}/candidates`,
    {
      headers: {
        origin: "http://web:3000",
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      data: {
        leaseToken: materialization.leaseToken,
        expectedRevision: materialization.configuredRevision,
      },
    },
  );
  expect(materializationResponse.ok()).toBeTruthy();
  const materializationJob = (await materializationResponse.json()).job;
  const materializationCandidateId = (await materializationResponse.json())
    .candidate.id;
  const materializationLock = await database.connect();
  await materializationLock.query("BEGIN");
  await materializationLock.query(
    "SELECT id FROM candidate_snapshot WHERE id = $1 FOR UPDATE",
    [materializationCandidateId],
  );
  try {
    let workerReachedCommit = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await database.query(
        `SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query ILIKE '%candidate_snapshot%'
         LIMIT 1`,
      );
      if (waiting.rowCount) {
        workerReachedCommit = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(workerReachedCommit).toBeTruthy();
    await page.addInitScript((job) => {
      sessionStorage.setItem("agentbench-active-job", JSON.stringify(job));
    }, materializationJob);
    await page.goto(`/workbench/${materialization.draftId}`);
    await page.getByRole("button", { name: "进入 AgentBench" }).click();
    await page.route(`**/jobs/${materializationJob.id}`, async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ job: materializationJob }),
      });
    });
    await expect(
      page.getByRole("button", { name: "取消后台任务" }),
    ).toBeVisible();
    const materializationCancel = await request.post(
      `/api/projects/project_demo/jobs/${materializationJob.id}/cancel`,
      { headers: { origin: "http://web:3000", "x-csrf-token": csrfToken } },
    );
    expect(materializationCancel.status()).toBe(202);
  } finally {
    await materializationLock.query("ROLLBACK");
    materializationLock.release();
  }
  await page.unroute(`**/jobs/${materializationJob.id}`);
  await expect(jobPanel).toContainText("cancelled", { timeout: 30_000 });
  const materializationCandidate = await request.get(
    `/api/projects/project_demo/candidates/${materializationCandidateId}`,
  );
  expect((await materializationCandidate.json()).candidate).toMatchObject({
    status: "failed",
    validationReport: {
      errorCode: "job_cancelled",
      blockingPhase: "candidate_materialization",
    },
  });
  const materializationDraft = await request.get(
    `/api/projects/project_demo/drafts/${materialization.draftId}`,
  );
  expect((await materializationDraft.json()).draft.status).toBe("editing");

  const cancelled = await createReadyCandidate(request, csrfToken);
  const cancelledPublish = await request.post(
    `/api/projects/project_demo/candidates/${cancelled.candidateId}/publish`,
    {
      headers: {
        origin: "http://web:3000",
        "x-csrf-token": csrfToken,
      },
    },
  );
  expect(cancelledPublish.ok()).toBeTruthy();
  const cancelledJob = (await cancelledPublish.json()).job;
  await database.query(
    `UPDATE job SET status = 'queued', stage = 'queued', attempt = 0,
        lease_owner = NULL, lease_expires_at = NULL,
        next_run_at = now() + interval '1 hour'
     WHERE id = $1`,
    [cancelledJob.id],
  );
  await page.addInitScript((job) => {
    sessionStorage.setItem("agentbench-active-job", JSON.stringify(job));
  }, cancelledJob);
  await page.goto(`/workbench/${cancelled.draftId}`);
  await page.getByRole("button", { name: "进入 AgentBench" }).click();
  await expect(
    page.getByRole("button", { name: "取消后台任务" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "取消后台任务" }).click();
  await expect(jobPanel).toContainText("cancelled", { timeout: 30_000 });
  const candidateAfterCancel = await request.get(
    `/api/projects/project_demo/candidates/${cancelled.candidateId}`,
  );
  expect((await candidateAfterCancel.json()).candidate.status).toBe(
    "ready_to_publish",
  );
  const versions = await request.get(
    `/api/projects/project_demo/test-sets/${cancelled.testSetId}/versions`,
  );
  expect(versions.status()).toBe(200);
  expect(await versions.json()).toMatchObject({
    testSet: { id: cancelled.testSetId },
    versions: [],
    pagination: { total: 0, offset: 0 },
  });
});
