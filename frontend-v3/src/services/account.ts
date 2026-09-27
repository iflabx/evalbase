import { request, resetWorkspaceSession } from "@/services/workspace";

export type Session = { csrfToken: string; actor: { id: string; role: string } };
export type Account = {
  id: string;
  email: string;
  displayName: string;
  avatarColor: string;
  role: string;
};
export type Member = Account & { role: "editor" | "viewer" };
export type Invitation = {
  id: string;
  projectId: string;
  projectName: string;
  email?: string;
  role: "editor" | "viewer";
  status?: string;
  expiresAt: string;
};

async function publicPost<T>(path: string, body: object): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
    throw new Error(payload.error?.code ?? "操作失败");
  }
  return response.json() as Promise<T>;
}

export async function installation() {
  const response = await fetch("/api/installation", { credentials: "same-origin" });
  if (!response.ok) throw new Error("无法获取初始化状态");
  return response.json() as Promise<{ needsAdministrator: boolean; needsMigration?: boolean }>;
}
export function createAdministrator(input: {
  displayName: string;
  email: string;
  password: string;
  confirmPassword: string;
}) {
  return publicPost("/api/installation/administrator", input);
}
export function registerAccount(input: {
  email: string;
  password: string;
  confirmPassword: string;
}) {
  return publicPost("/api/accounts", input);
}
export async function login(email: string, password: string) {
  resetWorkspaceSession();
  return publicPost<Session>("/api/session", { email, password });
}
export async function currentSession() {
  const response = await fetch("/api/session", { credentials: "same-origin" });
  if (!response.ok) throw new Error("authentication_required");
  return response.json() as Promise<Session>;
}
export async function logout() {
  await request<void>("/api/session", { method: "DELETE" });
  resetWorkspaceSession();
}
export async function myAccount() {
  return (await request<{ account: Account }>("/api/me")).account;
}
export async function updateProfile(input: { displayName: string; avatarColor: string }) {
  return (
    await request<{ account: Account }>("/api/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
  ).account;
}
export async function myInvitations() {
  return (await request<{ invitations: Invitation[] }>("/api/me/invitations")).invitations;
}
export async function acceptInvitation(id: string) {
  return request<{ projectId: string; role: string }>(
    `/api/me/invitations/${encodeURIComponent(id)}/accept`,
    { method: "POST" },
  );
}
export async function projectMembers(projectId: string) {
  return (
    await request<{ members: Member[] }>(`/api/projects/${encodeURIComponent(projectId)}/members`)
  ).members;
}
export async function projectInvitations(projectId: string) {
  return (
    await request<{ invitations: Invitation[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/invitations`,
    )
  ).invitations;
}
export async function inviteMember(projectId: string, email: string, role: "editor" | "viewer") {
  return request(`/api/projects/${encodeURIComponent(projectId)}/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
}
export async function revokeInvitation(projectId: string, id: string) {
  return request<void>(
    `/api/projects/${encodeURIComponent(projectId)}/invitations/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}
export async function changeMemberRole(projectId: string, id: string, role: "editor" | "viewer") {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    },
  );
}
export async function removeMember(projectId: string, id: string) {
  return request<void>(
    `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}
