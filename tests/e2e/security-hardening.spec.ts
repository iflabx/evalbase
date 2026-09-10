import { expect, test } from "@playwright/test";

const origin = process.env.E2E_ORIGIN ?? "http://127.0.0.1:3000";

test("renders untrusted asset and record payloads as text without execution", async ({
  page,
}) => {
  const sourcePayload =
    '<img data-agentbench-security-canary src=x onerror="window.__agentbenchCanaryExecuted=true"> [synthetic](javascript:alert("unsafe"))';
  const recordPayload =
    "<script>window.__agentbenchRecordCanaryExecuted=true</script>";
  let dialogMessage = "";
  page.on("dialog", (dialog) => {
    dialogMessage = dialog.message();
    return dialog.dismiss();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "进入 AgentBench" }).click();
  await page.getByLabel("资产文件").setInputFiles({
    name: `${sourcePayload}.exe`,
    mimeType: "application/octet-stream",
    buffer: Buffer.from("unsafe executable content"),
  });
  await page.getByLabel("来源名称").fill(sourcePayload);
  await page.getByRole("button", { name: "保存并解析" }).click();
  await expect(page.getByRole("alert", { name: "操作错误" })).toHaveText(
    /unsupported_asset_format/u,
  );
  await expect(page.getByRole("alert", { name: "操作错误" })).not.toContainText(
    sourcePayload,
  );

  await page.getByLabel("资产文件").setInputFiles({
    name: `${sourcePayload}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(
      `question,answer,category\n${recordPayload},safe answer,billing\n`,
    ),
  });
  await page.getByLabel("来源名称").fill(sourcePayload);
  await page.getByRole("button", { name: "保存并解析" }).click();

  await expect(page.getByText(recordPayload).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(sourcePayload).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByText(`${sourcePayload}.csv`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("a[href='javascript:alert(\"unsafe\")']"),
  ).toHaveCount(0);
  const session = await page.request.get("/api/session");
  const csrf = ((await session.json()) as { csrfToken: string }).csrfToken;
  const draftCreation = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/projects/project_demo/test-sets"),
  );
  await page
    .getByRole("button", { name: "创建 Working Draft 并附加此资产" })
    .click();
  const draftCreated = await draftCreation;
  expect(draftCreated.status()).toBe(201);
  const draftReference = (
    (await draftCreated.json()) as {
      draft: { id: string };
    }
  ).draft;
  const draftId = draftReference.id;
  const draftResponse = await page.request.get(
    `/api/projects/project_demo/drafts/${draftId}`,
  );
  expect(draftResponse.ok()).toBeTruthy();
  const draft = (
    (await draftResponse.json()) as {
      draft: {
        leaseToken: string;
        revision: number;
      };
    }
  ).draft;
  const mapping = {
    input: { object: { message: { source: "/question" } } },
    expectedOutput: { source: "/answer" },
    metadata: { object: { injection: { source: "/question" } } },
  };
  const savedRecipe = await page.request.post(
    `/api/projects/project_demo/drafts/${draftId}/recipe`,
    {
      headers: {
        origin,
        "x-csrf-token": csrf,
      },
      data: {
        leaseToken: draft.leaseToken,
        expectedRevision: draft.revision,
        versionDescription: "Security metadata injection synthetic v1",
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
  expect(savedRecipe.ok()).toBeTruthy();
  const proposalResponse = await page.request.get(
    `/api/projects/project_demo/drafts/${draftId}/mapping/schema-suggestion`,
  );
  expect(proposalResponse.ok()).toBeTruthy();
  const proposal = (
    (await proposalResponse.json()) as {
      proposalId: string;
    }
  ).proposalId;
  const configured = await page.request.put(
    `/api/projects/project_demo/drafts/${draftId}`,
    {
      headers: {
        origin,
        "x-csrf-token": csrf,
      },
      data: {
        leaseToken: draft.leaseToken,
        expectedRevision: (
          (await savedRecipe.json()) as { draft: { revision: number } }
        ).draft.revision,
        proposalId: proposal,
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
  expect(configured.ok()).toBeTruthy();
  await page.reload();
  await page.getByRole("button", { name: "进入 AgentBench" }).click();
  await expect(page.getByText("当前身份：owner")).toBeVisible();

  await page.getByLabel("筛选字段").fill("category");
  await page.getByLabel("筛选值").fill("billing");
  await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
  await expect(page.getByLabel("未映射字段样例")).toBeVisible();
  await expect(page.getByLabel("映射预览").first()).toContainText(
    recordPayload,
  );
  await expect(page.locator("[data-agentbench-security-canary]")).toHaveCount(
    0,
  );
  await expect(
    page.locator("script", { hasText: "__agentbenchRecordCanaryExecuted" }),
  ).toHaveCount(0);
  expect(dialogMessage).toBe("");
  const execution = await page.evaluate(() => ({
    image: Boolean((window as any).__agentbenchCanaryExecuted),
    script: Boolean((window as any).__agentbenchRecordCanaryExecuted),
  }));
  expect(execution).toEqual({ image: false, script: false });

  await page.getByLabel("确认未映射字段仅保留在 Data Asset").check();
  await page.getByLabel("版本说明").fill("Security injection synthetic v1");
  await page.getByRole("button", { name: "确认并发布 v1" }).click();
  await expect(
    page.getByRole("heading", { name: "v1 · 默认版本" }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "按结构化条件查询" }).click();
  await expect(
    page.getByRole("list", { name: "固定版本用例查询结果" }),
  ).toContainText(recordPayload);
  const auditTable = page.getByRole("table", { name: "项目 Audit Event 结果" });
  await expect(auditTable).toContainText("asset_upload_completed");
  await expect(auditTable).not.toContainText(sourcePayload);
  await expect(auditTable).not.toContainText(recordPayload);
  await expect(page.locator("[data-agentbench-security-canary]")).toHaveCount(
    0,
  );
});
