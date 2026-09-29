import { expect, test } from "@playwright/test";

const detail = {
  testSet: { id: "testset_browser", name: "客服问答", purpose: "" },
  version: {
    id: "version_v3",
    label: "v3",
    recordCount: 1,
    parentVersionId: "version_v2",
    createdAt: "2026-09-06T00:00:00.000Z",
  },
  versionSummary: {
    sourceFiles: ["客服资料.csv"],
    manualRecordCount: 0,
    changes: { modified: 0, added: 1, removed: 0 },
  },
  dataCheck: { missingQuestionCount: 0, exactDuplicateCount: 0, traceableRecordCount: 0 },
  graph: {
    nodes: [
      {
        id: "version_v1",
        label: "v1",
        recordCount: 1,
        parentVersionId: null,
        publicationOrder: 1,
        generation: 1,
        branchNumber: null,
        createdAt: "2026-09-06T00:00:00.000Z",
      },
      {
        id: "version_v2",
        label: "v2",
        recordCount: 0,
        parentVersionId: "version_v1",
        publicationOrder: 2,
        generation: 2,
        branchNumber: null,
        createdAt: "2026-09-06T00:01:00.000Z",
        tombstoned: true,
        tombstonedAt: "2026-09-06T00:03:00.000Z",
      },
      {
        id: "version_v3",
        label: "v3",
        recordCount: 1,
        parentVersionId: "version_v2",
        publicationOrder: 3,
        generation: 3,
        branchNumber: null,
        createdAt: "2026-09-06T00:02:00.000Z",
      },
    ],
  },
};

const testSets = {
  testSets: [
    {
      id: "testset_browser",
      name: "客服问答",
      currentVersionId: "version_v3",
      currentVersion: "v3",
      recordCount: 1,
      source: "客服资料.csv",
      status: "已发布",
      updatedAt: "2026-09-06T00:00:00.000Z",
    },
  ],
  pagination: { total: 1 },
};

test("keeps entire-Test-Set trash on the list and only version deletion on detail", async ({
  page,
}) => {
  let trashed = false;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/installation")
      return void (await route.fulfill({
        json: { needsAdministrator: false, needsMigration: false },
      }));
    if (url.pathname === "/api/session")
      return void (await route.fulfill({
        json: { csrfToken: "csrf", actor: { id: "admin", role: "admin" } },
      }));
    if (url.pathname === "/api/projects/project_browser/access")
      return void (await route.fulfill({
        json: {
          access: {
            role: "admin",
            capabilities: { read: true, write: true, export: true, manage: true },
          },
        },
      }));
    if (method === "POST" && url.pathname.endsWith("/solo-test-sets/testset_browser/trash")) {
      trashed = true;
      return void (await route.fulfill({ status: 201, json: { entry: { id: "trash_set" } } }));
    }
    if (url.pathname === "/api/projects/project_browser/solo-test-sets")
      return void (await route.fulfill({
        json: trashed ? { testSets: [], pagination: { total: 0 } } : testSets,
      }));
    if (url.pathname === "/api/projects/project_browser/solo-test-set-trash")
      return void (await route.fulfill({ json: { entries: [], pagination: { total: 0 } } }));
    if (url.pathname.endsWith("/versions/version_v3"))
      return void (await route.fulfill({ json: detail }));
    await route.fulfill({ status: 404, json: { error: { code: "route_not_found" } } });
  });

  await page.goto("/projects/project_browser/test-sets");
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  const emptyTrash = page.getByRole("dialog", { name: "回收站" });
  await expect(emptyTrash.getByText("测试集", { exact: true })).toBeVisible();
  await expect(emptyTrash.getByText("版本与版本分支", { exact: true })).toBeVisible();
  await expect(emptyTrash.getByText("没有移入回收站的测试集。", { exact: true })).toBeVisible();
  await emptyTrash.getByRole("button", { name: "关闭" }).click();
  const row = page.getByRole("row", { name: /客服问答/ });
  await expect(row.getByRole("link", { name: "查看" })).toBeVisible();
  await row.getByRole("button", { name: "移入回收站：客服问答" }).click();
  const dialog = page.getByRole("alertdialog", { name: "移入回收站" });
  await expect(dialog).toContainText("原始数据中的文件不会被删除");
  await dialog.getByRole("button", { name: "移入回收站" }).click();
  await expect(page.getByText("还没有测试集")).toBeVisible();

  await page.goto("/projects/project_browser/test-sets/testset_browser?version=version_v3");
  await expect(page.locator(".version-node.tombstoned")).toContainText("内容已删除");
  await page.getByRole("button", { name: "删除选项" }).click();
  await expect(page.getByRole("menuitem", { name: "删除此版本" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "移入回收站" })).toHaveCount(0);
});

test("groups Trash and enables permanent deletion only for an exact current name or label", async ({
  page,
}) => {
  let confirmation = "";
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/installation")
      return void (await route.fulfill({
        json: { needsAdministrator: false, needsMigration: false },
      }));
    if (url.pathname === "/api/session")
      return void (await route.fulfill({
        json: { csrfToken: "csrf", actor: { id: "admin", role: "admin" } },
      }));
    if (url.pathname === "/api/projects/project_browser/access")
      return void (await route.fulfill({
        json: {
          access: {
            role: "admin",
            capabilities: { read: true, write: true, export: true, manage: true },
          },
        },
      }));
    if (
      method === "POST" &&
      url.pathname ===
        "/api/projects/project_browser/solo-test-set-trash/trash_set/permanent-delete"
    ) {
      confirmation = JSON.parse(route.request().postData() ?? "{}").confirmation;
      return void (await route.fulfill({ json: { permanentlyDeleted: true } }));
    }
    if (url.pathname === "/api/projects/project_browser/solo-test-sets")
      return void (await route.fulfill({ json: testSets }));
    if (url.pathname === "/api/projects/project_browser/solo-test-set-trash")
      return void (await route.fulfill({
        json: {
          entries: [
            {
              id: "trash_set",
              type: "test_set",
              testSetId: "testset_browser",
              testSetName: "客服问答",
              rootVersionId: null,
              rootVersionLabel: null,
              versionCount: 3,
              trashedAt: "2026-09-06T00:00:00.000Z",
              pendingCleanup: false,
            },
            {
              id: "trash_branch",
              type: "version_branch",
              testSetId: "other_set",
              testSetName: "另一测试集",
              rootVersionId: "version_v2",
              rootVersionLabel: "v2",
              versionCount: 2,
              trashedAt: "2026-09-06T00:01:00.000Z",
              pendingCleanup: false,
            },
          ],
          pagination: { total: 2 },
        },
      }));
    await route.fulfill({ status: 404, json: { error: { code: "route_not_found" } } });
  });

  await page.goto("/projects/project_browser/test-sets");
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "回收站" });
  await expect(dialog.getByText("测试集", { exact: true })).toBeVisible();
  await expect(dialog.getByText("版本与版本分支", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "永久删除" }).first().click();
  const permanent = page.getByRole("alertdialog", { name: "永久删除" });
  const action = permanent.getByRole("button", { name: "永久删除" });
  await expect(action).toBeDisabled();
  await permanent.getByLabel("请输入 客服问答 以确认").fill("错误名称");
  await expect(action).toBeDisabled();
  await permanent.getByLabel("请输入 客服问答 以确认").fill("客服问答");
  await expect(action).toBeEnabled();
  await action.click();
  await expect.poll(() => confirmation).toBe("客服问答");
});
