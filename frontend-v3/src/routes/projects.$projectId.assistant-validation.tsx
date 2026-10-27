import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { request } from "@/services/workspace";
export const Route = createFileRoute("/projects/$projectId/assistant-validation")({
  component: ValidationPage,
});
type Snapshot = {
  session: {
    id: string;
    status: string;
    readonly: boolean;
    revision: number;
    requirements: {
      name: string;
      count: number;
      mode: string;
      operation: string;
      instructions: string;
      allowedFields: string[];
    } | null;
    error_code: string | null;
  };
  messages: { id: number; role: string; content: string }[];
  documents: { id: string; name: string }[];
  confirmations: {
    id: string;
    revision: number;
    status: string;
    expires_at: string;
    payload: { target: { name: string }; resultIds: string[] };
  }[];
  receipts: { draftId: string; name: string; href: string; adopted: number }[];
  run: {
    records: {
      id: string;
      result: {
        question: string;
        expectedOutput: string;
        metadata: { key: string; value: string }[];
      };
    }[];
  } | null;
};
function ValidationPage() {
  const { projectId } = Route.useParams();
  const base = "/api/projects/" + encodeURIComponent(projectId) + "/assistant-validation";
  const [id, setId] = useState(() => new URLSearchParams(location.search).get("session") ?? "");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [sending, setSending] = useState(false);
  const refresh = async (sessionId = id) => {
    if (sessionId) setSnapshot(await request<Snapshot>(base + "/" + sessionId));
  };
  useEffect(() => {
    if (!id) return;
    void refresh().catch((e) => setError(e.message));
    const t = setInterval(() => void refresh().catch((e) => setError(e.message)), 800);
    return () => clearInterval(t);
  }, [id]);
  const act = async (action: () => Promise<unknown>) => {
    setError("");
    setSending(true);
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作未完成");
    } finally {
      setSending(false);
    }
  };
  const post = (suffix: string, body?: unknown) =>
    request(base + "/" + id + suffix, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  const create = () =>
    act(async () => {
      const s = await request<Snapshot>(base, { method: "POST" });
      setId(s.session.id);
      setSnapshot(s);
      history.replaceState(null, "", location.pathname + "?session=" + s.session.id);
    });
  const status: Record<string, string> = {
    idle: "等待输入",
    running: "正在处理",
    waiting: "后台处理中",
    paused: "已暂停",
    confirmation: "等待确认保存",
    failed: "执行未完成",
  };
  return (
    <main className="mx-auto w-full max-w-6xl space-y-5 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">项目助手 · 适配验证</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {snapshot
              ? (snapshot.session.readonly ? "历史验证会话 · 只读" : (status[snapshot.session.status] ?? snapshot.session.status))
              : "创建新会话开始"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void create()} disabled={sending}>
            新会话
          </Button>
          {id && !snapshot?.session.readonly && (
            <Button variant="outline" onClick={() => void act(() => post("/stop"))}>
              停止任务
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {snapshot && (
        <>
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <section
              className="space-y-4 rounded-xl border bg-card p-5 shadow-sm"
              aria-label="会话消息"
            >
              {snapshot.messages.length === 0 && (
                <p className="text-muted-foreground">描述你希望处理的数据和目标。</p>
              )}
              {snapshot.messages.map((m) => (
                <div key={m.id} className={m.role === "user" ? "rounded-lg bg-muted p-4" : "p-2"}>
                  <p className="mb-2 text-xs text-muted-foreground">
                    {m.role === "user" ? "你" : "项目助手"}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm leading-7">{m.content}</p>
                </div>
              ))}
              {["running", "waiting"].includes(snapshot.session.status) && (
                <p role="status" className="text-sm text-muted-foreground">
                  正在处理，完成后会显示结果。
                </p>
              )}
            </section>
            <aside className="space-y-4">
              <section className="rounded-xl border bg-card p-4 shadow-sm">
                <h2 className="font-medium">背景文档</h2>
                <ul className="my-3 text-sm">
                  {snapshot.documents.map((d) => (
                    <li key={d.id}>{d.name}</li>
                  ))}
                </ul>
                <input
                  aria-label="上传背景文档"
                  type="file"
                  accept=".md,.txt,.pdf"
                  disabled={snapshot.session.readonly || sending || ["running", "waiting"].includes(snapshot.session.status)}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f)
                      void act(async () => {
                        const bytes = new Uint8Array(await f.arrayBuffer());
                        let binary = "";
                        for (const byte of bytes) binary += String.fromCharCode(byte);
                        await post("/documents", { name: f.name, content: btoa(binary) });
                      });
                  }}
                />
              </section>
              {snapshot.session.requirements && (
                <section className="rounded-xl border bg-card p-4 shadow-sm">
                  <h2 className="font-medium">当前要求</h2>
                  <p className="mt-2 text-sm">
                    {snapshot.session.requirements.name} · {snapshot.session.requirements.count} 条
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                    {snapshot.session.requirements.instructions || "整理首尾空白"}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {snapshot.session.requirements.mode === "plan"
                      ? "方案已保存，尚未执行"
                      : "按当前要求执行"}
                  </p>
                </section>
              )}
              {snapshot.confirmations
                .filter((c) => c.status === "pending" && c.revision === snapshot.session.revision)
                .map((c) => (
                  <section key={c.id} className="rounded-xl border bg-card p-4 shadow-sm">
                    <h2 className="font-medium">确认保存</h2>
                    <p className="my-3 text-sm">
                      将 {c.payload.resultIds.length} 条保存为“{c.payload.target.name}”草稿。
                    </p>
                    <Button
                      disabled={
                        snapshot.session.readonly || sending ||
                        snapshot.session.status !== "confirmation" ||
                        Date.parse(c.expires_at) <= Date.now()
                      }
                      onClick={() => void act(() => post("/confirmations/" + c.id))}
                    >
                      确认保存
                    </Button>
                  </section>
                ))}
              {snapshot.receipts.map((r) => (
                <section key={r.draftId} className="rounded-xl border bg-card p-4 shadow-sm">
                  <p className="text-sm">已保存 {r.adopted} 条</p>
                  <a className="text-primary underline" href={r.href}>
                    {r.name}
                  </a>
                </section>
              ))}
            </aside>
          </div>
          {snapshot.run && snapshot.run.records.length > 0 && (
            <details className="rounded-xl border bg-card p-4">
              <summary>查看处理结果</summary>
              <div className="mt-3 overflow-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th>问题</th>
                      <th>期望输出</th>
                      <th>Metadata</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.run.records.map((r) => (
                      <tr key={r.id} className="border-t">
                        <td className="p-2">{r.result.question}</td>
                        <td className="p-2">{r.result.expectedOutput}</td>
                        <td className="p-2">
                          {r.result.metadata.map((m) => m.key + ": " + m.value).join(" · ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim()) return;
              void act(async () => {
                await post("/messages", { text });
                setText("");
              });
            }}
          >
            <Textarea
              aria-label="给项目助手发送消息"
              disabled={snapshot.session.readonly}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="描述你想处理的数据和要求…"
              rows={4}
            />
            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={snapshot.session.readonly || sending || !text.trim() || snapshot.session.status === "running"}
              >
                发送
              </Button>
            </div>
          </form>
        </>
      )}
    </main>
  );
}
