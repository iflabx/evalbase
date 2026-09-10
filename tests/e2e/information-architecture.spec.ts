import { expect, test } from "@playwright/test";

async function loginIfNeeded(page: import("@playwright/test").Page) {
  const loginButton = page.getByRole("button", { name: "进入 AgentBench" });
  if (await loginButton.isVisible()) await loginButton.click();
  const navigation = page.getByRole("navigation", { name: "主导航" });
  if (!(await navigation.isVisible())) {
    const openNavigation = page.getByRole("button", { name: "打开主导航" });
    if (await openNavigation.isVisible()) await openNavigation.click();
  }
  await expect(navigation).toBeVisible();
}

test("root and primary navigation expose separate Phase 1A pages", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/assets$/u);
  await loginIfNeeded(page);

  const navigation = page.getByRole("navigation", { name: "主导航" });
  await expect(navigation.getByRole("link")).toHaveCount(3);
  await expect(
    navigation.getByRole("link", { name: "数据资产", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel("资产文件")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Data Asset 结构化列表" }),
  ).toBeVisible();

  await navigation.getByRole("link", { name: "测试集", exact: true }).click();
  await expect(page).toHaveURL(/\/test-sets$/u);
  await expect(page.getByRole("heading", { name: "测试集" })).toBeVisible();
  await expect(page.getByLabel("资产文件")).toHaveCount(0);
  await expect(
    navigation.getByRole("link", { name: "测试集", exact: true }),
  ).toHaveAttribute("aria-current", "page");

  await navigation.getByRole("link", { name: "交付记录", exact: true }).click();
  await expect(page).toHaveURL(/\/deliveries$/u);
  await expect(page.locator("#page-title")).toHaveText("交付记录");
  await expect(page.getByLabel("资产文件")).toHaveCount(0);
  await expect(page.getByLabel("交付记录列表")).toBeVisible();
});

test("navigation keeps browser history and focus at the new page title", async ({
  page,
}) => {
  await page.goto("/assets");
  await loginIfNeeded(page);
  await page.getByRole("link", { name: "测试集", exact: true }).click();
  await expect(page).toHaveURL(/\/test-sets$/u);
  await page.getByRole("link", { name: "交付记录", exact: true }).click();
  await expect(page).toHaveURL(/\/deliveries$/u);

  await page.goBack();
  await expect(page).toHaveURL(/\/test-sets$/u);
  await expect(page.getByRole("heading", { name: "测试集" })).toBeFocused();
  await page.goForward();
  await expect(page).toHaveURL(/\/deliveries$/u);
  await expect(page.locator("#page-title")).toBeFocused();
});

test("asset filters survive refresh as URL query state", async ({ page }) => {
  await page.goto("/assets");
  await loginIfNeeded(page);
  await page.getByLabel("资产名称精确筛选").fill("synthetic-fixture");
  await page.getByRole("button", { name: "应用结构化筛选" }).click();
  await expect(page).toHaveURL(/name=synthetic-fixture/u);
  await page.reload();
  await loginIfNeeded(page);
  await expect(page.getByLabel("资产名称精确筛选")).toHaveValue(
    "synthetic-fixture",
  );
  await page.getByLabel("资产名称精确筛选").fill("");
  await page.getByRole("button", { name: "应用结构化筛选" }).click();
  await expect(page).not.toHaveURL(/name=synthetic-fixture/u);
  await page.reload();
  await loginIfNeeded(page);
  await expect(page.getByLabel("资产名称精确筛选")).toHaveValue("");
});

test("narrow navigation closes after selection and unknown routes are truthful", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/assets");
  await loginIfNeeded(page);
  await page.getByRole("button", { name: "关闭主导航" }).click();
  await page.getByRole("button", { name: "打开主导航" }).click();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await page.getByRole("link", { name: "测试集", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "打开主导航" }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("heading", { name: "测试集" })).toBeFocused();

  await page.goto("/not-an-approved-page");
  await loginIfNeeded(page);
  await expect(
    page.getByRole("heading", { name: "找不到这个页面" }),
  ).toBeVisible();
  await expect(
    page.getByText("这个地址不属于当前批准的 Phase 1A 页面。"),
  ).toBeVisible();
  await expect(page.getByText("Langfuse", { exact: true })).toHaveCount(0);

  await page.goto("/assets/unknown/extra-segment");
  await loginIfNeeded(page);
  await expect(
    page.getByRole("heading", { name: "找不到这个页面" }),
  ).toBeVisible();

  await page.goto("/assets/asset_missing_ia");
  await loginIfNeeded(page);
  await expect(page.getByRole("alert", { name: "操作错误" })).toContainText(
    "asset_not_found",
  );
  await expect(page.getByText("asset_missing_ia", { exact: true })).toHaveCount(
    0,
  );

  await page.goto("/test-sets/testset_missing_ia");
  await loginIfNeeded(page);
  await expect(page.getByRole("alert", { name: "操作错误" })).toContainText(
    "test_set_not_found",
  );
  await expect(
    page.getByText("testset_missing_ia", { exact: true }),
  ).toHaveCount(0);
});
