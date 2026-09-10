import { expect, test } from "@playwright/test";

const graph = [
  {
    id: "version_v1",
    label: "v1",
    recordCount: 2,
    parentVersionId: null,
    generation: 1,
    branchNumber: null,
    createdAt: "2026-09-05T00:00:00.000Z",
  },
  {
    id: "version_v2",
    label: "v2",
    recordCount: 2,
    parentVersionId: "version_v1",
    generation: 2,
    branchNumber: null,
    createdAt: "2026-09-05T00:01:00.000Z",
  },
  {
    id: "version_v3",
    label: "v3",
    recordCount: 2,
    parentVersionId: "version_v2",
    generation: 3,
    branchNumber: null,
    createdAt: "2026-09-05T00:02:00.000Z",
  },
  {
    id: "version_branch",
    label: "v2-b1",
    recordCount: 2,
    parentVersionId: "version_v1",
    generation: 2,
    branchNumber: 1,
    createdAt: "2026-09-05T00:03:00.000Z",
  },
  ...[4, 5, 6, 7].map((number) => ({
    id: `version_v${number}`,
    label: `v${number}`,
    recordCount: 2,
    parentVersionId: `version_v${number - 1}`,
    generation: number,
    branchNumber: null,
    createdAt: `2026-09-05T00:0${number}:00.000Z`,
  })),
];

function versionDetail(id: string) {
  const version = graph.find((node) => node.id === id)!;
  return {
    testSet: { id: "testset_browser", name: "客服问答", purpose: "核对常见问答" },
    version,
    versionSummary:
      id === "version_branch"
        ? {
            sourceFiles: ["分支资料.csv"],
            manualRecordCount: 0,
            changes: { modified: 0, added: 0, removed: 0 },
          }
        : {
            sourceFiles: ["帮助中心.csv", "新增资料.csv"],
            manualRecordCount: 1,
            changes: { modified: 1, added: 2, removed: 1 },
          },
    dataCheck: { missingQuestionCount: 0, exactDuplicateCount: 0, traceableRecordCount: 2 },
    graph: { nodes: graph },
  };
}

const records = [
  {
    ordinal: 1,
    question: "如何重置密码？",
    expectedOutput: "在设置中重置。",
    metadata: [{ key: "渠道", value: "帮助中心" }],
    source: { ordinal: 0, fileName: "帮助中心.csv" },
  },
  {
    ordinal: 2,
    question: "如何联系支持？",
    expectedOutput: "提交工单。",
    metadata: [{ key: "渠道", value: "帮助中心" }],
    source: { ordinal: 1, fileName: "帮助中心.csv" },
  },
];

test("shows the selected version summary before its highlighted source path", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
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
          testSets: [
            {
              id: "testset_browser",
              name: "客服问答",
              purpose: "核对常见问答",
              currentVersionId: "version_v3",
            },
          ],
          pagination: { total: 1 },
        },
      });
      return;
    }
    if (/\/versions\/version_[^/]+\/records$/u.test(url.pathname)) {
      await route.fulfill({
        json: {
          records,
          pagination: { total: records.length, limit: 10, offset: 0 },
          filterOptions: {
            sourceFiles: [{ id: "asset_help", name: "帮助中心.csv" }],
            metadataFields: ["渠道"],
          },
        },
      });
      return;
    }
    const match = url.pathname.match(
      /^\/api\/projects\/project_browser\/solo-test-sets\/testset_browser\/versions\/(version_[^/]+)$/,
    );
    if (match?.[1]) {
      await route.fulfill({ json: versionDetail(match[1]) });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: "route_not_found" } } });
  });

  await page.goto("/projects/project_browser/test-sets/testset_browser");
  const summary = page.getByText("当前版本摘要", { exact: true });
  const graphHeading = page.locator(".version-graph-card").getByText("版本关系", { exact: true });
  await expect(summary).toBeVisible();
  await expect(graphHeading).toBeVisible();
  expect(
    await summary.evaluate((node) => {
      const graph = [...document.querySelectorAll("strong")].find(
        (element) => element.textContent === "版本关系",
      );
      return Boolean(
        graph && node.compareDocumentPosition(graph) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }),
  ).toBe(true);
  await expect(page.getByText("v3 · 父版本 v2", { exact: true })).toBeVisible();
  await expect(page.getByText("资料来源", { exact: true })).toBeVisible();
  await expect(
    page.getByText("帮助中心.csv、新增资料.csv；手工新增 1 条", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("本版本修改", { exact: true })).toBeVisible();
  await expect(
    page.getByText("从 v2 创建：修改 1 条、新增 2 条、移除 1 条记录。", { exact: true }),
  ).toBeVisible();

  const versionGraph = page.locator(".version-graph-card");
  await expect(versionGraph.locator(".version-child.on-path")).toHaveCount(2);
  await expect(versionGraph.locator(".version-child.dimmed")).toHaveCount(5);
  await expect(versionGraph.locator(".version-node.selected")).toContainText("v3");

  const fit = page.getByRole("button", { name: "适应视图" });
  await expect(fit).toBeVisible();
  await fit.click();
  await expect(page.getByRole("button", { name: "实际大小" })).toBeVisible();
  await page.getByRole("button", { name: "实际大小" }).click();
  await expect(fit).toBeVisible();

  await page.setViewportSize({ width: 400, height: 900 });
  await fit.click();
  await expect(page.getByText("版本图较宽，保留横向滚动以保证文字可读。")).toBeVisible();
  await expect(fit).toBeVisible();

  await page.getByRole("button", { name: /v2-b1/ }).click();
  await expect(page.getByText("v2-b1 · 父版本 v1", { exact: true })).toBeVisible();
  await expect(page.getByText("分支资料.csv", { exact: true })).toBeVisible();
  await expect(page.getByText("从 v1 创建：未修改记录。", { exact: true })).toBeVisible();
  await expect(versionGraph.locator(".version-child.on-path")).toHaveCount(1);
  await expect(versionGraph.locator(".version-node.selected")).toContainText("v2-b1");
});
