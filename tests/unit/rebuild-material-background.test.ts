import { describe, it, expect, vi } from "vitest";
import { WorkspaceStore } from "../../src/assistant-rebuild/workspace-store.js";
import { FORMAL_RUNTIME_VERSION } from "../../src/assistant-rebuild/session-contract.js";
import { sessionTools } from "../../src/assistant-rebuild/session-tools.js";
function fixture(extracted: any) {
  const guard = vi.fn(async () => {});
  const query = vi.fn(async (..._args: any[]) => ({
    rows: [{ id: "attachment-a", name: "业务规则.md", extracted }],
  }));
  const store = { guard, db: { query } } as any;
  const tools = sessionTools(
    store,
    { sessionId: "private-session" } as any,
    false,
  );
  return {
    guard,
    query,
    read: tools.tools.find((t) => t.name === "read_attachment")!,
    list: tools.tools.find((t) => t.name === "list_attachments")!,
  };
}
describe("R05 private background evidence", () => {
  it("returns bounded fragments, truthful line citations and a continuation offset", async () => {
    const fragments = Array.from({ length: 7 }, (_, i) => ({
      index: i + 1,
      startLine: i * 40 + 1,
      endLine: (i + 1) * 40,
      text: "规则" + i,
    }));
    const f = fixture({
      format: "md",
      units: 280,
      extractorVersion: "text-v1",
      fragments,
    });
    const first: any = await f.read.invoke({ attachmentId: "attachment-a" });
    expect(first.fragments).toEqual(fragments.slice(0, 5));
    expect(first.truncated).toBe(true);
    expect(first.nextOffset).toBe(5);
    expect(first.citations[0]).toEqual({
      attachmentId: "attachment-a",
      fileName: "业务规则.md",
      fragmentIndex: 1,
      startLine: 1,
      endLine: 40,
    });
    const last: any = await f.read.invoke({
      attachmentId: "attachment-a",
      offset: 5,
    });
    expect(last.fragments).toEqual(fragments.slice(5));
    expect(last.nextOffset).toBe(null);
    expect(f.query.mock.calls[0][1]).toEqual([
      "attachment-a",
      "private-session",
    ]);
  });
  it("keeps real PDF page references and does not fabricate line numbers", async () => {
    const f = fixture({
      format: "pdf",
      units: 3,
      extractorVersion: "pdf-v1",
      fragments: [{ index: 1, page: 3, text: "真实第三页" }],
    });
    const x: any = await f.read.invoke({ attachmentId: "attachment-a" });
    expect(x.citations).toEqual([
      {
        attachmentId: "attachment-a",
        fileName: "业务规则.md",
        fragmentIndex: 1,
        page: 3,
      },
    ]);
    expect(x.truncated).toBe(false);
  });
  it("does not represent an out of range page as the full document", async () => {
    const f = fixture({ fragments: [{ index: 1, text: "one" }] });
    const x: any = await f.read.invoke({
      attachmentId: "attachment-a",
      offset: 99,
    });
    expect(x.fragments).toEqual([]);
    expect(x.total).toBe(1);
    expect(x.truncated).toBe(true);
  });
  it("checks current access before returning private directory or document content", async () => {
    const f = fixture({ fragments: [] });
    f.guard.mockRejectedValue(new Error("membership_revoked"));
    await expect(f.list.invoke({})).rejects.toThrow("membership_revoked");
    await expect(
      f.read.invoke({ attachmentId: "attachment-a" }),
    ).rejects.toThrow("membership_revoked");
    expect(f.query).not.toHaveBeenCalled();
  });
  it("queries only this session active attachments", async () => {
    const f = fixture({});
    await f.list.invoke({});
    expect(f.query.mock.calls[0][0]).toContain(
      "session_id=$1 AND removed_at IS NULL",
    );
    expect(f.query.mock.calls[0][1]).toEqual(["private-session", 0]);
  });
  it("rejects missing private references and invalid offsets", async () => {
    const f = fixture({});
    f.query.mockResolvedValue({ rows: [] });
    await expect(
      f.read.invoke({ attachmentId: "other-session-document" }),
    ).rejects.toMatchObject({ code: "attachment_not_found" });
    await expect(
      f.read.invoke({ attachmentId: "attachment-a", offset: -1 }),
    ).rejects.toThrow();
  });
});
it("R05 cumulative background capacity counts existing original byte sizes before insertion", async () => {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("SELECT id,object_ref")
      ? [{ id: "old", object_ref: "old-original" }]
      : [],
    rowCount: sql.includes("SELECT id,object_ref") ? 1 : 0,
  }));
  const client = { query, release: vi.fn() };
  const store = {
    access: vi.fn(async () => {}),
    get: vi.fn(async () => ({ runtime_version: FORMAL_RUNTIME_VERSION })),
    db: { connect: async () => client },
  } as any;
  const artifacts = {
    storeImmutable: vi.fn(async () => ({ objectRef: "new-original" })),
    size: vi.fn(async () => 10 * 1024 * 1024),
  } as any;
  await expect(
    new WorkspaceStore(store, artifacts).attach(
      { projectId: "p", actorId: "a" },
      "s",
      "rules.md",
      Buffer.from("真实背景"),
    ),
  ).rejects.toMatchObject({ code: "attachment_capacity" });
  expect(artifacts.size).toHaveBeenCalledWith("old-original");
  expect(query.mock.calls.some(([sql]) => sql.includes("INSERT"))).toBe(false);
  expect(query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
});
