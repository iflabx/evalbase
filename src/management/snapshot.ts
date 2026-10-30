import type { Database } from "../db/pool.js";
import type { OperationScope } from "../operations/commit.js";
import { BusinessError } from "../operations/errors.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import { hasProjectCapability } from "../security/project-access.js";

/** Freeze only the affected identity/state; confirmation never follows a newer target silently. */
export async function managementSnapshot(
  db: Pick<Database, "query">,
  scope: OperationScope,
  command: string,
  input: any,
  lock = false,
) {
  if (
    !(await hasProjectCapability(db, scope.projectId, scope.actorId, "manage"))
  )
    throw new BusinessError(403, "administrator_required");
  const project = (
    await db.query(
      "SELECT id,name FROM project WHERE id=$1" + (lock ? " FOR SHARE" : ""),
      [scope.projectId],
    )
  ).rows[0];
  let state: any,
    summary: any = { projectName: project.name };
  const suffix = lock ? " FOR UPDATE" : "";
  if (command === "invite") {
    const target = (
      await db.query(
        "SELECT id,email,display_name FROM app_user WHERE lower(email)=$1 AND role='user'" +
          suffix,
        [input.body.email.trim().toLowerCase()],
      )
    ).rows[0];
    if (!target) throw new BusinessError(422, "account_not_registered");
    const member = (
      await db.query(
        "SELECT role FROM project_member WHERE project_id=$1 AND user_id=$2",
        [scope.projectId, target.id],
      )
    ).rows[0];
    if (member) throw new BusinessError(409, "already_project_member");
    const pending = (
      await db.query(
        "SELECT id,status,role FROM project_invitation WHERE project_id=$1 AND target_user_id=$2 AND status='pending' AND expires_at>now()",
        [scope.projectId, target.id],
      )
    ).rows;
    state = { target, pending };
    summary = {
      ...summary,
      targetName: target.display_name,
      email: target.email,
      newRole: input.body.role,
      impact: "邀请后，接收人接受邀请才能访问当前项目。",
    };
  } else if (command === "revokeInvitation") {
    state = (
      await db.query(
        "SELECT id,email,role,status,expires_at FROM project_invitation WHERE project_id=$1 AND id=$2" +
          suffix,
        [scope.projectId, input.invitationId],
      )
    ).rows[0];
    if (
      !state ||
      state.status !== "pending" ||
      new Date(state.expires_at) <= new Date()
    )
      throw new BusinessError(409, "invitation_inactive");
    summary = {
      ...summary,
      email: state.email,
      role: state.role,
      impact: "撤销此邀请，接收人将不能再接受。",
    };
  } else if (command === "changeRole" || command === "removeMember") {
    state = (
      await db.query(
        "SELECT pm.user_id,pm.role,u.email,u.display_name FROM project_member pm JOIN app_user u ON u.id=pm.user_id WHERE pm.project_id=$1 AND pm.user_id=$2" +
          (lock ? " FOR UPDATE OF pm" : ""),
        [scope.projectId, input.userId],
      )
    ).rows[0];
    if (!state || !["editor", "viewer"].includes(state.role))
      throw new BusinessError(404, "member_not_found");
    summary = {
      ...summary,
      targetName: state.display_name,
      email: state.email,
      oldRole: state.role,
      ...(command === "changeRole" ? { newRole: input.body.role } : {}),
      impact:
        command === "removeMember"
          ? "该成员将失去当前项目访问权限。"
          : "仅调整当前项目权限。",
    };
  } else if (command === "trashSet" || command === "trashBranch") {
    const target = (
      await db.query(
        "SELECT id,name,status,created_at FROM test_set WHERE project_id=$1 AND id=$2" +
          suffix,
        [scope.projectId, input.testSetId],
      )
    ).rows[0];
    if (!target || target.status !== "available")
      throw new BusinessError(404, "test_set_not_found");
    const versions = (
      await db.query(
        "SELECT id,parent_version_id,version_label,status FROM test_set_version WHERE test_set_id=$1 ORDER BY id" +
          (lock ? " FOR SHARE" : ""),
        [target.id],
      )
    ).rows;
    let drafts = (
      await db.query(
        "SELECT id,parent_version_id,revision,status FROM collaborative_draft WHERE test_set_id=$1 AND status='editing' ORDER BY id",
        [target.id],
      )
    ).rows;
    let selected = versions.filter((v) =>
      ["published", "tombstoned", "trashed"].includes(v.status),
    );
    if (command === "trashBranch") {
      const ids = new Set([input.versionId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const v of versions)
          if (ids.has(v.parent_version_id) && !ids.has(v.id)) {
            ids.add(v.id);
            changed = true;
          }
      }
      selected = versions.filter((v) => ids.has(v.id));
      if (!selected.length || selected.some((v) => v.status !== "published"))
        throw new BusinessError(409, "version_branch_unavailable");
      if (selected.length > 1 && !input.body.includeDescendants)
        throw new BusinessError(422, "version_branch_required");
    }
    if (command === "trashBranch")
      drafts = drafts.filter((d) =>
        selected.some((v) => v.id === d.parent_version_id),
      );
    state = { target, versions: selected, drafts };
    summary = {
      ...summary,
      targetName: target.name,
      version:
        command === "trashBranch"
          ? selected.find((v) => v.id === input.versionId)?.version_label
          : null,
      versionCount: selected.length,
      draftCount: drafts.length,
      impact:
        command === "trashSet"
          ? "整个测试集及其版本将移入回收站，相关草稿将暂不可用。"
          : "指定版本分支将移入回收站，相关草稿将暂不可用。",
    };
  } else if (command === "restore") {
    state = (
      await db.query(
        "SELECT e.id,e.test_set_id,e.type,e.root_version_id,e.version_ids,e.status,ts.name,ts.status AS test_set_status,v.version_label FROM test_set_trash_entry e JOIN test_set ts ON ts.id=e.test_set_id LEFT JOIN test_set_version v ON v.id=e.root_version_id WHERE e.project_id=$1 AND e.id=$2" +
          (lock ? " FOR UPDATE OF e,ts" : ""),
        [scope.projectId, input.entryId],
      )
    ).rows[0];
    if (!state || state.status !== "trashed")
      throw new BusinessError(404, "trash_entry_not_found");
    summary = {
      ...summary,
      targetName: state.name,
      entryType: state.type === "test_set" ? "整个测试集" : "版本分支",
      rootVersion: state.version_label ?? null,
      versionCount: state.version_ids.length,
      impact: "恢复该回收站条目及其原版本范围。",
    };
  } else throw new BusinessError(422, "management_command_invalid");
  return {
    hash: sha256(canonicalJson(JSON.parse(JSON.stringify(state)))),
    summary,
  };
}
