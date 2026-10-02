import { RuntimeMetrics } from "../../src/observability/runtime.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";

const baseUrl = loadConfig().databaseUrl;
const databaseName = `evalbase_runtime_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = baseUrl.replace(/\/[^/]+$/, `/${databaseName}`);
let app: AgentBenchApp;
beforeAll(async () => {
  const db = createPool(baseUrl);
  try {
    await db.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await db.end();
  }
  await migrate(databaseUrl);
  app = await buildApp(
    { databaseUrl, soloOwnerMode: false, allowTestIdentity: false },
    { disableLegacyTestBootstrap: true },
  );
});
afterAll(async () => {
  await app?.close();
  const db = createPool(baseUrl);
  try {
    await db.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  } finally {
    await db.end();
  }
});
it("reports bounded HTTP/SQL/runtime diagnostics without request content or resource IDs", async () => {
  const privateId = `private-${randomUUID()}`;
  const response = await app.inject({
    method: "GET",
    url: `/api/projects/${privateId}/collaborative-drafts?search=PRIVATE_RECORD_BODY`,
  });
  expect(response.statusCode).toBe(401);
  const metrics = await app.inject({ method: "GET", url: "/metrics" });
  expect(metrics.statusCode).toBe(200);
  expect(metrics.body).toContain("evalbase_http_duration_seconds_count");
  expect(metrics.body).toContain(
    "/api/projects/:projectId/collaborative-drafts",
  );
  expect(metrics.body).toContain("evalbase_sql_duration_seconds_count");
  expect(metrics.body).toContain("evalbase_pool_wait_duration_seconds_count");
  expect(metrics.body).toContain("evalbase_process_resident_memory_bytes");
  expect(metrics.body).toContain("evalbase_event_loop_delay_seconds");
  expect(metrics.body).not.toContain(privateId);
  expect(metrics.body).not.toContain("PRIVATE_RECORD_BODY");
});

it("preserves PostgreSQL promise/callback values and errors while measuring pool waits", async () => {
  const metrics = new RuntimeMetrics();
  const db = createPool(databaseUrl, metrics);
  try {
    expect((await db.query("SELECT 17 AS value")).rows[0].value).toBe(17);
    const client = await db.connect();
    try {
      await new Promise<void>((resolve, reject) =>
        client.query("SELECT 19 AS value", (error, result) => {
          if (error) {
            reject(error);
            return;
          }
          try {
            expect(result.rows[0].value).toBe(19);
            resolve();
          } catch (cause) {
            reject(cause);
          }
        }),
      );
      await expect(
        client.query("SELECT * FROM runtime_private_missing_table"),
      ).rejects.toMatchObject({ code: "42P01" });
      await new Promise<void>((resolve, reject) =>
        client.query("SELECT * FROM runtime_private_missing_table", (error) => {
          try {
            expect(error).toMatchObject({ code: "42P01" });
            resolve();
          } catch (cause) {
            reject(cause);
          }
        }),
      );
    } finally {
      client.release();
    }
    const output = metrics.render(db);
    expect(output).toContain("evalbase_sql_duration_seconds_count 4");
    expect(output).toContain("evalbase_sql_errors_total 2");
    expect(output).not.toContain("runtime_private_missing_table");
    expect(output).toContain("evalbase_pool_wait_duration_seconds_count");
  } finally {
    await db.end();
    metrics.close();
  }
});
it("can disable process diagnostics without changing successful database queries", async () => {
  const metrics = new RuntimeMetrics(false);
  const db = createPool(databaseUrl, metrics);
  try {
    expect((await db.query("SELECT 23 AS value")).rows[0].value).toBe(23);
    expect(metrics.render(db)).toBe(
      "# TYPE evalbase_runtime_metrics_enabled gauge\nevalbase_runtime_metrics_enabled 0\n",
    );
  } finally {
    await db.end();
    metrics.close();
  }
});
