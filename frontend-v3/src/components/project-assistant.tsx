import { AssistantCandidates, type CandidateSelection } from "./assistant-candidates";
import { AssistantBackground, type BackgroundDocument } from "./assistant-background";
import { AssistantSessionActions } from "./assistant-session-actions";
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
import { assistantReply } from "@/lib/assistant-reply";

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
  backgroundDocuments?: BackgroundDocument[];
  title?: string;
  task?: {
    title?: string;
    goal?: string;
    stage: string;
    runId?: string;
    runIds?: string[];
    checkedStatus?: string;
    candidateScope?: { hash: string; count: number; sourceCount: number; targetCount: number };
    error?: string;
    recovery?: { kind: string; message: string };
    target?: { kind: string; id?: string };
    targetName?: string;
    requirements?: string[];
    requirementSummary?: string[];
    requirementProblem?: string | null;
    executionPlan?: {
      mode: "plan" | "execute";
      current: number;
      needsReview?: boolean;
      steps: {
        id?: string;
        title: string;
        action: string;
        status: "pending" | "waiting" | "executed";
      }[];
    };
    review?: {
      runId: string;
      total: number;
      expectedCount: number | null;
      countSatisfied: boolean;
      countKind?: "new" | "final";
      baseCount?: number;
      remainingCount?: number;
      missingCount?: number;
      emptyQuestions: number;
      duplicates: number;
      protectedFieldChanges: number;
      outsideLabels?: number;
      selectionShortfalls?: {
        label: string;
        requested: number;
        available: number;
        selected: number;
      }[];
      labels: { label: string; count: number }[];
      additionalLabels?: number;
      formatIssues?: unknown[];
      complete?: boolean;
      compatibilityProblem?: string | null;
      classifications?: {
        field: string;
        key?: string;
        satisfied: boolean;
        missing: number;
        outsideValues: number;
        quotaDifferences: { value: string; expected: number; actual: number }[];
        missingCategories?: string[];
      }[];
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
  select_candidates: "按规则选取候选",
  plan_task: "整理任务要求",
  read_background: "读取背景文档",
  refine_candidates: "局部重改候选",
  retry_processing: "重试失败部分",
  request_selection_apply: "准备采用筛选结果",
  request_processing_apply: "准备采用处理结果",
  request_publish: "准备发布版本",
};
const messages: Record<string, string> = {
  assistant_document_format: "请选择 PDF、Markdown 或 TXT 文档。",
  assistant_document_capacity:
    "背景文档超出容量。最多 5 份、合计 10 MB；PDF 最多 200 页，文本最多 10,000 行。",
  assistant_document_encoding: "文本编码无法读取，请使用 UTF-8 的 Markdown 或 TXT 文件。",
  assistant_document_name: "文件名无法使用，请更换文件名后重试。",
  assistant_document_parse: "文档解析失败，请检查 PDF 是否完整或改用文本文件。",
  assistant_document_no_text: "文档没有可提取文字，请提供文字版 PDF、Markdown 或 TXT。",
  assistant_document_timeout: "文档提取超时，请减少内容或提供文本文件。",
  assistant_document_read_failed: "无法读取本地文件，请重新选择。",
  assistant_document_not_found: "背景文档已不可用，请重新打开会话核对。",
  assistant_background_not_read: "背景尚未核对，请让助手先读取附件要求。",
  assistant_background_capacity: "选用的背景过长，请缩小当前任务的依据范围。",
  assistant_background_changed: "背景已经变化，请重新核对要求。",
  processing_scope_changed: "资料内容已经变化，请重新确定处理范围。",
  processing_already_adopted: "这些候选已采用到相同草稿，请核对剩余结果。",
  processing_results_overlap: "同一记录有两份竞争结果，请先明确保留哪一份或进行局部重改。",
  assistant_stopped: "任务已停止，已有结果仍保留。",
  assistant_task_limit: "任务已达到自动执行上限。已有结果保留，请补充要求后继续。",
  assistant_session_limit: "此会话已达到回合上限。已有结果保留，请在新会话中继续。",
  assistant_retry_parameters_changed: "重试参数与原操作不同，已阻止重复操作。请核对原任务要求。",
  assistant_plan_revalidation_required: "要求已变化，请重新核对当前步骤和已有成果。",
  assistant_step_context_changed: "当前步骤的对象或范围已变化，请核对后继续。",
  assistant_candidate_selection_changed: "候选批次已经变化，请重新选择。",
  assistant_turn_running: "本会话还有一条消息正在处理，请稍候。",
  assistant_busy: "当前已有任务正在使用助手，请稍后再试。",
  assistant_session_full: "本会话已达到消息上限，请新建会话继续。",
  assistant_context_unavailable: "本会话引用的资料已回收或不可用。可恢复资料，或新建会话继续。",
  assistant_context_deleted: "相关内容已删除，本会话正文已清理。",
  assistant_interrupted: "这一轮已中断。请先核对下方已完成的操作，再发送后续要求。",
  assistant_model_failed: "模型未完成本轮回复。已完成操作仍保留在下方，可核对后重试。",
  assistant_task_not_executed: "计划中的操作尚未执行。已有结果保留，请重试继续。",
  assistant_result_incomplete: "本轮未给出完整结果。已完成操作保留在下方，请补充要求或重试。",
  assistant_no_progress:
    "连续检查没有取得新进展，任务已暂停。已完成结果保留，请重试未完成步骤或调整要求。",
  assistant_plan_only: "当前只设计方案，尚未授权执行。发送“开始执行”后再处理数据。",
  assistant_plan_count_conflict: "方案配额与目标条数不一致，尚未保存。请核对各类数量后重新规划。",
  assistant_candidate_review_incomplete:
    "候选尚未满足数量、分类或字段要求，暂未建立采用确认；请查看核对结果。",
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
    [candidateRun, setCandidateRun] = useState<string>(),
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
      ["inspecting", "yielding", "processing", "checking", "awaiting_confirmation"].includes(
        q.state.data?.task?.stage ?? "",
      )
        ? 1500
        : false,
  });
  const visible = conversation.error ? undefined : conversation.data;
  useLayoutEffect(() => {
    setPicked(undefined);
  }, [sessionId, visible?.task?.candidateScope?.hash]);
  const taskRuns = visible?.task?.runIds ?? (visible?.task?.runId ? [visible.task.runId] : []);
  const reviewRun =
    candidateRun && taskRuns.includes(candidateRun) ? candidateRun : visible?.task?.runId;
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
            ...(picked && taskRuns.includes(picked.runId) && picked.resultIds.length
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
      if (action === "confirm") setPicked(undefined);
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
      <SheetContent className="flex w-full min-w-0 flex-col gap-0 p-0 sm:max-w-6xl">
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
                  {(s.id === visible?.sessionId && (visible.title || visible.task?.title)) ||
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
          <AssistantSessionActions
            base={base}
            sessionId={sessionId}
            title={
              visible?.title ||
              visible?.task?.title ||
              sessions.data?.sessions.find((s) => s.id === sessionId)?.title ||
              "新会话"
            }
            disabled={busy || sessions.isPending || Boolean(sessionId && conversation.isPending)}
            setBusy={setBusy}
            onRenamed={async (title) => {
              await queryClient.cancelQueries({
                queryKey: ["assistant-conversation", projectId, sessionId],
              });
              queryClient.setQueryData<Conversation>(
                ["assistant-conversation", projectId, sessionId, canWrite],
                (current) => current && { ...current, title },
              );
              void sessions.refetch();
            }}
            onDeleted={async (id) => {
              await queryClient.cancelQueries({
                queryKey: ["assistant-conversation", projectId, id],
              });
              queryClient.removeQueries({ queryKey: ["assistant-conversation", projectId, id] });
              queryClient.setQueryData<typeof sessions.data>(
                ["assistant-sessions", projectId],
                (current) => current && { sessions: current.sessions.filter((s) => s.id !== id) },
              );
              setSelectedSession(undefined);
              setPicked(undefined);
              setCandidateRun(undefined);
              setMessage("");
              setError("");
              setPendingSubmissions((current) => {
                const next = { ...current };
                delete next[id];
                return next;
              });
              await sessions.refetch();
            }}
          />
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
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:grid-rows-1">
          <div className="flex min-h-0 min-w-0 flex-col">
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
                          {assistantReply(turn.assistantText)}
                        </p>
                      )}
                      {["queued", "running"].includes(turn.status) && (
                        <p className="text-muted-foreground">
                          正在处理… 关闭面板后可再回来查看结果。
                        </p>
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
                        .filter((p) => p.turn_id === turn.id)
                        .map((p) => (
                          <div
                            key={p.id}
                            className="space-y-3 rounded-md border bg-card p-4 shadow-sm"
                          >
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
                                    disabled={
                                      busy || new Date(p.expires_at).getTime() <= Date.now()
                                    }
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
                                  <p className="text-xs text-destructive">
                                    确认已过期，请重新生成。
                                  </p>
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
                                    : p.status === "invalid"
                                      ? "要求或范围已变化，此确认已失效；请在本会话重新核对。"
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
                              ) : p.action === "processing" && p.receipt?.receipt?.draftId ? (
                                <Link
                                  to="/projects/$projectId/test-sets/drafts/$draftId"
                                  params={{ projectId, draftId: p.receipt.receipt.draftId }}
                                  className="inline-block text-primary hover:underline"
                                  onClick={() => setOpen(false)}
                                >
                                  继续编辑草稿
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
              {picked && taskRuns.includes(picked.runId) && Boolean(picked.resultIds.length) && (
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
          </div>
          <aside
            aria-label="任务与背景"
            className="min-h-0 min-w-0 space-y-4 overflow-y-auto border-t bg-muted/30 p-4 md:border-l md:border-t-0"
          >
            <AssistantBackground
              key={sessionId ?? "new"}
              base={base}
              projectId={projectId}
              sessionId={sessionId}
              documents={visible?.backgroundDocuments ?? []}
              getSession={async () => sessionId ?? (await createSession())}
              canWrite={canWrite}
              disabled={
                busy ||
                running ||
                sessions.isPending ||
                Boolean(sessionId && conversation.isPending) ||
                Boolean(conversation.error) ||
                visible?.task?.stage === "processing"
              }
              setBusy={setBusy}
              onError={(e) => setError(errorText(e))}
            />
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
                          planning: "方案已保存，等待执行",
                          processing: "处理中",
                          checking: "核对结果",
                          yielding: "阶段结果已保存，准备继续",
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
                        visible.task.error !== "assistant_session_limit" &&
                        !visible.task.requirementProblem &&
                        ![
                          "assistant_requirement_conflict",
                          "assistant_plan_count_conflict",
                          "assistant_plan_revalidation_required",
                          "assistant_step_context_changed",
                        ].includes(visible.task.error ?? "")) ||
                        (visible.task.stage === "awaiting_review" &&
                          (visible.task.checkedStatus === "failed" ||
                            visible.task.checkedStatus === "cancelled" ||
                            Boolean(visible.task.review?.missingCount)))) && (
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
                <p className="rounded-md bg-muted/40 px-3 py-2 text-sm leading-6">
                  下一步：
                  {visible.task.requirementProblem ||
                  visible.task.executionPlan?.needsReview ||
                  visible.task.review?.compatibilityProblem
                    ? "在对话中更正要求，保留的成果会重新核对。"
                    : visible.task.stage === "failed" &&
                        visible.task.recovery?.kind === "model_reply" &&
                        visible.task.checkedStatus === "succeeded"
                      ? "核对已保留的候选，回复失败不会重新生成数据。"
                      : ((
                          {
                            planning: "发送“开始执行”后按当前方案处理。",
                            processing: "后台正在处理，完成后会自动继续；你可以稍后回来查看。",
                            inspecting: "正在查看资料与要求，请稍候。",
                            yielding: "正在从已保存的进度继续，请稍候。",
                            checking: "正在核对实际结果，请稍候。",
                            awaiting_review:
                              "对照原文审核候选；勾选后可在对话中提出局部调整或采用要求。",
                            awaiting_confirmation: "核对对话中的确认卡，点击后才会采用或发布。",
                            waiting_input: "在对话中补充助手询问的业务选择。",
                            failed: "查看下面的具体原因，修正要求或重试未完成步骤。",
                            stopped: "已保留成果，可核对后在本会话继续提出要求。",
                            complete: "本次目标已完成，可查看成果或提出新的要求。",
                          } as Record<string, string>
                        )[visible.task.stage] ?? "查看当前结果后继续提出要求。")}
                </p>
                {Boolean(visible.task.executionPlan?.steps.length) && (
                  <div className="space-y-2">
                    {visible.task.executionPlan?.mode === "plan" && (
                      <p className="text-xs text-muted-foreground">
                        已保存方案（尚未执行）
                      </p>
                    )}
                    <ol
                      aria-label={
                        visible.task.executionPlan?.mode === "plan" ? "方案步骤" : "执行步骤"
                      }
                      className="space-y-2 text-sm"
                    >
                      {visible.task.executionPlan!.steps.map((step, index) => (
                        <li
                          key={step.id ?? `${index}:${step.action}`}
                          className="flex items-start justify-between gap-3"
                        >
                          <span
                            className={
                              index === visible.task?.executionPlan?.current
                                ? "font-medium"
                                : "text-muted-foreground"
                            }
                          >
                            {index + 1}. {step.title}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {visible.task?.executionPlan?.needsReview
                              ? "待重新核对"
                              : step.status === "executed"
                                ? "已执行"
                                : step.status === "waiting"
                                  ? step.action.startsWith("request_")
                                    ? "等待确认"
                                    : visible.task?.checkedStatus === "failed"
                                      ? "需要重试"
                                      : "等待结果"
                                  : visible.task?.executionPlan?.mode === "plan"
                                    ? "方案待执行"
                                    : "待执行"}
                          </span>
                        </li>
                      ))}
                    </ol>
                    {visible.task.executionPlan?.mode === "plan" && visible.task.review && (
                      <p className="text-xs text-muted-foreground">
                        候选核对结果来自实际读取；上述方案仍未切换为执行。
                      </p>
                    )}
                  </div>
                )}
                {visible.task.requirements === undefined && (
                  <p className="break-words text-sm leading-6">{visible.task.goal}</p>
                )}
                {Boolean(
                  (visible.task.requirementSummary ?? visible.task.requirements)?.length,
                ) && (
                  <details className="rounded-md border px-3 py-2 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      当前生效要求（
                      {(visible.task.requirementSummary ?? visible.task.requirements)!.length}）
                    </summary>
                    <ul className="mt-2 list-disc space-y-1 pl-4">
                      {(visible.task.requirementSummary ?? visible.task.requirements)!.map(
                        (requirement, index) => (
                          <li key={index} className="break-words leading-5">
                            {requirement}
                          </li>
                        ),
                      )}
                    </ul>
                  </details>
                )}
                {visible.task.requirementProblem && (
                  <p role="alert" className="break-words text-sm text-destructive">
                    {visible.task.requirementProblem}。原有要求与已完成结果已保留。
                  </p>
                )}
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
                {visible.task.review?.runId === visible.task.runId && visible.task.review && (
                  <div className="space-y-2 border-t pt-3 text-xs">
                    <p>
                      {visible.task.review.countKind === "final" ? "最终总数" : "本次候选"}{" "}
                      {visible.task.review.total}
                      {visible.task.review.expectedCount !== null &&
                        ` / 目标 ${visible.task.review.expectedCount}`}{" "}
                      条 ·{" "}
                      {visible.task.review.expectedCount === null
                        ? visible.task.review.countSatisfied
                          ? "运行输出齐全"
                          : "运行输出不完整"
                        : visible.task.review.countSatisfied
                          ? "数量达标"
                          : "数量未达标"}
                    </p>
                    {visible.task.candidateScope && (
                      <p className="text-muted-foreground">
                        已从 {visible.task.candidateScope.sourceCount} 条处理结果中选出{" "}
                        {visible.task.candidateScope.count} 条。
                      </p>
                    )}
                    {visible.task.review.selectionShortfalls?.map((group, index) => (
                      <p key={index} className="text-destructive">
                        {group.label}：可选 {group.available} 条，已选 {group.selected} / 要求{" "}
                        {group.requested} 条。
                      </p>
                    ))}
                    {visible.task.review.countKind === "final" &&
                      visible.task.review.baseCount !== undefined && (
                        <p className="text-muted-foreground">
                          草稿已有 {visible.task.review.baseCount} 条 · 待采用{" "}
                          {visible.task.review.remainingCount} 条
                        </p>
                      )}
                    <p className="text-muted-foreground">
                      空问题 {visible.task.review.emptyQuestions} · 完全重复{" "}
                      {visible.task.review.duplicates} · 受保护字段变化{" "}
                      {visible.task.review.protectedFieldChanges}
                      {visible.task.review.outsideLabels
                        ? ` · 范围外标签 ${visible.task.review.outsideLabels}`
                        : ""}
                    </p>
                    <details
                      className="rounded-md border px-3 py-2 text-xs"
                      open={visible.task.review.labels.length <= 10}
                    >
                      <summary className="cursor-pointer text-muted-foreground">
                        期望输出统计（
                        {visible.task.review.labels.length +
                          (visible.task.review.additionalLabels ?? 0)}{" "}
                        种）
                      </summary>
                      <div className="mt-2 max-h-48 overflow-y-auto flex flex-wrap gap-x-3 gap-y-1">
                        {visible.task.review.labels?.map((label) => (
                          <span key={label.label}>
                            {label.label || "空期望输出"}：{label.count}
                          </span>
                        ))}
                      </div>
                    </details>
                    <p className="text-muted-foreground">
                      以上是结构与数量核对，内容是否正确请审核候选。
                    </p>
                    {visible.task.review.classifications?.map((rule, i) => (
                      <div key={i} className="text-muted-foreground">
                        <p>
                          {rule.key || "期望输出"}：
                          {rule.satisfied ? "分类与配额符合要求" : "分类或配额未符合要求"}
                          {rule.missing ? ` · 缺少唯一分类 ${rule.missing} 条` : ""}
                          {rule.outsideValues ? ` · 范围外 ${rule.outsideValues} 条` : ""}
                        </p>
                        {rule.quotaDifferences.map((value) => (
                          <p key={value.value}>
                            {value.value}：实际 {value.actual} / 要求 {value.expected} 条
                          </p>
                        ))}
                        {Boolean(rule.missingCategories?.length) && (
                          <p>尚未覆盖：{rule.missingCategories!.join("、")}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {visible.task.error && (
                  <p role="alert" className="text-sm text-destructive">
                    {messages[visible.task.error] ?? "任务未完成，已有输入与候选仍保留。"}
                  </p>
                )}
                {visible.task.recovery && (
                  <p
                    role="status"
                    className="rounded-md border bg-muted/30 px-3 py-2 text-sm leading-6"
                  >
                    {visible.task.recovery.message}
                    {visible.task.runId && " 可在下方查看已保留的处理任务与候选。"}
                  </p>
                )}
                {visible.task.review?.compatibilityProblem && (
                  <p role="alert" className="text-sm text-destructive">
                    {visible.task.review.compatibilityProblem}
                  </p>
                )}
              </section>
            )}
            {taskRuns.length > 1 && reviewRun && (
              <Select
                value={reviewRun}
                onValueChange={(id) => {
                  setCandidateRun(id);
                  setPicked(undefined);
                }}
              >
                <SelectTrigger aria-label="选择候选批次">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {taskRuns.map((runId, index) => (
                    <SelectItem key={runId} value={runId}>
                      批次 {index + 1}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {canWrite &&
              sessionId &&
              reviewRun &&
              visible?.task &&
              ["awaiting_review", "awaiting_confirmation", "failed", "stopped"].includes(
                visible.task.stage,
              ) && (
                <AssistantCandidates
                  key={`${sessionId}:${reviewRun}:${visible.task.candidateScope?.hash ?? "all"}`}
                  base={base}
                  sessionId={sessionId}
                  runId={reviewRun}
                  scopeHash={visible.task.candidateScope?.hash}
                  selected={picked}
                  onSelect={setPicked}
                />
              )}
          </aside>
        </div>
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
          options: { operation: string; outputCount?: number };
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
      {run && !done && (
        <p className="text-xs text-muted-foreground">
          已保存 {task.data!.total} / {run.options.outputCount ?? run.inputCount} 条候选
        </p>
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
