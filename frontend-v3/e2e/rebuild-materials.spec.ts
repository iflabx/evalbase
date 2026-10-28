import { expect, test, type Page } from "@playwright/test";
import { mockAccountRoute } from "./mock-account";

const project = "r05_project",
  collection = "r05_collection",
  asset = "r05_asset";
const root = `/api/projects/${project}`,
  sessions = `${root}/assistant-runtime/sessions`;
const assistant = `/projects/${project}/assistant`;
async function fixture(page: Page, count = 3, viewer = false) {
  const state = {
    recordsSeen: 0,
    recordGate: undefined as Promise<void> | undefined,
    posts: [] as { path: string; body: any; key?: string | undefined }[],
    scopes: [] as any[],
    cancelled: 0,
    confirmations: 0,
    uploadBytes: "",
    loseConfirm: false,
    snapshot: {
      currentRuntime: "deepagents-v3",
      canWrite: true,
      session: {
        id: "r05_session",
        runtime_version: "deepagents-v3",
        title: "新会话",
        revision: 1,
        requirements_revision: 0,
        status: "idle",
        requirements: { objective: "", mode: "plan", deliveries: [] },
      },
      messages: [],
      turns: [],
      execution: null,
      confirmations: [],
      receipts: [],
      results: [],
      workspace: {
        cursor: "0",
        attachments: [] as { id: string; name: string }[],
        streams: [],
        process: [],
        nativeActions: [] as any[],
      },
    },
  };
  const records = Array.from({ length: count }, (_, i) => ({
    assetId: asset,
    ordinal: i + 1,
    sourceFile: "三条.csv",
    question: `问题 ${i + 1}`,
    expectedOutput: "答案",
    metadata: [],
  }));
  const pending = {
    id: "pending_one",
    fileName: "three.csv",
    format: "csv",
    size: 50,
    recordCount: 3,
    fields: [
      { path: "question", sample: " A " },
      { path: "expectedOutput", sample: "answer" },
    ],
    issues: [],
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    const reply = (json: any, status = 200) => route.fulfill({ json, status });
    if (viewer && path === root + "/access")
      return reply({
        access: {
          role: "viewer",
          capabilities: { read: true, write: false, export: false, manage: false },
        },
      });
    if (await mockAccountRoute(route)) return;
    if (path === "/api/projects")
      return reply({ projects: [{ id: project, name: "资料验收" }], pagination: { total: 1 } });
    if (path === root + "/collections")
      return reply({
        collections: [
          { id: collection, name: "未整理", isUnfiled: true, fileCount: 1, unifiedRecordCount: 3 },
        ],
        pagination: { total: 1 },
      });
    if (path === `${root}/collections/${collection}/assets/${asset}`)
      return reply({
        asset: { fileName: "三条.csv", format: "csv", recordCount: 3, mappingReady: true },
      });
    if (path === `${root}/collections/${collection}/records`) {
      state.recordsSeen++;
      if (state.recordGate) await state.recordGate;
      const search = url.searchParams.get("search") ?? "";
      const matches = records.filter((r) => r.question.includes(search));
      return reply({
        records: matches.slice(
          Number(url.searchParams.get("offset") ?? 0),
          Number(url.searchParams.get("offset") ?? 0) + 10,
        ),
        pagination: { total: matches.length },
      });
    }
    if (path === `${root}/assistant-runtime/input-scope`) {
      const body = req.postDataJSON();
      state.scopes.push(body);
      const chosen =
        body.mode === "selected"
          ? body.records
          : records.filter(
              (r) => body.mode !== "matching" || r.question.includes(body.search ?? ""),
            );
      return reply({
        source: {
          kind: "assets",
          assetIds: [asset],
          recordIds: chosen.map((r: any) => `record_${r.ordinal}`),
        },
        sourceRevision: "fixed-revision",
        total: chosen.length,
      });
    }
    if (path === sessions)
      return reply(
        req.method() === "POST"
          ? state.snapshot
          : { sessions: [state.snapshot.session], nextOffset: null },
      );
    if (path === sessions + "/r05_session") return reply(state.snapshot);
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: `event: snapshot\ndata: ${JSON.stringify(state.snapshot)}\n\n`,
      });
    if (path.endsWith("/messages")) {
      state.posts.push({ path, body: req.postDataJSON() });
      return reply({ turnId: "turn1" }, 202);
    }
    if (path === root + "/pending-uploads") {
      state.uploadBytes = req.postData() ?? "";
      return reply({ pendingUpload: pending }, 201);
    }
    if (path === root + "/pending-uploads/pending_one/preview")
      return reply({
        ...pending,
        preview: [{ question: " A ", expectedOutput: "answer", metadata: [] }],
      });
    if (path === root + "/pending-upload-batches/confirm") {
      state.confirmations++;
      state.posts.push({ path, body: req.postDataJSON(), key: req.headers()["idempotency-key"] });
      if (state.loseConfirm) {
        state.loseConfirm = false;
        return route.abort("failed");
      }
      return reply({ assets: [{ id: "uploaded_asset", fileName: "three.csv" }] });
    }
    if (path === root + "/pending-upload-batches") {
      state.cancelled++;
      return reply({ cancelled: true });
    }
    if (path.endsWith("/attachments") && req.method() === "POST") {
      state.posts.push({ path, body: req.postDataJSON() });
      const doc = { id: "document_one", name: "预约说明.md" };
      state.snapshot.workspace.attachments = [doc];
      return reply(doc);
    }
    if (path.endsWith("/attachments/document_one")) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return reply({
        id: "document_one",
        name: "预约说明.md",
        extracted: {
          fragments: [
            {
              text: offset ? "第六片段正文" : "第一片段正文",
              startLine: offset ? 26 : 1,
              endLine: offset ? 30 : 5,
            },
          ],
        },
        offset,
        nextOffset: offset ? null : 5,
        total: 6,
        truncated: !offset,
      });
    }
    return reply({ error: { code: "unmocked:" + path } }, 404);
  });
  return state;
}
test("R05 real page checkboxes and top-bar handoff preserve only the two chosen rows", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(`/projects/${project}/datasets/${collection}/files/${asset}`);
  await page.getByRole("checkbox", { name: "选择 三条.csv 第 1 条" }).check();
  await page.getByRole("checkbox", { name: "选择 三条.csv 第 3 条" }).check();
  await page.getByRole("button", { name: "打开项目助手" }).click();
  await expect(page).toHaveURL(/assistant\?.*selection=/);
  expect(state.scopes).toEqual([
    {
      collectionId: collection,
      assetId: asset,
      mode: "selected",
      records: [
        { assetId: asset, ordinal: 1 },
        { assetId: asset, ordinal: 3 },
      ],
    },
  ]);
  await page
    .getByRole("complementary")
    .getByRole("button", { name: "新会话", exact: true })
    .click();
  await page.getByRole("textbox", { name: "描述你的需求" }).fill("看看我选中的记录");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0]!.body).toMatchObject({
    text: "看看我选中的记录",
    context: { kind: "assets", assetIds: [asset], recordIds: ["record_1", "record_3"] },
    contextRevision: "fixed-revision",
  });
});
test("R05 clear selection refuses implicit whole-file handoff and explicit matching keeps search", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(`/projects/${project}/datasets/${collection}/files/${asset}`);
  await page.getByRole("button", { name: "勾选本页", exact: true }).click();
  await page.getByRole("button", { name: "清空选择", exact: true }).click();
  await page.getByRole("button", { name: "打开项目助手" }).click();
  await expect(page.getByRole("alert")).toContainText("请先勾选记录");
  expect(state.scopes).toHaveLength(0);
  await page.getByRole("textbox", { name: "搜索文件记录" }).fill("问题 2");
  await expect(page.getByRole("checkbox")).toHaveCount(1);
  await page.getByRole("button", { name: "其他范围", exact: true }).click();
  await page.getByRole("menuitem", { name: "将全部匹配记录交给助手（1 条）" }).click();
  await expect(page).toHaveURL(/assistant\?.*selection=/);
  expect(state.scopes[0]).toMatchObject({ mode: "matching", search: "问题 2" });
});
test("R05 native upload is previewed before confirmation, retries one confirmation and carries the saved asset", async ({
  page,
}) => {
  const state = await fixture(page);
  state.loseConfirm = true;
  await page.goto(assistant + "/r05_session");
  await page.getByRole("button", { name: "上传原始数据", exact: true }).click();
  await page
    .locator("#upload-files")
    .setInputFiles({
      name: "three.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("question,expectedOutput\n A ,answer\nB,b\nC,c\n"),
    });
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(page.getByRole("heading", { name: "字段映射与预览" })).toBeVisible();
  expect(state.confirmations).toBe(0);
  expect(state.uploadBytes).toContain(" A ,answer");
  await page.getByRole("button", { name: "确认保存", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "确认保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.confirmations).toBe(2);
  expect(state.posts[0]!.key).toBe(state.posts[1]!.key);
  await expect(page.getByText("本条消息的资料：three.csv")).toBeVisible();
  await page.getByRole("textbox", { name: "描述你的需求" }).fill("把这份文件移到资料集合");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(3);
  expect(state.posts[2]!.body.context).toEqual({ kind: "assets", assetIds: ["uploaded_asset"] });
});
test("R05 upload cancel never confirms a file, background keeps real line references and pagination", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto(assistant + "/r05_session");
  await page.getByRole("button", { name: "上传原始数据", exact: true }).click();
  await page
    .locator("#upload-files")
    .setInputFiles({
      name: "three.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("question\nA\n"),
    });
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(page.getByRole("heading", { name: "字段映射与预览" })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect.poll(() => state.cancelled).toBe(1);
  expect(state.confirmations).toBe(0);
  await page
    .locator('input[type="file"][accept=".txt,.md,.pdf"]')
    .setInputFiles({
      name: "预约说明.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("预约分类：改期、取消。"),
    });
  await page.getByRole("button", { name: "预约说明.md", exact: true }).click();
  await expect(page.getByText("第 1–5 行", { exact: true })).toBeVisible();
  await expect(page.getByText("当前显示部分原文，未展示完整文档。")).toBeVisible();
  await page.getByRole("button", { name: "文档下一页", exact: true }).click();
  await expect(page.getByText("第 26–30 行", { exact: true })).toBeVisible();
  await expect(page.getByText("第六片段正文")).toBeVisible();
  await page.setViewportSize({ width: 480, height: 900 });
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(state.posts.every((p) => !p.path.includes("processing"))).toBe(true);
});
test("R05 v2 history stays read only under v3 and does not expose upload", async ({ page }) => {
  const state = await fixture(page);
  state.snapshot.session.runtime_version = "deepagents-v2";
  state.snapshot.canWrite = false;
  await page.goto(assistant + "/r05_session");
  await expect(
    page.getByText("旧会话只读保留；请点“新会话”继续，原成果与预算不变。"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "上传原始数据", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "添加背景文档", exact: true })).toBeDisabled();
});

test("R05 top-bar handoff keeps selected rows during page loading", async ({ page }) => {
  const state = await fixture(page, 12);
  await page.goto(`/projects/${project}/datasets/${collection}/files/${asset}`);
  await page.getByRole("checkbox", { name: "选择 三条.csv 第 1 条" }).check();
  let release!: () => void;
  state.recordGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect.poll(() => state.recordsSeen).toBe(2);
  await expect(page.getByText("已选 1 条", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "打开项目助手" }).click();
  await expect(page).toHaveURL(/assistant\?.*selection=/);
  expect(state.scopes).toEqual([
    {
      collectionId: collection,
      assetId: asset,
      mode: "selected",
      records: [{ assetId: asset, ordinal: 1 }],
    },
  ]);
  release();
});
test("R05 search empty state retains selection and exact top-bar handoff", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/projects/${project}/datasets/${collection}/files/${asset}`);
  await page.getByRole("checkbox", { name: "选择 三条.csv 第 3 条" }).check();
  await page.getByRole("textbox", { name: "搜索文件记录" }).fill("没有这种记录");
  await expect(page.getByText("没有可浏览的记录", { exact: true })).toBeVisible();
  await expect(page.getByText("已选 1 条", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "打开项目助手" }).click();
  await expect(page).toHaveURL(/assistant\?.*selection=/);
  expect(state.scopes).toEqual([
    {
      collectionId: collection,
      assetId: asset,
      mode: "selected",
      records: [{ assetId: asset, ordinal: 3 }],
    },
  ]);
});

test("R05 viewer can query but cannot upload background or raw materials", async ({ page }) => {
  const state = await fixture(page, 3, true);
  state.snapshot.canWrite = false;
  await page.goto(assistant + "/r05_session");
  await expect(page.getByRole("button", { name: "添加背景文档", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "上传原始数据", exact: true })).toHaveCount(0);
  await page
    .locator('input[type="file"][accept=".txt,.md,.pdf"]')
    .setInputFiles({
      name: "预约说明.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("预约分类：改期、取消。"),
    });
  expect(state.posts).toHaveLength(0);
  await page.getByRole("textbox", { name: "描述你的需求" }).fill("查看当前项目资料");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
});
