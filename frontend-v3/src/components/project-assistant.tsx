import { AssistantCandidates, type CandidateSelection } from "./assistant-candidates";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
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
    inputCount?: number;
    total?: number;
    requiresUserConfirmation?: boolean;
  };
  error?: { code: string };
};
type Turn = {
  id: string;
  event?: string;
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
  receipt?: {
    receipt?: { draftId?: string; added?: number; adopted?: number; changedFields?: number };
    testSet?: { id: string };
    version?: { id: string; label: string; recordCount: number };
  };
};
type Conversation = {
  sessionId: string;
  title?: string;
  task?: {
    title?: string;
    goal?: string;
    stage: string;
    runId?: string;
    checkedStatus?: string;
    error?: string;
    target?: { kind: string; id?: string };
    targetName?: string;
    review?: {
      total: number;
      expectedCount: number;
      countSatisfied: boolean;
      emptyQuestions: number;
      duplicates: number;
      protectedFieldChanges: number;
      outsideLabels?: number;
      labels: { label: string; count: number }[];
      formatIssues?: unknown[];
      complete?: boolean;
    };
  };
  turns: Turn[];
  proposals: Proposal[];
  context?: {
    focusDraft?: string;
    drafts?: { ref: string; name: string; recordCount: number }[];
    pageObject?: { kind: string; name: string; recordCount?: number; label?: string };
  };
};
export type AssistantPageContext = { kind: "draft" | "asset" | "version" | "testSet"; id: string };
type PageData = {
  draft?: { name: string };
  testSet?: { name: string };
  version?: { id: string; label: string; recordCount: number };
  fileName?: string;
  recordCount?: number;
  total?: number;
};
type Submission = {
  message: string;
  key: string;
  sessionId?: string | undefined;
  context?: AssistantPageContext | undefined;
  candidates?: CandidateSelection | undefined;
  turnId?: string;
  status: "submitting" | "accepted" | "failed";
};
const toolLabels: Record<string, string> = {
  query_project: "查询项目",
  read_records: "读取记录",
  create_draft: "建立草稿",
  preview_selection: "筛选预览",
  submit_processing: "提交处理任务",
  read_processing: "读取处理结果",
  plan_task: "整理任务要求",
  refine_candidates: "局部重改候选",
  retry_processing: "重试失败部分",
  request_selection_apply: "准备采用筛选结果",
  request_processing_apply: "准备采用处理结果",
  request_publish: "准备发布版本",
};
const messages: Record<string, string> = {
  assistant_stopped: "任务已停止，已有结果仍保留。",
  assistant_task_limit: "任务已达到自动执行上限。已有结果保留，请补充要求后继续。",
  assistant_session_limit: "此会话已达到回合上限。已有结果保留，请在新会话中继续。",
  assistant_retry_parameters_changed: "重试参数与原操作不同，已阻止重复操作。请核对原任务要求。",
  assistant_candidate_selection_changed: "候选批次已经变化，请重新选择。",
  assistant_turn_running: "本会话还有一条消息正在处理，请稍候。",
  assistant_busy: "当前已有任务正在使用助手，请稍后再试。",
  assistant_session_full: "本会话已达到消息上限，请新建会话继续。",
  assistant_context_unavailable: "本会话引用的资料已回收或不可用。可恢复资料，或新建会话继续。",
  assistant_context_deleted: "相关内容已删除，本会话正文已清理。",
  assistant_interrupted: "这一轮已中断。请先核对下方已完成的操作，再发送后续要求。",
  assistant_model_failed: "模型未完成本轮回复。已完成操作仍保留在下方，可核对后重试。",
  assistant_task_not_executed: "计划中的操作尚未执行。已有结果保留，请重试继续。",
  assistant_confirmation_expired: "确认已过期，请让助手重新准备操作。",
  assistant_confirmation_running: "这项操作正在提交，请稍后查看结果。",
  draft_revision_conflict: "草稿已经变化，请重新核对并生成确认卡片。",
  draft_field_conflict: "同一字段已有新修改，未覆盖当前内容。",
  model_connection_unavailable: "请管理员先在设置中启用模型连接。",
  assistant_not_found: "当前会话不可访问。",
  assistant_reference_invalid: "对象引用无效，请重新查询或明确选择目标。",
  assistant_source_invalid: "缺少来源，请明确文件、草稿或版本。",
  processing_scope_invalid: "尚未确定处理记录，请明确范围。",
  processing_still_running: "处理任务仍在运行，可在任务卡中查看进度。",
  processing_not_found: "当前任务不可访问，或来源已被删除。",
};
const errorText = (error: unknown) =>
  messages[error instanceof Error ? error.message : ""] ?? "操作未完成，请重试。输入已保留。";
const post = <T,>(path: string, body: unknown, key?: string) =>
  request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    body: JSON.stringify(body),
  });

export function ProjectAssistant({
  projectId,
  pageContext,
  canWrite,
}: {
  projectId: string;
  pageContext?: AssistantPageContext | undefined;
  canWrite: boolean;
}) {
  const [open, setOpen] = useState(false),
    [selectedSession, setSelectedSession] = useState<string>(),
    [picked, setPicked] = useState<CandidateSelection>(),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [pendingSubmissions, setPendingSubmissions] = useState<Record<string, Submission>>({});
  const queryClient = useQueryClient(),
    historyRef = useRef<HTMLDivElement>(null),
    contentRef = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    lastSession = useRef<string | undefined>(undefined);
  const pageData = useSyncExternalStore(
    (notify) => queryClient.getQueryCache().subscribe(notify),
    () => {
      if (!pageContext) return undefined;
      const prefix =
        pageContext.kind === "draft"
          ? "shared-draft"
          : pageContext.kind === "asset"
            ? "material-file"
            : "solo-test-set-version";
      return queryClient
        .getQueriesData<PageData>({ queryKey: [prefix, projectId] })
        .find(
          ([key, value]) =>
            value &&
            key[pageContext.kind === "asset" || pageContext.kind === "version" ? 3 : 2] ===
              pageContext.id,
        )?.[1];
    },
    () => undefined,
  );
  const base = `/api/projects/${encodeURIComponent(projectId)}/assistant`;
  const sessions = useQuery({
    queryKey: ["assistant-sessions", projectId],
    queryFn: () =>
      request<{ sessions: { id: string; title?: string; ordinal: number; updated_at: string }[] }>(
        `${base}/sessions`,
      ),
    enabled: open,
  });
  const sessionId = selectedSession ?? sessions.data?.sessions[0]?.id;
  const conversation = useQuery({
    queryKey: ["assistant-conversation", projectId, sessionId, canWrite],
    queryFn: () => request<Conversation>(`${base}/sessions/${encodeURIComponent(sessionId!)}`),
    enabled: open && Boolean(sessionId),
    retry: false,
    refetchInterval: (q) =>
      (pendingSubmissions[sessionId ?? "new"]?.status === "accepted" &&
        !q.state.data?.turns.some(
          (t) => t.id === pendingSubmissions[sessionId ?? "new"]?.turnId,
        )) ||
      q.state.data?.turns.some((t) => ["queued", "running"].includes(t.status)) ||
      ["inspecting", "processing", "checking", "awaiting_confirmation"].includes(
        q.state.data?.task?.stage ?? "",
      )
        ? 1500
        : false,
  });
  const visible = conversation.error ? undefined : conversation.data;
  const pending = pendingSubmissions[sessionId ?? "new"];
  function setPending(submission: Submission) {
    setPendingSubmissions((current) => {
      const next = { ...current, [submission.sessionId ?? "new"]: submission };
      if (submission.sessionId && next["new"]?.key === submission.key) delete next["new"];
      return next;
    });
  }
  const running = visible?.turns.some((t) => ["queued", "running"].includes(t.status)) ?? false;
  useLayoutEffect(() => {
    if (!selectedSession && sessionId) setSelectedSession(sessionId);
    if (lastSession.current !== sessionId) follow.current = true;
    lastSession.current = sessionId;
    const scroll = () => {
      if (follow.current && historyRef.current)
        historyRef.current.scrollTop = historyRef.current.scrollHeight;
    };
    scroll();
    const observer = new ResizeObserver(scroll);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [open, sessionId, selectedSession]);
  const focus = visible?.context?.drafts?.find((d) => d.ref === visible?.context?.focusDraft);
  const currentName = pageData?.draft?.name ?? pageData?.testSet?.name ?? pageData?.fileName;
  const currentCount = pageData?.total ?? pageData?.version?.recordCount ?? pageData?.recordCount;
  const currentLabel = pageContext
    ? `当前${pageContext.kind === "draft" ? "草稿" : pageContext.kind === "asset" ? "原始数据" : pageContext.kind === "version" ? "版本" : "测试集"}：${currentName ?? "正在定位…"}${pageData?.version?.label ? ` · ${pageData.version.label}` : ""}${currentCount !== undefined ? ` · ${currentCount} 条记录` : ""}`
    : focus
      ? `当前草稿：${focus.name} · ${focus.recordCount} 条记录`
      : undefined;
  const validLink = (url: string | undefined) =>
    url?.startsWith(`/projects/${projectId}/`) ? url : undefined;
  async function createSession() {
    const value = await post<{ sessionId: string }>(`${base}/sessions`, {});
    setSelectedSession(value.sessionId);
    setPicked(undefined);
    await sessions.refetch();
    return value.sessionId;
  }
  async function send(retry?: Submission) {
    const text = retry?.message ?? message;
    if (!text.trim() || busy || running) return;
    setBusy(true);
    setError("");
    follow.current = true;
    const retrySame =
      pending?.status === "failed" &&
      pending.message === text &&
      pending.sessionId === sessionId &&
      JSON.stringify(pending.context) === JSON.stringify(pageContext);
    const submission: Submission =
      retry ??
      (retrySame
        ? pending!
        : {
            message: text,
            key: crypto.randomUUID(),
            sessionId,
            context: pageContext,
            ...(picked?.runId === visible?.task?.runId && picked?.resultIds.length
              ? { candidates: picked }
              : {}),
            status: "submitting",
          });
    setPending({ ...submission, status: "submitting" });
    try {
      const id = submission.sessionId ?? (await createSession());
      submission.sessionId = id;
      setPending({ ...submission, status: "submitting" });
      const result = await post<{ turnId: string }>(
        `${base}/sessions/${id}/turns`,
        {
          message: text,
          ...(submission.context ? { context: submission.context } : {}),
          ...(submission.candidates ? { candidates: submission.candidates } : {}),
        },
        submission.key,
      );
      setMessage((current) => (current === text ? "" : current));
      setPending({ ...submission, turnId: result.turnId, status: "accepted" });
      await queryClient.invalidateQueries({ queryKey: ["assistant-conversation", projectId, id] });
      await sessions.refetch();
    } catch (e) {
      setError(errorText(e));
      setPending({ ...submission, status: "failed" });
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
  async function control(action: "stop" | "retry") {
    if (!sessionId || busy) return;
    setBusy(true);
    setError("");
    try {
      await post(`${base}/sessions/${sessionId}/${action}`, {});
      await conversation.refetch();
    } catch (error) {
      setError(errorText(error));
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
              setPicked(undefined);
              setError("");
            }}
          >
            <SelectTrigger className="min-w-0 flex-1" aria-label="选择助手会话">
              <SelectValue placeholder="新会话" />
            </SelectTrigger>
            <SelectContent>
              {sessions.data?.sessions.map((s) => (
                <SelectItem value={s.id} key={s.id}>
                  {(s.id === visible?.sessionId && (visible.task?.title || visible.title)) ||
                    s.title ||
                    `会话 ${s.ordinal}`}{" "}
                  ·{" "}
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
        {currentLabel && (
          <p className="border-b px-5 py-3 text-sm text-muted-foreground">{currentLabel}</p>
        )}
        <div
          ref={historyRef}
          role="log"
          aria-label="助手消息"
          className="min-h-0 flex-1 overflow-y-auto px-5 py-5"
          onScroll={(e) => {
            const el = e.currentTarget;
            follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 80;
          }}
        >
          <div ref={contentRef} className="space-y-5">
            {(sessions.error || conversation.error) && (
              <p role="alert" className="text-sm text-destructive">
                {errorText(conversation.error ?? sessions.error)}
              </p>
            )}
            {conversation.isLoading && sessionId ? (
              <p className="text-sm text-muted-foreground">正在读取会话…</p>
            ) : null}
            {!sessions.isPending &&
              !(sessionId && conversation.isPending) &&
              !(pending && (!pending.sessionId || pending.sessionId === sessionId)) &&
              !visible?.turns.length &&
              !conversation.error && (
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

            {visible?.turns.map((turn) => (
              <section key={turn.id} className="space-y-3">
                {turn.userText && (!turn.event || turn.event === "user") && (
                  <div className="ml-8 rounded-md bg-muted p-3 text-sm">
                    <p className="mb-1 text-xs text-muted-foreground">你</p>
                    <p className="whitespace-pre-wrap break-words">{turn.userText}</p>
                  </div>
                )}
                <div className="space-y-3 text-sm">
                  <p className="font-medium">
                    项目助手
                    {turn.event && turn.event !== "user" ? (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        自动继续
                      </span>
                    ) : null}
                  </p>
                  {turn.assistantText && (
                    <p className="whitespace-pre-wrap break-words leading-6">
                      {turn.assistantText}
                    </p>
                  )}
                  {["queued", "running"].includes(turn.status) && (
                    <p className="text-muted-foreground">正在处理… 关闭面板后可再回来查看结果。</p>
                  )}
                  {turn.errorCode && (
                    <p role="alert" className="text-destructive">
                      {messages[turn.errorCode] ?? "本轮未完成，请核对已执行的操作后再试。"}
                    </p>
                  )}
                  {turn.tools.length > 0 && (
                    <details className="rounded-md border bg-card p-3">
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        操作记录（{turn.tools.length}）
                      </summary>
                      <div className="mt-3 space-y-2">
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
                                {item.status === "failed" && (
                                  <span className="block text-xs text-destructive">
                                    {messages[item.error?.code ?? ""] ??
                                      "操作未完成，请核对范围后重试。"}
                                  </span>
                                )}
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
                      </div>
                    </details>
                  )}
                  {visible?.proposals
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
                                  <Link
                                    to={validLink(p.summary.url)!}
                                    onClick={() => setOpen(false)}
                                  >
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
                              ? p.action === "publish"
                                ? `已发布${p.receipt?.version?.label ? ` · ${p.receipt.version.label}` : ""}`
                                : p.action === "processing"
                                  ? `已采用${p.receipt?.receipt?.adopted !== undefined ? ` · ${p.receipt.receipt.adopted} 条记录` : ""}`
                                  : `已加入草稿${p.receipt?.receipt?.added !== undefined ? ` · 新增 ${p.receipt.receipt.added} 条记录` : ""}`
                              : p.status === "executing"
                                ? "正在提交…"
                                : "已取消"}
                          </p>
                        )}
                        {p.status === "succeeded" &&
                          (p.receipt?.testSet && p.receipt.version ? (
                            <Link
                              to="/projects/$projectId/test-sets/$testSetId"
                              params={{ projectId, testSetId: p.receipt.testSet.id }}
                              search={{ version: p.receipt.version.id }}
                              className="inline-block text-primary hover:underline"
                              onClick={() => setOpen(false)}
                            >
                              查看已发布版本
                            </Link>
                          ) : validLink(p.summary.url) ? (
                            <Link
                              to={p.summary.url!}
                              className="inline-block text-primary hover:underline"
                              onClick={() => setOpen(false)}
                            >
                              查看结果
                            </Link>
                          ) : null)}
                      </div>
                    ))}
                </div>
              </section>
            ))}
            {visible?.task?.goal && (
              <section
                aria-label="当前任务"
                className="space-y-3 rounded-md border bg-card p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="break-words font-semibold">
                      {visible.task.title || visible.title || "当前任务"}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {(
                        {
                          inspecting: "检查资料与要求",
                          processing: "处理中",
                          checking: "核对结果",
                          awaiting_review: "候选待审核",
                          awaiting_confirmation: "等待确认",
                          waiting_input: "等待补充",
                          failed: "任务未完成",
                          stopped: "已停止",
                          complete: "已完成",
                        } as Record<string, string>
                      )[visible.task.stage] ?? "检查任务"}
                    </p>
                  </div>
                  {canWrite && sessionId && (
                    <div className="flex gap-1">
                      {((visible.task.stage === "failed" &&
                        visible.task.error !== "assistant_session_limit") ||
                        (visible.task.stage === "awaiting_review" &&
                          (visible.task.checkedStatus === "failed" ||
                            visible.task.checkedStatus === "cancelled"))) && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void control("retry")}
                        >
                          重试未完成步骤
                        </Button>
                      )}
                      {!["stopped", "complete"].includes(visible.task.stage) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => void control("stop")}
                        >
                          停止任务
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                {visible.task.target && (
                  <p className="text-xs text-muted-foreground">
                    任务对象：
                    {visible.task.targetName ??
                      (
                        {
                          assets: "所选原始数据",
                          draft: "已固定的草稿",
                          version: "已固定的版本",
                        } as Record<string, string>
                      )[visible.task.target.kind] ??
                      "已固定的来源"}
                  </p>
                )}
                {visible.task.runId && (
                  <ProcessingTaskCard
                    projectId={projectId}
                    runId={visible.task.runId}
                    open={open}
                    onNavigate={() => setOpen(false)}
                  />
                )}
                {visible.task.review && (
                  <div className="space-y-2 border-t pt-3 text-xs">
                    <p>
                      候选 {visible.task.review.total} / 目标 {visible.task.review.expectedCount} 条
                      · {visible.task.review.countSatisfied ? "数量达标" : "数量未达标"}
                    </p>
                    <p className="text-muted-foreground">
                      空问题 {visible.task.review.emptyQuestions} · 完全重复{" "}
                      {visible.task.review.duplicates} · 受保护字段变化{" "}
                      {visible.task.review.protectedFieldChanges}
                      {visible.task.review.outsideLabels
                        ? ` · 范围外标签 ${visible.task.review.outsideLabels}`
                        : ""}
                    </p>
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {visible.task.review.labels?.map((label) => (
                        <span key={label.label}>
                          {label.label || "空期望输出"}：{label.count}
                        </span>
                      ))}
                    </div>
                    <p className="text-muted-foreground">
                      以上是结构与数量核对，内容是否正确请审核候选。
                    </p>
                  </div>
                )}
                {visible.task.error && (
                  <p role="alert" className="text-sm text-destructive">
                    {messages[visible.task.error] ?? "任务未完成，已有输入与候选仍保留。"}
                  </p>
                )}
              </section>
            )}
            {canWrite &&
              sessionId &&
              visible?.task?.runId &&
              ["awaiting_review", "awaiting_confirmation", "failed", "stopped"].includes(
                visible.task.stage,
              ) && (
                <AssistantCandidates
                  key={`${sessionId}:${visible.task.runId}`}
                  base={base}
                  sessionId={sessionId}
                  runId={visible.task.runId}
                  selected={picked}
                  onSelect={setPicked}
                />
              )}
            {pending &&
              (!pending.sessionId || pending.sessionId === sessionId) &&
              !visible?.turns.some((t) => t.id === pending.turnId) && (
                <div className="ml-8 space-y-2 rounded-md bg-muted p-3 text-sm">
                  <p className="text-xs text-muted-foreground">你</p>
                  <p className="whitespace-pre-wrap break-words">{pending.message}</p>
                  <p className="text-xs text-muted-foreground">
                    {pending.status === "failed"
                      ? "提交尚未确认，消息已保留。"
                      : pending.status === "accepted"
                        ? "已受理，正在处理…"
                        : "正在提交…"}
                  </p>
                  {pending.status === "failed" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || running}
                      onClick={() => void send(pending)}
                    >
                      重新提交这条
                    </Button>
                  )}
                </div>
              )}
          </div>
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
          {picked?.runId === visible?.task?.runId && Boolean(picked?.resultIds.length) && (
            <p className="text-xs text-muted-foreground">
              本条要求仅重改选中的 {picked!.resultIds.length} 条候选，其余保留。
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
              disabled={
                busy ||
                running ||
                !message.trim() ||
                sessions.isPending ||
                Boolean(sessionId && conversation.isPending) ||
                Boolean(conversation.error)
              }
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

function ProcessingTaskCard({
  projectId,
  runId,
  open,
  onNavigate,
}: {
  projectId: string;
  runId: string;
  open: boolean;
  onNavigate: () => void;
}) {
  const task = useQuery({
    queryKey: ["assistant-processing-run", projectId, runId],
    queryFn: () =>
      request<{
        run: {
          status: string;
          inputCount: number;
          progress: number;
          partial?: boolean;
          errorCode?: string;
          options: { operation: string };
        };
        total: number;
      }>(
        `/api/projects/${encodeURIComponent(projectId)}/processing-runs/${encodeURIComponent(runId)}/status`,
      ),
    enabled: open,
    retry: false,
    refetchInterval: (q) =>
      ["queued", "running", "retry_wait", "cancel_requested"].includes(
        q.state.data?.run.status ?? "",
      )
        ? 2000
        : false,
  });
  const run = task.data?.run,
    done = run && ["succeeded", "failed", "cancelled"].includes(run.status);
  const statuses: Record<string, string> = {
    queued: "等待中",
    running: "处理中",
    retry_wait: "等待重试",
    succeeded: "已完成",
    failed: "失败",
    cancel_requested: "正在取消",
    cancelled: "已取消",
  };
  const operations: Record<string, string> = { clean: "清洗", rewrite: "改写", augment: "扩充" };
  return (
    <div className="space-y-2 rounded-md border bg-card px-3 py-3">
      <p>
        {run
          ? `${operations[run.options.operation] ?? "数据处理"} · ${run.partial ? "部分成功" : (statuses[run.status] ?? run.status)} · ${done ? `${task.data!.total} 条有效结果` : `${run.inputCount} 条输入`}`
          : "处理任务已提交，正在读取进度…"}
      </p>
      {run?.status === "running" && (
        <p className="text-xs text-muted-foreground">进度 {Math.round(run.progress)}%</p>
      )}
      {task.error && (
        <p role="alert" className="text-xs text-destructive">
          {errorText(task.error)}
        </p>
      )}
      <Link
        to="/projects/$projectId/processing"
        params={{ projectId }}
        search={{ source: undefined, sourceId: undefined, run: runId }}
        onClick={onNavigate}
        className="inline-block text-sm text-primary hover:underline"
      >
        {done && task.data!.total > 0 ? "预览结果" : "查看任务"}
      </Link>
    </div>
  );
}
