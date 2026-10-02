import { expect, test, type BrowserContext } from "@playwright/test";

const projectId = process.env["V2C_PROJECT_ID"];
const draftId = process.env["V2C_DRAFT_ID"];
const base = process.env["PLAYWRIGHT_BASE_URL"];
test.skip(!projectId || !draftId || !base, "Requires the isolated V2-C checkpoint");

async function signedIn(context: BrowserContext, email: string, password: string) {
  const response = await context.request.post(`${base}/api/session`, {
    headers: { origin: base! },
    data: { email, password },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test("empty Metadata accepts peer updates but genuine empty-value edits still conflict", async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const editorContext = await browser.newContext();
  try {
    await signedIn(
      adminContext,
      process.env["V2C_ADMIN_EMAIL"] ?? "admin-v2c@example.test",
      process.env["V2C_ADMIN_PASSWORD"]!,
    );
    await signedIn(
      editorContext,
      process.env["V2C_EDITOR_EMAIL"] ?? "editor-v2c@example.test",
      process.env["V2C_EDITOR_PASSWORD"]!,
    );
    const admin = await adminContext.newPage();
    const editor = await editorContext.newPage();
    const path = `/projects/${projectId}/test-sets/drafts/${draftId}`;
    await Promise.all([admin.goto(path), editor.goto(path)]);
    await admin.getByRole("button", { name: "新增记录", exact: true }).click();
    const adminPanel = admin.getByLabel("记录编辑区");
    const question = `Metadata 协作回归 ${Date.now()}`;
    await adminPanel.getByRole("textbox", { name: "问题" }).fill(question);
    await adminPanel.getByRole("textbox", { name: "问题" }).blur();
    await expect(admin.getByText("已保存", { exact: true })).toBeVisible();
    await editor.getByRole("row").filter({ hasText: question }).click();
    const editorPanel = editor.getByLabel("记录编辑区");
    const editorKey = editorPanel.getByRole("textbox", { name: "第 1 项 Metadata 字段名" });
    const adminKey = adminPanel.getByRole("textbox", { name: "第 1 项 Metadata 字段名" });
    await editorKey.fill("备注");
    await editorPanel.getByRole("textbox", { name: "问题" }).focus();
    await expect(editor.getByText("已保存", { exact: true })).toBeVisible();
    await expect(adminKey).toHaveValue("备注", { timeout: 5000 });
    await expect(adminPanel.getByRole("textbox", { name: "第 1 项 Metadata 值" })).toHaveValue("");
    await expect(admin.getByText("已保存", { exact: true })).toBeVisible();
    await expect(admin.getByRole("button", { name: "采用对方输入" })).toHaveCount(0);
    await editorContext.setOffline(true);
    await editorKey.fill("本地备注");
    await adminKey.fill("远端备注");
    await adminPanel.getByRole("textbox", { name: "问题" }).focus();
    await expect(admin.getByText("已保存", { exact: true })).toBeVisible();
    await editorContext.setOffline(false);
    await expect(editor.getByRole("button", { name: "采用对方输入" })).toBeVisible({
      timeout: 7000,
    });
    await expect(editorKey).toHaveValue("本地备注");
    await editor.getByRole("button", { name: "采用对方输入" }).click();
    await expect(editorKey).toHaveValue("远端备注");
    await expect(editor.getByText("已保存", { exact: true })).toBeVisible();
    await admin.getByRole("button", { name: "退出草稿" }).click();
    await expect(admin).toHaveURL(new RegExp(`/projects/${projectId}/test-sets/`));
  } finally {
    await Promise.all([adminContext.close(), editorContext.close()]);
  }
});

test("two accounts see field focus, live saves and a resolvable same-field conflict", async ({
  browser,
}) => {
  test.setTimeout(45000);
  const adminContext = await browser.newContext();
  const editorContext = await browser.newContext();
  try {
    await signedIn(
      adminContext,
      process.env["V2C_ADMIN_EMAIL"] ?? "admin-v2c@example.test",
      process.env["V2C_ADMIN_PASSWORD"]!,
    );
    await signedIn(
      editorContext,
      process.env["V2C_EDITOR_EMAIL"] ?? "editor-v2c@example.test",
      process.env["V2C_EDITOR_PASSWORD"]!,
    );
    const admin = await adminContext.newPage();
    const editor = await editorContext.newPage();
    let sourceReads = 0,
      presenceReads = 0,
      eventReads = 0;
    editor.on("request", (request) => {
      if (request.method() !== "GET") return;
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/source-selection") || path.endsWith("/selected-sources")) sourceReads++;
      if (path.endsWith("/presence")) presenceReads++;
      if (path.endsWith("/events")) eventReads++;
    });
    const path = `/projects/${projectId}/test-sets/drafts/${draftId}`;
    await Promise.all([admin.goto(path), editor.goto(path)]);
    await expect(admin.getByRole("heading", { name: /继续创建新版本/ })).toBeVisible();
    await expect(editor.getByRole("heading", { name: /继续创建新版本/ })).toBeVisible();
    await expect(admin.locator("header").getByLabel("在线成员").getByRole("img")).toHaveCount(2, {
      timeout: 5000,
    });
    await admin.locator("tbody tr").first().click();
    await editor.locator("tbody tr").first().click();
    const adminPanel = admin.getByLabel("记录编辑区");
    const editorPanel = editor.getByLabel("记录编辑区");
    const adminQuestion = adminPanel.getByRole("textbox", { name: "问题" });
    const editorQuestion = editorPanel.getByRole("textbox", { name: "问题" });
    await adminQuestion.focus();
    await expect(editorPanel.getByLabel("管理员正在编辑问题")).toBeVisible({ timeout: 5000 });
    await admin.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(editorPanel.getByLabel("管理员正在编辑问题")).toHaveCount(0, {
      timeout: 5000,
    });
    await admin.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(editorPanel.getByLabel("管理员正在编辑问题")).toBeVisible({
      timeout: 5000,
    });
    const sourcesBefore = sourceReads;
    const update = `协作同步问题 ${Date.now()}`;
    await adminQuestion.fill(update);
    await adminQuestion.blur();
    await expect(admin.getByText("已保存", { exact: true })).toBeVisible();
    const savedAt = Date.now();
    await expect(editorQuestion).toHaveValue(update, { timeout: 2500 });
    console.log(`COLLAB-07 confirmed-save-to-peer-ms=${Date.now() - savedAt}`);
    expect(sourceReads).toBe(sourcesBefore);
    await editorContext.setOffline(true);
    await editorQuestion.fill(`编辑者本地值 ${Date.now()}`);
    const local = await editorQuestion.inputValue();
    await adminQuestion.fill(`管理员冲突值 ${Date.now()}`);
    await adminQuestion.blur();
    await expect(admin.getByText("已保存", { exact: true })).toBeVisible();
    await editorContext.setOffline(false);
    await expect(editor.getByText("问题冲突")).toBeVisible({ timeout: 5000 });
    await expect(editorQuestion).toHaveValue(local);
    await expect(editor.getByText("我的未保存输入：", { exact: false })).toContainText(local);
    await editor.getByRole("button", { name: "保留我的输入" }).click();
    await editor.getByRole("button", { name: "重试保存", exact: true }).click();
    await expect(adminQuestion).toHaveValue(local, { timeout: 2500 });
    await admin.screenshot({ path: "/evidence/v2c-admin-draft.png", fullPage: true });
    await editor.screenshot({ path: "/evidence/v2c-editor-draft.png", fullPage: true });
    const presenceBefore = presenceReads;
    await editor.waitForTimeout(4200);
    expect(presenceReads - presenceBefore).toBeLessThanOrEqual(3);
    await editor.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await editor.waitForTimeout(200);
    const eventsBefore = eventReads;
    await editor.waitForTimeout(2200);
    expect(eventReads).toBe(eventsBefore);
    await editor.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => eventReads, { timeout: 2000 }).toBeGreaterThan(eventsBefore);
    await editor.setViewportSize({ width: 960, height: 760 });
    await editor.screenshot({ path: "/evidence/architecture-draft-narrow.png", fullPage: true });
    expect(
      await editor.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBeTruthy();
    await editorContext.close();
    await expect(admin.locator("header").getByLabel("在线成员").getByRole("img")).toHaveCount(1, {
      timeout: 20000,
    });
  } finally {
    await Promise.all([adminContext.close(), editorContext.close()]);
  }
});

test("revocation hides cached draft content and keeps only unsent input", async ({ browser }) => {
  const adminContext = await browser.newContext();
  const editorContext = await browser.newContext();
  let editorId = "";
  let csrf = "";
  try {
    const login = await adminContext.request.post(`${base}/api/session`, {
      headers: { origin: base! },
      data: {
        email: process.env["V2C_ADMIN_EMAIL"] ?? "admin-v2c@example.test",
        password: process.env["V2C_ADMIN_PASSWORD"]!,
      },
    });
    expect(login.ok(), await login.text()).toBeTruthy();
    csrf = (await login.json()).csrfToken;
    await signedIn(
      editorContext,
      process.env["V2C_EDITOR_EMAIL"] ?? "editor-v2c@example.test",
      process.env["V2C_EDITOR_PASSWORD"]!,
    );
    const members = await adminContext.request.get(`${base}/api/projects/${projectId}/members`);
    expect(members.ok()).toBeTruthy();
    editorId = (await members.json()).members.find(
      (member: { email: string }) =>
        member.email === (process.env["V2C_EDITOR_EMAIL"] ?? "editor-v2c@example.test"),
    ).id;
    expect(editorId).toBeTruthy();
    const editor = await editorContext.newPage();
    await editor.goto(`/projects/${projectId}/test-sets/drafts/${draftId}`);
    await editor.locator("tbody tr").first().click();
    const panel = editor.getByLabel("记录编辑区");
    const remoteAnswer = await panel.getByRole("textbox", { name: "期望输出" }).inputValue();
    const local = `失权前未提交的输入 ${Date.now()}`;
    await panel.getByRole("textbox", { name: "问题" }).fill(local);
    const projectPresence = editor.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.pathname === `/api/projects/${projectId}/presence` &&
          url.search === "" &&
          response.request().method() === "GET" &&
          response.status() === 200
        );
      },
      { timeout: 10000 },
    );
    const revoke = await adminContext.request.patch(
      `${base}/api/projects/${projectId}/members/${editorId}`,
      { headers: { origin: base!, "x-csrf-token": csrf }, data: { role: "viewer" } },
    );
    expect(revoke.status(), await revoke.text()).toBe(200);
    await expect(editor.getByRole("heading", { name: "草稿访问已结束" })).toBeVisible({
      timeout: 7000,
    });
    await expect(editor.getByText(local)).toBeVisible();
    await expect(editor.getByLabel("记录编辑区")).toHaveCount(0);
    await projectPresence;
    await expect(
      editor.locator("header").getByRole("img", { name: "编辑（我） · 查看 · 在线" }),
    ).toBeVisible();
    await expect(editor.locator("main").last()).not.toContainText(remoteAnswer);
  } finally {
    if (editorId && csrf) {
      const restore = await adminContext.request.patch(
        `${base}/api/projects/${projectId}/members/${editorId}`,
        { headers: { origin: base!, "x-csrf-token": csrf }, data: { role: "editor" } },
      );
      expect(restore.status(), await restore.text()).toBe(200);
    }
    await Promise.all([adminContext.close(), editorContext.close()]);
  }
});

test("two real accounts publish one version and preserve the parent version", async ({
  browser,
}) => {
  test.skip(process.env["V2C_RUN_PUBLISH"] !== "1", "Run once after the draft checkpoint is ready");
  const adminContext = await browser.newContext();
  const editorContext = await browser.newContext();
  try {
    const sessions = await Promise.all([
      adminContext.request.post(`${base}/api/session`, {
        headers: { origin: base! },
        data: {
          email: process.env["V2C_ADMIN_EMAIL"] ?? "admin-v2c@example.test",
          password: process.env["V2C_ADMIN_PASSWORD"]!,
        },
      }),
      editorContext.request.post(`${base}/api/session`, {
        headers: { origin: base! },
        data: {
          email: process.env["V2C_EDITOR_EMAIL"] ?? "editor-v2c@example.test",
          password: process.env["V2C_EDITOR_PASSWORD"]!,
        },
      }),
    ]);
    for (const session of sessions) expect(session.status(), await session.text()).toBe(200);
    const tokens = await Promise.all(
      sessions.map(async (session) => (await session.json()).csrfToken as string),
    );
    const before = await adminContext.request.get(
      `${base}/api/projects/${projectId}/collaborative-drafts/${draftId}`,
    );
    expect(before.status(), await before.text()).toBe(200);
    const draft = (await before.json()).draft as {
      revision: number;
      testSetId: string;
      parentVersionId: string;
    };
    const publicationUrl = `${base}/api/projects/${projectId}/collaborative-drafts/${draftId}/publish`;
    const published = await Promise.all(
      [adminContext, editorContext].map((context, index) =>
        context.request.post(publicationUrl, {
          headers: { origin: base!, "x-csrf-token": tokens[index]! },
          data: { revision: draft.revision },
        }),
      ),
    );
    expect(published.map((item) => item.status()).sort()).toEqual([200, 201]);
    const results = await Promise.all(published.map((item) => item.json()));
    expect(results[0].version.id).toBe(results[1].version.id);
    const versionId = results[0].version.id as string;
    const testSetId = results[0].testSet.id as string;
    const parent = await adminContext.request.get(
      `${base}/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${draft.parentVersionId}`,
    );
    expect(parent.status(), await parent.text()).toBe(200);
    const csv = await adminContext.request.get(
      `${base}/api/projects/${projectId}/solo-test-sets/${testSetId}/versions/${draft.parentVersionId}/data.csv`,
    );
    expect(csv.status(), await csv.text()).toBe(200);
    const created = await adminContext.request.post(
      `${base}/api/projects/${projectId}/collaborative-drafts`,
      {
        headers: { origin: base!, "x-csrf-token": tokens[0]! },
        data: { testSetId, parentVersionId: versionId },
      },
    );
    expect([200, 201]).toContain(created.status());
    const nextDraftId = (await created.json()).draft.id as string;
    const admin = await adminContext.newPage();
    const editor = await editorContext.newPage();
    await Promise.all([
      admin.goto(`/projects/${projectId}/test-sets/${testSetId}?version=${versionId}`),
      editor.goto(`/projects/${projectId}/test-sets/drafts/${nextDraftId}`),
    ]);
    await expect(admin.getByRole("heading", { name: /协作验收测试集/ })).toBeVisible();
    await expect(editor.getByRole("heading", { name: /继续创建新版本/ })).toBeVisible();
    console.log(`PUB-01 same-version=${versionId} next-draft=${nextDraftId}`);
  } finally {
    await Promise.all([adminContext.close(), editorContext.close()]);
  }
});

test("a newly added visible record keeps synchronizing later edits", async ({ browser }) => {
  const adminContext = await browser.newContext();
  const editorContext = await browser.newContext();
  try {
    await signedIn(
      adminContext,
      process.env["V2C_ADMIN_EMAIL"] ?? "admin-v2c@example.test",
      process.env["V2C_ADMIN_PASSWORD"]!,
    );
    await signedIn(
      editorContext,
      process.env["V2C_EDITOR_EMAIL"] ?? "editor-v2c@example.test",
      process.env["V2C_EDITOR_PASSWORD"]!,
    );
    const admin = await adminContext.newPage();
    const editor = await editorContext.newPage();
    const path = `/projects/${projectId}/test-sets/drafts/${draftId}`;
    await Promise.all([admin.goto(path), editor.goto(path)]);
    await expect(editor.getByRole("heading", { name: /继续创建新版本/ })).toBeVisible();
    await admin.getByRole("button", { name: "新增记录", exact: true }).click();
    const question = admin.getByLabel("记录编辑区").getByRole("textbox", { name: "问题" });
    const initial = `新增初值${Date.now().toString().slice(-5)}`;
    const changed = `新增改值${Date.now().toString().slice(-5)}`;
    await question.fill(initial);
    await question.blur();
    await expect(admin.getByText("已保存", { exact: true })).toBeVisible();
    await expect(editor.locator("tbody tr").filter({ hasText: initial })).toHaveCount(1, {
      timeout: 2500,
    });
    await question.fill(changed);
    await question.blur();
    await expect(admin.getByText("已保存", { exact: true })).toBeVisible();
    await expect(editor.locator("tbody tr").filter({ hasText: changed })).toHaveCount(1, {
      timeout: 2500,
    });
  } finally {
    await Promise.all([adminContext.close(), editorContext.close()]);
  }
});
