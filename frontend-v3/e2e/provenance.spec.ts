import { expect, test } from "@playwright/test";

const version = {
  id: "version_v2",
  label: "v2",
  recordCount: 3,
  parentVersionId: "version_v1",
  createdAt: "2026-09-05T00:01:00.000Z",
};

const changes = [
  {
    id: "case_modified",
    changeType: "modified",
    current: {
      question: "已更新的问题",
      expectedOutput: "新答案",
      metadata: [{ key: "状态", value: "更新" }],
      source: {
        assetId: "asset_original",
        ordinal: 1,
        fileName: "原始资料.csv",
        collectionId: "dataset_original",
      },
    },
    previous: {
      question: "旧问题",
      expectedOutput: "旧答案",
      metadata: [{ key: "状态", value: "初始" }],
      source: {
        assetId: "asset_original",
        ordinal: 1,
        fileName: "原始资料.csv",
        collectionId: "dataset_original",
      },
    },
    source: {
      assetId: "asset_original",
      ordinal: 1,
      fileName: "原始资料.csv",
      collectionId: "dataset_original",
    },
    changedFields: ["question", "expectedOutput"],
  },
  {
    id: "case_added",
    changeType: "added",
    current: { question: "手工新增", expectedOutput: "", metadata: [], source: null },
    previous: null,
    source: null,
    changedFields: [],
  },
  {
    id: "case_removed",
    changeType: "removed",
    current: null,
    previous: {
      question: "已移除的问题",
      expectedOutput: "旧答案",
      metadata: [{ key: "状态", value: "旧数据" }],
      source: {
        assetId: "asset_original",
        ordinal: 2,
        fileName: "原始资料.csv",
        collectionId: "dataset_original",
      },
    },
    source: {
      assetId: "asset_original",
      ordinal: 2,
      fileName: "原始资料.csv",
      collectionId: "dataset_original",
    },
    changedFields: [],
  },
];

test("shows the frozen provenance controls and record detail for the selected version", async ({
  page,
}) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") {
      await route.fulfill({ json: { csrfToken: "csrf" } });
      return;
    }
    if (url.pathname === "/api/projects") {
      await route.fulfill({ json: { projects: [], pagination: { total: 0 } } });
      return;
    }
    if (
      /^\/api\/projects\/project_browser\/solo-test-sets\/testset_browser\/versions\/[^/]+$/u.test(
        url.pathname,
      )
    ) {
      await route.fulfill({
        json: {
          testSet: { id: "testset_browser", name: "客服问答", purpose: "核对问答" },
          version,
          versionSummary: {
            sourceFiles: ["原始资料.csv"],
            manualRecordCount: 1,
            changes: { modified: 1, added: 1, removed: 1 },
          },
          dataCheck: { missingQuestionCount: 0, exactDuplicateCount: 0, traceableRecordCount: 1 },
          graph: {
            nodes: [
              {
                ...version,
                parentVersionId: "version_v1",
                publicationOrder: 2,
                generation: 2,
                branchNumber: null,
              },
              {
                id: "version_v1",
                label: "v1",
                recordCount: 2,
                parentVersionId: null,
                createdAt: "2026-09-05T00:00:00.000Z",
                publicationOrder: 1,
                generation: 1,
                branchNumber: null,
              },
            ],
          },
        },
      });
      return;
    }
    if (url.pathname.endsWith("/records")) {
      await route.fulfill({
        json: {
          records: [
            {
              ordinal: 1,
              ...changes[0]!.current,
            },
          ],
          pagination: { total: 1, limit: 10, offset: 0 },
          filterOptions: {
            sourceFiles: [{ id: "asset_original", name: "原始资料.csv" }],
            metadataFields: ["状态"],
          },
        },
      });
      return;
    }
    const changeId = url.pathname.match(/\/provenance\/(case_[^/]+)$/u)?.[1];
    if (changeId) {
      await route.fulfill({ json: { change: changes.find((change) => change.id === changeId) } });
      return;
    }
    if (url.pathname.endsWith("/provenance")) {
      await route.fulfill({
        json: {
          summary: {
            parentVersion: { id: "version_v1", label: "v1" },
            currentVersion: {
              id: "version_v2",
              label: "v2",
              recordCount: 3,
              createdAt: version.createdAt,
            },
            counts: { unchanged: 0, modified: 1, added: 1, removed: 1 },
            manualAddedCount: 1,
            addedFiles: [
              {
                assetId: "asset_added",
                fileName: "新增资料.csv",
                recordCount: 1,
                mapping: {
                  question: "/question",
                  expectedOutput: "/answer",
                  metadata: ["/tag"],
                },
              },
            ],
          },
          changes,
          pagination: { total: 2, limit: 10, offset: 0 },
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: "route_not_found" } } });
  });

  await page.goto("/projects/project_browser/test-sets/testset_browser?version=version_v2");
  await expect(page.getByText("当前版本摘要", { exact: true })).toBeVisible();
  await expect(
    page.locator(".version-graph-card").getByText("版本关系", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("当前版本摘要", { exact: true })).toHaveText("当前版本摘要");
  await expect(page.getByRole("button", { name: "查看来源与修改" })).toBeVisible();
  await expect(page.getByRole("link", { name: "下载 CSV" })).toBeVisible();
  await expect(page.getByRole("button", { name: "下载数据与溯源" })).toBeVisible();
  await expect(page.getByRole("button", { name: /创建新版本|创建分支/ })).toBeVisible();
  await page.getByRole("button", { name: "查看来源与修改" }).click();
  await expect(page.getByRole("heading", { name: "来源与修改" })).toBeVisible();
  await expect(page.getByText("当前版本摘要", { exact: true })).toHaveCount(0);
  await expect(page.getByText("版本关系", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "下载 CSV" })).toHaveCount(0);
  const summary = page.locator(".version-summary-card").filter({ hasText: "本版本如何形成" });
  await expect(summary.locator("dt")).toHaveText([
    "基于版本",
    "当前版本",
    "本次结果",
    "本次新加入的资料",
  ]);
  await expect(summary.locator("dd").first()).toContainText("在 v1 的基础上编辑。");
  await expect(summary.locator(".lineage-result-counts")).toContainText("已修改 1");
  await expect(page.getByText("逐条查看变化", { exact: true })).toBeVisible();
  const addedFile = summary.locator(".lineage-source-row").filter({ hasText: "新增资料.csv" });
  await expect(addedFile.getByText("新增 1 条")).toBeVisible();
  await expect(addedFile.getByText("question → 问题")).toBeHidden();
  await addedFile.locator("summary").click();
  await expect(addedFile.getByText("question → 问题")).toBeVisible();
  await expect(addedFile.getByText("answer → 期望输出")).toBeVisible();
  await expect(addedFile.getByText("tag → Metadata")).toBeVisible();
  await expect(summary.getByText("手工新增")).toBeVisible();
  await expect(page.getByRole("button", { name: "本次有变化" })).toBeVisible();
  await expect(page.getByRole("button", { name: "全部" })).toBeVisible();
  await expect(page.getByRole("button", { name: "未改变" })).toBeVisible();
  await expect(page.getByRole("button", { name: "已修改" })).toBeVisible();
  await expect(page.getByRole("button", { name: "新增" })).toBeVisible();
  await expect(page.getByRole("button", { name: "已移除" })).toBeVisible();
  await expect(page.getByRole("button", { name: "下载数据与溯源" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "记录" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "状态" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "变更字段" })).toBeVisible();
  await expect(page.getByText("共 2 条记录 · 第 1/1 页", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看" }).first().click();
  await expect(page.getByRole("heading", { name: "记录来源与修改" })).toBeVisible();
  await expect(page.getByText("来源与本次修改", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "查看原始资料" })).toBeVisible();
  await expect(page.getByText("修改前内容", { exact: true })).toBeVisible();
  await expect(page.getByText("原始资料.csv 第 2 条记录", { exact: true }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "查看" }).nth(2).click();
  await expect(page.getByText("移除前内容", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "v1" }).click();
  await expect(page).toHaveURL(/\?version=version_v1$/u);
});
