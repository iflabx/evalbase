import { defineConfig, devices } from "@playwright/test";

const loopbackBypass = [process.env["NO_PROXY"], "127.0.0.1", "localhost"]
  .filter(Boolean)
  .join(",");
process.env["NO_PROXY"] = loopbackBypass;
process.env["no_proxy"] = loopbackBypass;

const externalBaseUrl = process.env["PLAYWRIGHT_BASE_URL"];
const baseURL = externalBaseUrl ?? "http://127.0.0.1:4191";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  ...(externalBaseUrl
    ? {}
    : {
        webServer: {
          command: "npm run build && npm run preview -- --host 127.0.0.1 --port 4191 --strictPort",
          url: baseURL,
          reuseExistingServer: false,
          timeout: 120_000,
        },
      }),
});
