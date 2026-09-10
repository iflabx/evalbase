import { expect, test } from "@playwright/test";

test("Owner registers external Agent augmentation and publishes honest asset-level v2", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "进入 AgentBench" }).click();

  await page.getByLabel("资产文件").setInputFiles("tests/fixtures/owner.csv");
  await page.getByLabel("来源名称").fill("Scenario D v1 source");
  await page.getByLabel("使用目的").fill("Scenario D external Agent fixture");
  await page.getByRole("button", { name: "保存并解析" }).click();
  await expect(page.getByText("Can I get a refund?")).toBeVisible();
  await page
    .getByRole("button", { name: "创建 Working Draft 并附加此资产" })
    .click();
  await page.getByLabel("筛选字段").fill("category");
  await page.getByLabel("筛选值").fill("billing");
  await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
  await expect(page.getByLabel("未映射字段样例")).toBeVisible();
  await page.getByLabel("确认未映射字段仅保留在 Data Asset").check();
  await page.getByLabel("版本说明").fill("Scenario D base version");
  const v1ResponsePromise = page.waitForResponse((response) =>
    /\/test-sets\/[^/]+\/versions\/[^/]+$/u.test(response.url()),
  );
  await page.getByRole("button", { name: "确认并发布 v1" }).click();
  const v1Body = await (await v1ResponsePromise).json();
  expect(v1Body.version.number).toBe(1);
  await expect(
    page.getByRole("heading", { name: "v1 · 默认版本" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "从 v1 创建 v2 草稿" }).click();
  await expect(page).toHaveURL(/\/workbench\/[^/]+$/u);

  await page.getByRole("link", { name: "数据资产", exact: true }).click();
  await expect(page).toHaveURL(/\/assets$/u);

  await page.getByLabel("资产文件").setInputFiles({
    name: "scenario-d-agent-output.csv",
    mimeType: "text/csv; charset=utf-8",
    buffer: Buffer.from(
      [
        "question,answer,category",
        "Explain refund delays in detail,Refunds may wait for policy review,billing",
      ].join("\n"),
    ),
  });
  await page.getByLabel("来源名称").fill("Scenario D Agent output");
  await page
    .getByLabel("使用目的")
    .fill("Register an external synthetic Agent result");
  await page.getByRole("button", { name: "保存并解析" }).click();
  await expect(page.getByText("Explain refund delays in detail")).toBeVisible();

  await page.getByLabel("处理类型").selectOption("agent_augmentation");
  await page.getByLabel("血缘粒度").selectOption("asset_level");
  await page.getByLabel("处理目的").fill("Expand refund questions");
  await page.getByLabel("输入版本 ID").fill(v1Body.version.id);
  await page
    .getByLabel("输入版本 Manifest SHA-256")
    .fill(v1Body.version.manifestHash);
  const runResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/projects/project_demo/transformation-runs"),
  );
  await page.getByRole("button", { name: "登记 Transformation Run" }).click();
  const runResponse = await runResponsePromise;
  expect(runResponse.status()).toBe(201);
  const runEvidence = page.getByLabel("Transformation Run 证据");
  await expect(runEvidence).toContainText("agent_augmentation");
  await expect(runEvidence).toContainText("asset_level");
  await expect(runEvidence).toContainText("synthetic-model");
  await expect(runEvidence).toContainText("browser-scenario-d-v1");
  await expect(runEvidence).toContainText("category=billing");

  await page.getByRole("button", { name: "追加此资产到当前草稿" }).click();
  await expect(
    page.getByText(/附件 1\/5 已保存，并使用独立 mapping/),
  ).toBeVisible();
  await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
  await expect(page.getByLabel("未映射字段样例")).toBeVisible();
  await page.getByLabel("确认未映射字段仅保留在 Data Asset").check();
  await page.getByLabel("版本说明").fill("Scenario D Agent asset-level v2");
  const v2ResponsePromise = page.waitForResponse((response) =>
    /\/test-sets\/[^/]+\/versions\/[^/]+$/u.test(response.url()),
  );
  await page.getByRole("button", { name: "确认并发布 v2" }).click();
  const v2Body = await (await v2ResponsePromise).json();
  expect(v2Body.version).toMatchObject({
    number: 2,
    itemCount: 3,
    lineageLevels: { recordLevel: 2, assetLevel: 1 },
  });
  await expect(page.getByRole("heading", { name: /^v2/u })).toBeVisible();
  await expect(page.getByText(/asset_level 1/)).toBeVisible();

  const assetCase = v2Body.version.lineage.find(
    (item: any) => item.level === "asset_level",
  );
  const caseDetail = await page.evaluate(
    async (subject: {
      testSetId: string;
      versionId: string;
      caseId: string;
    }) => {
      const response = await fetch(
        `/api/projects/project_demo/test-sets/${subject.testSetId}/versions/${subject.versionId}/cases/${subject.caseId}`,
      );
      return response.json();
    },
    {
      testSetId: v2Body.testSet.id,
      versionId: v2Body.version.id,
      caseId: assetCase.caseId,
    },
  );
  await page
    .getByLabel("追踪 Case Revision ID")
    .fill(caseDetail.testCase.revisionId);
  await page.getByRole("button", { name: "向上追踪血缘" }).click();
  const trace = page.getByLabel("血缘图");
  await expect(trace).toContainText("最多 3 跳");
  await expect(trace).toContainText("transformation_run");
  await expect(trace).toContainText("test_set_version");
  await expect(trace).toContainText("source_record");
  await expect(trace).toContainText("asset_level");
});
