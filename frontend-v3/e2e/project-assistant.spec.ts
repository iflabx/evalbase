import { test, expect, type Page, type Route } from "@playwright/test";
import { mockAccountRoute } from "./mock-account";

test("reviews candidates inside the assistant and preserves cross-page selection for a local rewrite", async ({
  page,
}) => {
  let sent: unknown;
  let scopeHash = "initial-classified-selection";
  await assistantPage(page, async (route, path) => {
    if (path === `${assistantBase}/sessions`)
      return route.fulfill({
        json: {
          sessions: [
            {
              id: "task",
              title: "尚未更新的旧名称",
              ordinal: 9,
              updated_at: "2026-10-05T08:00:00Z",
            },
          ],
        },
      });
    if (path.endsWith("/sessions/task"))
      return route.fulfill({
        json: {
          sessionId: "task",
          task: {
            title: "退款问题改写",
            goal: "改写25条，保留答案",
            stage: "awaiting_review",
            runId: "candidate_run",
            candidateScope: { hash: scopeHash, count: 25, sourceCount: 30, targetCount: 25 },
            executionPlan: {
              mode: "execute",
              current: 1,
              steps: [
                { title: "后台逐条分类", action: "submit_processing", status: "executed" },
                { title: "按类别选取", action: "select_candidates", status: "pending" },
              ],
            },
            review: {
              runId: "candidate_run",
              total: 25,
              expectedCount: 25,
              countSatisfied: true,
              emptyQuestions: 0,
              duplicates: 0,
              protectedFieldChanges: 0,
              labels: [{ label: "退款", count: 25 }],
              semanticReview: "required",
              classifications: [
                {
                  field: "expectedOutput",
                  satisfied: false,
                  missing: 0,
                  outsideValues: 0,
                  quotaDifferences: [{ value: "退款", expected: 26, actual: 25 }],
                },
              ],
            },
          },
          turns: [
            {
              id: "auto",
              event: "processing_completed",
              userText: "[processing_completed]",
              assistantText: "已核对25条候选。",
              status: "succeeded",
              tools: [{ key: "read", name: "read_processing", status: "succeeded" }],
              errorCode: null,
            },
          ],
          proposals: [],
        },
      });
    if (path.endsWith("/candidates")) {
      const offset = Number(new URL(route.request().url()).searchParams.get("offset") ?? 0);
      return route.fulfill({
        json: {
          total: 25,
          offset,
          limit: 10,
          records: Array.from({ length: Math.min(10, 25 - offset) }, (_, i) => ({
            id: `0:${offset + i}`,
            original: {
              question: `原问题 ${offset + i + 1}`,
              expectedOutput: "退款",
              metadata: [],
            },
            result: { question: `新问题 ${offset + i + 1}`, expectedOutput: "退款", metadata: [] },
          })),
        },
      });
    }
    if (path.includes("/processing-runs/"))
      return route.fulfill({
        json: {
          run: {
            status: "succeeded",
            inputCount: 25,
            progress: 100,
            options: { operation: "rewrite" },
          },
          total: 25,
        },
      });
    if (path.endsWith("/turns")) {
      sent = route.request().postDataJSON();
      return route.fulfill({ status: 202, json: { turnId: "next", status: "queued" } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await expect(page.getByRole("combobox", { name: "选择助手会话" })).toContainText("退款问题改写");
  await expect(page.getByText("候选待审核", { exact: true })).toBeVisible();
  await expect(page.getByText("期望输出：分类或配额未符合要求", { exact: true })).toBeVisible();
  await expect(page.getByText("退款：实际 25 / 要求 26 条", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "执行步骤" })).toContainText("后台逐条分类");
  await expect(page.getByRole("list", { name: "执行步骤" })).toContainText("已执行");
  await page.getByLabel("选择候选 1", { exact: true }).check();
  await page.getByRole("button", { name: "下一页候选" }).click();
  await page.getByLabel("选择候选 11", { exact: true }).check();
  await expect(page.getByText("已选 2 条候选", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看候选 11" }).click();
  await expect(page.getByRole("dialog")).toContainText("原问题 11");
  await expect(page.getByRole("dialog")).toContainText("新问题 11");
  await page.keyboard.press("Escape");
  await page.getByLabel("向项目助手发送消息").fill("只把选中的问题写得更口语");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  expect(sent).toEqual({
    message: "只把选中的问题写得更口语",
    candidates: { runId: "candidate_run", resultIds: ["0:0", "0:10"] },
  });
  scopeHash = "changed-classified-selection";
  await expect(page.getByText("已选 0 条候选", { exact: true })).toBeVisible();
  await expect(page.getByLabel("选择候选 1", { exact: true })).not.toBeChecked();
  await expect(page.getByText("共 25 条 · 第 1 页", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("log").getByText("[processing_completed]", { exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 420, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("opens the actual adopted draft from the persisted receipt", async ({ page }) => {
  await assistantPage(page, async (route, path) => {
    if (path === `${assistantBase}/sessions`)
      return route.fulfill({
        json: { sessions: [{ id: "adopted", title: "采用结果", ordinal: 1 }] },
      });
    if (path.endsWith("/sessions/adopted"))
      return route.fulfill({
        json: {
          sessionId: "adopted",
          turns: [
            {
              id: "turn",
              status: "succeeded",
              userText: "采用结果",
              assistantText: "已采用",
              tools: [],
            },
          ],
          proposals: [
            {
              id: "proposal",
              turn_id: "turn",
              action: "processing",
              status: "succeeded",
              summary: {
                title: "采用处理结果",
                count: 2,
                url: "/projects/assistant_project/processing?run=run",
              },
              receipt: { receipt: { adopted: 2, draftId: "actual_draft" } },
            },
          ],
        },
      });
    return route.fulfill({ status: 404, json: {} });
  });
  await expect(page.getByRole("link", { name: "继续编辑草稿", exact: true })).toHaveAttribute(
    "href",
    "/projects/assistant_project/test-sets/drafts/actual_draft",
  );
});

test("selects task batches without carrying checked rows into another batch and shows the final total", async ({
  page,
}) => {
  let sent: unknown;
  await assistantPage(page, async (route, path) => {
    if (path === `${assistantBase}/sessions`)
      return route.fulfill({
        json: {
          sessions: [
            { id: "multi", title: "补到两条", ordinal: 1, updated_at: "2026-10-06T00:00:00Z" },
          ],
        },
      });
    if (path.endsWith("/sessions/multi"))
      return route.fulfill({
        json: {
          sessionId: "multi",
          proposals: [],
          turns: [],
          task: {
            title: "补到两条",
            goal: "保留已有的一条",
            stage: "awaiting_review",
            runId: "second",
            runIds: ["first", "second"],
            review: {
              runId: "second",
              total: 2,
              expectedCount: 2,
              countKind: "final",
              baseCount: 1,
              remainingCount: 1,
              countSatisfied: true,
              emptyQuestions: 0,
              duplicates: 0,
              protectedFieldChanges: 0,
              labels: [],
            },
          },
        },
      });
    if (path.endsWith("/candidates")) {
      const run = new URL(route.request().url()).searchParams.get("run");
      return route.fulfill({
        json: {
          total: 1,
          offset: 0,
          limit: 10,
          records: [
            {
              id: "0:0",
              original: null,
              result: {
                question: run === "first" ? "第一批问题" : "第二批问题",
                expectedOutput: "正常回答",
                metadata: [],
              },
            },
          ],
        },
      });
    }
    if (path.includes("/processing-runs/"))
      return route.fulfill({
        json: {
          run: {
            status: "succeeded",
            inputCount: 1,
            progress: 100,
            options: { operation: "augment" },
          },
          total: 1,
        },
      });
    if (path.endsWith("/turns")) {
      sent = route.request().postDataJSON();
      return route.fulfill({ status: 202, json: { turnId: "next", status: "queued" } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await expect(page.getByText(/最终总数 2 \/ 目标 2 条/)).toBeVisible();
  await expect(page.getByText("草稿已有 1 条 · 待采用 1 条")).toBeVisible();
  await expect(page.getByText("第二批问题", { exact: true })).toBeVisible();
  await page.getByLabel("选择候选 1", { exact: true }).check();
  await page.getByRole("combobox", { name: "选择候选批次" }).click();
  await page.getByRole("option", { name: "批次 1", exact: true }).click();
  await expect(page.getByText("第一批问题", { exact: true })).toBeVisible();
  await expect(page.getByLabel("选择候选 1", { exact: true })).not.toBeChecked();
  await page.getByLabel("选择候选 1", { exact: true }).check();
  await page.getByLabel("向项目助手发送消息").fill("只改选中这一条");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  expect(sent).toEqual({
    message: "只改选中这一条",
    candidates: { runId: "first", resultIds: ["0:0"] },
  });
});

test("keeps the assistant conversation across close/reload and submits only an explicit bound confirmation", async ({
  page,
}) => {
  const base = "/api/projects/assistant_project/assistant";
  let session = false,
    sent = false,
    confirmed = false,
    confirmCount = 0;
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    if (method === "POST")
      expect(route.request().headers()["content-type"]).toBe("application/json");
    if (path === "/api/projects")
      return route.fulfill({
        json: {
          projects: [
            { id: "assistant_project", name: "助手验收项目", datasetCount: 0, testSetCount: 0 },
          ],
          pagination: { total: 1 },
        },
      });
    if (path.endsWith("/test-sets"))
      return route.fulfill({ json: { testSets: [], pagination: { total: 0 } } });
    if (path === `${base}/sessions`) {
      if (method === "POST") {
        session = true;
        return route.fulfill({ status: 201, json: { sessionId: "session" } });
      }
      return route.fulfill({
        json: {
          sessions: session
            ? [{ id: "session", ordinal: 1, updated_at: "2026-10-04T08:00:00Z" }]
            : [],
        },
      });
    }
    if (path === `${base}/sessions/session/turns`) {
      expect(route.request().postDataJSON()).toEqual({ message: "请发布这个草稿" });
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      sent = true;
      return route.fulfill({ status: 202, json: { turnId: "turn", status: "running" } });
    }
    if (path === `${base}/sessions/session`)
      return route.fulfill({
        json: {
          sessionId: "session",
          turns: sent
            ? [
                {
                  id: "turn",
                  userText: "请发布这个草稿",
                  assistantText: "已准备发布确认，请核对。",
                  status: "succeeded",
                  tools: [],
                  errorCode: null,
                },
              ]
            : [],
          proposals: sent
            ? [
                {
                  id: "proposal",
                  turn_id: "turn",
                  action: "publish",
                  summary: {
                    title: "发布正式版本",
                    target: "意图识别测试集",
                    count: 20,
                    revision: 4,
                    url: "/projects/assistant_project/test-sets/drafts/draft",
                  },
                  status: confirmed ? "succeeded" : "pending",
                  receipt: confirmed
                    ? {
                        testSet: { id: "testset" },
                        version: { id: "version", label: "v3", recordCount: 20 },
                      }
                    : null,
                  expires_at: "2099-01-01T00:00:00Z",
                },
              ]
            : [],
        },
      });
    if (path === `${base}/proposals/proposal/confirm`) {
      expect(route.request().postDataJSON()).toEqual({});
      confirmed = true;
      confirmCount++;
      return route.fulfill({ json: { receipt: { version: { id: "version" } }, replayed: false } });
    }
    return route.fulfill({ status: 404, json: { error: { code: "route_not_found" } } });
  });
  await page.goto("/projects/assistant_project/test-sets");
  await page.getByRole("button", { name: "打开项目助手" }).click();
  await expect(page.getByRole("heading", { name: "项目助手", exact: true })).toBeVisible();
  await page.getByLabel("向项目助手发送消息").fill("请发布这个草稿");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("意图识别测试集 · 20 条记录 · 草稿修订 4")).toBeVisible();
  expect(confirmCount).toBe(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "打开项目助手" }).click();
  await expect(page.getByRole("button", { name: "确认发布" })).toBeVisible();
  await page.setViewportSize({ width: 800, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "test-results/assistant-confirm-narrow.png", fullPage: true });
  await page.getByRole("button", { name: "确认发布" }).click();
  await expect.poll(() => confirmCount).toBe(1);
  await expect(page.getByRole("button", { name: "确认发布" })).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "打开项目助手" }).click();
  await expect(page.getByText("已发布 · v3", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "查看已发布版本" })).toHaveAttribute(
    "href",
    "/projects/assistant_project/test-sets/testset?version=version",
  );
  expect(confirmCount).toBe(1);
});

const assistantBase = "/api/projects/assistant_project/assistant";

test("renames sessions, retains input on failure, and confirms deletion before returning to the empty state", async ({
  page,
}) => {
  let title = "安全题库",
    deleted = false,
    renameAttempts = 0,
    deleteAttempts = 0;
  await assistantPage(page, async (route, path) => {
    if (path === `${assistantBase}/sessions`) {
      expect(route.request().method()).toBe("GET");
      return route.fulfill({
        json: {
          sessions: deleted
            ? []
            : [{ id: "manage", title, ordinal: 1, updated_at: "2026-10-06T08:00:00Z" }],
        },
      });
    }
    if (path === `${assistantBase}/sessions/manage/status`)
      return route.fulfill({ json: { exists: !deleted } });
    if (path === `${assistantBase}/sessions/manage`) {
      if (route.request().method() === "PATCH") {
        renameAttempts++;
        if (renameAttempts === 1)
          return route.fulfill({ status: 503, json: { error: { code: "unavailable" } } });
        title = route.request().postDataJSON().title;
        return route.fulfill({ json: { sessionId: "manage", title } });
      }
      if (route.request().method() === "DELETE") {
        deleteAttempts++;
        if (deleteAttempts === 1)
          return route.fulfill({ status: 503, json: { error: { code: "unavailable" } } });
        deleted = true;
        // The server committed, but its response was lost. Exact status proves removal.
        return route.fulfill({ status: 503, json: { error: { code: "response_lost" } } });
      }
      return route.fulfill({
        json: {
          sessionId: "manage",
          title,
          task: { title: "自动生成标题" },
          turns: [],
          proposals: [],
        },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.getByLabel("向项目助手发送消息").fill("尚未发送的要求");
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "重命名会话", exact: true });
  await expect(rename.getByLabel("会话名称")).toHaveValue("安全题库");
  await rename.getByLabel("会话名称").fill("  我的安全测试  ");
  await rename.getByRole("button", { name: "保存名称" }).click();
  await expect(rename.getByRole("alert")).toContainText("名称已保留");
  await expect(rename.getByLabel("会话名称")).toHaveValue("  我的安全测试  ");
  await rename.getByRole("button", { name: "保存名称" }).click();
  await expect(rename).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "选择助手会话" })).toContainText("我的安全测试");
  await expect(page.getByLabel("向项目助手发送消息")).toHaveValue("尚未发送的要求");
  await page.reload();
  await page.getByRole("button", { name: "打开项目助手" }).click();
  await expect(page.getByRole("combobox", { name: "选择助手会话" })).toContainText("我的安全测试");
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "删除会话", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "删除会话？", exact: true });
  await expect(confirm).toContainText("已创建的资料、草稿和正式版本保留");
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  expect(deleteAttempts).toBe(0);
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "删除会话", exact: true }).click();
  await confirm.getByRole("button", { name: "确认删除会话" }).click();
  await expect(confirm.getByRole("alert")).toContainText("删除未完成");
  await confirm.getByRole("button", { name: "确认删除会话" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "选择助手会话" })).toContainText("新会话");
  await expect(page.getByRole("button", { name: "会话操作" })).toBeDisabled();
  await expect(page.getByText("从当前项目开始", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 420, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("keeps background and task beside the conversation, with located preview and explicit removal", async ({
  page,
}) => {
  let uploaded = false,
    removed = false;
  const document = {
    id: "background",
    fileName: "要求.md",
    format: "md",
    fileSize: 40,
    units: 3,
    characters: 20,
    fragmentCount: 1,
  };
  await assistantPage(page, async (route, path) => {
    if (path === `${assistantBase}/sessions`)
      return route.fulfill({
        json: {
          sessions: [{ id: "background_session", ordinal: 1, updated_at: "2026-10-06T00:00:00Z" }],
        },
      });
    if (path === `${assistantBase}/sessions/background_session`)
      return route.fulfill({
        json: {
          sessionId: "background_session",
          backgroundDocuments: uploaded && !removed ? [document] : [],
          task: {
            title: "安全测试集",
            goal: "创建200条",
            stage: "waiting_input",
            requirements: ["覆盖31类风险"],
          },
          turns: removed
            ? []
            : [
                {
                  id: "old",
                  userText: "创建200条",
                  assistantText: "请上传背景要求。",
                  status: "succeeded",
                  errorCode: null,
                  tools: [],
                },
              ],
          proposals: [],
        },
      });
    if (path.endsWith("/background-documents")) {
      expect(route.request().postDataJSON()).toEqual({
        fileName: "要求.md",
        contentBase64: Buffer.from("# 要求\n覆盖31类风险\n共200条").toString("base64"),
      });
      uploaded = true;
      return route.fulfill({ status: 201, json: { document, replayed: false } });
    }
    if (path.endsWith("/background-documents/background")) {
      if (route.request().method() === "DELETE") {
        removed = true;
        return route.fulfill({ json: { removed: true } });
      }
      return route.fulfill({
        json: {
          ...document,
          fragments: [
            { index: 1, startLine: 1, endLine: 3, text: "# 要求\n覆盖31类风险\n共200条" },
          ],
        },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.getByLabel("上传背景文档").setInputFiles({
    name: "要求.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# 要求\n覆盖31类风险\n共200条"),
  });
  await expect(page.getByText("要求.md", { exact: true })).toBeVisible();
  const work = page.getByRole("complementary", { name: "任务与背景" });
  await expect(work.getByRole("heading", { name: "安全测试集" })).toBeVisible();
  await page.getByRole("button", { name: "查看背景 要求.md" }).click();
  await expect(page.getByRole("dialog").getByText("第 1–3 行", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("覆盖31类风险");
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: "打开项目助手" }).click();
  await expect(page.getByText("要求.md", { exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const box = await work.boundingBox();
      return box!.x + box!.width;
    })
    .toBeLessThanOrEqual(1281);
  const bounds = await work.boundingBox(),
    log = await page.getByRole("log").boundingBox();
  expect(bounds!.x).toBeGreaterThan(log!.x + log!.width - 1);
  await page.screenshot({ path: "test-results/assistant-background-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 420, height: 800 });
  await expect(page.getByRole("button", { name: "查看背景 要求.md" })).toBeVisible();
  expect(await page.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "test-results/assistant-background-narrow.png", fullPage: true });
  await page.getByRole("button", { name: "移除背景 要求.md" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("清除本会话正文");
  expect(removed).toBe(false);
  await page.getByRole("button", { name: "确认移除" }).click();
  await expect(page.getByText("要求.md", { exact: true })).toHaveCount(0);
  await expect(page.getByText("请上传背景要求。", { exact: true })).toHaveCount(0);
});
test("preserves a failed submission and retry identity while using another session", async ({
  page,
}) => {
  const keys: string[] = [];
  let oneSucceeded = false,
    twoSucceeded = false;
  await assistantPage(page, async (route, path) => {
    if (path === `${assistantBase}/sessions`)
      return route.fulfill({
        json: {
          sessions: [
            { id: "one", ordinal: 1, updated_at: "2026-10-04T08:00:00Z" },
            { id: "two", ordinal: 2, updated_at: "2026-10-04T07:00:00Z" },
          ],
        },
      });
    if (path.endsWith("/turns")) {
      if (path.includes("/one/")) {
        keys.push(route.request().headers()["idempotency-key"]!);
        expect(route.request().postDataJSON()).toEqual({ message: "第一会话的原始要求" });
        if (keys.length === 1)
          return route.fulfill({ status: 503, json: { error: { code: "temporary" } } });
        oneSucceeded = true;
      } else twoSucceeded = true;
      return route.fulfill({
        status: 202,
        json: { turnId: path.includes("/one/") ? "one-turn" : "two-turn" },
      });
    }
    if (/\/sessions\/(one|two)$/.test(path)) {
      const one = path.endsWith("/one"),
        done = one ? oneSucceeded : twoSucceeded;
      return route.fulfill({
        json: {
          sessionId: one ? "one" : "two",
          proposals: [],
          turns: done
            ? [
                {
                  id: one ? "one-turn" : "two-turn",
                  userText: one ? "第一会话的原始要求" : "第二会话要求",
                  assistantText: "已受理",
                  status: "succeeded",
                  tools: [],
                  errorCode: null,
                },
              ]
            : [],
        },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.getByLabel("向项目助手发送消息").fill("第一会话的原始要求");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新提交这条" })).toBeVisible();
  await page.getByRole("combobox", { name: "选择助手会话" }).click();
  await page.getByRole("option", { name: /会话 2/ }).click();
  await page.getByLabel("向项目助手发送消息").fill("第二会话要求");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("log").getByText("已受理", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "选择助手会话" }).click();
  await page.getByRole("option", { name: /会话 1/ }).click();
  await expect(page.getByRole("button", { name: "重新提交这条" })).toBeVisible();
  await page.getByRole("button", { name: "重新提交这条" }).click();
  await expect(page.getByRole("log").getByText("已受理", { exact: true })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});

test("clears private cached history when project write access is revoked", async ({ page }) => {
  let viewer = false,
    reads = 0;
  await assistantPage(page, async (route, path) => {
    if (path === `${assistantBase}/sessions`)
      return route.fulfill({
        json: { sessions: [{ id: "private", ordinal: 1, updated_at: "2026-10-04T08:00:00Z" }] },
      });
    if (path.endsWith("/sessions/private")) {
      reads++;
      return viewer
        ? route.fulfill({ status: 404, json: { error: { code: "assistant_not_found" } } })
        : route.fulfill({
            json: {
              sessionId: "private",
              proposals: [],
              turns: [
                {
                  id: "private-turn",
                  userText: "未发布草稿的独占正文",
                  assistantText: "私有草稿结果",
                  status: "succeeded",
                  tools: [],
                  errorCode: null,
                },
              ],
            },
          });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await expect(page.getByText("未发布草稿的独占正文", { exact: true })).toBeVisible();
  viewer = true;
  await page.route("**/api/projects/assistant_project/access", (route) =>
    route.fulfill({
      json: {
        access: {
          role: "viewer",
          capabilities: { read: true, write: false, export: true, manage: false },
        },
      },
    }),
  );
  await page.route("**/api/projects/assistant_project/presence", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 404, json: { error: { code: "project_not_found" } } })
      : route.fulfill({ status: 204 }),
  );
  await expect(page.getByText("未发布草稿的独占正文", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "打开项目助手" }).click();
  await expect(page.getByText("当前会话不可访问。", { exact: true })).toBeVisible();
  expect(reads).toBeGreaterThan(1);
  await expect(page.getByText("未发布草稿的独占正文", { exact: true })).toHaveCount(0);
});
async function assistantPage(
  page: Page,
  handle: (route: Route, path: string) => Promise<unknown>,
  url = "/projects/assistant_project/test-sets",
) {
  await page.route("**/api/**", async (route) => {
    if (await mockAccountRoute(route)) return;
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/projects")
      return route.fulfill({
        json: {
          projects: [{ id: "assistant_project", name: "助手验收项目" }],
          pagination: { total: 1 },
        },
      });
    if (path.endsWith("/test-sets"))
      return route.fulfill({ json: { testSets: [], pagination: { total: 0 } } });
    if (path.endsWith("/collaborative-drafts")) return route.fulfill({ json: { drafts: [] } });
    return handle(route, path);
  });
  await page.goto(url);
  await page.getByRole("button", { name: "打开项目助手" }).click();
}

test("keeps the renamed title when an older in-flight conversation response arrives", async ({
  page,
}) => {
  let title = "旧名称",
    reads = 0,
    release = () => {},
    entered = () => {},
    released = false;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await assistantPage(page, async (route, path) => {
    if (path === `${assistantBase}/sessions`)
      return route.fulfill({
        json: {
          sessions: [{ id: "title-race", title, ordinal: 1, updated_at: "2026-10-06T08:00:00Z" }],
        },
      });
    if (path === `${assistantBase}/sessions/title-race`) {
      if (route.request().method() === "PATCH") {
        title = route.request().postDataJSON().title;
        return route.fulfill({ json: { sessionId: "title-race", title } });
      }
      const snapshot = title;
      reads++;
      if (reads === 2) {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      await route.fulfill({
        json: {
          sessionId: "title-race",
          title: snapshot,
          turns: [
            { id: "active", userText: "查询", assistantText: "", status: "running", tools: [] },
          ],
          proposals: [],
        },
      });
      if (snapshot === "旧名称" && reads > 1) released = true;
      return;
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await waiting;
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "重命名会话", exact: true });
  await rename.getByLabel("会话名称").fill("持久的新名称");
  await rename.getByRole("button", { name: "保存名称" }).click();
  await expect(rename).toHaveCount(0);
  release();
  await expect.poll(() => released).toBe(true);
  await expect(page.getByRole("combobox", { name: "选择助手会话" })).toContainText("持久的新名称");
});

test("shows loading rather than an empty conversation and preserves the creation-order number", async ({
  page,
}) => {
  let release = () => {};
  await assistantPage(page, async (route, path) => {
    if (path === `${assistantBase}/sessions`)
      return route.fulfill({
        json: {
          sessions: [
            { id: "four", ordinal: 4, updated_at: "2026-10-04T08:00:00Z" },
            { id: "one", ordinal: 1, updated_at: "2026-10-04T07:00:00Z" },
          ],
        },
      });
    if (path.endsWith("/sessions/four")) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return route.fulfill({ json: { sessionId: "four", turns: [], proposals: [] } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await expect(page.getByText("正在读取会话…")).toBeVisible();
  await expect(page.getByText("从当前项目开始", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "选择助手会话" })).toContainText("会话 4");
  release();
  await expect(page.getByText("从当前项目开始", { exact: true })).toBeVisible();
});

test("acknowledges a submitted message immediately without clearing the next message on the response", async ({
  page,
}) => {
  let sent = false,
    release = () => {};
  await assistantPage(page, async (route, path) => {
    if (path === `${assistantBase}/sessions`)
      return route.fulfill({
        json: { sessions: [{ id: "four", ordinal: 4, updated_at: "2026-10-04T08:00:00Z" }] },
      });
    if (path.endsWith("/turns")) {
      expect(route.request().postDataJSON()).toEqual({ message: "改写这十条问题" });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      sent = true;
      return route.fulfill({ status: 202, json: { turnId: "turn", status: "running" } });
    }
    if (path.endsWith("/sessions/four"))
      return route.fulfill({
        json: {
          sessionId: "four",
          turns: sent
            ? [
                {
                  id: "turn",
                  userText: "改写这十条问题",
                  assistantText: "已提交。",
                  status: "succeeded",
                  tools: [],
                  errorCode: null,
                },
              ]
            : [],
          proposals: [],
        },
      });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.getByLabel("向项目助手发送消息").fill("改写这十条问题");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByRole("log", { name: "助手消息" }).getByText("改写这十条问题", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("向项目助手发送消息").fill("下一步只查看结果");
  release();
  await expect(page.getByText("已提交。", { exact: true })).toBeVisible();
  await expect(page.getByLabel("向项目助手发送消息")).toHaveValue("下一步只查看结果");
});

test("shows actual background progress, current draft scope and recoverable tool errors", async ({
  page,
}) => {
  let stage = "queued";
  await assistantPage(page, async (route, path) => {
    if (path === `${assistantBase}/sessions`)
      return route.fulfill({
        json: { sessions: [{ id: "four", ordinal: 4, updated_at: "2026-10-04T08:00:00Z" }] },
      });
    if (path.endsWith("/sessions/four"))
      return route.fulfill({
        json: {
          sessionId: "four",
          task: {
            title: "改写当前问题",
            goal: "改写当前十条问题",
            stage: "processing",
            runId: "processing_ten",
          },
          context: {
            focusDraft: "d:ten",
            drafts: [{ ref: "d:ten", name: "意图识别草稿", recordCount: 10 }],
          },
          proposals: [],
          turns: [
            {
              id: "turn",
              userText: "改写当前十条问题",
              assistantText: "处理任务已受理。",
              status: "succeeded",
              errorCode: null,
              tools: [
                {
                  key: "job",
                  name: "submit_processing",
                  status: "succeeded",
                  result: {
                    runId: "processing_ten",
                    inputCount: 10,
                    url: "/projects/assistant_project/processing?run=processing_ten",
                  },
                },
                {
                  key: "missing",
                  name: "read_records",
                  status: "failed",
                  error: { code: "assistant_reference_invalid" },
                },
              ],
            },
          ],
        },
      });
    if (path.endsWith("/processing-runs/processing_ten/status"))
      return route.fulfill({
        json: {
          run: {
            status: stage,
            progress: stage === "succeeded" ? 100 : stage === "running" ? 50 : 0,
            inputCount: 10,
            options: { operation: "augment", outputCount: 200 },
            partial: false,
          },
          total: stage === "succeeded" ? 200 : stage === "running" ? 5 : 0,
        },
      });
    return route.fulfill({ status: 404, json: {} });
  });
  await expect(page.getByText("当前草稿：意图识别草稿 · 10 条记录")).toBeVisible();
  await expect(page.getByText("扩充 · 等待中 · 10 条输入")).toBeVisible();
  await page.getByText("操作记录（2）", { exact: true }).click();
  await expect(
    page.getByText("对象引用无效，请重新查询或明确选择目标。", { exact: true }),
  ).toBeVisible();
  stage = "running";
  await expect(page.getByText("进度 50%", { exact: true })).toBeVisible();
  await expect(page.getByText("已保存 5 / 200 条候选", { exact: true })).toBeVisible();
  stage = "succeeded";
  await expect(page.getByText("扩充 · 已完成 · 200 条有效结果")).toBeVisible();
  await expect(page.getByRole("link", { name: "预览结果", exact: true })).toHaveAttribute(
    "href",
    "/projects/assistant_project/processing?run=processing_ten",
  );
});

test("binds the displayed draft and retries the original submission without losing new input", async ({
  page,
}) => {
  let release = () => {},
    attempt = 0,
    accepted = false,
    key = "";
  await assistantPage(
    page,
    async (route, path) => {
      if (path.endsWith("/collaborative-drafts/page_draft"))
        return route.fulfill({
          json: {
            draft: {
              id: "page_draft",
              projectId: "assistant_project",
              testSetId: null,
              parentVersionId: null,
              parentVersionLabel: null,
              name: "当前页面草稿",
              purpose: "",
              status: "editing",
              suspended: false,
              revision: 0,
              nameRevision: 0,
              purposeRevision: 0,
              createdBy: "admin",
              createdByName: "管理员",
              createdAt: "2026-10-04T08:00:00Z",
              updatedBy: "admin",
              updatedByName: "管理员",
              updatedAt: "2026-10-04T08:00:00Z",
              publishedVersionId: null,
            },
            records: [],
            total: 0,
            authors: {},
          },
        });
      if (path.endsWith("/events"))
        return route.fulfill({ json: { events: [], nextCursor: 0, snapshotRequired: false } });
      if (path === `${assistantBase}/sessions`)
        return route.fulfill({
          json: { sessions: [{ id: "four", ordinal: 4, updated_at: "2026-10-04T08:00:00Z" }] },
        });
      if (path.endsWith("/turns")) {
        expect(route.request().postDataJSON()).toEqual({
          message: "读取当前草稿",
          context: { kind: "draft", id: "page_draft" },
        });
        if (attempt++ === 0) {
          key = route.request().headers()["idempotency-key"]!;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return route.fulfill({ status: 503, json: { error: { code: "assistant_busy" } } });
        }
        expect(route.request().headers()["idempotency-key"]).toBe(key);
        accepted = true;
        return route.fulfill({ status: 202, json: { turnId: "bound_turn", status: "running" } });
      }
      if (path.endsWith("/sessions/four"))
        return route.fulfill({
          json: {
            sessionId: "four",
            turns: accepted
              ? [
                  {
                    id: "bound_turn",
                    userText: "读取当前草稿",
                    assistantText: "当前草稿没有记录。",
                    status: "succeeded",
                    tools: [],
                    errorCode: null,
                  },
                ]
              : [],
            proposals: [],
          },
        });
      return route.fulfill({ status: 404, json: {} });
    },
    "/projects/assistant_project/test-sets/drafts/page_draft",
  );
  await expect(page.getByText("当前草稿：当前页面草稿 · 0 条记录")).toBeVisible();
  await page.getByLabel("向项目助手发送消息").fill("读取当前草稿");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByLabel("向项目助手发送消息").fill("新的下一条消息");
  release();
  await expect(page.getByRole("button", { name: "重新提交这条" })).toBeVisible();
  await expect(page.getByRole("log").getByText("读取当前草稿", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重新提交这条" }).click();
  await expect(page.getByText("当前草稿没有记录。", { exact: true })).toBeVisible();
  await expect(page.getByLabel("向项目助手发送消息")).toHaveValue("新的下一条消息");
  expect(attempt).toBe(2);
});

test("follows new results at the bottom without pulling the user away from reading history", async ({
  page,
}) => {
  let phase = 0;
  await assistantPage(page, async (route, path) => {
    if (path === `${assistantBase}/sessions`)
      return route.fulfill({
        json: { sessions: [{ id: "four", ordinal: 4, updated_at: "2026-10-04T08:00:00Z" }] },
      });
    if (path.endsWith("/sessions/four"))
      return route.fulfill({
        json: {
          sessionId: "four",
          proposals: [],
          turns: [
            ...Array.from({ length: 12 }, (_, i) => ({
              id: `history_${i}`,
              userText: `历史问题 ${i}`,
              assistantText: "已经核对资料和记录范围。\n".repeat(10),
              status: "succeeded",
              tools: [],
              errorCode: null,
            })),
            {
              id: "current",
              userText: "查询当前状态",
              assistantText:
                phase === 0
                  ? "正在核对。"
                  : phase === 1
                    ? "第一条进度已返回。\n".repeat(15)
                    : "最终结果已返回。\n".repeat(25),
              status: phase === 2 ? "succeeded" : "running",
              tools: [],
              errorCode: null,
            },
          ],
        },
      });
    return route.fulfill({ status: 404, json: {} });
  });
  const log = page.getByRole("log", { name: "助手消息" });
  await expect(page.getByText("正在核对。", { exact: true })).toHaveCount(1);
  await expect
    .poll(() => log.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThan(5);
  await log.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect.poll(() => log.evaluate((el) => el.scrollTop)).toBeLessThan(5);
  phase = 1;
  await expect(page.getByText(/第一条进度已返回/)).toHaveCount(1);
  expect(await log.evaluate((el) => el.scrollTop)).toBeLessThan(5);
  await log.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  phase = 2;
  await expect(page.getByText(/最终结果已返回/)).toHaveCount(1);
  await expect
    .poll(() => log.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThan(5);
});

test("hides another run's diagnostics and displays model prose as readable text", async ({
  page,
}) => {
  await assistantPage(page, async (route, path) => {
    if (path === `${assistantBase}/sessions`)
      return route.fulfill({
        json: {
          sessions: [{ id: "four", title: "核对", ordinal: 4, updated_at: "2026-10-05T08:00:00Z" }],
        },
      });
    if (path.endsWith("/sessions/four"))
      return route.fulfill({
        json: {
          sessionId: "four",
          task: {
            title: "已停止",
            stage: "stopped",
            runId: "new",
            review: {
              runId: "old",
              total: 3,
              expectedCount: 3,
              countSatisfied: true,
              emptyQuestions: 0,
              duplicates: 0,
              protectedFieldChanges: 0,
              labels: [],
            },
          },
          proposals: [],
          turns: [
            {
              id: "reply",
              userText: "核对",
              assistantText:
                "## 核对\n共 **100条**，`protectedFieldChanges`：0，outsideLabels：1。",
              status: "succeeded",
              tools: [],
              errorCode: null,
            },
          ],
        },
      });
    if (path.includes("/processing-runs/"))
      return route.fulfill({
        json: {
          run: {
            status: "cancelled",
            inputCount: 20,
            progress: 0,
            options: { operation: "augment" },
          },
          total: 0,
        },
      });
    return route.fulfill({ status: 404, json: {} });
  });
  await expect(
    page.getByText("核对\n共 100条，受保护字段变化：0，超出类别：1。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/候选 3 \/ 目标 3/)).toHaveCount(0);
  await expect(page.getByText(/protectedFieldChanges/)).toHaveCount(0);
});
