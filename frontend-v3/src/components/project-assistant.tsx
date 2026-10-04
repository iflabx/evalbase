import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MessageSquare, Plus, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { request } from "@/services/workspace";

type ToolResult = {
  key: string;
  name: string;
  status: string;
  result?: {
    url?: string;
    name?: string;
    draftId?: string;
    runId?: string;
    selectedCount?: number;
    requiresUserConfirmation?: boolean;
  };
  error?: { code: string };
};
type Turn = {
  id: string;
  userText: string;
  assistantText: string;
  status: string;
  errorCode: string | null;
  tools: ToolResult[];
};
type Proposal = {
  id: string;
  turn_id: string;
  action: string;
  summary: { title?: string; target?: string; count?: number; revision?: number; url?: string };
  status: string;
  expires_at: string;
};
type Conversation = { sessionId: string; turns: Turn[]; proposals: Proposal[] };
const toolLabels: Record<string, string> = {
  query_project: "查询项目",
  read_records: "读取记录",
  create_draft: "建立草稿",
  preview_selection: "筛选预览",
  submit_processing: "提交处理任务",
  read_processing: "读取处理结果",
  request_selection_apply: "准备采用筛选结果",
  request_processing_apply: "准备采用处理结果",
  request_publish: "准备发布版本",
};
const messages: Record<string, string> = {
  assistant_turn_running: "本会话还有一条消息正在处理，请稍候。",
  assistant_busy: "当前已有任务正在使用助手，请稍后再试。",
  assistant_session_full: "本会话已达到消息上限，请新建会话继续。",
  assistant_context_unavailable: "本会话引用的资料已回收或不可用。可恢复资料，或新建会话继续。",
  assistant_context_deleted: "相关内容已删除，本会话正文已清理。",
  assistant_interrupted: "这一轮已中断。请先核对下方已完成的操作，再发送后续要求。",
  assistant_model_failed: "模型未完成本轮回复。已完成操作仍保留在下方，可核对后重试。",
  assistant_confirmation_expired: "确认已过期，请让助手重新准备操作。",
  assistant_confirmation_running: "这项操作正在提交，请稍后查看结果。",
  draft_revision_conflict: "草稿已经变化，请重新核对并生成确认卡片。",
  draft_field_conflict: "同一字段已有新修改，未覆盖当前内容。",
  model_connection_unavailable: "请管理员先在设置中启用模型连接。",
  assistant_not_found: "当前会话不可访问。",
};
const errorText = (error: unknown) =>
  messages[error instanceof Error ? error.message : ""] ?? "操作未完成，请重试。输入已保留。";
const post = <T,>(path: string, body: unknown, key?: string) =>
  request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    body: JSON.stringify(body),
  });

export function ProjectAssistant({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false),
    [selectedSession, setSelectedSession] = useState<string>(),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submitted = useRef<{ message: string; key: string } | null>(null),
    queryClient = useQueryClient();
  const base = `/api/projects/${encodeURIComponent(projectId)}/assistant`;
  const sessions = useQuery({
    queryKey: ["assistant-sessions", projectId],
    queryFn: () => request<{ sessions: { id: string; updated_at: string }[] }>(`${base}/sessions`),
    enabled: open,
  });
  const sessionId = selectedSession ?? sessions.data?.sessions[0]?.id;
  const conversation = useQuery({
    queryKey: ["assistant-conversation", projectId, sessionId],
    queryFn: () => request<Conversation>(`${base}/sessions/${encodeURIComponent(sessionId!)}`),
    enabled: open && Boolean(sessionId),
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.turns.some((t) => t.status === "running") ? 1500 : false,
  });
  const running = conversation.data?.turns.some((t) => t.status === "running") ?? false;
  const validLink = (url: string | undefined) =>
    url?.startsWith(`/projects/${projectId}/`) ? url : undefined;
  async function createSession() {
    const value = await post<{ sessionId: string }>(`${base}/sessions`, {});
    setSelectedSession(value.sessionId);
    await sessions.refetch();
    return value.sessionId;
  }
  async function send() {
    if (!message.trim() || busy || running) return;
    setBusy(true);
    setError("");
    try {
      const id = sessionId ?? (await createSession());
      if (submitted.current?.message !== message)
        submitted.current = { message, key: crypto.randomUUID() };
      await post(`${base}/sessions/${id}/turns`, { message }, submitted.current!.key);
      setMessage("");
      submitted.current = null;
      await queryClient.invalidateQueries({ queryKey: ["assistant-conversation", projectId, id] });
      await sessions.refetch();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function confirm(id: string, action: "confirm" | "reject") {
    setBusy(true);
    setError("");
    try {
      await post(`${base}/proposals/${id}/${action}`, {});
      await conversation.refetch();
      await queryClient.invalidateQueries({
        predicate: (q) =>
          !["assistant-conversation", "assistant-sessions"].includes(String(q.queryKey[0])),
      });
    } catch (e) {
      setError(errorText(e));
      await conversation.refetch();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="打开项目助手">
          <MessageSquare className="size-4" />
          <span className="hidden sm:inline">项目助手</span>
        </Button>
      </SheetTrigger>
      <SheetContent className="flex w-full min-w-0 flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-5 py-5 pr-12">
          <SheetTitle>项目助手</SheetTitle>
          <SheetDescription>
            查询资料、筛选记录、清洗改写与扩充；采用和发布由你确认。
          </SheetDescription>
        </SheetHeader>
        <div className="flex items-center gap-2 border-b px-5 py-3">
          <Select
            value={sessionId ?? ""}
            disabled={busy}
            onValueChange={(id) => {
              setSelectedSession(id);
              setError("");
            }}
          >
            <SelectTrigger className="min-w-0 flex-1" aria-label="选择助手会话">
              <SelectValue placeholder="新会话" />
            </SelectTrigger>
            <SelectContent>
              {sessions.data?.sessions.map((s, index) => (
                <SelectItem value={s.id} key={s.id}>
                  会话 {sessions.data!.sessions.length - index} ·{" "}
                  {new Date(s.updated_at).toLocaleString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await createSession();
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Plus className="size-4" />
            新会话
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5" aria-live="polite">
          {(sessions.error || conversation.error) && (
            <p role="alert" className="text-sm text-destructive">
              {errorText(conversation.error ?? sessions.error)}
            </p>
          )}
          {conversation.isLoading && sessionId ? (
            <p className="text-sm text-muted-foreground">正在读取会话…</p>
          ) : null}
          {!conversation.data?.turns.length && !conversation.error && (
            <div className="rounded-md border bg-card p-5 text-sm shadow-sm">
              <h3 className="font-semibold">从当前项目开始</h3>
              <p className="mt-2 leading-6 text-muted-foreground">
                例如：“列出项目里的原始文件”“创建一个意图识别测试集草稿”“把这个草稿的问题改写得更自然，保留答案和
                Metadata”。
              </p>
              <p className="mt-3 text-xs text-muted-foreground">
                范围不清楚时，助手会先询问。处理结果可以先预览，再决定是否采用。
              </p>
            </div>
          )}
          {conversation.data?.turns.map((turn) => (
            <section key={turn.id} className="space-y-3">
              {turn.userText && (
                <div className="ml-8 rounded-md bg-muted p-3 text-sm">
                  <p className="mb-1 text-xs text-muted-foreground">你</p>
                  <p className="whitespace-pre-wrap break-words">{turn.userText}</p>
                </div>
              )}
              <div className="space-y-3 text-sm">
                <p className="font-medium">项目助手</p>
                {turn.assistantText && (
                  <p className="whitespace-pre-wrap break-words leading-6">{turn.assistantText}</p>
                )}
                {turn.status === "running" && (
                  <p className="text-muted-foreground">正在处理… 关闭面板后可再回来查看结果。</p>
                )}
                {turn.errorCode && (
                  <p role="alert" className="text-destructive">
                    {messages[turn.errorCode] ?? "本轮未完成，请核对已执行的操作后再试。"}
                  </p>
                )}
                {turn.tools
                  .filter((t) => !t.result?.requiresUserConfirmation)
                  .map((item, index) => (
                    <div
                      key={`${item.key}:${index}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-card px-3 py-2"
                    >
                      <span>
                        {toolLabels[item.name] ?? "操作"} ·{" "}
                        {item.status === "succeeded"
                          ? "已完成"
                          : item.status === "started"
                            ? "已发起，待核对"
                            : "未完成"}
                        {item.result?.name ? ` · ${item.result.name}` : ""}
                      </span>
                      {validLink(item.result?.url) && (
                        <Link
                          to={validLink(item.result?.url)!}
                          className="text-primary underline-offset-4 hover:underline"
                          onClick={() => setOpen(false)}
                        >
                          查看结果
                        </Link>
                      )}
                    </div>
                  ))}
                {conversation.data?.proposals
                  .filter((p) => p.turn_id === turn.id && p.status !== "invalid")
                  .map((p) => (
                    <div key={p.id} className="space-y-3 rounded-md border bg-card p-4 shadow-sm">
                      <h4 className="font-semibold">{p.summary.title}</h4>
                      <p className="break-words text-muted-foreground">
                        {p.summary.target} · {p.summary.count ?? 0} 条记录
                        {p.summary.revision !== undefined
                          ? ` · 草稿修订 ${p.summary.revision}`
                          : ""}
                      </p>
                      {p.status === "pending" ? (
                        <>
                          <p className="text-xs text-muted-foreground">
                            确认将执行以上操作；范围变化后需要重新核对。
                          </p>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              disabled={busy || new Date(p.expires_at).getTime() <= Date.now()}
                              onClick={() => void confirm(p.id, "confirm")}
                            >
                              确认{p.action === "publish" ? "发布" : "采用"}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void confirm(p.id, "reject")}
                            >
                              暂不执行
                            </Button>
                            {validLink(p.summary.url) && (
                              <Button size="sm" variant="ghost" asChild>
                                <Link to={validLink(p.summary.url)!} onClick={() => setOpen(false)}>
                                  查看内容
                                </Link>
                              </Button>
                            )}
                          </div>
                          {new Date(p.expires_at).getTime() <= Date.now() && (
                            <p className="text-xs text-destructive">确认已过期，请重新生成。</p>
                          )}
                        </>
                      ) : (
                        <p className="text-muted-foreground">
                          {p.status === "succeeded"
                            ? "已完成"
                            : p.status === "executing"
                              ? "正在提交…"
                              : "已取消"}
                        </p>
                      )}
                    </div>
                  ))}
              </div>
            </section>
          ))}
        </div>
        <form
          className="space-y-3 border-t bg-background px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <label className="sr-only" htmlFor="project-assistant-message">
            向项目助手发送消息
          </label>
          <Textarea
            id="project-assistant-message"
            value={message}
            maxLength={4000}
            placeholder="描述你想处理的数据和要求…"
            className="min-h-24 resize-none"
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Ctrl / ⌘ + Enter 发送</span>
            <Button
              type="submit"
              disabled={busy || running || !message.trim() || Boolean(conversation.error)}
            >
              <Send className="size-4" />
              {busy ? "正在提交…" : "发送"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
