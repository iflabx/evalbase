import { test, expect } from "@playwright/test";

test("selecting files only scopes the preview; stale configuration cannot be applied", async ({
  page,
}) => {
  let applications = 0;
  // This UI contract runs in a network-isolated container with all HTTP mocked.
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { get: () => true }));
  const source = {
    id: '["file",1]',
    assetId: "file",
    ordinal: 1,
    fileName: "资料.csv",
    question: "示例问题",
    expectedOutput: "示例答案",
    metadata: [{ key: "类别", value: "普通" }],
    selected: true,
  };
  const preview = {
    id: "preview",
    configuration: {
      assetIds: ["file"],
      conditions: [],
      method: "random",
      mode: "count",
      value: 500,
      seed: "evalbase-2026",
    },
    seed: "evalbase-2026",
    algorithm: "sha256-rank-v1",
    scopeCount: 1,
    candidateCount: 1,
    selectedCount: 1,
    selectedIds: [source.id],
    targetCount: 500,
    draftRevision: 0,
    appliedAt: null,
    receipt: null,
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/installation")
      return json({ needsAdministrator: false, needsMigration: false });
    if (path === "/api/session")
      return json({ csrfToken: "csrf", actor: { id: "admin", role: "admin" } });
    if (path === "/api/projects")
      return json({ projects: [{ id: "project", name: "选取项目" }], pagination: { total: 1 } });
    if (path.endsWith("/access"))
      return json({
        access: {
          role: "admin",
          capabilities: { read: true, write: true, manage: true, export: true },
        },
      });
    if (path.endsWith("/presence"))
      return route.request().method() === "POST"
        ? route.fulfill({ status: 204 })
        : json({ users: [] });
    if (path.includes("/presence/")) return route.fulfill({ status: 204 });
    if (path.endsWith("/events"))
      return json({
        events: [],
        cursor: 0,
        hasMore: false,
        needsSnapshot: false,
        status: "editing",
      });
    if (path.endsWith("/selected-sources")) return json({ sources: [] });
    if (path.endsWith("/selection-history")) return json({ history: [] });
    if (path.endsWith("/collaborative-draft-source-files"))
      return json({
        files: [
          {
            id: "file",
            fileName: "资料.csv",
            collectionName: "原始数据",
            recordCount: 1,
            metadataKeys: ["类别"],
          },
        ],
        total: 1,
      });
    if (path.endsWith("/selection-previews")) return json({ preview }, 201);
    if (path.endsWith("/preview/records"))
      return json({ preview, records: [source], total: 1, currentDraftRevision: 0 });
    if (path.endsWith("/preview/apply")) {
      applications++;
      return json({ added: 1, skipped: 0, revision: 1, replayed: false });
    }
    if (path.endsWith("/collaborative-drafts/draft"))
      return json({
        draft: {
          id: "draft",
          projectId: "project",
          testSetId: null,
          parentVersionId: null,
          name: "选取草稿",
          purpose: "",
          status: "editing",
          suspended: false,
          revision: 0,
          nameRevision: 0,
          purposeRevision: 0,
          updatedBy: "admin",
          updatedAt: "2026-10-04T00:00:00Z",
        },
        records: [],
        authors: {},
        total: 0,
      });
    return json({ error: { code: "route_not_found" } }, 404);
  });
  await page.goto("/projects/project/test-sets/drafts/draft");
  await page.getByRole("tab", { name: /添加资料/ }).click();
  await expect(page.getByRole("heading", { name: "筛选与选取" })).toBeVisible();
  await page.getByRole("checkbox", { name: "选择 资料.csv" }).click();
  expect(applications).toBe(0);
  await page.getByRole("button", { name: "生成预览", exact: true }).click();
  await expect(page.getByRole("row", { name: /示例问题/ })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Metadata" })).toBeVisible();
  await expect(page.getByRole("row", { name: /示例问题/ })).toContainText("普通");
  await expect(page.getByText("目标为 500 条，但筛选后只有 1 条，已选取全部候选。")).toBeVisible();
  const apply = page.getByRole("button", { name: /确认加入草稿/ });
  await expect(apply).toBeEnabled();
  await page.getByLabel("抽取数量").fill("2");
  await expect(apply).toBeDisabled();
  await expect(page.getByText(/配置已修改/)).toBeVisible();
  await page.getByRole("button", { name: "更新预览", exact: true }).click();
  await page.getByRole("row", { name: /示例问题/ }).click();
  await expect(page.getByRole("dialog")).toContainText("示例答案");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath("selection-desktop.png"), fullPage: true });
  await apply.click();
  await expect(page.getByText(/已加入 1 条/)).toBeVisible();
  expect(applications).toBe(1);
  await page.setViewportSize({ width: 800, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: test.info().outputPath("selection-narrow.png"), fullPage: true });
});
