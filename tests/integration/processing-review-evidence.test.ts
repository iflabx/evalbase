import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { buildApp, type AgentBenchApp } from "../../src/server/app.js";
import { createPool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { loadConfig } from "../../src/config.js";
import { ArtifactRepository } from "../../src/storage/artifacts.js";
import { runProcessing } from "../../src/processing/execute.js";
import { reviewRulesHash } from "../../src/processing/content-review.js";
import { sha256 } from "../../src/package/contract.js";
const origin = "http://127.0.0.1:4217";
const databaseName = "processing_" + randomUUID().replaceAll("-", "");
const baseUrl = loadConfig().databaseUrl;
const databaseUrl = baseUrl.replace(/\/[^/]+$/, "/" + databaseName);
describe("OPT41 public evidence and bounded repair", () => {
  let app: AgentBenchApp,
    db: ReturnType<typeof createPool>,
    headers: Record<string, string>,
    projectId: string;
  const config = {
    ...loadConfig(),
    databaseUrl,
    modelEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
  };
  const artifacts = new ArtifactRepository(config.minio);
  beforeAll(async () => {
    const root = createPool(baseUrl);
    try {
      await root.query("CREATE DATABASE " + databaseName);
    } finally {
      await root.end();
    }
    await migrate(databaseUrl);
    app = await buildApp(
      {
        ...config,
        appOrigin: origin,
        soloOwnerMode: false,
        allowTestIdentity: false,
      },
      { disableLegacyTestBootstrap: true },
    );
    db = createPool(databaseUrl);
    const account = {
      email: "admin@example.test",
      password: "Processing123",
      confirmPassword: "Processing123",
      displayName: "管理员",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/installation/administrator",
          headers: { origin },
          payload: account,
        })
      ).statusCode,
    ).toBe(201);
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      headers: { origin },
      payload: account,
    });
    headers = {
      origin,
      cookie: login.cookies[0].name + "=" + login.cookies[0].value,
      "x-csrf-token": login.json().csrfToken,
    };
    projectId = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers,
        payload: { name: "OPT41隔离验证" },
      })
    ).json().project.id;
  });
  afterAll(async () => {
    await app?.close();
    await db?.end();
    const root = createPool(baseUrl);
    try {
      await root.query(
        "DROP DATABASE IF EXISTS " + databaseName + " WITH (FORCE)",
      );
    } finally {
      await root.end();
    }
  });
  it.each([
    "normal",
    "not_proposed",
    "invalid_proposal",
    "no_recheck_budget",
    "recheck_nonconforms",
    "response_unknown",
    "invalid_evidence",
    "exhausted",
    "interrupted",
  ])(
    "%s preserves evidence, original content and the shared budget",
    async (mode) => {
      const draft = (
        await app.inject({
          method: "POST",
          url: "/api/projects/" + projectId + "/collaborative-drafts",
          headers,
          payload: {},
        })
      ).json().draft;
      const seed = (
        await app.inject({
          method: "POST",
          url:
            "/api/projects/" +
            projectId +
            "/collaborative-drafts/" +
            draft.id +
            "/records",
          headers,
          payload: {
            question: "参考输入",
            expectedOutput: "查询",
            metadata: [{ key: "keep", value: "yes" }],
          },
        })
      ).json().record;
      const questions = [
        "请问订单目前是什么状态？",
        "这个怎么办？",
        "我想查看物流进度，该去哪里查询？",
      ];
      let requests = 0,
        generations = 0;
      const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        requests++;
        const input = JSON.parse(JSON.parse(body).messages.at(-1).content);
        let output: any;
        if (input.candidates) {
          const recheck = input.candidates.some(
            (row: any) => row.question === "请问我可以从哪里查询退款进度？",
          );
          if (recheck && mode === "response_unknown") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                id: "x",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "{" },
                    finish_reason: "stop",
                  },
                ],
              }),
            );
            return;
          }
          output = {
            reviews: input.candidates.map((row: any) => {
              const bad =
                row.question === questions[1] ||
                (recheck && mode === "recheck_nonconforms");
              return {
                id: row.id,
                checks: Object.fromEntries(
                  ["question", "category", "expectedBehavior", "facts"].map(
                    (key) => [
                      key,
                      {
                        verdict:
                          key === "question" && bad
                            ? "nonconforms"
                            : "conforms",
                        reason: bad
                          ? "缺少可独立理解的对象"
                          : "问题及输出符合当前查询要求",
                        quote:
                          mode === "invalid_evidence"
                            ? "不存在的原句"
                            : row.question,
                        ...(key === "expectedBehavior"
                          ? { outputQuote: row.expectedOutput }
                          : {}),
                        ...(key === "facts" ? { basis: "no_assertion" } : {}),
                      },
                    ],
                  ),
                ),
                ...(bad &&
                !recheck &&
                !["not_proposed", "invalid_evidence"].includes(mode)
                  ? {
                      replacement: {
                        question:
                          mode === "invalid_proposal"
                            ? ""
                            : "请问我可以从哪里查询退款进度？",
                        expectedOutput: "查询",
                        metadata: row.metadata,
                      },
                    }
                  : {}),
              };
            }),
          };
        } else {
          generations++;
          output = {
            records: (mode === "no_recheck_budget"
              ? [questions[generations - 1]]
              : questions
            ).map((question) => ({
              sourceId: seed.id,
              question,
              expectedOutput: "查询",
              metadata: seed.metadata,
            })),
          };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "test",
            object: "chat.completion",
            created: 1,
            model: "synthetic",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: JSON.stringify(output) },
                finish_reason: "stop",
              },
            ],
          }),
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const rev =
          (
            await app.inject({
              method: "GET",
              url: "/api/settings/model-connection",
              headers,
            })
          ).json().connection?.revision ?? 0;
        expect(
          (
            await app.inject({
              method: "PUT",
              url: "/api/settings/model-connection",
              headers,
              payload: {
                revision: rev,
                name: "OPT41 controlled",
                endpoint:
                  "http://127.0.0.1:" +
                  (server.address() as { port: number }).port +
                  "/v1",
                model: "synthetic",
                apiKey: "synthetic-test",
                enabled: true,
              },
            })
          ).statusCode,
        ).toBe(200);
        const path = "/api/projects/" + projectId + "/processing-runs";
        const created = await app.inject({
          method: "POST",
          url: path,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: {
            source: { kind: "draft", id: draft.id, recordIds: [seed.id] },
            options: {
              operation: "augment",
              instructions: "生成完整自然的查询问题",
              allowedFields: ["question"],
              outputCount: 3,
            },
          },
        });
        expect(created.statusCode, created.body).toBe(201);
        const run = created.json().run;
        const frozen = (
          await db.query(
            "SELECT input_ref,input_hash FROM processing_run WHERE id=$1",
            [run.id],
          )
        ).rows[0];
        const input = JSON.parse(
          (await artifacts.readBytes(frozen.input_ref, 100000000)).toString(
            "utf8",
          ),
        );
        expect(input.background.contentReviewPolicy).toBe("evidence-v1");
        if (["exhausted", "interrupted"].includes(mode)) {
          const retained = {
            records: questions.map((question) => ({
              sourceId: seed.id,
              question,
              expectedOutput: "查询",
              metadata: seed.metadata,
            })),
            issues: [],
            ...(mode === "interrupted"
              ? {
                  contentReview: {
                    version: 2,
                    policy: "evidence-v1",
                    rulesHash: reviewRulesHash(run.options, input.background),
                    initialAttempted: true,
                    pendingCode: "response_unknown",
                    pendingReason: "核对响应未知，候选保留",
                    items: [],
                  },
                }
              : {}),
          };
          const stored = await artifacts.storeProcessing(
            Buffer.from(JSON.stringify(retained)),
            run.id,
            "batch-0",
          );
          await db.query(
            "INSERT INTO processing_batch(run_id,ordinal,result_ref,output_count,issues,error_code,output_bytes,result_indices,model_attempts,model_started_at) VALUES($1,0,$2,3,'[]','content_review_in_progress',100,ARRAY[0,1,2],$3,now())",
            [run.id, stored.objectRef, mode === "exhausted" ? 3 : 2],
          );
        }
        const job = (
          await db.query(
            "UPDATE job SET status='running',attempt=1,lease_owner='opt41',lease_expires_at=now()+interval '120 seconds' WHERE id=$1 RETURNING *",
            [run.jobId],
          )
        ).rows[0];
        let result: any;
        try {
          result = await runProcessing(db, artifacts, config, job);
        } catch (error) {
          if (mode !== "no_recheck_budget") throw error;
          expect((error as Error).message).toBe("processing_batch_failed");
          result = { partial: true };
        }
        await db.query("UPDATE job SET status=$2,result=$3 WHERE id=$1", [
          job.id,
          mode === "no_recheck_budget" ? "failed" : "succeeded",
          result,
        ]);
        const page = (
          await app.inject({
            method: "GET",
            url: path + "/" + run.id + "?view=all",
            headers,
          })
        ).json();
        if (mode === "normal") {
          expect(requests).toBe(3);
          expect(page.records[1].result.question).toBe(
            "请问我可以从哪里查询退款进度？",
          );
          expect(page.records[1].contentReview).toMatchObject({
            verdict: "conforms",
            repaired: true,
            repairStatus: "accepted",
          });
        } else if (mode === "invalid_evidence") {
          expect(requests).toBe(2);
          expect(page.stats.contentPending).toBe(3);
        } else if (["exhausted", "interrupted"].includes(mode)) {
          expect(requests).toBe(0);
          expect(page.stats.contentPending).toBe(3);
        } else {
          expect(page.records[1].result.question).toBe(questions[1]);
          expect(page.records[1].contentReview).toMatchObject({
            verdict: "nonconforms",
            repairStatus:
              mode === "invalid_proposal" ? "validation_rejected" : mode,
          });
        }
        expect(page.records[0].result.question).toBe(questions[0]);
        expect(
          page.records.every(
            (row: any) =>
              row.result.expectedOutput === "查询" &&
              row.result.metadata[0].value === "yes",
          ),
        ).toBe(true);
        const batch = (
          await db.query(
            "SELECT result_ref,model_attempts FROM processing_batch WHERE run_id=$1",
            [run.id],
          )
        ).rows[0];
        expect(batch.model_attempts).toBeLessThanOrEqual(3);
        const completed = JSON.parse(
          (await artifacts.readBytes(batch.result_ref, 100000000)).toString(
            "utf8",
          ),
        );
        expect(completed.contentReview.version).toBe(2);
        const used = requests;
        await db.query("UPDATE job SET status='running' WHERE id=$1", [job.id]);
        try {
          await runProcessing(db, artifacts, config, job);
        } catch (error) {
          if (mode !== "no_recheck_budget") throw error;
        }
        expect(requests).toBe(used);
        expect(
          sha256(await artifacts.readBytes(frozen.input_ref, 100000000)),
        ).toBe(frozen.input_hash);
        expect(
          (
            await db.query(
              "SELECT question FROM collaborative_draft_record WHERE draft_id=$1",
              [draft.id],
            )
          ).rows.map((row) => row.question),
        ).toEqual(["参考输入"]);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
