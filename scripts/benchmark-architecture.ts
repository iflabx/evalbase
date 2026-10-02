/** Run only in the isolated architecture test Compose; never against the formal database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fork, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import type { AgentBenchApp } from "../src/server/app.js";

const variant = process.env.EVALBASE_BENCH_VARIANT ?? "optimized";
assert(["baseline", "optimized"].includes(variant));
const repetitions = Number(process.env.EVALBASE_BENCH_RUNS ?? 3);
assert(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 3);
const source = resolve(process.env.EVALBASE_BENCH_SOURCE ?? ".");
const output = resolve(
  process.env.EVALBASE_BENCH_OUTPUT ??
    `local-acceptance-evidence/architecture-performance/${variant}.json`,
);
const { buildApp } = (await import(
  pathToFileURL(`${source}/src/server/app.ts`).href
)) as typeof import("../src/server/app.js");
const { migrate } = (await import(
  pathToFileURL(`${source}/src/db/migrate.ts`).href
)) as typeof import("../src/db/migrate.js");
const { loadConfig } = (await import(
  pathToFileURL(`${source}/src/config.ts`).href
)) as typeof import("../src/config.js");
const config = loadConfig();
assert(
  config.databaseUrl.includes("@postgres:5432/evalbase_phase1a"),
  "Use the dedicated architecture test Compose",
);
assert(
  config.minio.bucket === "evalbase-architecture-tests",
  "Use the dedicated test bucket",
);
const databaseName = `evalbase_arch_bench_${variant}_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = config.databaseUrl.replace(/\/[^/]+$/, `/${databaseName}`);
const root = new pg.Pool({ connectionString: config.databaseUrl });
let sqlCount = 0;
const originalQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args: unknown[]) {
  sqlCount++;
  return Reflect.apply(originalQuery, this, args);
} as typeof originalQuery;
const logs = console.log;
console.log = () => undefined; // Backend logs contain IDs; the benchmark retains only aggregate observations.
type Session = { cookie: string; origin: string; "x-csrf-token": string };
type Sample = {
  run: number;
  stage: string;
  durationMs: number;
  sqlStatements: number;
  rssPeakBytes: number;
  heapPeakBytes: number;
  failed: boolean;
};
const samples: Sample[] = [];
let app: AgentBenchApp | undefined;
let worker: ReturnType<typeof spawn> | undefined;
let baseUrl = "";
let completed = false;
let failureName: string | undefined;
let lastVersionId = "";
const idleWindows: number[] = [];
let workerPickupMs: number | undefined;
let workerResult: string | undefined;
const observations = new pg.Pool({ connectionString: databaseUrl });
const mixedLoadSamples: Array<{
  run: number;
  stage: string;
  latencies: number[];
  p50Ms: number;
  p95Ms: number;
  failures: number;
}> = [];
const sessionLatencies: Array<{ run: number; latencies: number[] }> = [];
const origin = "http://127.0.0.1:3000";
let rssPeakBytes = 0;
let heapPeakBytes = 0;
const memory = setInterval(() => {
  const current = process.memoryUsage();
  rssPeakBytes = Math.max(rssPeakBytes, current.rss);
  heapPeakBytes = Math.max(heapPeakBytes, current.heapUsed);
}, 20);
const started = new Date().toISOString();
async function measured<T>(
  run: number,
  stage: string,
  work: () => Promise<T>,
): Promise<T> {
  const before = sqlCount;
  const at = performance.now();
  rssPeakBytes = process.memoryUsage().rss;
  heapPeakBytes = process.memoryUsage().heapUsed;
  let failed = false;
  try {
    return await work();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const current = process.memoryUsage();
    const sample = {
      run,
      stage,
      durationMs: performance.now() - at,
      sqlStatements: sqlCount - before,
      rssPeakBytes: Math.max(rssPeakBytes, current.rss),
      heapPeakBytes: Math.max(heapPeakBytes, current.heapUsed),
      failed,
    };
    samples.push(sample);
    logs(JSON.stringify({ variant, ...sample }));
  }
}
async function httpRequest(options: {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  payload?: unknown;
}) {
  const headers = Object.fromEntries(
    Object.entries(options.headers).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  if (options.payload !== undefined && !headers["content-type"])
    headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${options.url}`, {
    method: options.method,
    headers,
    ...(options.payload === undefined
      ? {}
      : {
          body:
            typeof options.payload === "string"
              ? options.payload
              : JSON.stringify(options.payload),
        }),
  });
  const body = await response.text();
  const cookies = response.headers.getSetCookie().map((value) => {
    const pair = value.split(";", 1)[0];
    const equal = pair.indexOf("=");
    return { name: pair.slice(0, equal), value: pair.slice(equal + 1) };
  });
  return {
    statusCode: response.status,
    body,
    cookies,
    json: () => JSON.parse(body),
  };
}
async function loadBurst(
  run: number,
  stage: string,
  draftUrl: string,
  sessions: Session[],
) {
  const snapshot = await request("GET", draftUrl, sessions[0]);
  const child = fork("scripts/architecture-load-client.mjs", [], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  await new Promise<void>((done, fail) => {
    child.once("error", fail);
    child.once("exit", () =>
      fail(new Error("load_client_exited_before_ready")),
    );
    child.once("message", () => done());
  });
  const result = new Promise<void>((done, fail) => {
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error("load_client_timeout"));
    }, 60000);
    child.once("exit", (code) => {
      if (code) {
        clearTimeout(timer);
        fail(new Error(`load_client_exit_${code}`));
      }
    });
    child.once("message", (value) => {
      clearTimeout(timer);
      const message = value as {
        error?: string;
        latencies: number[];
        p50Ms: number;
        p95Ms: number;
        failures: number;
      };
      if (message.error) {
        fail(new Error(message.error));
        return;
      }
      mixedLoadSamples.push({ run, stage, ...message });
      logs(
        JSON.stringify({
          variant,
          run,
          stage: `mixed-${stage}`,
          p50Ms: message.p50Ms,
          p95Ms: message.p95Ms,
          failures: message.failures,
        }),
      );
      done();
    });
    child.once("error", fail);
  });
  return {
    start: () =>
      child.send({
        baseUrl,
        draftUrl,
        sessions,
        records: snapshot.records,
        valuePrefix: `并发-${run}-${stage}`,
      }),
    result,
  };
}
async function request(
  method: "GET" | "POST" | "PUT" | "PATCH",
  url: string,
  headers: Partial<Session>,
  payload?: unknown,
  expected = 200,
) {
  assert(app);
  const response = await httpRequest({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
  assert.equal(
    response.statusCode,
    expected,
    `${method} ${url}: ${response.statusCode} ${response.body.slice(0, 500)}`,
  );
  return response.json();
}
async function login(email: string, password: string): Promise<Session> {
  assert(app);
  const response = await httpRequest({
    method: "POST",
    url: "/api/session",
    headers: { origin },
    payload: { email, password },
  });
  assert.equal(response.statusCode, 200);
  return {
    cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
    origin,
    "x-csrf-token": response.json().csrfToken,
  };
}
try {
  await root.query(`CREATE DATABASE ${databaseName}`);
  await root.query(
    `ALTER DATABASE ${databaseName} SET statement_timeout = '60s'`,
  );
  await migrate(databaseUrl);
  app = await buildApp(
    {
      databaseUrl,
      appOrigin: origin,
      soloOwnerMode: false,
      allowTestIdentity: false,
    },
    { disableLegacyTestBootstrap: true },
  );
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  await request(
    "POST",
    "/api/installation/administrator",
    { origin },
    {
      email: "admin@performance.test",
      displayName: "管理员",
      password: "BenchAdmin123!",
      confirmPassword: "BenchAdmin123!",
    },
    201,
  );
  await request(
    "POST",
    "/api/accounts",
    { origin },
    {
      email: "editor@performance.test",
      password: "BenchEditor123!",
      confirmPassword: "BenchEditor123!",
    },
    201,
  );
  const admin = await login("admin@performance.test", "BenchAdmin123!");
  const editor = await login("editor@performance.test", "BenchEditor123!");
  const project = (
    await request(
      "POST",
      "/api/projects",
      admin,
      { name: "架构性能合成项目" },
      201,
    )
  ).project.id as string;
  const invitation = await request(
    "POST",
    `/api/projects/${project}/invitations`,
    admin,
    { email: "editor@performance.test", role: "editor" },
    201,
  );
  await request(
    "POST",
    `/api/me/invitations/${invitation.invitation.id}/accept`,
    editor,
  );
  const sessions = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      login(
        index % 2 ? "editor@performance.test" : "admin@performance.test",
        index % 2 ? "BenchEditor123!" : "BenchAdmin123!",
      ),
    ),
  );
  const collection = (
    await request("GET", `/api/projects/${project}/collections`, admin)
  ).collections[0].id as string;
  const drafts = `/api/projects/${project}/collaborative-drafts`;
  const collaboration = (await request("POST", drafts, admin, {}, 201)).draft
    .id as string;
  for (let index = 0; index < 10; index++)
    await request("POST", `${drafts}/${collaboration}/records`, admin, {}, 201);
  for (let run = 1; run <= repetitions; run++) {
    const csv = `question,answer,topic\n${Array.from({ length: 10000 }, (_, index) => `问题${run}-${String(index).padStart(5, "0")},答案${index},主题${index % 5}`).join("\n")}\n`;
    const raw = await measured(run, "upload-preview", async () => {
      assert(app);
      const response = await httpRequest({
        method: "POST",
        url: `/api/projects/${project}/pending-uploads`,
        headers: {
          ...admin,
          "content-type": "text/csv",
          "x-file-name": `performance-run-${run}.csv`,
        },
        payload: csv,
      });
      assert.equal(response.statusCode, 201, response.body);
      return response.json();
    });
    const pendingId = raw.pendingUpload.id as string;
    const mapping = {
      question: "/question",
      expectedOutput: "/answer",
      metadata: ["/topic"],
    };
    await measured(run, "mapping-preview", () =>
      request(
        "PUT",
        `/api/projects/${project}/pending-uploads/${pendingId}/preview`,
        admin,
        { mapping },
      ),
    );
    const confirmed = await measured(run, "confirm-upload", async () => {
      assert(app);
      const response = await httpRequest({
        method: "POST",
        url: `/api/projects/${project}/pending-upload-batches/confirm`,
        headers: { ...admin, "idempotency-key": randomUUID() },
        payload: { collectionId: collection, pendingUploadIds: [pendingId] },
      });
      assert.equal(response.statusCode, 201, response.body);
      return response.json();
    });
    const assetId = confirmed.assets[0].id as string;
    const created = await request("POST", drafts, admin, {}, 201);
    const draftId = created.draft.id as string;
    await request("PATCH", `${drafts}/${draftId}`, admin, {
      field: "name",
      value: `性能样本 ${run}`,
      expectedFieldRevision: 0,
    });
    await measured(run, "select-10000-records", () =>
      request("POST", `${drafts}/${draftId}/source-selection`, admin, {
        mode: "add",
        assetIds: [assetId],
      }),
    );
    const ready = await request("GET", `${drafts}/${draftId}`, admin);
    assert.equal(ready.total, 10000);
    const burst = await loadBurst(
      run,
      "publish-initial",
      `${drafts}/${collaboration}`,
      sessions,
    );
    burst.start();
    const published = await measured(run, "publish-initial", () =>
      request(
        "POST",
        `${drafts}/${draftId}/publish`,
        admin,
        { revision: ready.draft.revision },
        201,
      ),
    );
    await burst.result;
    // Compare reads with the same up-to-date planner statistics in both variants.
    // Ingest/publication timings above include all writes; ANALYZE is outside them.
    await observations.query("ANALYZE");
    const testSetId = published.testSet.id as string;
    const versionId = published.version.id as string;
    const recordsUrl = `/api/projects/${project}/solo-test-sets/${testSetId}/versions/${versionId}/records`;
    const records = await measured(run, "version-page", () =>
      request("GET", `${recordsUrl}?limit=20&offset=4980`, admin),
    );
    assert.equal(records.pagination.total, 10000);
    assert.equal(records.records.length, 20);
    const filtered = await measured(run, "version-filter", () =>
      request(
        "GET",
        `${recordsUrl}?limit=20&search=${encodeURIComponent(`问题${run}-099`)}`,
        admin,
      ),
    );
    assert.equal(filtered.pagination.total, 100);
    await measured(run, "csv-download", async () => {
      assert(app);
      const response = await httpRequest({
        method: "GET",
        url: `/api/projects/${project}/solo-test-sets/${testSetId}/versions/${versionId}/data.csv`,
        headers: admin,
      });
      assert.equal(response.statusCode, 200, response.body.slice(0, 100));
      assert(response.body.includes(`问题${run}-00000`));
      assert(response.body.includes(`问题${run}-09999`));
    });
    const inherited = await measured(run, "derive-10000-records", () =>
      request(
        "POST",
        drafts,
        editor,
        { testSetId, parentVersionId: versionId },
        201,
      ),
    );
    const inheritedId = inherited.draft.id as string;
    const snapshot = await request("GET", `${drafts}/${inheritedId}`, editor);
    const publicRows = snapshot.records as Array<{
      id: string;
      expectedOutputRevision: number;
    }>;
    const latency: number[] = [];
    await measured(run, "10-session-edit-and-read", async () => {
      await Promise.all(
        sessions.map(async (session, index) => {
          const at = performance.now();
          await request(
            "PATCH",
            `${drafts}/${inheritedId}/records/${publicRows[index].id}`,
            session,
            {
              field: "expectedOutput",
              value: `十会话已保存-${index}`,
              expectedFieldRevision: publicRows[index].expectedOutputRevision,
            },
          );
          await request(
            "GET",
            `${recordsUrl}?limit=20&offset=${index * 20}`,
            session,
          );
          await request(
            "GET",
            `${drafts}/${inheritedId}/events?after=0`,
            session,
          );
          latency.push(performance.now() - at);
        }),
      );
    });
    sessionLatencies.push({ run, latencies: [...latency] });
    latency.sort((a, b) => a - b);
    logs(
      JSON.stringify({
        variant,
        run,
        stage: "10-session-latency",
        p50Ms: latency[4],
        p95Ms: latency[9],
        failures: 0,
      }),
    );
    const updated = await request("GET", `${drafts}/${inheritedId}`, admin);
    for (let index = 0; index < 10; index++)
      assert.equal(
        updated.records[index].expectedOutput,
        `十会话已保存-${index}`,
      );
    const sparse = await measured(run, "publish-sparse-10", () =>
      request(
        "POST",
        `${drafts}/${inheritedId}/publish`,
        editor,
        { revision: updated.draft.revision },
        201,
      ),
    );
    lastVersionId = sparse.version.id;
    const count = await observations.query(
      "SELECT count(*)::int AS n FROM collaborative_draft_attribution WHERE version_id=$1",
      [lastVersionId],
    );
    assert.equal(
      count.rows[0].n,
      10000,
      "all attribution rows survive batch boundaries",
    );
  }
  // Idle measurements observe the queue through aggregate PostgreSQL transaction counters.
  const workerEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    NODE_ENV: "development",
    SOLO_OWNER_MODE: "false",
    ALLOW_TEST_IDENTITY: "false",
    WORKER_HEALTH_PORT: "0",
    GIT_SHA: variant,
  };
  worker = spawn(
    process.execPath,
    ["--import", "tsx", `${source}/src/worker/main.ts`],
    { env: workerEnv, stdio: ["ignore", "ignore", "ignore"] },
  );
  await delay(3000);
  assert.equal(worker.exitCode, null, "Worker remains running");
  const counter = async () =>
    Number(
      (
        await root.query(
          "SELECT xact_commit FROM pg_stat_database WHERE datname=$1",
          [databaseName],
        )
      ).rows[0].xact_commit,
    );
  for (let window = 0; window < 3; window++) {
    const before = await counter();
    await delay(6000);
    const transactions = (await counter()) - before;
    idleWindows.push(transactions);
    logs(
      JSON.stringify({
        variant,
        stage: "worker-idle",
        window,
        windowMs: 6000,
        transactions,
      }),
    );
  }
  const actor = (
    await observations.query("SELECT id FROM app_user WHERE role='admin'")
  ).rows[0].id;
  const jobId = `architecture_wakeup_${randomUUID()}`;
  const enqueuedAt = performance.now();
  await observations.query(
    `INSERT INTO job (id,project_id,actor_id,kind,payload,status,correlation_id,idempotency_key)
     VALUES ($1,$2,$3,'materialize_version_checkpoint',$4,'queued',$1,$1)`,
    [jobId, project, actor, JSON.stringify({ versionId: lastVersionId })],
  );
  while (performance.now() - enqueuedAt < 30000) {
    const job = (
      await observations.query(
        "SELECT status,error_code FROM job WHERE id=$1",
        [jobId],
      )
    ).rows[0];
    if (job.status !== "queued" && workerPickupMs === undefined)
      workerPickupMs = performance.now() - enqueuedAt;
    if (["succeeded", "failed", "cancelled"].includes(job.status)) {
      workerResult = job.status;
      assert.equal(job.status, "succeeded", job.error_code);
      break;
    }
    await delay(20);
  }
  assert.equal(
    workerResult,
    "succeeded",
    "real checkpoint job finishes after idle backoff",
  );
  assert(
    workerPickupMs !== undefined && workerPickupMs <= 1500,
    "Worker picks up within 1s plus scheduling allowance",
  );
  logs(
    JSON.stringify({
      variant,
      stage: "worker-wakeup",
      workerPickupMs,
      workerResult,
    }),
  );
  completed = true;
} catch (error) {
  failureName = error instanceof Error ? error.name : typeof error;
  throw error;
} finally {
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        variant,
        source,
        started,
        finished: new Date().toISOString(),
        recordsPerRun: 10000,
        repetitions,
        concurrentSessions: 10,
        distinctAccounts: 2,
        coldCacheControlled: false,
        plannerStatisticsControlled: true,
        statementTimeoutMs: 60000,
        samples,
        mixedLoadSamples,
        sessionLatencies,
        idleWindows,
        workerPickupMs,
        workerResult,
        completed,
        failureName,
        runtime: process.version,
      },
      null,
      2,
    ),
  );
  clearInterval(memory);
  if (worker && worker.exitCode === null) {
    worker.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((done) => worker!.once("exit", () => done())),
      delay(3000),
    ]);
    if (worker.exitCode === null) worker.kill("SIGKILL");
  }
  await app?.close();
  await observations.end();
  await root.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await root.end();
  pg.Client.prototype.query = originalQuery;
  console.log = logs;
}
