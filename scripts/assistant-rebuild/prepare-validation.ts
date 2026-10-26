import { readFile } from "node:fs/promises";
import { createPool } from "../../src/db/pool.js";
import { loadConfig } from "../../src/config.js";
let stdin = "";
for await (const part of process.stdin) stdin += part;
const input = JSON.parse(stdin) as {
  connection: {
    revision: number;
    name: string;
    endpoint: string;
    model: string;
    enabled: boolean;
    credential: unknown;
  };
  admin: { email: string; password: string };
  editor: { email: string; password: string };
};
const endpoint = process.argv[2] ?? "http://web:3000",
  origin = "http://127.0.0.1:4226";
async function request(
  method: string,
  path: string,
  body?: unknown,
  auth?: { cookie: string; csrfToken: string },
  extra?: Record<string, string>,
) {
  const response = await fetch(endpoint + path, {
    method,
    headers: {
      origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(auth ? { cookie: auth.cookie, "x-csrf-token": auth.csrfToken } : {}),
      ...extra,
    },
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok)
    throw Error(
      "setup_" + response.status + "_" + path + "_" + text.slice(0, 150),
    );
  return {
    data: text ? JSON.parse(text) : null,
    cookie: response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  };
}
async function login(account: { email: string; password: string }) {
  const value = await request("POST", "/api/session", account);
  return {
    actorId: value.data.actor.id,
    cookie: value.cookie,
    csrfToken: value.data.csrfToken,
  };
}
const installed = await request("GET", "/api/installation");
if (installed.data.needsAdministrator)
  await request("POST", "/api/installation/administrator", {
    ...input.admin,
    confirmPassword: input.admin.password,
    displayName: "验证管理员",
  });
const admin = await login(input.admin);
const known = await request("GET", "/api/projects?limit=100", undefined, admin);
let project = known.data.projects.find(
  (p: { name: string }) => p.name === "Deep Agents 适配验证",
);
if (!project)
  project = (
    await request(
      "POST",
      "/api/projects",
      {
        name: "Deep Agents 适配验证",
        description: "独立候选适配验证，合成资料",
      },
      admin,
    )
  ).data.project;
let editor;
try {
  editor = await login(input.editor);
} catch {
  await request("POST", "/api/accounts", {
    ...input.editor,
    confirmPassword: input.editor.password,
  });
  editor = await login(input.editor);
}
const members = (
  await request(
    "GET",
    "/api/projects/" + project.id + "/members",
    undefined,
    admin,
  )
).data.members;
if (!members.some((m: { id: string }) => m.id === editor.actorId)) {
  await request(
    "POST",
    "/api/projects/" + project.id + "/invitations",
    { email: input.editor.email, role: "editor" },
    admin,
  );
  const invitations = (
    await request("GET", "/api/me/invitations", undefined, editor)
  ).data.invitations;
  const invitation = invitations.find(
    (i: { projectId: string }) => i.projectId === project.id,
  );
  if (!invitation) throw Error("setup_invitation_missing");
  await request(
    "POST",
    "/api/me/invitations/" + invitation.id + "/accept",
    undefined,
    editor,
  );
}
const collections = (
  await request(
    "GET",
    "/api/projects/" + project.id + "/collections",
    undefined,
    admin,
  )
).data.collections;
const bytes = await readFile(
  ".scratch/assistant-rebuild/validation/materials/验收资料.jsonl",
);
const uploaded = await fetch(
  endpoint + "/api/projects/" + project.id + "/pending-uploads",
  {
    method: "POST",
    headers: {
      origin,
      cookie: admin.cookie,
      "x-csrf-token": admin.csrfToken,
      "content-type": "application/octet-stream",
      "x-agentbench-upload-encoding": "percent-utf8",
      "x-file-name": encodeURIComponent("验收资料.jsonl"),
      "idempotency-key": "rebuild-validation-source-upload-v1",
    },
    body: bytes,
  },
);
if (!uploaded.ok) throw Error("setup_upload_" + uploaded.status);
const upload = (await uploaded.json()) as { pendingUpload: { id: string } };
const confirmed = await request(
  "POST",
  "/api/projects/" + project.id + "/pending-upload-batches/confirm",
  {
    collectionId: collections[0].id,
    pendingUploadIds: [upload.pendingUpload.id],
    mode: "raw",
  },
  admin,
  { "idempotency-key": "rebuild-validation-source-confirm-v1" },
);
const assetId = confirmed.data.assets[0].id;
const path = "/api/projects/" + project.id + "/assets/" + assetId + "/mapping";
const before = (await request("GET", path, undefined, admin)).data;
if (!before.mappingReady)
  await request(
    "PUT",
    path,
    {
      parsedViewId: before.parsedViewId,
      expectedRevision: before.mappingRevision,
      mapping: {
        question: "/question",
        expectedOutput: "/expectedOutput",
        metadata: ["/fixtureId", "/channel", "/note"],
      },
    },
    admin,
  );
const db = createPool(loadConfig().databaseUrl);
try {
  const c = input.connection;
  const existing = (
    await db.query(
      "SELECT revision,model FROM model_connection ORDER BY revision DESC LIMIT 1",
    )
  ).rows[0];
  if (
    existing &&
    (existing.revision !== c.revision || existing.model !== c.model)
  )
    throw Error("setup_model_config_conflict");
  await db.query(
    "INSERT INTO model_connection(revision,name,endpoint,model,enabled,credential,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(revision) DO NOTHING",
    [
      c.revision,
      c.name,
      c.endpoint,
      c.model,
      c.enabled,
      JSON.stringify(c.credential),
      admin.actorId,
    ],
  );
  console.log(
    JSON.stringify({
      projectId: project.id,
      adminId: admin.actorId,
      editorId: editor.actorId,
      assetId,
      configurationRevision: c.revision,
      model: c.model,
      sourcePrepared: true,
    }),
  );
} finally {
  await db.end();
}
