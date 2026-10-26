import { ChatOpenAI } from "@langchain/openai";
import { tool } from "langchain";
import { z } from "zod";
import { createPool } from "../../src/db/pool.js";
import { loadConfig } from "../../src/config.js";
import {
  configuredChatConnection,
  modelFetch,
} from "../../src/model/connection.js";
import { previewProcessingInput } from "../../src/processing/store.js";
import {
  validationFetch,
  processingCost,
} from "../../src/assistant-rebuild/budget.js";
const [projectId, actorId, assetId] = process.argv.slice(2);
if (
  !projectId ||
  !actorId ||
  !assetId ||
  process.env.REBUILD_VALIDATION_ENABLED !== "true"
)
  throw Error("validation_scope_required");
const db = createPool(loadConfig().databaseUrl);
const results: unknown[] = [];
try {
  const cfg = await configuredChatConnection(db, loadConfig());
  const transport = validationFetch(
    db,
    process.env.REBUILD_VALIDATION_CAMPAIGN_ID!,
    { kind: "probe" },
    modelFetch,
  );
  const make = (streaming = false) =>
    new ChatOpenAI({
      model: cfg.model,
      apiKey: cfg.apiKey,
      temperature: 0,
      maxTokens: 8192,
      maxRetries: 1,
      timeout: 180000,
      streaming,
      modelKwargs: { parallel_tool_calls: false },
      configuration: { baseURL: cfg.baseURL, fetch: transport },
    });
  const read = async (count: number) => {
    const data = await previewProcessingInput(
      db,
      { projectId, actorId },
      { source: { kind: "assets", assetIds: [assetId] }, limit: count },
      "read",
    );
    return { records: data.records };
  };
  const simple = tool(
    async ({ assetId: actual, count }) => {
      if (actual !== assetId) throw Error("probe_wrong_source");
      return read(count);
    },
    {
      name: "read_records",
      description: "读取指定真实文件前几条",
      schema: z
        .object({ assetId: z.string(), count: z.number().int().min(1).max(6) })
        .strict(),
    },
  );
  const nested = tool(
    async ({ source, selection }) => {
      if (source.assetId !== assetId || selection.label !== "预约服务")
        throw Error("probe_wrong_nested_value");
      return read(selection.count);
    },
    {
      name: "preview_source",
      description: "嵌套参数读取预约服务资料",
      schema: z
        .object({
          source: z.object({ assetId: z.string() }).strict(),
          selection: z
            .object({
              count: z.number().int().min(1).max(6),
              label: z.string(),
            })
            .strict(),
        })
        .strict(),
    },
  );
  for (const [name, selected, stream] of [
    ["simple", simple, false],
    ["nested", nested, false],
    ["streamed", nested, true],
  ] as const) {
    try {
      const answer = await make(stream)
        .bindTools([selected], {
          tool_choice: selected.name,
          parallel_tool_calls: false,
        })
        .invoke([
          {
            role: "user",
            content:
              "读取真实文件 " +
              assetId +
              " 前3条。嵌套selection.label为“预约服务”。只调用指定读取工具。",
          },
        ]);
      if (answer.response_metadata.finish_reason === "length")
        throw Error("probe_output_truncated");
      const call = answer.tool_calls?.find((c) => c.name === selected.name);
      if (!call) throw Error("probe_tool_call_missing");
      const data =
        name === "simple"
          ? await simple.invoke(simple.schema.parse(call.args))
          : await nested.invoke(nested.schema.parse(call.args));
      if (JSON.parse(JSON.stringify(data)).records?.length !== 3)
        throw Error("probe_business_result_missing");
      results.push({ name, passed: true, tool: selected.name });
    } catch (e) {
      results.push({
        name,
        passed: false,
        error: e instanceof Error ? e.name : "unknown",
        reason: e instanceof Error ? e.message.slice(0, 100) : "unknown",
      });
      if (name !== "streamed") {
        console.log(
          JSON.stringify({
            model: cfg.model,
            results,
            requiredProtocolPassed: false,
          }),
        );
        process.exitCode = 1;
        break;
      }
    }
  }
  if (!process.exitCode) {
    try {
      const answer = await processingCost.run({ rows: 1, generated: 0 }, () =>
        make().invoke([
          {
            role: "user",
            content:
              '把问题“  怎样预约座位？  ”去掉首尾空格，仅返回JSON对象：{"question":"整理后的问题"}。不增加说明。',
          },
        ]),
      );
      const text = typeof answer.content === "string" ? answer.content : "";
      const value = JSON.parse(
        text
          .trim()
          .replace(/^\x60\x60\x60(?:json)?\s*/, "")
          .replace(/\s*\x60\x60\x60$/, ""),
      );
      results.push({
        name: "json",
        passed: value.question === "怎样预约座位？",
      });
    } catch (e) {
      results.push({
        name: "json",
        passed: false,
        error: e instanceof Error ? e.name : "unknown",
      });
    }
    const requiredProtocolPassed = ["simple", "nested", "json"].every((name) =>
      results.some((r: any) => r.name === name && r.passed),
    );
    if (!requiredProtocolPassed) process.exitCode = 1;
    console.log(
      JSON.stringify({
        model: cfg.model,
        results,
        requiredProtocolPassed,
      }),
    );
  }
} finally {
  await db.end();
}
