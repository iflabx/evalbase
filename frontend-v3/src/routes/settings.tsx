import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, UserRound, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/state-view";
import {
  currentSession,
  myAccount,
  updateProfile,
  myInvitations,
  acceptInvitation,
  projectMembers,
  projectInvitations,
  inviteMember,
  revokeInvitation,
  changeMemberRole,
  removeMember,
  type Invitation,
} from "@/services/account";
import { listProjects } from "@/services/workspace";

type Section = "profile" | "info" | "members";
export const Route = createFileRoute("/settings")({
  validateSearch: (search: Record<string, unknown>) => ({
    project: typeof search["project"] === "string" ? search["project"] : "",
    section:
      search["section"] === "profile" ||
      search["section"] === "info" ||
      search["section"] === "members"
        ? (search["section"] as Section)
        : undefined,
  }),
  component: SettingsPage,
});
const palette = ["#2563eb", "#9333ea", "#0f766e", "#b45309", "#be123c", "#0369a1", "#4d7c0f"];
const roleName = (role: string) =>
  role === "editor" ? "编辑者" : role === "viewer" ? "查看者" : "管理员";
const message: Record<string, string> = {
  account_not_registered: "此邮箱尚未注册，请让对方先注册账号。",
  invitation_pending: "此账号已有待处理邀请。",
  already_project_member: "此账号已是项目成员。",
  invitation_inactive: "邀请已过期或撤销，请让管理员重新邀请。",
  profile_payload_invalid: "请检查显示名称和头像颜色。",
};
function errorText(cause: unknown) {
  const code = cause instanceof Error ? cause.message : "";
  return message[code] ?? "操作失败，请稍后重试。";
}

function SettingsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { project: projectId, section: requestedSection } = Route.useSearch();
  const projects = useQuery({
    queryKey: ["projects", "settings"],
    queryFn: () => listProjects({ limit: 100, offset: 0 }),
  });
  const available = projects.data?.items ?? [];
  const activeId = available.some((p) => p.id === projectId) ? projectId : (available[0]?.id ?? "");
  const project = available.find((p) => p.id === activeId);
  const section: Section =
    requestedSection === "members" && projects.isSuccess && !activeId
      ? "info"
      : (requestedSection ?? (projects.isSuccess && !activeId ? "info" : "profile"));
  useEffect(() => {
    if (!projects.isSuccess) return;
    if (activeId && projectId !== activeId) {
      void navigate({ to: "/settings", search: { project: activeId, section }, replace: true });
    } else if (!activeId && requestedSection === "members") {
      void navigate({ to: "/settings", search: { project: "", section: "info" }, replace: true });
    }
  }, [projects.isSuccess, activeId, projectId, requestedSection, section, navigate]);
  const session = useQuery({ queryKey: ["session"], queryFn: currentSession });
  const isAdmin = session.data?.actor.role === "admin";
  const me = useQuery({ queryKey: ["me"], queryFn: myAccount });
  const inbox = useQuery({ queryKey: ["invitations", "me"], queryFn: myInvitations });
  const members = useQuery({
    queryKey: ["members", activeId],
    queryFn: () => projectMembers(activeId),
    enabled: !!activeId && section === "members",
  });
  const invitations = useQuery({
    queryKey: ["invitations", activeId],
    queryFn: () => projectInvitations(activeId),
    enabled: !!activeId && section === "members" && !!isAdmin,
  });
  const [name, setName] = useState("");
  const [color, setColor] = useState(palette[0]!);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (me.data) {
      setName(me.data.displayName);
      setColor(me.data.avatarColor || palette[0]!);
    }
  }, [me.data]);
  async function act(action: () => Promise<unknown>, keys: string[][], success: string) {
    setNotice("");
    setBusy(true);
    try {
      await action();
      await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      setNotice(success);
      return true;
    } catch (cause) {
      setNotice(errorText(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    await act(
      () => updateProfile({ displayName: name.trim(), avatarColor: color }),
      [["me"]],
      "个人资料已保存。",
    );
  }
  async function sendInvite(event: FormEvent) {
    event.preventDefault();
    const sent = await act(
      () => inviteMember(activeId, email.trim(), role),
      [["invitations", activeId]],
      "邀请已创建，等待对方在设置 → 信息接受。",
    );
    if (sent) setEmail("");
  }
  function openSection(next: Section) {
    setNotice("");
    void navigate({ to: "/settings", search: { project: activeId, section: next } });
  }
  function setActiveProject(id: string) {
    setNotice("");
    void navigate({ to: "/settings", search: { project: id, section } });
  }
  const pendingInvites = invitations.data?.filter((invite) => invite.status === "pending") ?? [];
  const pastInvites = invitations.data?.filter((invite) => invite.status !== "pending") ?? [];
  const initial = (name.trim().charAt(0) || "用").toUpperCase();

  function invitationRow(invite: Invitation) {
    const removed =
      invite.status === "accepted" &&
      members.isSuccess &&
      !members.data?.some((member) => member.email === invite.email);
    const status =
      invite.status === "pending"
        ? "待接受"
        : invite.status === "expired"
          ? "已过期"
          : invite.status === "revoked"
            ? "已撤销"
            : removed
              ? "已接受 · 成员已移除"
              : "已接受";
    return (
      <div className="member-row" key={invite.id}>
        <div className="member-person">
          <span className="member-avatar" aria-hidden="true">
            ✉
          </span>
          <div>
            <b>{invite.email}</b>
            <small>邀请有效期至 {new Date(invite.expiresAt).toLocaleDateString()}</small>
          </div>
        </div>
        <span className="role-chip">
          {roleName(invite.role)} · {status}
        </span>
        <div className="member-actions">
          {invite.status === "pending" && (
            <Button
              className="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(
                  () => revokeInvitation(activeId, invite.id),
                  [["invitations", activeId]],
                  "邀请已撤销。",
                )
              }
            >
              撤销
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={section === "profile" ? "个人资料" : section === "info" ? "信息" : "项目成员"}
        description={
          section === "profile"
            ? "管理你的显示名称与头像颜色。"
            : section === "info"
              ? "查看并接受发给你的项目邀请。"
              : `${project?.name ?? "当前项目"} · 管理项目成员和访问权限。`
        }
        actions={
          section === "members" && isAdmin ? (
            <>
              {available.length > 1 && (
                <label className="settings-project-selector">
                  当前项目
                  <select
                    value={activeId}
                    onChange={(event) => setActiveProject(event.target.value)}
                  >
                    {available.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <Button className="button primary" onClick={() => setInviteOpen((value) => !value)}>
                {inviteOpen ? "取消邀请" : "邀请成员"}
              </Button>
            </>
          ) : undefined
        }
      />
      <div className="settings-layout">
        <aside className="settings-nav" aria-label="设置分类">
          <div className="settings-nav-group">
            <div className="settings-nav-title">我的账号</div>
            <button
              aria-current={section === "profile" ? "page" : undefined}
              onClick={() => {
                openSection("profile");
              }}
            >
              <UserRound />
              个人资料
            </button>
            <button
              aria-current={section === "info" ? "page" : undefined}
              onClick={() => {
                openSection("info");
              }}
            >
              <Info />
              信息
              {(inbox.data?.length ?? 0) > 0 && (
                <span className="settings-count">{inbox.data?.length}</span>
              )}
            </button>
          </div>
          {activeId && (
            <div className="settings-nav-group">
              <div className="settings-nav-title" title={project?.name}>
                {project?.name ?? "当前项目"}
              </div>
              <button
                aria-current={section === "members" ? "page" : undefined}
                onClick={() => {
                  openSection("members");
                }}
              >
                <UsersRound />
                项目成员
              </button>
            </div>
          )}
        </aside>
        <div className="settings-stack">
          {section === "profile" && (
            <section className="member-card profile-card">
              <div className="member-card-head">
                <h2>公开资料</h2>
                <p>其他项目成员会看到你的显示名称和头像。</p>
              </div>
              <form className="profile-form" onSubmit={saveProfile}>
                <div className="profile-preview">
                  <span
                    className="member-avatar"
                    style={{ backgroundColor: color, color: "white" }}
                    aria-hidden="true"
                  >
                    {initial}
                  </span>
                  <div>
                    <b>{name || "显示名称"}</b>
                    <small>{me.data?.email ?? ""}</small>
                  </div>
                </div>
                <div className="profile-row">
                  <label className="profile-row-label" htmlFor="profile-name">
                    显示名称<small>用于成员列表和协作状态。</small>
                  </label>
                  <input
                    id="profile-name"
                    type="text"
                    required
                    maxLength={30}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
                <div className="profile-row">
                  <div className="profile-row-label" id="profile-color-label">
                    头像颜色<small>选择预设颜色，或使用自定义颜色。</small>
                  </div>
                  <div className="profile-color" role="group" aria-labelledby="profile-color-label">
                    {palette.map((swatch, index) => (
                      <button
                        className="profile-swatch"
                        key={swatch}
                        type="button"
                        style={{ backgroundColor: swatch }}
                        aria-label={`选择预设颜色 ${index + 1}`}
                        aria-pressed={color === swatch}
                        onClick={() => setColor(swatch)}
                      />
                    ))}
                    <label className="profile-color-custom">
                      <input
                        type="color"
                        aria-label="自定义头像颜色"
                        value={color}
                        onChange={(event) => setColor(event.target.value)}
                      />
                      自定义
                    </label>
                  </div>
                </div>
                <div className="profile-form-footer">
                  <Button className="button primary" type="submit" disabled={busy || !name.trim()}>
                    保存更改
                  </Button>
                </div>
              </form>
            </section>
          )}
          {section === "info" && (
            <section className="member-card">
              <div className="member-card-head">
                <h2>项目邀请</h2>
                <p>发送至 {me.data?.email ?? "你的邮箱"} 的邀请。接受后即可进入对应项目。</p>
              </div>
              {inbox.isLoading ? (
                <p className="member-empty">正在加载邀请…</p>
              ) : inbox.isError ? (
                <p className="member-empty" role="alert">
                  邀请加载失败。{" "}
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-2"
                    onClick={() => void inbox.refetch()}
                  >
                    重试
                  </Button>
                </p>
              ) : inbox.data?.length ? (
                inbox.data.map((invite) => (
                  <div className="member-row" key={invite.id}>
                    <div className="member-person">
                      <div>
                        <b>{invite.projectName}</b>
                        <small>
                          邀请邮箱：{me.data?.email} · 有效期至{" "}
                          {new Date(invite.expiresAt).toLocaleDateString()}
                        </small>
                      </div>
                    </div>
                    <span className="role-chip">{roleName(invite.role)}</span>
                    <div className="member-actions">
                      <Button
                        className="button primary"
                        disabled={busy}
                        onClick={async () => {
                          const accepted = await act(
                            () => acceptInvitation(invite.id),
                            [["invitations", "me"], ["projects"]],
                            "已加入项目。",
                          );
                          if (accepted) await navigate({ to: "/" });
                        }}
                      >
                        接受邀请
                      </Button>
                    </div>
                  </div>
                ))
              ) : (
                <p className="member-empty">暂无待接受的项目邀请。</p>
              )}
            </section>
          )}
          {section === "members" && activeId && (
            <>
              <section className="member-card">
                <div className="member-card-head">
                  <h2>成员与权限</h2>
                  <p>查看成员并管理其在当前项目的角色。</p>
                </div>
                {members.isLoading ? (
                  <p className="member-empty">正在加载成员…</p>
                ) : members.isError ? (
                  <p className="member-empty" role="alert">
                    成员加载失败。{" "}
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-2"
                      onClick={() => void members.refetch()}
                    >
                      重试
                    </Button>
                  </p>
                ) : members.data?.length ? (
                  members.data.map((member) => (
                    <div className="member-row" key={member.id}>
                      <div className="member-person">
                        <span
                          className="member-avatar"
                          style={{
                            backgroundColor: member.avatarColor || palette[0],
                            color: "white",
                          }}
                          aria-hidden="true"
                        >
                          {member.displayName.charAt(0).toUpperCase()}
                        </span>
                        <div>
                          <b>{member.displayName}</b>
                          <small>{member.email}</small>
                        </div>
                      </div>
                      {isAdmin && member.role !== "admin" ? (
                        <select
                          aria-label={`${member.displayName}的角色`}
                          value={member.role}
                          disabled={busy}
                          onChange={(event) =>
                            void act(
                              () =>
                                changeMemberRole(
                                  activeId,
                                  member.id,
                                  event.target.value as "editor" | "viewer",
                                ),
                              [["members", activeId]],
                              "角色已更新。",
                            )
                          }
                        >
                          <option value="editor">编辑者</option>
                          <option value="viewer">查看者</option>
                        </select>
                      ) : (
                        <span className="role-chip">{roleName(member.role)}</span>
                      )}
                      <div className="member-actions">
                        {isAdmin && member.role !== "admin" && (
                          <Button
                            className="button"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              void act(
                                () => removeMember(activeId, member.id),
                                [["members", activeId]],
                                "成员已移除。",
                              )
                            }
                          >
                            移除
                          </Button>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="member-empty">暂无成员。</p>
                )}
              </section>
              {isAdmin && (
                <>
                  {inviteOpen && (
                    <section className="member-card">
                      <div className="member-card-head">
                        <h2>邀请成员</h2>
                        <p>填写已注册账号邮箱并选择项目角色。</p>
                      </div>
                      <form className="member-form" onSubmit={sendInvite}>
                        <label>
                          邮箱
                          <input
                            type="email"
                            required
                            placeholder="name@example.test"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                          />
                        </label>
                        <label>
                          项目角色
                          <select
                            value={role}
                            onChange={(event) => setRole(event.target.value as "editor" | "viewer")}
                          >
                            <option value="editor">编辑者</option>
                            <option value="viewer">查看者</option>
                          </select>
                        </label>
                        <Button className="button primary" type="submit" disabled={busy}>
                          发送邀请
                        </Button>
                      </form>
                    </section>
                  )}
                  <section className="member-card">
                    <div className="member-card-head">
                      <h2>待处理邀请</h2>
                      <p>对方接受后会出现在上方成员列表中。</p>
                    </div>
                    {invitations.isLoading ? (
                      <p className="member-empty">正在加载邀请…</p>
                    ) : invitations.isError ? (
                      <p className="member-empty" role="alert">
                        邀请加载失败。{" "}
                        <Button
                          variant="outline"
                          size="sm"
                          className="ml-2"
                          onClick={() => void invitations.refetch()}
                        >
                          重试
                        </Button>
                      </p>
                    ) : pendingInvites.length ? (
                      pendingInvites.map(invitationRow)
                    ) : (
                      <p className="member-empty">暂无待处理邀请。</p>
                    )}
                  </section>
                  <section className="member-card">
                    <div className="member-card-head">
                      <h2>邀请记录</h2>
                      <p>已接受、撤销和过期的邀请；当前成员以上方列表为准。</p>
                    </div>
                    {invitations.isLoading ? (
                      <p className="member-empty">正在加载记录…</p>
                    ) : invitations.isError ? (
                      <p className="member-empty" role="alert">
                        邀请记录加载失败。{" "}
                        <Button
                          variant="outline"
                          size="sm"
                          className="ml-2"
                          onClick={() => void invitations.refetch()}
                        >
                          重试
                        </Button>
                      </p>
                    ) : pastInvites.length ? (
                      pastInvites.map(invitationRow)
                    ) : (
                      <p className="member-empty">暂无历史邀请。</p>
                    )}
                  </section>
                </>
              )}
              <p className="settings-help">
                管理员可邀请和管理成员；编辑者可修改项目内容；查看者只能浏览与下载。
              </p>
            </>
          )}
          {notice && (
            <p className="settings-notice" role="status">
              {notice}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
