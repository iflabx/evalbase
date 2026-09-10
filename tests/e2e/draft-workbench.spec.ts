import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { createPool } from "../../src/db/pool.js";
import { hashPassword } from "../../src/security/password.js";
import {
  buildCapacityFixture,
  buildCapacityFixtureValue,
} from "../fixtures/capacity-boundaries.js";

const draftStorageKey = "agentbench.ticket04.draft";
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://evalbase_phase1a:synthetic-nonproduction-only@postgres:5432/evalbase_phase1a";

async function uploadSyntheticCsv(page: any, name: string) {
  await page.getByRole("button", { name: "进入 AgentBench" }).click();
  await page.getByLabel("资产文件").setInputFiles("tests/fixtures/owner.csv");
  await page.getByLabel("来源名称").fill(name);
  await page.getByLabel("使用目的").fill("Ticket 04 browser evidence");
  await page.getByRole("button", { name: "保存并解析" }).click();
  await expect(page.getByText("Can I get a refund?")).toBeVisible();
}

async function openWorkingDraft(page: any) {
  await page
    .getByRole("button", { name: "创建 Working Draft 并附加此资产" })
    .click();
  await expect(page).toHaveURL(/\/workbench\/[^/]+$/u);
}

async function uploadAnotherSyntheticCsv(page: any, name: string) {
  await page.getByRole("link", { name: "数据资产", exact: true }).click();
  await expect(page).toHaveURL(/\/assets$/u);
  await page.getByLabel("资产文件").setInputFiles("tests/fixtures/owner.csv");
  await page.getByLabel("来源名称").fill(name);
  const parsedReady = page.waitForResponse(async (response: any) => {
    if (!/\/assets\/[^/]+\/records(?:\?|$)/u.test(response.url())) return false;
    const body = await response.json().catch(() => null);
    return body?.parsedView?.status === "ready";
  });
  await page.getByRole("button", { name: "保存并解析" }).click();
  await expect(page).toHaveURL(/\/assets\/[^/]+$/u);
  await parsedReady;
  await expect(
    page.getByRole("button", { name: "追加此资产到当前草稿" }),
  ).toBeEnabled();
}

async function uploadOverLimitJsonl(page: any, name: string) {
  await page.getByRole("button", { name: "进入 AgentBench" }).click();
  await page.getByLabel("资产文件").setInputFiles({
    name: "over-limit.jsonl",
    mimeType: "application/x-ndjson",
    buffer: buildCapacityFixture("source-over-10000-jsonl").bytes,
  });
  await page.getByLabel("来源名称").fill(name);
  await page.getByLabel("使用目的").fill("Ticket 06 browser capacity evidence");
  await page.getByRole("button", { name: "保存并解析" }).click();
}

test("Workbench auto-saves and restores the full browser recipe", async ({
  page,
}) => {
  await page.goto("/");
  await uploadSyntheticCsv(page, "Ticket 04 restore fixture");
  await openWorkingDraft(page);
  await expect(page.getByLabel("Working Draft 容量")).toContainText("附件 1/5");
  await expect(page.getByLabel("Working Draft 容量")).toContainText(
    "100,000,000 bytes",
  );
  await expect(page.getByLabel("策展顺序")).toContainText(
    "1. Source attachment / lease",
  );
  await expect(page.getByLabel("策展顺序")).toContainText(
    "5. Validation / publish",
  );
  await expect(page.getByLabel("Working Draft 状态摘要")).toBeVisible();

  await uploadAnotherSyntheticCsv(page, "Ticket 06 second attachment");
  const attachButton = page.getByRole("button", {
    name: "追加此资产到当前草稿",
  });
  await expect(attachButton).toBeEnabled();
  await attachButton.click();
  await expect(page.getByText(/附件 2\/5 已保存/)).toBeVisible();
  await expect(page.getByLabel("Working Draft 容量")).toContainText("附件 2/5");

  await page.getByLabel("筛选操作").selectOption("contains");
  await page.getByLabel("筛选值").fill("billing");
  await page.getByLabel("编辑完整递归布尔树").check();
  await page.getByLabel("递归布尔筛选树 JSON").fill(
    JSON.stringify({
      all: [
        {
          any: [
            { field: "/category", operator: "eq", value: "billing" },
            { field: "/category", operator: "eq", value: "never" },
          ],
        },
        {
          not: { field: "/category", operator: "eq", value: "account" },
        },
      ],
    }),
  );
  await page.getByLabel("启用确定性抽样").check();
  await page.getByLabel("抽样模式").selectOption("count");
  await page.getByLabel("抽样数量或比例").fill("1");
  await page.getByLabel("抽样种子").fill("browser-seed");
  await page.getByLabel("版本说明").fill("Browser restore description");
  await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
  await expect(page.getByLabel("未映射字段样例")).toBeVisible();
  await page.getByLabel("确认未映射字段仅保留在 Data Asset").check();
  await page.getByLabel("人工取舍记录").selectOption({ index: 0 });
  await page.getByLabel("人工取舍动作").selectOption("exclude");
  await page.getByLabel("人工取舍理由").fill("Synthetic duplicate");
  await page.getByRole("button", { name: "添加人工取舍" }).click();

  await expect(page.getByText("草稿已自动保存")).toBeVisible();
  await expect(page.getByText(/filter: 6 → 4/)).toBeVisible();
  await expect(page.getByText(/记录退出：/).first()).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "进入 AgentBench" }).click();
  await expect(page).toHaveURL(/\/workbench\/[^/]+$/u);
  await expect(page.getByLabel("Working Draft 状态摘要")).toBeVisible();
  await expect(page.getByLabel("编辑完整递归布尔树")).toBeChecked();
  await expect(page.getByLabel("递归布尔筛选树 JSON")).toContainText('"any"');
  await expect(page.getByLabel("抽样种子")).toHaveValue("browser-seed");
  await expect(page.getByLabel("版本说明")).toHaveValue(
    "Browser restore description",
  );
  await expect(
    page.getByLabel("确认未映射字段仅保留在 Data Asset"),
  ).not.toBeChecked();
  await expect(page.getByText("Synthetic duplicate")).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "放弃草稿" }).click();
  await expect(page.getByText(/草稿已放弃/)).toBeVisible();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), draftStorageKey),
  ).toBeNull();
});

test("Workbench previews nested mapping errors and keeps schema suggestions unconfirmed", async ({
  page,
}) => {
  await page.goto("/");
  await uploadSyntheticCsv(page, "Ticket 05 mapping fixture");
  await openWorkingDraft(page);
  await page.getByLabel("映射 JSON").fill(
    JSON.stringify({
      input: {
        object: {
          first: { source: "/missing_first" },
          second: { source: "/missing_second" },
        },
      },
      expectedOutput: { source: "/missing_output" },
    }),
  );
  await page.getByRole("button", { name: "立即保存并预览 Recipe" }).click();
  await expect(page.getByText("草稿已自动保存")).toBeVisible();
  await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
  const preview = page.getByLabel("映射预览");
  await expect(preview).toContainText("数据行 2（物理行 3）");
  await expect(preview).toContainText("/input/first");
  await expect(preview).toContainText("/input/second");
  await expect(preview).toContainText("/expected_output");

  await page.getByLabel("映射 JSON").fill(
    JSON.stringify({
      input: {
        object: {
          message: { source: "/question" },
          details: { object: { source: { constant: "synthetic" } } },
        },
      },
      expectedOutput: { source: "/answer" },
      metadata: { object: {} },
    }),
  );
  await page.getByRole("button", { name: "立即保存并预览 Recipe" }).click();
  await expect(page.getByText("草稿已自动保存")).toBeVisible();
  await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
  await expect(page.getByLabel("未映射字段样例")).toContainText("/category");
  await page
    .getByRole("button", { name: "扫描全部映射记录并建议 Schema" })
    .click();
  await expect(page.getByLabel("Schema 建议")).toContainText("尚未确认", {
    timeout: 30_000,
  });
  await expect(page.getByText("已扫描 2 条映射记录")).toBeVisible({
    timeout: 30_000,
  });
});

test("draft attachment capacity failure remains visible", async ({ page }) => {
  await page.goto("/");
  await uploadSyntheticCsv(page, "Ticket 06 aggregate capacity fixture");
  await openWorkingDraft(page);
  for (const index of [2, 3, 4, 5]) {
    await uploadAnotherSyntheticCsv(
      page,
      `Ticket 06 aggregate attachment ${index}`,
    );
    await page.getByRole("button", { name: "追加此资产到当前草稿" }).click();
    await expect(
      page.getByText(new RegExp(`附件 ${index}/5 已保存`)),
    ).toBeVisible();
  }

  await uploadAnotherSyntheticCsv(page, "Ticket 06 sixth attachment");
  await page.getByRole("button", { name: "追加此资产到当前草稿" }).click();
  const report = page.getByRole("alert", { name: "操作错误" });
  await expect(report).toContainText("附件 6/5");
  await expect(report).toContainText("阻断阶段：draft_attachment");
  await expect(report).toContainText("Remove or replace");
});

test("Parsed View record capacity failure remains visible and actionable", async ({
  page,
}) => {
  await page.goto("/");
  await uploadOverLimitJsonl(page, "Ticket 06 Parsed View capacity fixture");
  await expect(page.getByRole("status")).toContainText(
    "Parsed View 已超过容量上限；请减少或替换资产后重试",
  );
  const report = page.getByLabel("Parsed View 容量阻断");
  await expect(report).toBeVisible({ timeout: 60_000 });
  await expect(report).toContainText("10,001");
  await expect(report).toContainText("10,000");
  await expect(report).toContainText("source_record_limit_exceeded");
  await expect(report).toContainText(
    "Use an asset with at most 10,000 Source Records",
  );
});

test("single input capacity failure shows exact record-level limits", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await uploadSyntheticCsv(page, "Ticket 06 input capacity fixture");
  await openWorkingDraft(page);
  await page.getByLabel("映射 JSON").fill(
    JSON.stringify({
      input: { constant: buildCapacityFixtureValue("g02-over-input") },
      expectedOutput: { source: "/answer" },
      metadata: { object: {} },
    }),
  );
  await page.getByLabel("Input Formal Schema").fill('{"type":"string"}');
  await page.getByRole("button", { name: "立即保存并预览 Recipe" }).click();
  await expect(page.getByText("草稿已自动保存")).toBeVisible();
  await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
  await expect(page.getByLabel("未映射字段样例")).toBeVisible();
  await page.getByLabel("确认未映射字段仅保留在 Data Asset").check();
  await page.getByLabel("版本说明").fill("Ticket 06 input capacity version");
  await page.getByRole("button", { name: "确认并发布 v1" }).click();
  const report = page.getByLabel("Candidate 验证失败报告");
  await expect(report).toBeVisible({ timeout: 60_000 });
  await expect(report).toContainText("input_capacity_exceeded");
  await expect(report).toContainText(/10,000,00[35]\/10,000,000 bytes/);
  await expect(report).toContainText(/#\d+ · 数据行/);
  await expect(report).not.toContainText("0/10,000,000 bytes");
});

test("candidate aggregate drift failure shows exact object limits", async ({
  page,
}) => {
  await page.goto("/");
  await uploadSyntheticCsv(page, "Ticket 06 aggregate drift fixture");
  await openWorkingDraft(page);
  await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
  await expect(page.getByLabel("未映射字段样例")).toBeVisible();
  await page.getByLabel("确认未映射字段仅保留在 Data Asset").check();
  await page.getByLabel("版本说明").fill("Ticket 06 aggregate drift version");

  const db = createPool(databaseUrl);
  const assetResult = await db.query(
    `SELECT da.id
     FROM data_asset da
     JOIN source_attribution_revision sar ON sar.asset_id = da.id
     WHERE sar.source_name = 'Ticket 06 aggregate drift fixture'
     ORDER BY sar.created_at DESC LIMIT 1`,
  );
  const assetId = assetResult.rows[0].id;
  await page.route(/\/drafts\/[^/]+\/candidates$/u, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await db.query(
      "UPDATE data_asset SET size_bytes = 100000001 WHERE id = $1",
      [assetId],
    );
    await route.fulfill({ response, json: body });
  });

  await page.getByRole("button", { name: "确认并发布 v1" }).click();
  const report = page.getByLabel("Candidate 验证失败报告");
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report).toContainText("candidate_materialization");
  await expect(report).toContainText("originalBytes");
  await expect(report).toContainText("100,000,001/100,000,000 bytes");
  await expect(report).toContainText(
    "Correct the Working Draft attachment capacity",
  );
  await page.unroute(/\/drafts\/[^/]+\/candidates$/u);
  await db.end();
});

test("publication scalar capacity failure shows a safe structured report", async ({
  page,
}) => {
  await page.goto("/");
  await uploadSyntheticCsv(page, "Ticket 06 publication scalar fixture");
  await openWorkingDraft(page);
  await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
  await expect(page.getByLabel("未映射字段样例")).toBeVisible();
  await page.getByLabel("确认未映射字段仅保留在 Data Asset").check();
  await page
    .getByLabel("版本说明")
    .fill("Ticket 06 publication scalar version");

  const db = createPool(databaseUrl);
  let drifted = false;
  await page.route(/\/candidates\/[^/]+$/u, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.candidate?.status === "ready_to_publish" && !drifted) {
      drifted = true;
      await db.query(
        "UPDATE candidate_snapshot SET item_count = 10001 WHERE id = $1",
        [body.candidate.id],
      );
    }
    await route.fulfill({ response, json: body });
  });

  await page.getByRole("button", { name: "确认并发布 v1" }).click();
  const report = page.getByLabel("Candidate 验证失败报告");
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report).toContainText("publication_transaction");
  await expect(report).toContainText("candidate_item_count");
  await expect(report).toContainText("10,001/10,000");
  await expect(report).toContainText("Materialize a new Candidate");
  await page.unroute(/\/candidates\/[^/]+$/u);
  await db.end();
});

test("empty candidate failure shows object boundary and next step", async ({
  page,
}) => {
  await page.goto("/");
  await uploadSyntheticCsv(page, "Ticket 06 empty candidate fixture");
  await openWorkingDraft(page);
  await page.getByLabel("筛选字段").fill("category");
  await page.getByLabel("筛选值").fill("value-with-no-match");
  await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
  await expect(page.getByLabel("未映射字段样例")).toBeVisible();
  await page.getByLabel("确认未映射字段仅保留在 Data Asset").check();
  await page.getByLabel("版本说明").fill("Ticket 06 empty candidate version");
  await page.getByRole("button", { name: "确认并发布 v1" }).click();
  const report = page.getByLabel("Candidate 验证失败报告");
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report).toContainText("candidate_empty");
  await expect(report).toContainText("candidate_materialization");
  await expect(report).toContainText("记录数：0/10,000");
  await expect(report).toContainText("最小记录数：至少 1 条");
  await expect(report).toContainText("A Candidate needs at least one item");
});

test("a different Editor sees read-only state and confirms takeover", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await ownerPage.goto("/");
  await uploadSyntheticCsv(ownerPage, "Ticket 04 takeover fixture");
  await openWorkingDraft(ownerPage);
  await expect(ownerPage.getByText(/当前写者 user_owner/)).toBeVisible();
  await expect(
    ownerPage.getByText("工作草稿已打开；筛选修改可保存并重新打开。"),
  ).toBeVisible();
  const storedDraft = await ownerPage.evaluate(
    (key) => localStorage.getItem(key),
    draftStorageKey,
  );
  expect(storedDraft).toBeTruthy();

  const editorId = `user_${randomUUID().replaceAll("-", "")}`;
  const editorName = `editor_${randomUUID()}`;
  const db = createPool(databaseUrl);
  await db.query(
    "INSERT INTO app_user (id, username, password_hash, role) VALUES ($1, $2, $3, 'editor')",
    [editorId, editorName, await hashPassword("editor-test-password")],
  );
  await db.query(
    "INSERT INTO project_member (project_id, user_id, role) VALUES ('project_demo', $1, 'editor')",
    [editorId],
  );
  await db.end();

  const editorContext = await browser.newContext();
  await editorContext.addInitScript(
    ({ key, value }) => localStorage.setItem(key, value),
    { key: draftStorageKey, value: storedDraft! },
  );
  const editorPage = await editorContext.newPage();
  await editorPage.goto("/");
  await editorPage.getByLabel("用户名").fill(editorName);
  await editorPage.getByLabel("密码").fill("editor-test-password");
  await editorPage.getByRole("button", { name: "进入 AgentBench" }).click();
  await expect(editorPage.getByText(/当前写者 user_owner/)).toBeVisible();
  await expect(
    editorPage.getByRole("button", { name: "确认接管编辑租约" }),
  ).toBeVisible();
  editorPage.once("dialog", (dialog) => dialog.accept());
  await editorPage.getByRole("button", { name: "确认接管编辑租约" }).click();
  await expect(editorPage.getByText(`当前写者 ${editorId}`)).toBeVisible();
  await expect(
    editorPage.getByText("已确认接管；已保存内容保持不变"),
  ).toBeVisible();

  await editorContext.close();
  await ownerContext.close();
});

test("publishing replays the auto-saved sampling and manual steps", async ({
  page,
}) => {
  await page.goto("/");
  await uploadSyntheticCsv(page, "Ticket 04 publish Recipe fixture");
  await openWorkingDraft(page);
  await expect(
    page.getByText(/Working Draft draft_.* · revision/),
  ).toBeVisible();
  await page.getByLabel("启用确定性抽样").check();
  await page.getByLabel("抽样数量或比例").fill("1");
  await page.getByLabel("抽样种子").fill("publish-preserve");
  await page.getByLabel("人工取舍记录").selectOption({ index: 0 });
  await page.getByLabel("人工取舍动作").selectOption("exclude");
  await page.getByRole("button", { name: "添加人工取舍" }).click();
  await expect(page.getByText("草稿已自动保存")).toBeVisible();
  await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
  await expect(page.getByLabel("未映射字段样例")).toBeVisible();
  await page.getByLabel("确认未映射字段仅保留在 Data Asset").check();
  await page
    .getByLabel("版本说明")
    .fill("Ticket 04 recipe publication version");

  const materialized = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/drafts\/[^/]+\/candidates$/u.test(response.url()),
  );
  await page.getByRole("button", { name: "确认并发布 v1" }).click();
  const candidateId = (await (await materialized).json()).candidate.id;
  await expect(
    page.getByRole("heading", { name: "v1 · 默认版本" }),
  ).toBeVisible({ timeout: 30_000 });
  const candidate = await page.evaluate(async (id) => {
    const response = await fetch(`/api/projects/project_demo/candidates/${id}`);
    return response.json();
  }, candidateId);
  expect(candidate.candidate).toMatchObject({
    itemCount: 1,
    recipe: {
      steps: [
        expect.objectContaining({ kind: "filter" }),
        expect.objectContaining({ kind: "sample", seed: "publish-preserve" }),
        expect.objectContaining({ kind: "manual" }),
      ],
    },
  });
});
