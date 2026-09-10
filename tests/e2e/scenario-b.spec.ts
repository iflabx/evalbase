import { expect, test } from "@playwright/test";

test("Owner locates and explicitly excludes three JSONL failures", async ({
  page,
}) => {
  const badLines = new Set([3, 5_000, 9_999]);
  const source = Buffer.from(
    Array.from({ length: 10_000 }, (_, index) =>
      badLines.has(index + 1)
        ? '{"broken":}'
        : index === 0
          ? '{"custom":{"nested":true}}'
          : index === 1
            ? "null"
            : `{"question":"q${index + 1}","answer":"a${index + 1}"}`,
    ).join("\n"),
  );

  await page.goto("/");
  await page.getByRole("button", { name: "进入 AgentBench" }).click();
  await page.getByLabel("资产文件").setInputFiles({
    name: "scenario-b.jsonl",
    mimeType: "application/x-ndjson",
    buffer: source,
  });
  await page.getByLabel("来源名称").fill("Scenario B synthetic JSONL");
  await page.getByLabel("使用目的").fill("Locate three malformed lines");
  await page.getByRole("button", { name: "保存并解析" }).click();

  await expect(
    page.getByText("10,000 总计 · 9,997 成功 · 3 失败"),
  ).toBeVisible();
  await expect(page.getByText("物理行 3", { exact: true })).toBeVisible();
  await expect(page.getByText("物理行 5000", { exact: true })).toBeVisible();
  await expect(page.getByText("物理行 9999", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/实际阻断阶段：Parsed View/).first(),
  ).toBeVisible();
  await expect(page.getByText(/重试方式：修正该物理行/).first()).toBeVisible();
  await expect(page.locator("tbody pre").nth(0)).toContainText('"custom"');
  await expect(page.locator("tbody pre").nth(1)).toHaveText("null");

  await page.getByRole("button", { name: "查看第 1 条记录的原始位置" }).click();
  const originalLocation = page.getByRole("complementary", {
    name: "原始位置",
  });
  await expect(originalLocation).toContainText("Source Record 1");
  await expect(originalLocation).toContainText("物理行 1");
  await expect(page.getByRole("link", { name: "下载原始资产" })).toBeVisible();

  await page.getByRole("button", { name: "排除 3 条可定位错误" }).click();
  await expect(page.getByText("9,997 条可加入草稿")).toBeVisible();
});

test("does not claim draft eligibility after excluding only one error page", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "进入 AgentBench" }).click();
  await page.getByLabel("资产文件").setInputFiles({
    name: "many-errors.jsonl",
    mimeType: "application/x-ndjson",
    buffer: Buffer.from(
      Array.from({ length: 101 }, () => '{"broken":}').join("\n"),
    ),
  });
  await page.getByLabel("来源名称").fill("Synthetic many-error JSONL");
  await page
    .getByLabel("使用目的")
    .fill("Verify partial exclusion remains blocked");
  await page.getByRole("button", { name: "保存并解析" }).click();

  await expect(page.getByText("101 总计 · 0 成功 · 101 失败")).toBeVisible();
  await page.getByRole("button", { name: "排除 100 条可定位错误" }).click();
  await expect(
    page.getByText("已排除 100 条；仍有 1 条错误未排除"),
  ).toBeVisible();
  await expect(page.getByText(/可加入草稿/)).toHaveCount(0);
});
