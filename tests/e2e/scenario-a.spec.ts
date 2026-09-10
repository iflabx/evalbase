import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

test("narrow viewport keeps the Phase 1A navigation available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await page.getByRole("button", { name: "打开主导航" }).click();
  const navigation = page.getByRole("navigation", { name: "主导航" });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByText("数据资产", { exact: true })).toBeVisible();
  await expect(navigation.getByText("测试集", { exact: true })).toBeVisible();
  await expect(navigation.getByText("交付记录", { exact: true })).toBeVisible();
  await expect(navigation.getByText(/Langfuse|计算|报告/)).toHaveCount(0);
});

test("Owner completes Scenario A through the UI and offline validator", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "agentbench-browser-"));
  try {
    await page.goto("/");
    await expect(page.getByText(/仅限非敏感数据/)).toBeVisible();
    await page.getByRole("button", { name: "进入 AgentBench" }).click();
    await page.getByLabel("资产文件").setInputFiles("tests/fixtures/owner.csv");
    await page.getByLabel("来源名称").fill("Browser synthetic fixture");
    await page.getByLabel("使用目的").fill("Scenario A browser evidence");
    const uploadResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/api/projects/project_demo/assets"),
    );
    await page.getByRole("button", { name: "保存并解析" }).click();
    const uploadResponse = await uploadResponsePromise;
    expect(uploadResponse.status()).toBe(201);
    await expect(page).toHaveURL(/\/assets\/[^/]+$/u);
    const uploadedAssetId = new URL(page.url()).pathname.split("/").pop();
    await expect(page.getByText("Can I get a refund?")).toBeVisible();
    await page
      .getByRole("button", { name: "创建 Working Draft 并附加此资产" })
      .click();
    await page.getByLabel("筛选字段").fill("category");
    await page.getByLabel("筛选值").fill("billing");
    await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
    await expect(page.getByLabel("未映射字段样例")).toBeVisible();
    await page.getByLabel("确认未映射字段仅保留在 Data Asset").check();
    await page.getByLabel("版本说明").fill("Scenario A synthetic version");
    await page.getByRole("button", { name: "确认并发布 v1" }).click();
    await expect(
      page.getByRole("heading", { name: "v1 · 默认版本" }),
    ).toBeVisible({ timeout: 30_000 });
    const publishedUrl = page.url();
    await expect(page.getByText("来源说明")).toBeVisible();
    await expect(
      page.getByText(/Browser synthetic fixture/).first(),
    ).toBeVisible();
    await expect(
      page.getByText("gold_required", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "下载原始资产" }),
    ).toBeVisible();
    await expect(page.getByText(/仅限非敏感数据/u).first()).toBeVisible();
    await page.goto(`/assets/${uploadedAssetId}`);
    await page.getByRole("button", { name: "进入 AgentBench" }).click();
    await expect(
      page.getByRole("heading", { name: "数据资产详情" }),
    ).toBeVisible();
    await expect(
      page.getByRole("list", { name: "来源修订历史" }),
    ).toContainText("Browser synthetic fixture", { timeout: 30_000 });

    await page.goto(publishedUrl);
    await page.getByRole("button", { name: "进入 AgentBench" }).click();
    await expect(
      page.getByRole("heading", { name: "测试集详情" }),
    ).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page
      .getByRole("link", { name: "下载 Standard Version Package" })
      .click();
    const download = await downloadPromise;
    const packagePath = join(directory, "standard.zip");
    await download.saveAs(packagePath);
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "src/validator/cli.ts",
        packagePath,
        "--json",
      ],
      { env: {} },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      valid: true,
      package_type: "standard",
      verification_level: "standard",
    });

    await page.goto(`/assets/${uploadedAssetId}`);
    await page.getByRole("button", { name: "进入 AgentBench" }).click();
    await expect(
      page.getByRole("heading", { name: "数据资产详情" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "归档资产" }).click();
    await expect(
      page.locator("#data-assets").getByText("archived", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "尝试普通删除" }).click();
    await expect(page.getByText(/普通删除被阻断.*受控删除流程/)).toBeVisible();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
