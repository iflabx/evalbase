import { mockAccountRoute } from "./mock-account";
import { expect, test } from "@playwright/test";

const version = {
  id: "version_v1",
  label: "v1",
  recordCount: 2,
  parentVersionId: null,
  createdAt: "2026-09-09T00:00:00.000Z",
};

const records = [
  {
    ordinal: 1,
    question: "",
    expectedOutput: "预约说明",
    metadata: [
      { key: "渠道", value: "公开" },
      { key: "主题", value: "预约" },
    ],
    source: { ordinal: 0, fileName: "预约资料.csv" },
  },
  {
    ordinal: 2,
    question: "如何预约？",
    expectedOutput: "填写表单",
    metadata: [{ key: "渠道", value: "内部" }],
    source: { ordinal: 0, fileName: "内部资料.csv" },
  },
];

test("filters paged version records and opens an ordinal detail", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/session") {
      await route.fulfill(
        method === "POST" ? { json: { csrfToken: "csrf" } } : { status: 401, body: "" },
      );
      return;
    }
    if (url.pathname === "/api/projects") {
      await route.fulfill({ json: { projects: [], pagination: { total: 0 } } });
      return;
    }
    if (url.pathname === "/api/projects/project_browser/solo-test-sets") {
      await route.fulfill({
        json: {
          testSets: [{ id: "testset_browser", currentVersionId: version.id }],
          pagination: { total: 1 },
        },
      });
      return;
    }
    if (url.pathname.endsWith("/records")) {
      const filtered = records.filter(
        (record) =>
          (!url.searchParams.has("sourceAssetId") ||
            (url.searchParams.get("sourceAssetId") === "asset_a" && record.ordinal === 1)) &&
          (!url.searchParams.has("question") || record.question === "") &&
          (!url.searchParams.has("origin") || record.source !== null) &&
          (!url.searchParams.has("metadata") ||
            record.metadata.some(
              (entry) =>
                entry.key === url.searchParams.get("metadataField") &&
                entry.value.includes(url.searchParams.get("metadata") ?? ""),
            )),
      );
      await route.fulfill({
        json: {
          records: filtered,
          pagination: { total: filtered.length, limit: 10, offset: 0 },
          filterOptions: {
            sourceFiles: [
              { id: "asset_a", name: "预约资料.csv" },
              { id: "asset_b", name: "内部资料.csv" },
            ],
            metadataFields: ["渠道", "主题"],
          },
        },
      });
      return;
    }
    const detailOrdinal = url.pathname.match(/\/records\/(\d+)$/u)?.[1];
    if (detailOrdinal) {
      await route.fulfill({ json: { record: records[Number(detailOrdinal) - 1] } });
      return;
    }
    if (/\/versions\/version_v1$/u.test(url.pathname)) {
      await route.fulfill({
        json: {
          testSet: { id: "testset_browser", name: "预约测试集", purpose: "" },
          version,
          versionSummary: {
            sourceFiles: ["预约资料.csv", "内部资料.csv"],
            manualRecordCount: 0,
            changes: { modified: 0, added: 2, removed: 0 },
          },
          dataCheck: { missingQuestionCount: 1, exactDuplicateCount: 0, traceableRecordCount: 2 },
          graph: {
            nodes: [{ ...version, publicationOrder: 1, generation: 1, branchNumber: null }],
          },
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: "route_not_found" } } });
  });

  await page.goto("/projects/project_browser/test-sets/testset_browser");
  await expect(page.getByText("匹配 2 条记录", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "筛选当前版本记录" }).click();
  await page.getByText("预约资料.csv", { exact: true }).click();
  await page.getByLabel("问题").click();
  await page.getByRole("option", { name: "未填写" }).click();
  await page.getByLabel("记录来源").click();
  await page.getByRole("option", { name: "原始资料" }).click();
  await page.getByLabel("Metadata", { exact: true }).click();
  await page.getByRole("option", { name: "渠道" }).click();
  await page.getByLabel("Metadata 包含").fill("公开");
  await page.getByRole("button", { name: "应用筛选" }).click();
  await expect(page.getByText("匹配 1 条记录", { exact: true })).toBeVisible();
  await expect(page.getByLabel(/移除筛选：来源文件：预约资料.csv/)).toBeVisible();
  await page.getByRole("button", { name: "1", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "第 1 条记录" });
  await expect(detail.getByRole("heading", { name: "第 1 条记录" })).toBeVisible();
  await expect(detail.getByText("渠道", { exact: true })).toBeVisible();
  await expect(detail.getByText("公开", { exact: true })).toBeVisible();
});
