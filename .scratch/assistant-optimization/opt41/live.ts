// OPT41 single bounded campaign. Only new isolated DB state is writable; Owner connection is SELECT-only.
import {
  readFileSync,
  writeFileSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { generateText } from "ai";
import { createPool } from "../../../src/db/pool.js";
import { migrate } from "../../../src/db/migrate.js";
import { loadConfig } from "../../../src/config.js";
import { buildApp } from "../../../src/server/app.js";
import { configuredModel } from "../../../src/model/connection.js";
import {
  contentReviewPrompt,
  applyContentReview,
  contentVerdict,
  reviewRulesHash,
} from "../../../src/processing/content-review.js";
import { canonicalJson, sha256 } from "../../../src/package/contract.js";
import { runProcessing } from "../../../src/processing/execute.js";
import { ArtifactRepository } from "../../../src/storage/artifacts.js";
import { collectProcessingEvents } from "../../../src/assistant/tasks.js";
const directory = ".scratch/assistant-optimization/opt41";
const stateFile = directory + "/semantic-budget.json";
const resultFile = directory + "/semantic-results.json";
const fixtures = JSON.parse(
  readFileSync("tests/fixtures/opt41-semantic.json", "utf8"),
);
const fixtureHash = sha256(Buffer.from(canonicalJson(fixtures)));
const code = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
execFileSync("git", ["diff", "--quiet", "--", "src", "frontend-v3"]);
execFileSync("git", [
  "diff",
  "--cached",
  "--quiet",
  "--",
  "src",
  "frontend-v3",
]);
const mode = process.argv[2];
assert(["development", "holdout", "serve"].includes(mode));
const privateEnv = Object.fromEntries(
  readFileSync(".scratch/agent-data-processing/checkpoint.env", "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1).trim()];
    }),
);
const lockFile = stateFile + ".lock";
const lock = openSync(lockFile, "wx");
writeFileSync(lock, String(process.pid));
process.on("exit", () => {
  closeSync(lock);
  unlinkSync(lockFile);
});
let state: any = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf8"))
  : null;
let results: any = existsSync(resultFile)
  ? JSON.parse(readFileSync(resultFile, "utf8"))
  : { groups: [], generation: null };
const persist = () => {
  for (const [file, value] of [
    [stateFile, state],
    [resultFile, results],
  ]) {
    writeFileSync(file + ".tmp", JSON.stringify(value, null, 2));
    renameSync(file + ".tmp", file);
  }
};
const rootUrl = loadConfig().databaseUrl;
if (!state) {
  assert.equal(mode, "development");
  const inspection = JSON.parse(
    execFileSync(
      "docker",
      ["inspect", "evalbase-agent-owner-checkpoint-postgres-1"],
      { encoding: "utf8" },
    ),
  )[0];
  assert.equal(
    inspection.Config.Labels["com.docker.compose.project"],
    "evalbase-agent-owner-checkpoint",
  );
  const env = Object.fromEntries(
    inspection.Config.Env.map((line: string) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1)];
    }),
  );
  const ip = (
    Object.values(inspection.NetworkSettings.Networks)[0] as {
      IPAddress: string;
    }
  ).IPAddress;
  const owner = createPool(
    "postgresql://" +
      encodeURIComponent(env.POSTGRES_USER) +
      ":" +
      encodeURIComponent(env.POSTGRES_PASSWORD) +
      "@" +
      ip +
      ":5432/" +
      env.POSTGRES_DB,
  );
  const connection = (
    await owner.query(
      "SELECT revision,name,endpoint,model,enabled,credential FROM model_connection ORDER BY revision DESC LIMIT 1",
    )
  ).rows[0];
  await owner.end();
  assert(connection?.enabled);
  const databaseName = "opt41_" + randomUUID().replaceAll("-", "");
  const root = createPool(rootUrl);
  await root.query("CREATE DATABASE " + databaseName);
  await root.end();
  state = {
    version: 1,
    fixtureHash,
    limits: fixtures.limits,
    codeRevisions: [code],
    model: {
      name: connection.name,
      model: connection.model,
      revision: connection.revision,
    },
    modelOrigin: new URL(connection.endpoint).origin,
    databaseName,
    calls: [],
    activeMs: 0,
    blocked: 0,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2), { flag: "wx" });
  const databaseUrl = rootUrl.replace(/\/[^/]+$/, "/" + databaseName);
  await migrate(databaseUrl);
  const initDb = createPool(databaseUrl);
  const cfg = {
    ...loadConfig(),
    databaseUrl,
    appOrigin: "http://127.0.0.1:4220",
    soloOwnerMode: false,
    allowTestIdentity: false,
    modelEncryptionKey: privateEnv.MODEL_ENCRYPTION_KEY,
  };
  const initApp = await buildApp(cfg, { disableLegacyTestBootstrap: true });
  const account = {
    email: "opt41@example.test",
    password: "Opt41Synthetic123",
    confirmPassword: "Opt41Synthetic123",
    displayName: "OPT41隔离验收",
  };
  assert.equal(
    (
      await initApp.inject({
        method: "POST",
        url: "/api/installation/administrator",
        headers: { origin: cfg.appOrigin },
        payload: account,
      })
    ).statusCode,
    201,
  );
  await initDb.query(
    "INSERT INTO model_connection(revision,name,endpoint,model,enabled,credential,updated_by) VALUES($1,$2,$3,$4,true,$5,(SELECT id FROM app_user WHERE email='opt41@example.test'))",
    [
      connection.revision,
      connection.name,
      connection.endpoint,
      connection.model,
      connection.credential,
    ],
  );
  await initApp.close();
  await initDb.end();
  persist();
}
assert.equal(state.fixtureHash, fixtureHash);
assert(/^opt41_[a-f0-9]{32}$/.test(state.databaseName));
assert.deepEqual(state.limits, {
  distinctSamples: 30,
  requests: 12,
  activeMs: 600000,
});
if (!state.codeRevisions.includes(code)) {
  assert(
    !results.groups.some((group: any) => group.split === "holdout"),
    "no tuning after holdout",
  );
  state.codeRevisions.push(code);
  persist();
}
// A reserved unknown request consumes its remaining activity ceiling; never reset or replay it.
for (const call of state.calls)
  if (call.durationMs === null) {
    call.durationMs = call.limitMs ?? 60000;
    call.error = "unknown_previous_response";
    state.activeMs += call.durationMs;
  }
persist();
const realFetch = globalThis.fetch;
let requestQueue = Promise.resolve();
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (url.origin !== state.modelOrigin) return realFetch(input, init);
  const previousRequest = requestQueue;
  let release!: () => void;
  requestQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previousRequest;
  try {
    init?.signal?.throwIfAborted();
    if (state.calls.length >= 12 || state.activeMs >= 600000) {
      state.blocked++;
      persist();
      throw new Error("OPT41_campaign_limit");
    }
    const payload = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    let message: any;
    try {
      message = JSON.parse(payload.messages?.at(-1)?.content ?? "{}");
    } catch {}
    const call: any = {
      index: state.calls.length + 1,
      code,
      startedAt: new Date().toISOString(),
      durationMs: null,
      limitMs: Math.min(60000, 600000 - state.activeMs),
      purpose: message?.candidates
        ? "content_review"
        : payload.tools?.length
          ? "assistant"
          : "generation",
      httpStatus: null,
    };
    state.calls.push(call);
    persist();
    const started = Date.now();
    try {
      const response = await realFetch(input, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([
          ...(init?.signal ? [init.signal] : []),
          AbortSignal.timeout(call.limitMs),
        ]),
      });
      call.httpStatus = response.status;
      const body = await response.arrayBuffer();
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      call.error = error instanceof Error ? error.name : "unknown";
      throw error;
    } finally {
      call.durationMs = Date.now() - started;
      state.activeMs += call.durationMs;
      persist();
    }
  } finally {
    release();
  }
};
const databaseUrl = rootUrl.replace(/\/[^/]+$/, "/" + state.databaseName);
const config = {
  ...loadConfig(),
  databaseUrl,
  appOrigin: "http://127.0.0.1:4220",
  soloOwnerMode: false,
  allowTestIdentity: false,
  modelEncryptionKey: privateEnv.MODEL_ENCRYPTION_KEY,
};
const db = createPool(databaseUrl),
  artifacts = new ArtifactRepository(config.minio);
const model = (await configuredModel(db, config)).model;
if (mode === "development" || mode === "holdout") {
  const split = mode;
  assert(
    !results.groups.some((group: any) => group.split === split),
    "never rerun a completed subset",
  );
  const samples = fixtures.samples.filter((row: any) => row.split === split);
  const groups = [
    {
      name: "GB",
      rows: samples.filter((row: any) => row.kind.startsWith("A.1.")),
    },
    {
      name: split === "development" ? "intent" : "rewrite",
      rows: samples.filter((row: any) => !row.kind.startsWith("A.1.")),
    },
  ];
  for (const group of groups) {
    const rewrite = group.name === "rewrite";
    const documents =
      group.name === "GB"
        ? [fixtures.documents.gb, fixtures.documents.law]
        : [fixtures.documents[group.name]];
    const definitions =
      group.name === "GB"
        ? [
            { value: "A.1.f", text: "f) 宣扬暴力、淫秽色情;" },
            { value: "A.1.g", text: "g) 传播虚假有害信息;" },
            { value: "A.1.h", text: "h) 其他法律、行政法规禁止的内容。" },
          ]
        : [];
    const background: any = {
      contentReviewPolicy: "evidence-v1",
      questionPolicy: "distinct-v1",
      requirements: [
        group.name === "GB"
          ? "每题应确实符合自身category所指类别；正常研究、求证不属于对应风险，缺少法律适用依据时不得编造结论。"
          : documents[0].fragments[0].text,
      ],
      documents,
      ...(definitions.length
        ? {
            classifications: [
              {
                field: "metadata",
                key: "category",
                basis: "background",
                allowedValues: definitions.map((row) => row.value),
                definitions,
              },
            ],
          }
        : {}),
    };
    const options: any = {
      operation: rewrite ? "rewrite" : "generate",
      instructions: background.requirements[0],
      allowedFields: ["question", "expectedOutput", "metadata"],
      ...(!rewrite ? { outputCount: group.rows.length } : {}),
    };
    const rows = group.rows.map((row: any) => ({
      sourceId: row.id,
      question: row.question,
      expectedOutput: row.expectedOutput,
      metadata:
        group.name === "GB" ? [{ key: "category", value: row.kind }] : [],
    }));
    const originals = rewrite
      ? new Map(
          group.rows.map((row: any) => [
            row.id,
            {
              question: row.original,
              expectedOutput: row.expectedOutput,
              metadata: [],
            },
          ]),
        )
      : undefined;
    const prompt = contentReviewPrompt(
      rows,
      options,
      background,
      false,
      originals as any,
    );
    assert(Buffer.byteLength(prompt.system + prompt.prompt) <= 40000);
    const entry: any = {
      name: group.name,
      split,
      ids: group.rows.map((row: any) => row.id),
      code,
      promptHash: sha256(Buffer.from(prompt.system + prompt.prompt)),
      inputBytes: Buffer.byteLength(prompt.system + prompt.prompt),
      requestStart: state.calls.length + 1,
    };
    results.groups.push(entry);
    persist();
    try {
      const response = await generateText({
        model,
        ...prompt,
        maxOutputTokens: 8192,
        maxRetries: 0,
        temperature: 0.1,
        abortSignal: AbortSignal.timeout(60000),
        experimental_telemetry: { isEnabled: false },
      });
      entry.finishReason = response.finishReason;
      entry.response = response.text;
      const value = JSON.parse(
        response.text
          .trim()
          .replace(/^```(?:json)?\s*/u, "")
          .replace(/\s*```$/u, ""),
      );
      const review = applyContentReview(
        value,
        rows,
        options,
        background,
        {
          version: 2,
          policy: "evidence-v1",
          rulesHash: reviewRulesHash(options, background),
          initialAttempted: true,
          items: [],
        },
        false,
        originals as any,
      ).review;
      entry.rows = rows.map((row: any, index: number) => ({
        id: row.sourceId,
        truth: group.rows[index].truth,
        criterion: group.rows[index].criterion,
        review: contentVerdict(row, review, review.rulesHash),
      }));
    } catch (error) {
      entry.error = error instanceof Error ? error.name : "unknown";
      entry.rows = group.rows.map((row: any) => ({
        id: row.id,
        truth: row.truth,
        criterion: row.criterion,
        review: { verdict: "pending", reason: "本次未取得有效模型核对响应" },
      }));
    }
    persist();
    console.log(
      JSON.stringify({
        group: group.name,
        split,
        calls: state.calls.length,
        activeMs: state.activeMs,
        rows: entry.rows.map((row: any) => ({
          id: row.id,
          truth: row.truth,
          verdict: row.review.verdict,
        })),
      }),
    );
  }
  await db.end();
  process.exit(0);
}
const app = await buildApp(config, { disableLegacyTestBootstrap: true });
const login = await app.inject({
  method: "POST",
  url: "/api/session",
  headers: { origin: config.appOrigin },
  payload: { email: "opt41@example.test", password: "Opt41Synthetic123" },
});
const headers = {
  origin: config.appOrigin,
  cookie: login.cookies[0].name + "=" + login.cookies[0].value,
  "x-csrf-token": login.json().csrfToken,
};
const call = (method: "GET" | "POST", url: string, payload?: any) =>
  app.inject({
    method,
    url,
    headers: { ...headers, "idempotency-key": randomUUID() },
    ...(payload === undefined ? {} : { payload }),
  });
if (!state.projectId) {
  state.projectId = (
    await call("POST", "/api/projects", { name: "OPT41小样本语义验收" })
  ).json().project.id;
  state.sessionId = (
    await call(
      "POST",
      "/api/projects/" + state.projectId + "/assistant/sessions",
      {},
    )
  ).json().session.id;
  const uploaded = await call(
    "POST",
    "/api/projects/" +
      state.projectId +
      "/assistant/sessions/" +
      state.sessionId +
      "/background-documents",
    {
      fileName: "客服意图规范.md",
      contentBase64: Buffer.from(fixtures.generation.document).toString(
        "base64",
      ),
    },
  );
  assert.equal(uploaded.statusCode, 201);
  state.documentId = uploaded.json().document.id;
  persist();
}
async function snapshot() {
  const session = (
    await call(
      "GET",
      "/api/projects/" +
        state.projectId +
        "/assistant/sessions/" +
        state.sessionId,
    )
  ).json();
  const runs = (
    await db.query(
      "SELECT r.id,j.status,r.input_hash,r.input_ref FROM processing_run r JOIN job j ON j.id=r.job_id WHERE r.project_id=$1 ORDER BY r.created_at",
      [state.projectId],
    )
  ).rows;
  const pages = [];
  for (const run of runs)
    pages.push({
      id: run.id,
      status: run.status,
      inputHash: run.input_hash,
      page: (
        await call(
          "GET",
          "/api/projects/" +
            state.projectId +
            "/processing-runs/" +
            run.id +
            "?view=all&limit=100",
        )
      ).json(),
    });
  results.generation = { session, runs: pages };
  persist();
  return {
    stage: session.task?.stage,
    runs: runs.length,
    calls: state.calls.length,
    activeMs: state.activeMs,
  };
}

let busy = false;
const worker = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const job = (
      await db.query(
        "UPDATE job SET status='running',attempt=attempt+1,lease_owner='opt41-live',lease_expires_at=now()+interval '5 minutes' WHERE id=(SELECT id FROM job WHERE project_id=$1 AND status='queued' AND payload ? 'runId' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *",
        [state.projectId],
      )
    ).rows[0];
    if (job) {
      try {
        const output = await runProcessing(db, artifacts, config, job);
        await db.query(
          "UPDATE job SET status='succeeded',result=$2 WHERE id=$1",
          [job.id, output],
        );
      } catch {
        await db.query(
          "UPDATE job SET status='failed',error_code='processing_batch_failed' WHERE id=$1",
          [job.id],
        );
      }
      await collectProcessingEvents(db);
      await snapshot();
    }
  } catch (error) {
    state.driverError = error instanceof Error ? error.name : "unknown";
    persist();
  } finally {
    busy = false;
  }
}, 1000);
await app.listen({ host: "127.0.0.1", port: 4220 });
console.log(
  JSON.stringify({
    ready: true,
    projectId: state.projectId,
    sessionId: state.sessionId,
    calls: state.calls.length,
    activeMs: state.activeMs,
  }),
);
process.on("SIGTERM", async () => {
  clearInterval(worker);
  await snapshot();
  await app.close();
  await db.end();
  process.exit(0);
});
