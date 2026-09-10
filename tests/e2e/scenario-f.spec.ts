import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

test("Scenario F stops at locally validated Langfuse CSV and user attestation", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "agentbench-scenario-f-"));
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "进入 AgentBench" }).click();
    await page.getByLabel("资产文件").setInputFiles({
      name: "scenario-f.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "question,answer,category\nHow do refunds work?,Use the published policy,billing\n",
      ),
    });
    await page.getByLabel("来源名称").fill("Scenario F synthetic CSV");
    await page.getByLabel("使用目的").fill("Local Langfuse CSV delivery");
    await page.getByRole("button", { name: "保存并解析" }).click();
    await expect(page.getByText("How do refunds work?")).toBeVisible();
    await page
      .getByRole("button", { name: "创建 Working Draft 并附加此资产" })
      .click();
    await page.getByLabel("筛选字段").fill("category");
    await page.getByLabel("筛选值").fill("billing");
    await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
    await page.getByLabel("确认未映射字段仅保留在 Data Asset").check();
    await page.getByLabel("版本说明").fill("Scenario F local delivery");
    await page.getByRole("button", { name: "确认并发布 v1" }).click();
    await expect(
      page.getByRole("heading", { name: "v1 · 默认版本" }),
    ).toBeVisible({ timeout: 30_000 });

    await page
      .getByRole("button", { name: "生成 Full Provenance Package" })
      .click();
    await expect(
      page.getByText("Full Provenance Package 已生成；验证级别：full。"),
    ).toBeVisible({ timeout: 30_000 });
    const fullDownload = page.waitForEvent("download");
    await page
      .getByRole("link", { name: "下载 Full Provenance Package" })
      .click();
    const fullPackagePath = join(directory, "full.zip");
    await (await fullDownload).saveAs(fullPackagePath);
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "src/validator/cli.ts",
        fullPackagePath,
        "--json",
      ],
      { env: {} },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      valid: true,
      package_type: "full_provenance",
      verification_level: "full",
    });

    await page.getByRole("button", { name: "生成 Langfuse CSV" }).click();
    await expect(
      page.getByText("Langfuse CSV 已生成并通过本地契约校验。"),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("list", { name: "Langfuse 人工导入边界" }),
    ).toContainText("未获取或验证远端 Langfuse Schema");
    await expect(
      page.getByRole("list", { name: "Langfuse 人工导入边界" }),
    ).toContainText("未设置稳定远端 item ID");
    await expect(
      page.getByRole("list", { name: "Langfuse 人工导入边界" }),
    ).toContainText("重复人工上传不幂等");
    await expect(page.getByLabel("Langfuse CSV 预览")).toContainText(
      "input,expected_output,metadata",
    );
    await expect(page.getByText("额外或未映射列：无")).toBeVisible();
    const csvDownload = page.waitForEvent("download");
    await page.getByRole("link", { name: "下载 Langfuse CSV" }).click();
    await (await csvDownload).saveAs(join(directory, "langfuse.csv"));

    await page
      .getByRole("button", { name: "确认已人工导入（仅用户声明）" })
      .click();
    await expect(
      page.getByText(
        "用户已确认导入；这是本地用户声明，未经 Langfuse 远端验证。",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("list", { name: "版本交付验证证据" }),
    ).toContainText("user_confirmed_imported");
    await expect(page.getByText("Langfuse 远端验证通过")).toHaveCount(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
