import { expect, test } from "@playwright/test";

test("Owner can diagnose dependency health and sees the persistence boundary", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "进入 AgentBench" }).click();

  const live = await page.request.get("/health/live");
  expect(live.ok()).toBeTruthy();
  const ready = await page.request.get("/health/ready");
  expect(ready.ok()).toBeTruthy();
  await expect(ready.json()).resolves.toMatchObject({
    status: "ok",
    dependencies: { postgresql: "ok", minio: "ok" },
  });

  const metrics = await page.request.get("/metrics");
  expect(metrics.ok()).toBeTruthy();
  const text = await metrics.text();
  expect(text).toContain("agentbench_queue_depth");
  expect(text).toContain("agentbench_postgresql_health");
  expect(text).toContain("agentbench_minio_health");
  expect(text).not.toMatch(/password|session|credential/i);

  await expect(page.getByText(/无备份、off-host copy/)).toBeVisible();
});
