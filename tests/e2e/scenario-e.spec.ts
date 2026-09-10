import { expect, test } from "@playwright/test";

test("Owner explicitly rolls the default back and archives a newer version", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "进入 AgentBench" }).click();
  await page.getByLabel("资产文件").setInputFiles({
    name: "scenario-e-v1.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "question,answer,category\nfirst question,first answer,billing\n",
    ),
  });
  await page.getByLabel("来源名称").fill("Scenario E synthetic CSV");
  await page.getByLabel("使用目的").fill("Verify explicit default rollback");
  await page.getByRole("button", { name: "保存并解析" }).click();
  await expect(page.getByText("first question")).toBeVisible();
  await page
    .getByRole("button", { name: "创建 Working Draft 并附加此资产" })
    .click();
  await page.getByLabel("筛选字段").fill("category");
  await page.getByLabel("筛选值").fill("billing");
  await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
  await expect(page.getByLabel("未映射字段样例")).toBeVisible();
  await page.getByLabel("确认未映射字段仅保留在 Data Asset").check();
  await page.getByLabel("版本说明").fill("Scenario E v1");
  const v1Response = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      /\/test-sets\/[^/]+\/versions\/[^/]+$/u.test(response.url()),
  );
  await page.getByRole("button", { name: "确认并发布 v1" }).click();
  const v1Body = await (await v1Response).json();
  expect(v1Body.testSet.defaultVersionId).toBe(v1Body.version.id);
  await expect(
    page.getByRole("heading", { name: "v1 · 默认版本" }),
  ).toBeVisible({ timeout: 30_000 });

  async function addSource(label: string, prompt: string) {
    await page.getByRole("link", { name: "数据资产", exact: true }).click();
    await expect(page).toHaveURL(/\/assets$/u);
    await page.getByLabel("资产文件").setInputFiles({
      name: `scenario-e-${label}.jsonl`,
      mimeType: "application/x-ndjson",
      buffer: Buffer.from(
        `{"prompt":"${prompt}","result":"allowed","category":"billing"}\n`,
      ),
    });
    await page.getByLabel("来源名称").fill(`Scenario E ${label}`);
    await page.getByLabel("使用目的").fill(`Add ${label} to derived version`);
    await page.getByRole("button", { name: "保存并解析" }).click();
    await expect(page.getByText(prompt)).toBeVisible();
    await page.getByRole("button", { name: "追加此资产到当前草稿" }).click();
    await expect(page).toHaveURL(/\/workbench\/[^/]+$/u);
    await page.getByLabel("映射 JSON").fill(
      JSON.stringify({
        input: { object: { message: { source: "/prompt" } } },
        expectedOutput: { source: "/result" },
        metadata: { object: {} },
      }),
    );
    await expect(
      page.getByText(/附件 1\/5 已保存，并使用独立 mapping/),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "保存所选 Source 独立 mapping" })
      .click();
    await expect(
      page.getByText("所选 Source 的独立 mapping 已保存。"),
    ).toBeVisible();
    await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
    await expect(page.getByLabel("未映射字段样例")).toBeVisible();
    await page.getByLabel("确认未映射字段仅保留在 Data Asset").check();
  }

  async function publishDerived(parentNumber: number, label: string) {
    await page
      .getByRole("button", {
        name: `从 v${parentNumber} 创建 v${parentNumber + 1} 草稿`,
      })
      .click();
    await expect(page).toHaveURL(/\/workbench\/[^/]+$/u);
    await addSource(label, `${label} synthetic question`);
    await page.getByLabel("版本说明").fill(`Scenario E ${label}`);
    const response = page.waitForResponse(
      (item) =>
        item.request().method() === "GET" &&
        /\/test-sets\/[^/]+\/versions\/[^/]+$/u.test(item.url()),
    );
    await page
      .getByRole("button", { name: `确认并发布 v${parentNumber + 1}` })
      .click();
    return await (await response).json();
  }

  const v2Body = await publishDerived(1, "v2");
  await expect(page.getByRole("heading", { name: /^v2/u })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "v2", exact: true }).click();
  await page.getByLabel("生命周期原因（默认切换必填）").fill("Promote v2");
  await page.getByRole("button", { name: "设为默认" }).click();
  await expect(
    page.getByText("v2 已显式设为默认版本；较新版本未被改写。"),
  ).toBeVisible();
  const v3Body = await publishDerived(2, "v3");
  await expect(page.getByRole("heading", { name: /^v3/u })).toBeVisible({
    timeout: 30_000,
  });
  expect(v3Body.testSet.defaultVersionId).toBe(v2Body.version.id);

  await page.getByRole("button", { name: "v3", exact: true }).click();
  await page.getByLabel("生命周期原因（默认切换必填）").fill("Promote v3");
  await page.getByRole("button", { name: "设为默认" }).click();
  await expect(
    page.getByText("v3 已显式设为默认版本；较新版本未被改写。"),
  ).toBeVisible();

  await page.getByRole("button", { name: "v2", exact: true }).click();
  await page
    .getByLabel("生命周期原因（默认切换必填）")
    .fill("Roll back after v3 review");
  await page.getByRole("button", { name: "设为默认" }).click();
  await expect(
    page.getByText("v2 已显式设为默认版本；较新版本未被改写。"),
  ).toBeVisible();

  const v3AfterRollback = await page.evaluate(async (version) => {
    const response = await fetch(
      `/api/projects/project_demo/test-sets/${version.testSet.id}/versions/${version.version.id}`,
    );
    return response.json();
  }, v3Body);
  expect(v3AfterRollback.version).toMatchObject({
    payloadHash: v3Body.version.payloadHash,
    manifestHash: v3Body.version.manifestHash,
    status: "published",
  });
  expect(v3AfterRollback.testSet.defaultVersionId).toBe(v2Body.version.id);

  await page.getByRole("button", { name: "v3", exact: true }).click();
  await page
    .getByLabel("生命周期原因（默认切换必填）")
    .fill("Retire reviewed v3");
  await page.getByRole("button", { name: "归档此版本" }).click();
  await expect(
    page.getByText("v3 已归档；历史内容和哈希保持可读取。"),
  ).toBeVisible();
  const v3AfterArchive = await page.evaluate(async (version) => {
    const response = await fetch(
      `/api/projects/project_demo/test-sets/${version.testSet.id}/versions/${version.version.id}`,
    );
    return response.json();
  }, v3Body);
  expect(v3AfterArchive.version).toMatchObject({
    status: "archived",
    payloadHash: v3Body.version.payloadHash,
  });
  expect(v3AfterArchive.testSet.defaultVersionId).toBe(v2Body.version.id);
});
