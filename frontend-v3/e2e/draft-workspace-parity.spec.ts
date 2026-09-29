import { expect, test } from "@playwright/test";

const projectId = "project_browser";
const draftBase = {
  projectId,
  name: "",
  purpose: "",
  status: "editing",
  suspended: false,
  revision: 1,
  nameRevision: 0,
  purposeRevision: 0,
  createdBy: "admin",
  createdByName: "管理员",
  createdAt: "2026-09-27T08:30:00.000Z",
  updatedBy: "editor",
  updatedByName: "编辑者甲",
  updatedAt: "2026-09-28T08:30:00.000Z",
  publishedVersionId: null,
};
const record = {
  id: "row_1",
  position: 101,
  activeOrdinal: 1,
  caseId: null,
  beforeRevisionId: null,
  question: "如何重置密码？",
  expectedOutput: "在设置中重置。",
  metadata: [{ key: "渠道", value: "" }],
  source: null,
  sourceFileName: null,
  rowRevision: 1,
  questionRevision: 0,
  expectedOutputRevision: 0,
  metadataRevision: 0,
  sourceRevision: 0,
  fieldAttribution: {},
  updatedBy: "editor",
  updatedAt: "2026-09-28T08:30:00.000Z",
};
const secondRecord = {
  ...record,
  id: "row_2",
  position: 102,
  activeOrdinal: 2,
  question: "第二条唯一问题",
};
const inheritedRecord = {
  ...record,
  caseId: "case_1",
  beforeRevisionId: "revision_1",
  rowRevision: 0,
  updatedBy: "admin",
  fieldAttribution: {
    metadata: { userId: "admin", at: "2026-09-27T08:30:00.000Z" },
  },
};
const editedInheritedRecord = {
  ...inheritedRecord,
  rowRevision: 1,
  questionRevision: 1,
  updatedBy: "editor",
  fieldAttribution: {
    ...inheritedRecord.fieldAttribution,
    question: { userId: "editor", at: "2026-09-29T08:30:00.000Z" },
  },
};

test("draft page keeps prototype hierarchy, confirmation, and narrow layout", async ({ page }) => {
  let derivedEdited = false;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/installation")
      return route.fulfill({ json: { needsAdministrator: false, needsMigration: false } });
    if (path === "/api/session")
      return route.fulfill({ json: { csrfToken: "csrf", actor: { id: "admin", role: "admin" } } });
    if (path === "/api/projects")
      return route.fulfill({
        json: { projects: [{ id: projectId, name: "演示项目" }], pagination: { total: 1 } },
      });
    if (path === `/api/projects/${projectId}/access`)
      return route.fulfill({
        json: {
          access: {
            role: "admin",
            capabilities: { read: true, write: true, export: true, manage: true },
          },
        },
      });
    if (path === `/api/projects/${projectId}/collaborative-drafts/draft_new`)
      return route.fulfill({
        json: {
          draft: {
            ...draftBase,
            id: "draft_new",
            testSetId: null,
            parentVersionId: null,
            parentVersionLabel: null,
          },
          records: url.searchParams.get("search") ? [secondRecord] : [record, secondRecord],
          total: url.searchParams.get("search") ? 1 : 2,
        },
      });
    if (path === `/api/projects/${projectId}/collaborative-drafts/draft_derived`)
      return route.fulfill({
        json: {
          draft: {
            ...draftBase,
            id: "draft_derived",
            name: "客服问答",
            testSetId: "set_1",
            parentVersionId: "version_v2",
            parentVersionLabel: "v2",
            parentRecordCount: 12,
          },
          records: [derivedEdited ? editedInheritedRecord : inheritedRecord],
          authors: {
            admin: { name: "管理员", avatarColor: "#6366f1" },
            editor: { name: "协作编辑", avatarColor: "#0ea5e9" },
          },
          total: 1,
        },
      });
    if (path.endsWith("/presence"))
      return route.request().method() === "POST"
        ? route.fulfill({ status: 204 })
        : route.fulfill({ json: { users: [] } });
    if (path.includes("/presence/")) return route.fulfill({ status: 204 });
    if (path.endsWith("/events"))
      return route.fulfill({
        json: { events: [], cursor: 1, hasMore: false, needsSnapshot: false, status: "editing" },
      });
    if (path.endsWith("/collaborative-draft-source-files"))
      return route.fulfill({
        json: {
          files: [
            { id: "file_2", fileName: "资料A.json", collectionName: "资料库", recordCount: 1 },
          ],
          total: 1,
        },
      });
    if (path.endsWith("/collaborative-draft-source-records"))
      return route.fulfill({
        json: {
          records: [
            {
              assetId: "file_2",
              ordinal: 0,
              question: "源记录X",
              expectedOutput: "答案",
              metadata: [],
            },
          ],
          total: 1,
        },
      });
    if (path.endsWith("/source-selection"))
      return route.fulfill({ json: { matched: 1, changed: 1 } });
    if (path.endsWith("/selected-sources"))
      return route.fulfill({ json: { sources: [{ assetId: "file_1", ordinal: 0 }] } });
    if (path === `/api/projects/${projectId}/solo-test-sets/set_1/versions/version_v2`)
      return route.fulfill({
        json: { version: { id: "version_v2", label: "v2", recordCount: 12 } },
      });
    return route.fulfill({ status: 404, json: { error: { code: "route_not_found" } } });
  });

  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto(`/projects/${projectId}/test-sets/drafts/draft_new`);
  await expect(page.getByText("测试集 v1 草稿", { exact: true })).toBeVisible();
  await expect(page.getByLabel("测试集名称")).toBeVisible();
  await expect(page.getByLabel("用途说明（可选）")).toBeVisible();
  await expect(page.getByRole("tab", { name: /草稿记录/ })).toContainText("2");
  await expect(page.getByRole("tab", { name: /添加资料/ })).toContainText("1");
  await expect(page.locator(".draft-page-actions button")).toHaveText([
    "删除当前草稿",
    "保存并退出",
    "创建 v1",
  ]);
  await expect(page.getByRole("columnheader", { name: "期望输出" })).toBeVisible();
  await expect(
    page
      .getByRole("row", { name: /如何重置密码/ })
      .locator("td")
      .first(),
  ).toHaveText("1");
  await page.getByRole("row", { name: /如何重置密码/ }).click();
  await expect(page.getByLabel("记录编辑区")).toContainText("编辑记录");
  await expect(page.getByLabel("记录编辑区")).toContainText("第 1 条");
  await expect(page.getByLabel("第 1 项 Metadata 值")).toHaveValue("");
  await page.getByRole("button", { name: "移除记录" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("此行尚未保存的输入也会丢失");
  await expect(page.getByRole("alertdialog")).toContainText("第 1 条记录");
  await page.getByRole("button", { name: "取消" }).click();
  await page.getByRole("textbox", { name: "搜索草稿记录" }).fill("第二条唯一问题");
  await expect(page.getByRole("row", { name: /如何重置密码/ })).toHaveCount(0);
  await expect(
    page
      .getByRole("row", { name: /第二条唯一问题/ })
      .locator("td")
      .first(),
  ).toHaveText("2");
  await page.getByRole("textbox", { name: "搜索草稿记录" }).fill("");
  const sidebarOverflow = await page
    .locator('[data-sidebar="content"]')
    .evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(sidebarOverflow).toBeLessThanOrEqual(0);
  await page.getByRole("tab", { name: /添加资料/ }).click();
  await page.getByRole("checkbox", { name: "选择 资料A.json" }).click();
  await expect(page.getByText("源记录X")).toBeVisible();
  await page.getByRole("tab", { name: /草稿记录/ }).click();
  const geometry = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
  const table = await page.getByRole("columnheader", { name: "期望输出" }).boundingBox();
  const editor = await page.getByLabel("记录编辑区").boundingBox();
  expect(editor!.y).toBeGreaterThan(table!.y);

  await page.goto(`/projects/${projectId}/test-sets/drafts/draft_derived`);
  await expect(page.getByText("草稿基于 v2 · 计划发布新版本")).toBeVisible();
  await expect(page.getByText(/已继承父版本 12 条记录/)).toBeVisible();
  await expect(page.getByLabel("测试集名称")).toHaveCount(0);
  const inheritedRow = page.getByRole("row", { name: /如何重置密码/ });
  await expect(inheritedRow.locator("td").nth(1).locator("small")).toHaveCount(0);
  await inheritedRow.click();
  await expect(page.getByLabel("记录编辑区").getByText(/最近修改：/)).toHaveCount(0);
  derivedEdited = true;
  await page.reload();
  const editedRow = page.getByRole("row", { name: /如何重置密码/ });
  await expect(editedRow).toContainText("协作编辑");
  await editedRow.click();
  await expect(page.getByLabel("记录编辑区")).toContainText("协作编辑");
  await expect(page.getByLabel("记录编辑区").getByText(/最近修改：/)).toHaveCount(1);
});
