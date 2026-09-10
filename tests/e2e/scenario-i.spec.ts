import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

test("Owner completes the controlled-deletion governance simulation", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText(/仅限非敏感数据/)).toBeVisible();
  await page.getByRole("button", { name: "进入 AgentBench" }).click();
  await page.getByLabel("资产文件").setInputFiles({
    name: "owner.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      `question,answer\nCan I get a refund?,Synthetic ${randomUUID()}\n`,
    ),
  });
  await page
    .getByLabel("来源名称")
    .fill("Scenario I synthetic deletion fixture");
  await page
    .getByLabel("使用目的")
    .fill("Scenario I controlled deletion evidence");
  await page.getByRole("button", { name: "保存并解析" }).click();
  await expect(page.getByText("Can I get a refund?")).toBeVisible();

  await page.getByRole("button", { name: "预览受控删除影响" }).click();
  const governance = page.getByRole("region", { name: "受控删除治理模拟" });
  await expect(governance).toBeVisible();
  await expect(governance).toContainText("非生产治理流程模拟");
  await expect(governance).toContainText("Preview hash:");
  await governance
    .getByLabel("理由说明（不写法律或合规结论）")
    .fill("Scenario I synthetic cleanup");
  await expect(
    governance.getByRole("button", {
      name: "同一 Project Owner 二次确认并执行",
    }),
  ).toBeEnabled();

  page.once("dialog", (dialog) => dialog.accept());
  await governance
    .getByRole("button", { name: "同一 Project Owner 二次确认并执行" })
    .click();
  await expect(governance).toContainText("状态：completed", {
    timeout: 30_000,
  });
  await expect(page.getByLabel("受控删除墓碑")).toContainText("data_asset");
  await expect(governance).toContainText("非生产治理流程模拟");
});
