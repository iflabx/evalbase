import { createSessionTransport } from "./session-model.js";
import { tool } from "langchain";
import { z } from "zod";
import { canonicalJson, sha256 } from "../package/contract.js";
import { accountOperations } from "../management/accounts.js";
import { recycleOperations } from "../management/recycle.js";
import { hasProjectCapability } from "../security/project-access.js";
import {
  availableModelConnection,
  modelConnectionSettings,
  testModelConnection,
} from "../model/connection.js";
import type { Config } from "../config.js";
import { SessionStore, SessionError, type TurnProof } from "./session-store.js";
import { ExecutionStore } from "./execution-store.js";
import { managementSnapshot } from "../management/snapshot.js";

const identity = z.string().min(1).max(250),
  role = z.enum(["editor", "viewer"]);
const empty = z.object({}).strict();
export function managementTools(
  store: SessionStore,
  execution: ExecutionStore,
  proof: TurnProof,
  config: Config,
  wait: () => Promise<unknown>,
) {
  const accounts = accountOperations(store.db),
    recycle = recycleOperations(store.db);
  const admin = async () => {
    if (
      !(await hasProjectCapability(
        store.db,
        proof.projectId,
        proof.actorId,
        "manage",
      ))
    )
      throw new SessionError("administrator_required", 403);
  };
  const prepare = async (command: string, input: any) => {
    await admin();
    const operationKey = `management:${proof.turnId}:${command}:${sha256(canonicalJson(input))}`;
    const prior = (
      await store.db.query(
        "SELECT * FROM assistant_runtime_operation WHERE session_id=$1 AND operation_key=$2",
        [proof.sessionId, operationKey],
      )
    ).rows[0];
    if (
      prior &&
      (prior.kind !== "management" ||
        prior.payload.command !== command ||
        canonicalJson(prior.payload.input) !== canonicalJson(input))
    )
      throw new SessionError("operation_payload_conflict");
    let op = prior;
    if (!op) {
      const snapshot = await managementSnapshot(
        store.db,
        proof,
        command,
        input,
      );
      op = await execution.operation(proof, operationKey, "management", {
        command,
        input,
        snapshot: snapshot.hash,
        summary: snapshot.summary,
      });
    }
    const receipt = await execution.receipt(proof, proof.sessionId, op.id);
    if (receipt) return { completed: true, receipt };
    const card = await execution.prepare(proof, op);
    await wait();
    return { confirmationId: card.id, operationId: op.id };
  };
  const defs: {
    name: string;
    description: string;
    schema: z.ZodType;
    readOnly: boolean;
    run: (a: any) => Promise<any>;
  }[] = [
    {
      name: "read_my_profile",
      description: "读取当前登录账号本人资料，不含密码或凭据。",
      schema: empty,
      readOnly: true,
      run: () => accounts.profile(proof),
    },
    {
      name: "update_my_profile",
      description:
        "按明确要求修改本人名称或头像颜色，不可修改邮箱、密码、角色。",
      schema: z
        .object({
          displayName: z.string().trim().min(1).max(30).optional(),
          avatarColor: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .optional(),
        })
        .strict()
        .refine((x) => Object.keys(x).length > 0),
      readOnly: false,
      run: async (a) => {
        const op = await execution.operation(
          proof,
          `profile:${proof.turnId}:${sha256(canonicalJson(a))}`,
          "account_mutation",
          a,
        );
        return accounts.updateProfile(execution.operationScope(proof, op), {
          body: a,
        });
      },
    },
    {
      name: "list_my_invitations",
      description: "查询本人尚可接受的项目邀请，不能代他人接受。",
      schema: empty,
      readOnly: true,
      run: () => accounts.myInvitations(proof),
    },
    {
      name: "accept_my_invitation",
      description: "仅用户明确接受时接受当前账号本人邀请，不代他人操作。",
      schema: z.object({ invitationId: identity }).strict(),
      readOnly: false,
      run: async (a) => {
        const op = await execution.operation(
          proof,
          `accept-invitation:${proof.turnId}:${a.invitationId}`,
          "account_mutation",
          a,
        );
        return accounts.acceptInvitation(
          execution.operationScope(proof, op),
          a,
        );
      },
    },
    {
      name: "list_project_members",
      description: "读取当前项目成员及角色。",
      schema: empty,
      readOnly: true,
      run: () => accounts.members(proof),
    },
    {
      name: "list_project_invitations",
      description: "管理员读取当前项目邀请记录。",
      schema: empty,
      readOnly: true,
      run: async () => {
        await admin();
        return accounts.invitations(proof);
      },
    },
    {
      name: "request_project_invitation",
      description:
        "邀请已注册测试账号为编辑或查看成员；固定接收账号及角色，必须等待用户点击确认，不发送邮件。",
      schema: z.object({ email: z.email().max(254), role }).strict(),
      readOnly: false,
      run: (a) => prepare("invite", { body: a }),
    },
    {
      name: "request_revoke_invitation",
      description: "撤销当前项目具体待处理邀请，固定目标并等待用户确认。",
      schema: z.object({ invitationId: identity }).strict(),
      readOnly: false,
      run: (a) => prepare("revokeInvitation", a),
    },
    {
      name: "request_member_role",
      description:
        "调整当前项目现有成员编辑/查看角色，展示原角色、新角色与访问影响并等待用户确认。",
      schema: z.object({ userId: identity, role }).strict(),
      readOnly: false,
      run: (a) =>
        prepare("changeRole", { userId: a.userId, body: { role: a.role } }),
    },
    {
      name: "request_remove_member",
      description: "移除当前项目具体成员，固定访问影响并等待用户确认。",
      schema: z.object({ userId: identity }).strict(),
      readOnly: false,
      run: (a) => prepare("removeMember", a),
    },
    {
      name: "read_available_model",
      description: "读取当前项目可用模型名称和状态，不含密钥或认证头。",
      schema: empty,
      readOnly: true,
      run: () => availableModelConnection(store.db),
    },
    {
      name: "read_model_settings",
      description: "管理员读取已保存实例模型非敏感配置和修订，不含密钥、密文。",
      schema: empty,
      readOnly: true,
      run: async () => {
        await admin();
        return modelConnectionSettings(store.db, config);
      },
    },
    {
      name: "test_saved_model_connection",
      description:
        "管理员明确要求时，对指定已保存修订作一次受限连接测试，真实尝试计入本活动预算；不能测试未保存参数，结果未知不自动重试。",
      schema: z.object({ revision: z.number().int().min(1) }).strict(),
      readOnly: false,
      run: async (a) => {
        await admin();
        const op = await execution.operation(
          proof,
          `model-test:${proof.turnId}:${a.revision}`,
          "model_connection_test",
          a,
        );
        const prior = await execution.receipt(proof, proof.sessionId, op.id);
        if (prior) return prior;
        const current = await modelConnectionSettings(store.db, config);
        if (current.connection?.revision !== a.revision)
          throw new SessionError("model_connection_conflict");
        const unknown = {
          test: {
            revision: a.revision,
            ok: null,
            code: "model_test_result_unknown",
          },
        };
        await store.db.query(
          "UPDATE assistant_runtime_operation SET receipt=$2 WHERE id=$1",
          [op.id, JSON.stringify(unknown)],
        );
        const result = await testModelConnection(store.db, config, a, {
          requestScope: {
            projectId: proof.projectId,
            sessionId: proof.sessionId,
            turnId: proof.turnId,
          },
          decorateFetch: (request) =>
            createSessionTransport({
              proof,
              store,
              execution,
              signal: AbortSignal.timeout(15000),
              correctionOf: () => null,
              fetch: request,
              purpose: "connection_test",
            }).fetch,
        });
        await store.db.query(
          "UPDATE assistant_runtime_operation SET receipt=$2 WHERE id=$1",
          [op.id, JSON.stringify(result)],
        );
        return result;
      },
    },
    {
      name: "open_model_settings",
      description:
        "准备模型连接的非敏感参数，打开原生设置表单；密钥只能由用户在表单输入并确认保存。不会直接修改配置。",
      schema: z
        .object({
          name: z.string().max(80).optional(),
          endpoint: z
            .string()
            .url()
            .max(2048)
            .refine((v) => {
              try {
                const u = new URL(v);
                return (
                  ["http:", "https:"].includes(u.protocol) &&
                  !u.username &&
                  !u.password &&
                  !u.search &&
                  !u.hash
                );
              } catch {
                return false;
              }
            }, "服务地址不能包含凭据、查询或片段")
            .optional(),
          model: z.string().max(200).optional(),
          enabled: z.boolean().optional(),
        })
        .strict(),
      readOnly: true,
      run: async (a) => {
        await admin();
        return {
          nativeAction: {
            kind: "model_settings",
            name: "模型连接设置",
            configuration: a,
          },
        };
      },
    },
    {
      name: "open_sign_out",
      description:
        "用户明确登出时打开本人的登出按钮；由原生页面结束当前浏览器登录，不影响其他账号。",
      schema: empty,
      readOnly: true,
      run: async () => ({
        nativeAction: { kind: "sign_out", name: "登出当前账号" },
      }),
    },
    {
      name: "list_recycle_bin",
      description: "管理员读取当前项目回收站；恢复不能代替永久删除或墓碑。",
      schema: z
        .object({
          limit: z.number().int().min(1).max(100).default(10),
          offset: z.number().int().min(0).default(0),
        })
        .strict(),
      readOnly: true,
      run: async (a) => {
        await admin();
        return recycle.trash(proof, { query: a });
      },
    },
    {
      name: "request_trash_test_set",
      description:
        "将整个测试集移入回收站，展示版本和相关草稿影响，等待用户确认。",
      schema: z.object({ testSetId: identity }).strict(),
      readOnly: false,
      run: (a) => prepare("trashSet", { ...a, body: {} }),
    },
    {
      name: "request_trash_version_branch",
      description:
        "将末端版本或指定版本分支移入回收站，includeDescendants明确包含后代，不能扩成整个测试集；等待用户确认。",
      schema: z
        .object({
          testSetId: identity,
          versionId: identity,
          includeDescendants: z.boolean().default(false),
        })
        .strict(),
      readOnly: false,
      run: (a) =>
        prepare("trashBranch", {
          testSetId: a.testSetId,
          versionId: a.versionId,
          body: { includeDescendants: a.includeDescendants },
        }),
    },
    {
      name: "request_restore_test_set",
      description:
        "恢复当前回收站具体条目，保持原依赖和版本分支，等待用户确认。",
      schema: z.object({ entryId: identity }).strict(),
      readOnly: false,
      run: (a) => prepare("restore", { ...a, body: {} }),
    },
    {
      name: "open_recycle_destructive_action",
      description:
        "打开指定对象的原生永久删除或中间版本墓碑确认；用户必须手动输入名称/版本号。工具只准备，不执行。",
      schema: z.discriminatedUnion("operation", [
        z
          .object({
            operation: z.literal("permanent_delete"),
            entryId: identity,
          })
          .strict(),
        z
          .object({
            operation: z.literal("tombstone"),
            testSetId: identity,
            versionId: identity,
          })
          .strict(),
      ]),
      readOnly: true,
      run: async (a) => {
        await admin();
        let name: string, confirmationName: string;
        if (a.operation === "permanent_delete") {
          const row = (
            await store.db.query(
              "SELECT e.id,e.type,ts.name,v.version_label FROM test_set_trash_entry e JOIN test_set ts ON ts.id=e.test_set_id LEFT JOIN test_set_version v ON v.id=e.root_version_id WHERE e.project_id=$1 AND e.id=$2 AND e.status='trashed'",
              [proof.projectId, a.entryId],
            )
          ).rows[0];
          if (!row) throw new SessionError("trash_entry_not_found", 404);
          name = row.name;
          confirmationName =
            row.type === "test_set" ? row.name : row.version_label;
        } else {
          const row = (
            await store.db.query(
              "SELECT ts.name,v.version_label FROM test_set_version v JOIN test_set ts ON ts.id=v.test_set_id WHERE ts.project_id=$1 AND ts.id=$2 AND v.id=$3 AND ts.status='available' AND v.status='published' AND EXISTS(SELECT 1 FROM test_set_version child WHERE child.parent_version_id=v.id AND child.status IN('published','tombstoned','trashed'))",
              [proof.projectId, a.testSetId, a.versionId],
            )
          ).rows[0];
          if (!row) throw new SessionError("middle_version_required", 422);
          name = row.name;
          confirmationName = row.version_label;
        }
        return {
          nativeAction: {
            kind: "recycle_management",
            ...a,
            name,
            confirmationName,
          },
        };
      },
    },
  ];
  return {
    nativeInputFields: new Map([
      ["open_model_settings", new Set(["endpoint"])],
    ]),
    tools: defs.map((d) =>
      tool(
        async (a) => {
          await store.guard(proof);
          if (!d.readOnly) {
            const t = await execution.processingGuard(proof);
            if (t.suspended) throw new SessionError("task_paused");
          }
          return d.run(a);
        },
        { name: d.name, description: d.description, schema: d.schema },
      ),
    ),
    schemas: new Map(defs.map((d) => [d.name, d.schema])),
    readOnly: new Set(defs.filter((d) => d.readOnly).map((d) => d.name)),
  };
}
