import { expect, test } from "@playwright/test";

test("Owner uses structured lists, fixed-version query, and timezone audit", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sourceName = `Ticket 13 browser fixture ${Date.now()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "进入 AgentBench" }).click();
  await page.getByLabel("资产文件").setInputFiles("tests/fixtures/owner.csv");
  await page.getByLabel("来源名称").fill(sourceName);
  await page
    .getByLabel("使用目的")
    .fill("Ticket 13 structured browser evidence");
  await page.getByRole("button", { name: "保存并解析" }).click();
  await expect(page.getByText("Can I get a refund?")).toBeVisible();
  await page
    .getByRole("button", { name: "创建 Working Draft 并附加此资产" })
    .click();
  await page.getByLabel("筛选字段").fill("category");
  await page.getByLabel("筛选值").fill("billing");
  await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
  await page.getByLabel("确认未映射字段仅保留在 Data Asset").check();
  await page.getByLabel("版本说明").fill("Ticket 13 structured version");
  await page.getByRole("button", { name: "确认并发布 v1" }).click();
  await expect(
    page.getByRole("heading", { name: "v1 · 默认版本" }),
  ).toBeVisible({ timeout: 30_000 });

  const versionDetailUrl = page.url();
  await page.getByRole("link", { name: "数据资产", exact: true }).click();
  await expect(page).toHaveURL(/\/assets$/u);
  await page.getByLabel("资产名称精确筛选").fill(sourceName);
  await page.getByRole("button", { name: "应用结构化筛选" }).click();
  await expect(
    page.getByRole("table", { name: "Data Asset 结构化列表结果" }),
  ).toContainText(sourceName);
  await expect(page.getByRole("button", { name: "资产上一页" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "资产下一页" })).toBeVisible();

  await page.getByRole("link", { name: "测试集", exact: true }).click();
  await expect(page).toHaveURL(/\/test-sets$/u);
  const summaries = page.getByRole("table", {
    name: "Test Set 摘要列表结果",
  });
  await expect(summaries.first()).toContainText("available");
  await expect(summaries.first()).toContainText("默认 v1 · published");
  await expect(summaries.first()).toContainText("generated");
  await expect(
    page.getByRole("button", { name: "测试集上一页" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "测试集下一页" }),
  ).toBeVisible();

  await page.goto(versionDetailUrl);
  await page.getByRole("button", { name: "进入 AgentBench" }).click();
  await expect(page).toHaveURL(/\/test-sets\/[^/]+\?version=/u);
  await expect(page.getByRole("heading", { name: /^v1/u })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "按结构化条件查询" }).click();
  const caseResults = page.getByRole("list", {
    name: "固定版本用例查询结果",
  });
  await expect(caseResults).toContainText(/case_/);
  await page.getByLabel("case_id 精确查询").fill("");
  await page.getByLabel("业务元数据键精确查询").fill("source");
  await page.getByLabel("业务元数据值精确查询").fill("absent-ticket-13");
  await page.getByRole("button", { name: "按结构化条件查询" }).click();
  await expect(
    page.getByText(
      "当前固定版本没有匹配用例；请核对 case_id 或顶层业务元数据键值。",
    ),
  ).toBeVisible();

  await page.getByLabel("业务元数据值精确查询").fill("");
  await page.getByRole("button", { name: "按结构化条件查询" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Metadata key 和 value 必须成对填写",
  );

  await page.getByLabel("审计显示时区").selectOption("UTC");
  await page
    .getByLabel("审计动作筛选")
    .selectOption("test_set_version_published");
  await page.getByRole("button", { name: "应用审计结构化筛选" }).click();
  const auditTable = page.getByRole("table", { name: "项目 Audit Event 结果" });
  await expect(auditTable).toContainText("owner");
  await expect(auditTable).toContainText("test_set_version_published");
  await expect(auditTable).toContainText("succeeded");
  await expect(page.getByRole("button", { name: "审计上一页" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "审计下一页" })).toBeVisible();
  await expect(
    page.getByLabel("审计动作筛选").locator("option", {
      hasText: "job_retry_scheduled",
    }),
  ).toHaveCount(1);
  const utcDisplay = await auditTable.locator("time").first().textContent();
  const utcFact = await auditTable.locator("small").first().textContent();
  await page.getByLabel("审计显示时区").selectOption("Asia/Shanghai");
  expect(await auditTable.locator("time").first().textContent()).not.toBe(
    utcDisplay,
  );
  expect(await auditTable.locator("small").first().textContent()).toBe(utcFact);
  expect(utcFact).toMatch(/^UTC 20\d\d-\d\d-\d\dT/);

  const searchable = page.getByRole("textbox", {
    name: /搜索|全文|语义/,
  });
  await expect(searchable).toHaveCount(0);
  const pageContent = await page.content();
  expect(pageContent).not.toContain("全文搜索");
  expect(pageContent).not.toContain("语义搜索");
  expect(pageContent).not.toContain("即将可用");
});
