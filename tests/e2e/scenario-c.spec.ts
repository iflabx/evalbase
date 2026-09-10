import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

test("Owner derives v2 from v1 with a second source and manual changes", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "agentbench-scenario-c-"));
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "进入 AgentBench" }).click();
    await page.getByLabel("资产文件").setInputFiles({
      name: "scenario-c-v1.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        [
          "question,answer,category",
          ...Array.from(
            { length: 7 },
            (_, index) =>
              `billing question ${index + 1},billing answer ${index + 1},billing`,
          ),
        ].join("\n") + "\n",
      ),
    });
    await page.getByLabel("来源名称").fill("Scenario C v1 synthetic CSV");
    await page.getByLabel("使用目的").fill("Derive v2 from v1");
    await page.getByRole("button", { name: "保存并解析" }).click();
    await expect(page.getByText("billing question 7")).toBeVisible();
    await page
      .getByRole("button", { name: "创建 Working Draft 并附加此资产" })
      .click();
    await page.getByLabel("筛选字段").fill("category");
    await page.getByLabel("筛选值").fill("billing");
    await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
    await expect(page.getByLabel("未映射字段样例")).toBeVisible();
    await page.getByLabel("确认未映射字段仅保留在 Data Asset").check();
    await page
      .getByLabel("版本说明")
      .fill("Scenario C initial synthetic version");
    const initialVersionResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        /\/test-sets\/[^/]+\/versions\/[^/]+$/u.test(response.url()),
    );
    await page.getByRole("button", { name: "确认并发布 v1" }).click();
    const initialVersionBody = await (await initialVersionResponse).json();
    await expect(
      page.getByRole("heading", { name: "v1 · 默认版本" }),
    ).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "从 v1 创建 v2 草稿" }).click();
    await expect(page).toHaveURL(/\/workbench\/[^/]+$/u);

    await page.getByRole("link", { name: "数据资产", exact: true }).click();
    await expect(page).toHaveURL(/\/assets$/u);

    await page.getByLabel("资产文件").setInputFiles({
      name: "scenario-c-second.jsonl",
      mimeType: "application/x-ndjson",
      buffer: Buffer.from(
        [
          '{"prompt":"billing question 1","result":"billing answer 1","category":"billing"}',
        ].join("\n") + "\n",
      ),
    });
    await page.getByLabel("来源名称").fill("Scenario C second JSONL");
    await page.getByLabel("使用目的").fill("Map a heterogeneous second source");
    await page.getByRole("button", { name: "保存并解析" }).click();
    await expect(page.getByText("billing question 1")).toBeVisible();
    await page.getByRole("button", { name: "追加此资产到当前草稿" }).click();
    await expect(page).toHaveURL(/\/workbench\/[^/]+$/u);
    await page
      .getByLabel("版本说明")
      .fill("Scenario C multi-source v2 synthetic changes");
    await page.getByLabel("映射 JSON").fill(
      JSON.stringify({
        input: { object: { message: { source: "/prompt" } } },
        expectedOutput: { source: "/result" },
        metadata: { object: {} },
      }),
    );
    await page
      .getByRole("button", { name: "保存所选 Source 独立 mapping" })
      .click();
    await expect(
      page.getByText("所选 Source 的独立 mapping 已保存。"),
    ).toBeVisible();
    await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
    await expect(page.getByLabel("未映射字段样例")).toBeVisible();
    await page.getByLabel("确认未映射字段仅保留在 Data Asset").check();

    const duplicateMaterialized = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/drafts\/[^/]+\/candidates$/u.test(response.url()),
    );
    await page.getByRole("button", { name: "确认并发布 v2" }).click();
    const duplicateCandidateId = (await (await duplicateMaterialized).json())
      .candidate.id;
    await expect(page.getByText(/必须逐条明确 include\/exclude/)).toBeVisible({
      timeout: 30_000,
    });
    const duplicateReport = await page.evaluate(async (candidateId) => {
      const response = await fetch(
        `/api/projects/project_demo/candidates/${candidateId}`,
      );
      return response.json();
    }, duplicateCandidateId);
    const baseCaseIds = new Set(
      initialVersionBody.version.lineage.map((item: any) => item.caseId),
    );
    const duplicateSourceCaseId =
      duplicateReport.candidate.validationReport.duplicateCaseIds.find(
        (caseId: string) => !baseCaseIds.has(caseId),
      );
    expect(duplicateSourceCaseId).toMatch(/^case_/);
    await page.getByLabel("重复用例 case_id").fill(duplicateSourceCaseId);
    await page.getByLabel("重复取舍").selectOption("exclude");
    await page.getByRole("button", { name: "保存重复取舍" }).click();
    await expect(
      page.getByText(/重复用例 case_.*已明确 exclude/),
    ).toBeVisible();

    const parentCaseSelect = page.getByLabel("选择父版本用例");
    for (const index of [1, 2]) {
      await parentCaseSelect.selectOption({ index });
      await page.getByRole("button", { name: "删除所选父用例" }).click();
      await expect(page.getByText(/将在 v2 中删除/)).toBeVisible();
    }
    for (const index of [0, 3, 4, 5, 6]) {
      await parentCaseSelect.selectOption({ index });
      await page
        .getByLabel("人工 input JSON")
        .fill(JSON.stringify({ message: `corrected question ${index}` }));
      await page
        .getByLabel("人工 expected output")
        .fill(`corrected answer ${index}`);
      await page
        .getByLabel("人工理由（新建和修改必填）")
        .fill(`Correct synthetic answer ${index}`);
      await page.getByRole("button", { name: "修改所选父用例" }).click();
      await expect(page.getByText(/已创建新修订/)).toBeVisible();
    }
    for (let index = 1; index <= 10; index += 1) {
      await page
        .getByLabel("人工 input JSON")
        .fill(JSON.stringify({ message: `manual scenario case ${index}` }));
      await page
        .getByLabel("人工 expected output")
        .fill(`manual result ${index}`);
      await page
        .getByLabel("人工理由（新建和修改必填）")
        .fill(`Add synthetic manual case ${index}`);
      await page.getByRole("button", { name: "新建人工用例" }).click();
      await expect(page.getByText(/manual creation event/)).toBeVisible();
    }
    await expect(page.getByText("当前变更：+10 / -2 / ~5")).toBeVisible();
    await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
    await expect(page.getByLabel("未映射字段样例")).toBeVisible();
    await page.getByLabel("确认未映射字段仅保留在 Data Asset").check();

    const finalVersionResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        /\/test-sets\/[^/]+\/versions\/[^/]+$/u.test(response.url()),
    );
    await page.getByRole("button", { name: "确认并发布 v2" }).click();
    const finalVersionBody = await (await finalVersionResponse).json();
    await expect(page.getByRole("heading", { name: /^v2/u })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText("派生版本已发布；默认版本不会自动切换。"),
    ).toBeVisible();
    expect(finalVersionBody.version).toMatchObject({
      number: 2,
      itemCount: 15,
      parentVersionId: expect.any(String),
    });
    expect(finalVersionBody.testSet.defaultVersionId).not.toBe(
      finalVersionBody.version.id,
    );
    await page.getByRole("button", { name: "查看用例修订" }).click();
    await expect(page.getByLabel("用例修订内容")).toContainText("case_id");
    await page.getByRole("button", { name: "比较版本" }).click();
    await expect(page.getByText("v1 → v2：+10 / -2 / ~5 / =0")).toBeVisible();
    await expect(page.getByLabel("Recipe 变化")).toBeVisible();
    await expect(page.getByLabel("Source 变化")).toBeVisible();
    await expect(page.getByText("Correct synthetic answer 3")).toBeVisible();

    const v1 = await page.evaluate(
      async ({ testSetId, versionId }) => {
        const response = await fetch(
          `/api/projects/project_demo/test-sets/${testSetId}/versions/${versionId}`,
        );
        return response.json();
      },
      {
        testSetId: finalVersionBody.testSet.id,
        versionId: finalVersionBody.version.parentVersionId,
      },
    );
    expect(v1.version.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(v1.version.payloadHash).toBe(initialVersionBody.version.payloadHash);

    const downloadPromise = page.waitForEvent("download");
    await page
      .getByRole("link", { name: "下载 Standard Version Package" })
      .click();
    const download = await downloadPromise;
    const packagePath = join(directory, "scenario-c-v2.zip");
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
