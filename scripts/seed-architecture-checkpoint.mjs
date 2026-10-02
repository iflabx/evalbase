import assert from "node:assert/strict";
const base = process.env.ARCHITECTURE_CHECKPOINT_URL;
assert(
  base &&
    [
      "http://web:3000",
      "http://127.0.0.1:4217",
      "http://127.0.0.1:4218",
    ].includes(base),
  "Use the isolated checkpoint URL",
);
const origin = base;
const adminEmail =
  process.env.ARCHITECTURE_ADMIN_EMAIL ?? "admin@architecture.test";
const editorEmail =
  process.env.ARCHITECTURE_EDITOR_EMAIL ?? "editor@architecture.test";
const adminPassword =
  process.env.ARCHITECTURE_ADMIN_PASSWORD ?? "ArchitectureAdmin123!";
const editorPassword =
  process.env.ARCHITECTURE_EDITOR_PASSWORD ?? "ArchitectureEditor123!";
async function request(method, path, session = {}, body, extra = {}) {
  const headers = { origin, ...session, ...extra };
  if (body !== undefined && !headers["content-type"])
    headers["content-type"] = "application/json";
  const response = await fetch(base + path, {
    method,
    headers,
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  assert(response.ok, `${method} ${path} failed ${response.status}`);
  return {
    data: text ? JSON.parse(text) : {},
    cookies: response.headers.getSetCookie(),
  };
}
const state = await request("GET", "/api/installation");
assert.equal(
  state.data.needsAdministrator,
  true,
  "Refuse to seed an existing installation",
);
assert.notEqual(state.data.needsMigration, true);
await request(
  "POST",
  "/api/installation/administrator",
  {},
  {
    email: adminEmail,
    displayName: "管理员",
    password: adminPassword,
    confirmPassword: adminPassword,
  },
);
await request(
  "POST",
  "/api/accounts",
  {},
  {
    email: editorEmail,
    password: editorPassword,
    confirmPassword: editorPassword,
  },
);
async function login(email, password) {
  const response = await request(
    "POST",
    "/api/session",
    {},
    { email, password },
  );
  return {
    cookie: response.cookies[0].split(";", 1)[0],
    "x-csrf-token": response.data.csrfToken,
  };
}
const admin = await login(adminEmail, adminPassword),
  editor = await login(editorEmail, editorPassword);
await request("PATCH", "/api/me", editor, {
  displayName: "编辑",
  avatarColor: "#8b5cf6",
});
const projectId = (
  await request("POST", "/api/projects", admin, {
    name: "架构优化验收项目",
    description: "用于验收性能与协作行为的合成数据",
  })
).data.project.id;
const project = `/api/projects/${projectId}`;
const invitation = (
  await request("POST", project + "/invitations", admin, {
    email: editorEmail,
    role: "editor",
  })
).data.invitation.id;
await request("POST", `/api/me/invitations/${invitation}/accept`, editor);
const collection = (await request("GET", project + "/collections", admin)).data
  .collections[0].id;
const pending = (
  await request(
    "POST",
    project + "/pending-uploads",
    admin,
    "question,answer,topic\n如何新建测试集？,选择原始数据并创建草稿,使用方法\n如何协作编辑？,邀请成员后共同编辑草稿,协作\n",
    {
      "content-type": "text/csv",
      "x-file-name": encodeURIComponent("使用示例.csv"),
      "x-agentbench-upload-encoding": "percent-utf8",
    },
  )
).data.pendingUpload.id;
await request("PUT", `${project}/pending-uploads/${pending}/preview`, admin, {
  mapping: {
    question: "/question",
    expectedOutput: "/answer",
    metadata: ["/topic"],
  },
});
const asset = (
  await request(
    "POST",
    project + "/pending-upload-batches/confirm",
    admin,
    { collectionId: collection, pendingUploadIds: [pending] },
    { "idempotency-key": "architecture-checkpoint-upload" },
  )
).data.assets[0].id;
const drafts = project + "/collaborative-drafts";
const rootDraft = (await request("POST", drafts, admin, {})).data.draft.id;
await request("PATCH", `${drafts}/${rootDraft}`, admin, {
  field: "name",
  value: "协作验收测试集",
  expectedFieldRevision: 0,
});
await request("POST", `${drafts}/${rootDraft}/source-selection`, admin, {
  mode: "add",
  assetIds: [asset],
});
const ready = (await request("GET", `${drafts}/${rootDraft}`, admin)).data;
const publication = (
  await request("POST", `${drafts}/${rootDraft}/publish`, admin, {
    revision: ready.draft.revision,
  })
).data;
const draftId = (
  await request("POST", drafts, editor, {
    testSetId: publication.testSet.id,
    parentVersionId: publication.version.id,
  })
).data.draft.id;
console.log(
  JSON.stringify({
    projectId,
    draftId,
    testSetId: publication.testSet.id,
    versionId: publication.version.id,
    adminEmail,
    editorEmail,
  }),
);
