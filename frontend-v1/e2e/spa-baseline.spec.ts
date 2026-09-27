import { expect, test } from "@playwright/test";

const routes = [
  { link: "发布到 Langfuse", path: "/publishes", heading: "发布到 Langfuse" },
  { link: "导入结果", path: "/imports", heading: "导入评测结果" },
  { link: "端到端计算", path: "/runs", heading: "端到端计算" },
  { link: "计算器", path: "/calculators", heading: "计算器", screenshot: "calculators.png" },
  { link: "报告", path: "/reports", heading: "报告" },
  {
    link: "Langfuse 连接",
    path: "/settings/langfuse",
    heading: "Langfuse 连接设置",
    screenshot: "langfuse-settings.png",
  },
  { link: "活动记录", path: "/activity", heading: "活动记录" },
] as const;

test("preserves the product-entry route flow and visual baseline", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await expect(page).toHaveURL(/\/datasets\/?$/);
  await expect(page.getByRole("heading", { name: "数据集" })).toBeVisible();
  await expect(page.getByText("大规模回归集（10k）", { exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot("datasets.png", { animations: "disabled", fullPage: true });

  for (const route of routes) {
    await page.getByRole("link", { name: route.link, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${route.path.replaceAll("/", "\\/")}\\/?$`));
    await expect(page.getByRole("heading", { name: route.heading, exact: true })).toBeVisible();
    if ("screenshot" in route) {
      if (route.path === "/calculators") {
        await expect(page.getByText("端到端质量计算器", { exact: true })).toBeVisible();
      }
      if (route.path === "/settings/langfuse") {
        await expect(page.getByText("生产 · agent-eval-prod", { exact: true })).toBeVisible();
      }
      await expect(page).toHaveScreenshot(route.screenshot, {
        animations: "disabled",
        fullPage: true,
      });
    }
  }

  expect(pageErrors).toEqual([]);
});

test("supports direct child-route refresh and renders the router 404", async ({ page }) => {
  await page.goto("/calculators");
  await expect(page.getByRole("heading", { name: "计算器", exact: true })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/calculators\/?$/);
  await expect(page.getByRole("heading", { name: "计算器", exact: true })).toBeVisible();

  await page.goto("/route-that-does-not-exist");
  await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go home", exact: true })).toBeVisible();
});
