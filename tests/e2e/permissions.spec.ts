import { expect, test } from "@playwright/test";

const origin = process.env.E2E_ORIGIN ?? "http://127.0.0.1:3000";

test("shows server roles and keeps Viewer actions read-only in the UI", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("用户名").fill("owner");
  await page.getByLabel("密码").fill("owner-test-password");
  await page.getByRole("button", { name: "进入 AgentBench" }).click();
  await expect(page.getByText("当前身份：owner")).toBeVisible();
  await expect(
    page.getByText(
      "Editor/Viewer 是非生产测试身份，不构成真实多人、外部共享、敏感数据或生产批准。",
    ),
  ).toBeVisible();
  await expect(page.getByText(/无备份、off-host copy/)).toBeVisible();
  const membership = page.getByRole("region", { name: "项目成员与角色" });
  await expect(membership).toBeVisible();
  await expect(membership).toContainText("owner");
  await expect(membership).toContainText("editor");
  await expect(membership).toContainText("viewer");

  await page.context().clearCookies();
  await page.goto("/");
  await page.getByLabel("用户名").fill("viewer");
  await page.getByLabel("密码").fill("viewer-test-password");
  await page.getByRole("button", { name: "进入 AgentBench" }).click();
  await expect(page.getByText("当前身份：viewer")).toBeVisible();
  await expect(
    page.getByRole("note", { name: "Viewer 只读边界" }),
  ).toContainText("写入、策展、发布和成员管理由服务端拒绝");
  await expect(page.getByLabel("资产文件")).toBeDisabled();
  await expect(page.getByRole("button", { name: "保存并解析" })).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "项目成员与角色" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("note", { name: "Viewer 只读边界" }),
  ).toContainText("正向导出仅使用合成非敏感 Fixture");
  await expect(
    page.getByRole("note", { name: "Viewer 只读边界" }),
  ).toContainText("已接受的非生产范围限制");
  const pageContent = await page.content();
  expect(pageContent).not.toContain("synthetic-nonproduction-only");
  expect(pageContent).not.toContain("MINIO_");
  expect(pageContent).not.toContain("9000/minio");
});

test("hides an existing Langfuse CSV from Viewer UI and rejects its direct commands", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByLabel("用户名").fill("owner");
  await page.getByLabel("密码").fill("owner-test-password");
  await page.getByRole("button", { name: "进入 AgentBench" }).click();

  await page.getByLabel("资产文件").setInputFiles("tests/fixtures/owner.csv");
  await page.getByLabel("来源名称").fill("Langfuse Viewer synthetic fixture");
  await page.getByLabel("使用目的").fill("Langfuse Viewer permission boundary");
  await page.getByRole("button", { name: "保存并解析" }).click();
  await expect(page.getByText("Can I get a refund?")).toBeVisible();
  await page
    .getByRole("button", { name: "创建 Working Draft 并附加此资产" })
    .click();
  await page.getByLabel("筛选字段").fill("category");
  await page.getByLabel("筛选值").fill("billing");
  await page.getByRole("button", { name: "预览映射（最多 20 条）" }).click();
  await page.getByLabel("未映射字段样例").waitFor();
  await page.getByLabel("确认未映射字段仅保留在 Data Asset").check();
  await page.getByLabel("版本说明").fill("Langfuse Viewer synthetic version");
  await page.getByRole("button", { name: "确认并发布 v1" }).click();
  await expect(
    page.getByRole("heading", { name: "v1 · 默认版本" }),
  ).toBeVisible({ timeout: 30_000 });

  const generationRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      /\/api\/projects\/project_demo\/versions\/[^/]+\/langfuse-csv$/.test(
        new URL(request.url()).pathname,
      ),
  );
  await page.getByRole("button", { name: "生成 Langfuse CSV" }).click();
  await expect(
    page.getByText("Langfuse CSV 已生成并通过本地契约校验。"),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Langfuse CSV 预览")).toBeVisible();

  const generationRequest = await generationRequestPromise;
  const versionMatch = new URL(generationRequest.url()).pathname.match(
    /\/versions\/([^/]+)\/langfuse-csv$/,
  );
  if (!versionMatch) throw new Error("missing_langfuse_version_id");
  const versionId = versionMatch[1];
  const deliveriesResponse = await page.request.get(
    `/api/projects/project_demo/versions/${versionId}/deliveries`,
  );
  expect(deliveriesResponse.ok()).toBeTruthy();
  const csvDelivery = (
    (await deliveriesResponse.json()) as {
      deliveries: Array<{ id: string; packageType: string }>;
    }
  ).deliveries.find((delivery) => delivery.packageType === "langfuse_csv");
  expect(csvDelivery).toBeDefined();
  const deliveryId = csvDelivery?.id ?? "";

  await page.context().clearCookies();
  const viewerLogin = await page.request.post("/api/session", {
    headers: { origin },
    data: { username: "viewer", password: "viewer-test-password" },
  });
  expect(viewerLogin.ok()).toBeTruthy();
  const viewerSession = (await viewerLogin.json()) as { csrfToken: string };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("当前身份：viewer")).toBeVisible();

  await expect(
    page.getByRole("button", { name: "生成 Langfuse CSV" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "下载 Langfuse CSV" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Langfuse CSV 预览")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "确认已人工导入（仅用户声明）" }),
  ).toBeDisabled();

  const mutationHeaders = {
    origin,
    "x-csrf-token": viewerSession.csrfToken,
  };
  const directGenerate = await page.request.post(
    `/api/projects/project_demo/versions/${versionId}/langfuse-csv`,
    { headers: mutationHeaders },
  );
  expect(directGenerate.status()).toBe(404);
  const directPreview = await page.request.get(
    `/api/projects/project_demo/deliveries/${deliveryId}/preview`,
  );
  expect(directPreview.status()).toBe(404);
  const directDownload = await page.request.get(
    `/api/projects/project_demo/deliveries/${deliveryId}/download`,
  );
  expect(directDownload.status()).toBe(404);
  const directConfirm = await page.request.post(
    `/api/projects/project_demo/deliveries/${deliveryId}/imported`,
    { headers: mutationHeaders, data: {} },
  );
  expect(directConfirm.status()).toBe(404);
});
