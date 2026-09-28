import { expect, test, type Page } from "@playwright/test";

const projectId = "project_browser";
const testSetId = "testset_browser";
const common = {
  projectId,
  name: "",
  purpose: "",
  status: "editing",
  suspended: false,
  revision: 0,
  nameRevision: 0,
  purposeRevision: 0,
  updatedBy: "editor",
  updatedByName: "编辑者甲",
  updatedAt: "2026-09-28T08:30:00.000Z",
  publishedVersionId: null,
};
const drafts = [
  {
    ...common,
    id: "draft_new_a",
    testSetId: null,
    parentVersionId: null,
    parentVersionLabel: null,
    createdBy: "admin",
    createdByName: "管理员",
    createdAt: "2026-09-27T08:30:00.000Z",
    name: "首份草稿",
  },
  {
    ...common,
    id: "draft_new_b",
    testSetId: null,
    parentVersionId: null,
    parentVersionLabel: null,
    createdBy: null,
    createdByName: null,
    createdAt: null,
    name: "",
  },
  {
    ...common,
    id: "draft_v1",
    testSetId,
    parentVersionId: "version_v1",
    parentVersionLabel: "v1",
    createdBy: "admin",
    createdByName: "管理员",
    createdAt: "2026-09-27T08:30:00.000Z",
  },
  {
    ...common,
    id: "draft_v2",
    testSetId,
    parentVersionId: "version_v2",
    parentVersionLabel: "v2",
    createdBy: "admin",
    createdByName: "管理员",
    createdAt: "2026-09-27T08:30:00.000Z",
  },
];
const graph = [
  {
    id: "version_v1",
    label: "v1",
    parentVersionId: null,
    recordCount: 1,
    createdAt: "2026-09-20T08:30:00.000Z",
  },
  {
    id: "version_v2",
    label: "v2",
    parentVersionId: "version_v1",
    recordCount: 1,
    createdAt: "2026-09-21T08:30:00.000Z",
  },
];

async function mockWorkspace(page: Page, role: "admin" | "editor" | "viewer" = "admin") {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/installation")
      return route.fulfill({ json: { needsAdministrator: false, needsMigration: false } });
    if (url.pathname === "/api/session")
      return route.fulfill({ json: { csrfToken: "csrf", actor: { id: role, role } } });
    if (url.pathname === "/api/projects")
      return route.fulfill({
        json: { projects: [{ id: projectId, name: "演示项目" }], pagination: { total: 1 } },
      });
    if (url.pathname === `/api/projects/${projectId}/access`)
      return route.fulfill({
        json: {
          access: {
            role,
            capabilities: {
              read: true,
              write: role !== "viewer",
              export: true,
              manage: role === "admin",
            },
          },
        },
      });
    if (url.pathname === `/api/projects/${projectId}/collaborative-drafts`) {
      const testSet = url.searchParams.get("testSetId");
      return route.fulfill({
        json: { drafts: testSet ? drafts.filter((draft) => draft.testSetId === testSet) : drafts },
      });
    }
    if (url.pathname === `/api/projects/${projectId}/solo-test-sets`) {
      return route.fulfill({
        json: {
          testSets: [
            {
              id: testSetId,
              name: "客服问答",
              currentVersionId: "version_v2",
              currentVersion: "v2",
              recordCount: 1,
              source: "帮助中心.csv",
              status: "已发布",
              updatedAt: "2026-09-21T08:30:00.000Z",
            },
          ],
          pagination: { total: 1 },
        },
      });
    }
    const match = url.pathname.match(
      /^\/api\/projects\/project_browser\/solo-test-sets\/testset_browser\/versions\/(version_v[12])$/,
    );
    if (match) {
      const version = graph.find((node) => node.id === match[1])!;
      return route.fulfill({
        json: {
          testSet: { id: testSetId, name: "客服问答", purpose: "核对常见问答" },
          version,
          versionSummary: {
            sourceFiles: ["帮助中心.csv"],
            manualRecordCount: 0,
            changes: { modified: 0, added: 1, removed: 0 },
          },
          dataCheck: { missingQuestionCount: 0, exactDuplicateCount: 0, traceableRecordCount: 1 },
          graph: { nodes: graph },
        },
      });
    }
    if (url.pathname.endsWith("/records"))
      return route.fulfill({
        json: {
          records: [],
          pagination: { total: 0, limit: 10, offset: 0 },
          filterOptions: { sourceFiles: [], metadataFields: [] },
        },
      });
    return route.fulfill({ status: 404, json: { error: { code: "route_not_found" } } });
  });
}

test("new drafts share the list without a separate card or derived-draft subline", async ({
  page,
}) => {
  await mockWorkspace(page);
  await page.goto(`/projects/${projectId}/test-sets`);
  await expect(page.getByRole("region", { name: "未发布的测试集草稿" })).toHaveCount(0);
  const first = page.getByRole("row", { name: /首份草稿/ });
  await expect(first.getByRole("link", { name: "继续编辑草稿" })).toHaveAttribute(
    "href",
    `/projects/${projectId}/test-sets/drafts/draft_new_a`,
  );
  await expect(page.getByRole("row", { name: /未命名草稿/ })).toBeVisible();
  const published = page.getByRole("row", { name: /客服问答/ });
  await expect(published).not.toContainText("草稿中");
  await expect(published).not.toContainText("基于 v1");
  await expect(published).not.toContainText("继续编辑草稿");
});

test("new drafts remain reachable without a published test set", async ({ page }) => {
  await mockWorkspace(page);
  await page.route(`**/api/projects/${projectId}/solo-test-sets?*`, (route) =>
    route.fulfill({ json: { testSets: [], pagination: { total: 0 } } }),
  );
  await page.goto(`/projects/${projectId}/test-sets`);
  await expect(page.getByRole("row", { name: /首份草稿/ })).toBeVisible();
  await page.getByRole("textbox", { name: "搜索测试集" }).fill("首份");
  await expect(page.getByRole("row", { name: /首份草稿/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /未命名草稿/ })).toHaveCount(0);
});

test("version detail places its draft card before the graph and shows draft graph nodes", async ({
  page,
}) => {
  await mockWorkspace(page);
  await page.goto(`/projects/${projectId}/test-sets/${testSetId}?version=version_v1`);
  const card = page.getByRole("region", { name: "此版本有未发布草稿" });
  await expect(card).toContainText("基于 v1");
  await expect(card).toContainText("编辑者甲");
  await expect(card.getByRole("link", { name: "继续编辑草稿" })).toHaveAttribute(
    "href",
    `/projects/${projectId}/test-sets/drafts/draft_v1`,
  );
  const summary = page.getByText("当前版本摘要", { exact: true });
  const graphHeading = page.locator(".version-graph-card").getByText("版本关系", { exact: true });
  expect(
    await summary.evaluate((node) =>
      Boolean(
        node.compareDocumentPosition(document.querySelector('[aria-label="此版本有未发布草稿"]')!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ),
  ).toBe(true);
  expect(
    await card.evaluate((node) =>
      Boolean(
        node.compareDocumentPosition(document.querySelector(".version-graph-card")!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ),
  ).toBe(true);
  await expect(graphHeading).toBeVisible();
  await expect(
    page.locator(".version-graph-card").getByRole("link", { name: /草稿.*基于 v1/ }),
  ).toHaveAttribute("href", `/projects/${projectId}/test-sets/drafts/draft_v1`);
  await expect(
    page.locator(".version-graph-card").getByRole("link", { name: /草稿.*基于 v2/ }),
  ).toHaveAttribute("href", `/projects/${projectId}/test-sets/drafts/draft_v2`);
});

test("editor finds drafts while viewer sees only published versions", async ({ page }) => {
  await mockWorkspace(page, "editor");
  await page.goto(`/projects/${projectId}/test-sets`);
  await expect(page.getByRole("row", { name: /首份草稿/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "回收站" })).toHaveCount(0);
  await page.unrouteAll();

  await mockWorkspace(page, "viewer");
  await page.goto(`/projects/${projectId}/test-sets`);
  await expect(page.getByRole("row", { name: /首份草稿/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新建测试集" })).toHaveCount(0);
  await page.goto(`/projects/${projectId}/test-sets/${testSetId}?version=version_v1`);
  await expect(page.getByRole("region", { name: "此版本有未发布草稿" })).toHaveCount(0);
  await expect(page.locator(".version-graph-card .draft-node")).toHaveCount(0);
});
