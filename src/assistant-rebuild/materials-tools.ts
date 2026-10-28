import { tool } from "langchain";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { PoolClient } from "pg";
import {
  MaterialsStore,
  materialNameSchema,
  materialPageSchema,
} from "../materials/store.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { SessionStore, type TurnProof } from "./session-store.js";
import type { ArtifactRepository } from "../storage/artifacts.js";

/** Domain tools use the same business service as Web writes; model arguments never supply actor/session/project authority. */
export function materialsTools(
  sessions: SessionStore,
  proof: TurnProof,
  canWrite: boolean,
  artifacts: ArtifactRepository,
) {
  const store = new MaterialsStore(sessions.db, artifacts);
  const write = async (
    name: string,
    args: unknown,
    run: (client: PoolClient) => Promise<unknown>,
  ) => {
    const c = await sessions.db.connect();
    const key =
      "material:" +
      sha256(
        canonicalJson({
          sessionId: proof.sessionId,
          turnId: proof.turnId,
          name,
          args,
        }),
      );
    try {
      await c.query("BEGIN");
      await sessions.guard(proof, true, c, true);
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
      const saved = (
        await c.query(
          "SELECT detail FROM assistant_runtime_event WHERE session_id=$1 AND operation_key=$2 AND kind='material_receipt' ORDER BY id LIMIT 1",
          [proof.sessionId, key],
        )
      ).rows[0];
      if (saved) {
        await c.query("COMMIT");
        return saved.detail.result;
      }
      const result = await run(c);
      await sessions.event(proof, "material_receipt", { name, result }, c, key);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  };
  const native = (kind: string, more: Record<string, unknown> = {}) => ({
    nativeAction: { kind, ...more },
  });
  const definitions: Array<{
    name: string;
    description: string;
    readOnly: boolean;
    schema: z.ZodType;
    run: (args: any) => Promise<unknown>;
  }> = [
    {
      name: "list_projects",
      description:
        "按名称查询当前账号可访问的项目，返回真实ID和导航链接。不会切换正在执行任务的项目。",
      readOnly: true,
      schema: materialPageSchema,
      run: (args) => store.projects(proof.actorId, args),
    },
    {
      name: "read_project_access",
      description: "读取当前项目名称、说明和当前账号实际权限。",
      readOnly: true,
      schema: z.object({}).strict(),
      run: () => store.project(proof),
    },
    {
      name: "navigate_project",
      description:
        "打开已核实可访问的项目页面；只返回导航卡，不会替换本会话绑定项目或执行任何任务。",
      readOnly: true,
      schema: z
        .object({
          projectId: z.string().min(1),
          page: z
            .enum(["datasets", "test-sets", "processing", "assistant"])
            .default("datasets"),
        })
        .strict(),
      run: async (args) => {
        const project = await store.project({
          actorId: proof.actorId,
          projectId: args.projectId,
        });
        return native("navigation", {
          href: `/projects/${project.id}/${args.page}`,
          name: project.name,
        });
      },
    },
    {
      name: "list_collections",
      description:
        "查询当前项目原始数据集合（含未整理区），搜索名称/说明，有界分页。",
      readOnly: true,
      schema: materialPageSchema,
      run: (args) => store.collections(proof, args),
    },
    {
      name: "list_material_files",
      description:
        "按文件名查找当前项目真实原始数据文件，可限定collectionId；用户明确文件名时先精确核对命中。未分页读取不能宣称已看完。",
      readOnly: true,
      schema: materialPageSchema.extend({
        collectionId: z.string().min(1).optional(),
      }),
      run: (args) => store.files(proof, args),
    },
    {
      name: "read_material_records",
      description:
        "查看原始数据集合统一记录，按问题/期望输出/Metadata搜索；结果含真实recordId、ordinal和页数。查询不代表选定全部输入。",
      readOnly: true,
      schema: materialPageSchema.extend({
        collectionId: z.string().min(1),
        assetId: z.string().min(1).optional(),
      }),
      run: (args) => store.records(proof, args),
    },
    {
      name: "read_material_record",
      description:
        "读取一条真实原始记录的完整统一字段；使用真实assetId和ordinal，不把列表截断当全文。",
      readOnly: true,
      schema: z
        .object({
          assetId: z.string().min(1),
          ordinal: z.number().int().min(1),
        })
        .strict(),
      run: (args) => store.record(proof, args.assetId, args.ordinal),
    },
    {
      name: "read_material_raw",
      description:
        "读取原始文件开头最多12000字节，明确truncated；不能把截断预览当完整文件。原件不变。",
      readOnly: true,
      schema: z.object({ assetId: z.string().min(1) }).strict(),
      run: (args) => store.raw(proof, args.assetId),
    },
    ...(canWrite
      ? [
          {
            name: "create_project",
            description:
              "仅管理员：根据用户明确的新建要求创建项目，返回真实结果；不切换正在执行的任务。",
            readOnly: false,
            schema: materialNameSchema,
            run: (args: any) =>
              write("create_project", args, (c) =>
                store.createProject(proof.actorId, args, c),
              ),
          },
          {
            name: "create_collection",
            description:
              "根据用户明确要求在当前项目创建原始数据集合。不得创建名为未整理的系统集合。",
            readOnly: false,
            schema: materialNameSchema,
            run: (args: any) =>
              write("create_collection", args, (c) =>
                store.createCollection(proof, args, c),
              ),
          },
          {
            name: "move_material_file",
            description:
              "将真实assetId移到当前项目的真实collectionId；只改变收纳位置，不改文件字节和记录。跨项目移动不支持。",
            readOnly: false,
            schema: z
              .object({
                assetId: z.string().min(1),
                collectionId: z.string().min(1),
              })
              .strict(),
            run: (args: any) =>
              write("move_material_file", args, (c) =>
                store.move(proof, args.assetId, args.collectionId, c),
              ),
          },
          {
            name: "list_pending_uploads",
            description:
              "查看本人在当前项目尚未确认的原始数据上传。未确认不是正式资料。上传确认必须用户在原生界面点击。",
            readOnly: false,
            schema: z.object({}).strict(),
            run: () => store.pending(proof),
          },
          {
            name: "open_material_upload",
            description:
              "打开原生上传/映射预览界面，由用户选择本机文件；确认前不创建正式资料。支持原生取消，不替用户确认。",
            readOnly: false,
            schema: z
              .object({ collectionId: z.string().min(1).optional() })
              .strict(),
            run: async (args: any) => {
              await store.access(proof, true);
              if (args.collectionId)
                await store.collection(proof, args.collectionId);
              return native(
                "upload",
                args.collectionId ? { collectionId: args.collectionId } : {},
              );
            },
          },
          {
            name: "open_material_mapping",
            description:
              "打开尚未整理字段文件的原生映射界面。仅预览和用户确认首次映射，不重新解释已有记录。",
            readOnly: false,
            schema: z.object({ assetId: z.string().min(1) }).strict(),
            run: async (args: any) => {
              await store.access(proof, true);
              const asset = await store.asset(proof, args.assetId);
              return native("mapping", {
                assetId: asset.id,
                collectionId: asset.collectionId,
                name: asset.fileName,
                href: `/projects/${proof.projectId}/datasets/${asset.collectionId}/files/${asset.id}`,
              });
            },
          },
        ]
      : []),
  ];
  return {
    tools: definitions.map((d) =>
      tool(
        async (args) => {
          await sessions.guard(proof, !d.readOnly);
          return d.run(args);
        },
        { name: d.name, description: d.description, schema: d.schema },
      ),
    ) as StructuredToolInterface[],
    schemas: new Map(definitions.map((d) => [d.name, d.schema])),
    readOnly: new Set(definitions.filter((d) => d.readOnly).map((d) => d.name)),
  };
}
