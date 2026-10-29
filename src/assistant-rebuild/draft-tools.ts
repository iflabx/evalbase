import { AsyncLocalStorage } from "node:async_hooks";
import { tool } from "langchain";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { draftOperations } from "../drafts/operations.js";
import { createSharedDraft } from "../drafts/create.js";
import { versionOperations } from "../version/store.js";
import {
  draftPatchSchema,
  draftRecordSchema,
  recordPatchSchema,
  selectionSchema,
  pageSchema,
  identity,
} from "../drafts/protocol.js";
import {
  createSelectionPreview,
  readSelectionPreview,
  readSelectionHistory,
  readVersionSelectionHistory,
} from "../selection/store.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { withOperationScope } from "../operations/commit.js";
import type { ArtifactRepository } from "../storage/artifacts.js";
import { SessionStore, SessionError, type TurnProof } from "./session-store.js";
import { ExecutionStore } from "./execution-store.js";

export function draftTools(
  store: SessionStore,
  execution: ExecutionStore,
  proof: TurnProof,
  artifacts: ArtifactRepository,
  canWrite: boolean,
  wait: () => Promise<unknown>,
) {
  const invocation = new AsyncLocalStorage<string>();
  const drafts = draftOperations(store.db, artifacts),
    versions = versionOperations(store.db, artifacts);
  const draftId = z.object({ draftId: identity }).strict(),
    versionId = z.object({ testSetId: identity, versionId: identity }).strict();
  const query = (args: any) =>
    Object.fromEntries(
      Object.entries(args)
        .filter(([k]) =>
          ["search", "limit", "offset", "view", "includeIds"].includes(k),
        )
        .map(([k, v]) => [k, typeof v === "number" ? String(v) : v]),
    );
  const invoke = async (
    name: string,
    args: any,
    kind: string,
    run: (scope: any, op: any) => Promise<any>,
  ) => {
    const op = await execution.operation(
      proof,
      `draft:${proof.turnId}:${name}:${invocation.getStore() ?? sha256(canonicalJson(args))}`,
      kind,
      args,
    );
    const scope = execution.operationScope(proof, op);
    return withOperationScope(scope, () =>
      run({ ...scope, ...(args.draftId ? { draftId: args.draftId } : {}) }, op),
    );
  };
  const direct = (
    name: string,
    args: any,
    run: (scope: any, op: any) => Promise<any>,
  ) => invoke(name, args, "draft_mutation", run);
  const prepare = async (kind: string, args: any) => {
    const operationKey = `draft:${proof.turnId}:request_${kind}:${invocation.getStore() ?? sha256(canonicalJson(args))}`;
    const prior = (
      await store.db.query(
        "SELECT * FROM assistant_runtime_operation WHERE session_id=$1 AND operation_key=$2",
        [proof.sessionId, operationKey],
      )
    ).rows[0];
    if (prior) {
      const derived = [
        "draftName",
        "recordCount",
        ...(["publish", "discard_draft"].includes(kind) ? [] : ["revision"]),
      ];
      const original = Object.fromEntries(
        Object.entries(prior.payload).filter(([key]) => !derived.includes(key)),
      );
      if (
        prior.kind !== kind ||
        canonicalJson(original) !== canonicalJson(args)
      )
        throw new SessionError("operation_payload_conflict");
      const receipt = await execution.receipt(proof, proof.sessionId, prior.id);
      if (receipt) return { saved: true, receipt };
    }
    // Read and lock the actual object now; the business transaction rechecks frozen revisions on confirmation.
    const current = await drafts.read({ ...proof, draftId: args.draftId });
    const revision =
      args.revision ?? args.expectedRevision ?? current.draft.revision;
    if (revision !== current.draft.revision)
      throw new SessionError("draft_revision_conflict");
    if (kind === "remove_record") {
      const record = (
        await store.db.query(
          "SELECT id,row_revision FROM collaborative_draft_record WHERE draft_id=$1 AND id=$2 AND deleted=false",
          [args.draftId, args.recordId],
        )
      ).rows[0];
      if (!record || Number(record.row_revision) !== args.expectedRowRevision)
        throw new SessionError("draft_row_conflict");
    }
    const payload = {
      ...args,
      revision,
      draftName: current.draft.name,
      recordCount:
        kind === "selection" ? args.selectedIds.length : current.total,
    };
    const op =
      prior ?? (await execution.operation(proof, operationKey, kind, payload));
    const confirmation = await execution.prepare(proof, op);
    await wait();
    return { confirmationId: confirmation.id };
  };
  const definitions: Array<{
    name: string;
    description: string;
    readOnly: boolean;
    schema: z.ZodType;
    run: (args: any) => Promise<any>;
  }> = [
    {
      name: "list_test_sets",
      description:
        "按全部/草稿/已发布搜索当前项目测试集，每次最多10项；查看账号不返回草稿。",
      readOnly: true,
      schema: pageSchema.extend({
        status: z.enum(["all", "draft", "published"]).default("all"),
      }),
      run: async (a) => {
        const allDrafts =
          canWrite && a.status !== "published"
            ? (await drafts.list(proof, {}, {})).drafts.filter(
                (d: any) =>
                  !d.parentVersionId &&
                  d.name.toLowerCase().includes(a.search.toLowerCase()),
              )
            : [];
        const draftPage = allDrafts.slice(a.offset, a.offset + 10);
        const published =
          a.status === "draft"
            ? { testSets: [] }
            : await versions.list(
                proof,
                {},
                {
                  ...(a.search.trim() ? { name: a.search } : {}),
                  offset: String(Math.max(0, a.offset - allDrafts.length)),
                  limit: String(10 - draftPage.length || 1),
                },
              );
        return {
          drafts: draftPage,
          published: draftPage.length === 10 ? { testSets: [] } : published,
          offset: a.offset,
          pageSize: 10,
        };
      },
    },
    {
      name: "read_version",
      description: "读取真实正式版本、版本图和名称；只读，不原地改写正式版本。",
      readOnly: true,
      schema: versionId,
      run: (a) => versions.read({ ...proof, ...a }),
    },
    {
      name: "read_version_records",
      description:
        "分页读取正式版本记录；ordinal给出时读取单条完整正文及Metadata。",
      readOnly: true,
      schema: versionId
        .merge(pageSchema)
        .extend({ ordinal: z.number().int().min(1).optional() }),
      run: (a) =>
        a.ordinal
          ? versions.record({ ...proof, ...a, ordinal: String(a.ordinal) })
          : versions.records({ ...proof, ...a }, {}, query(a)),
    },
    {
      name: "read_version_provenance",
      description:
        "读取正式版本来源、修改及选取历史；changeId给出时读取该修改详情。",
      readOnly: true,
      schema: versionId.merge(pageSchema).extend({
        changeId: identity.optional(),
        selectionHistory: z.boolean().optional(),
      }),
      run: (a) =>
        a.selectionHistory
          ? readVersionSelectionHistory(store.db, { ...proof, ...a })
          : a.changeId
            ? versions.change({ ...proof, ...a })
            : versions.provenance({ ...proof, ...a }, {}, query(a)),
    },
    {
      name: "download_version",
      description:
        "为已核实的正式版本提供CSV或数据与溯源ZIP下载卡，由用户点击下载，不返回私有存储地址。",
      readOnly: true,
      schema: versionId.extend({
        format: z.enum(["csv", "bundle"]).default("csv"),
      }),
      run: async (a) => {
        const v = await versions.read({ ...proof, ...a });
        return {
          nativeAction: {
            kind: "version_download",
            name: "下载正式版本",
            testSetId: a.testSetId,
            versionId: a.versionId,
            format: a.format,
          },
          version: v,
        };
      },
    },
    ...(canWrite
      ? [
          {
            name: "open_draft",
            description:
              "打开已核实的草稿及现有添加资料/冲突处理页面；原生页面编辑按现有离焦保存，交回助手前先提交。",
            readOnly: true,
            schema: draftId,
            run: async (a: any) => {
              const data = await drafts.read({ ...proof, draftId: a.draftId });
              return {
                nativeAction: {
                  kind: "navigation",
                  name: "打开草稿：" + data.draft.name,
                  href: `/projects/${proof.projectId}/test-sets/drafts/${a.draftId}`,
                },
                draft: data.draft,
              };
            },
          },

          {
            name: "create_draft",
            description:
              "明确新建空草稿，或提供真实testSetId与parentVersionId派生/继续共享草稿。普通创建无需额外确认；返回真实ID。",
            readOnly: false,
            schema: z
              .object({
                name: z.string().max(200).optional(),
                purpose: z.string().max(2000).optional(),
                testSetId: identity.optional(),
                parentVersionId: identity.optional(),
              })
              .strict(),
            run: (a: any) =>
              direct("create_draft", a, async (scope, op) =>
                createSharedDraft(store.db, scope, a, op.id),
              ),
          },
          {
            name: "read_draft",
            description:
              "读取草稿摘要、字段与行修订、分页记录及真实来源。recordId给出时服务端按真实身份定位，不把列表截断当全文。",
            readOnly: true,
            schema: draftId
              .merge(pageSchema)
              .extend({ recordId: identity.optional() }),
            run: async (a: any) => {
              const result = await drafts.read(
                { ...proof, draftId: a.draftId },
                {},
                query(a),
              );
              if (a.recordId)
                return drafts.record({
                  ...proof,
                  draftId: a.draftId,
                  recordId: a.recordId,
                });
              return result;
            },
          },
          {
            name: "update_draft",
            description:
              "修改已有草稿名称或用途；expectedFieldRevision取实际字段修订。发生冲突保留原输入并交用户选择，禁止自动换新修订强行覆盖。",
            readOnly: false,
            schema: draftId.merge(draftPatchSchema),
            run: (a: any) =>
              direct("update_draft", a, (scope) =>
                drafts.update(scope, (({ draftId: _, ...v }) => v)(a)),
              ),
          },
          {
            name: "add_draft_record",
            description:
              "手动新增一条草稿记录，或用真实原始记录source添加。与模型生成区分；source不能混合显式字段。",
            readOnly: false,
            schema: draftId.merge(draftRecordSchema),
            run: (a: any) =>
              direct("add_draft_record", a, (scope) =>
                drafts.addRecord(scope, (({ draftId: _, ...v }) => v)(a)),
              ),
          },
          {
            name: "update_draft_record",
            description:
              "只修改指定草稿记录的一个字段，使用该字段的实际修订，不覆盖其他字段。Metadata按完整有序数组提交。冲突交用户明确处理。",
            readOnly: false,
            schema: draftId
              .merge(recordPatchSchema)
              .extend({ recordId: identity }),
            run: (a: any) =>
              direct("update_draft_record", a, (scope) =>
                drafts.updateRecord(
                  { ...scope, recordId: a.recordId },
                  (({ draftId: _, recordId: __, ...v }) => v)(a),
                ),
              ),
          },
          {
            name: "request_remove_record",
            description:
              "准备移除一条草稿记录的固定确认，核对recordId与expectedRowRevision。用户确认才删除。",
            readOnly: false,
            schema: draftId.extend({
              recordId: identity,
              expectedRowRevision: z.number().int().min(0),
            }),
            run: (a: any) => prepare("remove_record", a),
          },
          {
            name: "request_discard_draft",
            description:
              "准备删除未发布草稿的固定确认；正式版本保留，用户确认前不删除。",
            readOnly: false,
            schema: draftId.extend({ revision: z.number().int().min(0) }),
            run: (a: any) => prepare("discard_draft", a),
          },
          {
            name: "request_publish",
            description:
              "准备发布草稿的固定确认；revision取已保存的草稿修订，用户确认才产生正式版本。先处理未保存输入或冲突。",
            readOnly: false,
            schema: draftId.extend({ revision: z.number().int().min(0) }),
            run: (a: any) => prepare("publish", a),
          },
          {
            name: "list_draft_source_files",
            description:
              "搜索可用于固定选取的原始文件，最多选择5个；区分本页与全部匹配，不扩大输入范围。",
            readOnly: true,
            schema: pageSchema,
            run: (a: any) => drafts.sourceFiles(proof, {}, query(a)),
          },
          {
            name: "preview_selection",
            description:
              "在真实草稿中冻结选中文件的筛选/随机预览。用户说前N条时预览全部后按实际ordinal选定selectedIds，不能随机替代。最多5文件，AND条件，比例向下取整；翻页读取同一previewId不重抽。重抽须重新创建并使旧确认失效。",
            readOnly: false,
            schema: draftId.merge(selectionSchema),
            run: (a: any) =>
              direct("preview_selection", a, async (scope, op) => {
                if (op.receipt) return op.receipt;
                const input = await store.guard(proof);
                if (
                  input.context?.recordIds?.length &&
                  input.context.kind !== "assets"
                )
                  throw new SessionError("selection_scope_changed");
                const result = await createSelectionPreview(
                  store.db,
                  {
                    ...scope,
                    draftId: a.draftId,
                    ...(input.context?.recordIds?.length
                      ? { fixedInputIds: input.context.recordIds }
                      : {}),
                  },
                  (({ draftId: _, ...v }) => v)(a),
                );
                return result;
              }),
          },
          {
            name: "read_selection_preview",
            description:
              "分页读取同一固定候选预览；view candidate可查看候选以排除或补选，includeIds给出已勾选身份；不能从页数猜测全部输入。",
            readOnly: true,
            schema: draftId.merge(pageSchema).extend({
              previewId: identity,
              view: z.enum(["selected", "candidates"]).default("selected"),
              includeIds: z.array(identity).optional(),
            }),
            run: (a: any) =>
              readSelectionPreview(
                store.db,
                { ...proof, draftId: a.draftId },
                a.previewId,
                query(a),
              ),
          },
          {
            name: "request_selection_apply",
            description:
              "将固定预览中明确选择的selectedIds加入草稿，冻结expectedRevision；用户在确认卡确认才采用，参数变化旧确认失效。",
            readOnly: false,
            schema: draftId.extend({
              previewId: identity,
              selectedIds: z.array(z.string().min(1)).min(1).max(10000),
              expectedRevision: z.number().int().min(0),
            }),
            run: (a: any) => prepare("selection", a),
          },
          {
            name: "read_selection_history",
            description:
              "读取草稿真实选取历史及已选原始来源，含规则、范围和采用回执，不重新抽取。",
            readOnly: true,
            schema: draftId,
            run: async (a: any) => ({
              ...(await readSelectionHistory(store.db, {
                ...proof,
                draftId: a.draftId,
              })),
              ...(await drafts.selectedSources({
                ...proof,
                draftId: a.draftId,
              })),
            }),
          },
          {
            name: "open_draft_processing",
            description:
              "从已保存草稿所选记录进入现有数据处理页，传递固定记录ID和原草稿保存目标；不创建第二套处理任务。",
            readOnly: true,
            schema: draftId.extend({
              recordIds: z.array(identity).min(1).max(10000),
            }),
            run: async (a: any) => {
              await drafts.read({ ...proof, draftId: a.draftId });
              const fixed = await store.freezeSource(proof, {
                kind: "draft",
                id: a.draftId,
                recordIds: a.recordIds,
              });
              return {
                nativeAction: {
                  kind: "processing",
                  draftId: a.draftId,
                  recordIds: a.recordIds,
                  sourceRevision: fixed.sourceRevision,
                  name: "处理草稿所选记录",
                  href: `/projects/${proof.projectId}/processing?source=draft&sourceId=${a.draftId}`,
                },
                source: fixed.source,
                saveTarget: { kind: "sourceDraft", draftId: a.draftId },
              };
            },
          },
        ]
      : []),
  ];
  return {
    tools: definitions.map((d) =>
      tool(
        async (args, config) =>
          invocation.run(
            config.toolCall?.id ?? sha256(canonicalJson(args)),
            async () => {
              await store.guard(proof, !d.readOnly);
              try {
                const result = await d.run(args);
                const a = args as any;
                if (d.name === "preview_selection")
                  await store.event(proof, "source_read", {
                    source: { kind: "assets", assetIds: a.assetIds },
                  });
                const targetId = a.draftId ?? result?.draft?.id;
                if (targetId && !d.name.startsWith("request_"))
                  await store.event(proof, "source_read", {
                    source: {
                      kind: "draft",
                      id: targetId,
                      recordIds: a.recordIds ?? [],
                    },
                  });
                if (
                  d.name === "read_draft" ||
                  d.name === "open_draft_processing"
                )
                  await store.event(proof, "source_read", {
                    source: {
                      kind: "draft",
                      id: a.draftId,
                      recordIds: a.recordIds ?? [],
                    },
                  });
                if (
                  d.name.startsWith("read_version") ||
                  d.name === "download_version"
                )
                  await store.event(proof, "source_read", {
                    source: { kind: "version", id: a.versionId, recordIds: [] },
                  });
                return result;
              } catch (error) {
                if (
                  /draft_(field|row)_conflict|draft_record_removed/.test(
                    (error as Error).message,
                  )
                ) {
                  await store.finish(
                    proof,
                    "草稿已有其他修改，你的输入已保留。请核对冲突后再决定是否采用。",
                    "draft_conflict",
                  );
                  throw new SessionError("runtime_interrupted");
                }
                throw error;
              }
            },
          ),
        { name: d.name, description: d.description, schema: d.schema },
      ),
    ) as StructuredToolInterface[],
    schemas: new Map(definitions.map((d) => [d.name, d.schema])),
    readOnly: new Set(definitions.filter((d) => d.readOnly).map((d) => d.name)),
  };
}
