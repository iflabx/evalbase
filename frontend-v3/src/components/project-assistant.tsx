import { AssistantCandidates, type CandidateSelection } from "./assistant-candidates";
import { AssistantBackground, type BackgroundDocument } from "./assistant-background";
import { AssistantSessionActions } from "./assistant-session-actions";
import {
  AssistantBudget,
  BudgetSummary,
  type AssistantBudgetFacts,
  type BudgetOffer,
} from "./assistant-budget";
import { AssistantTaskHistory } from "./assistant-task-history";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ChevronLeft,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Plus,
  Search,
  Send,
  X,
  Database,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { useAssistantDraft, readAssistantDraft, writeAssistantDraft } from "@/lib/assistant-draft";
import { AssistantMarkdown } from "./assistant-markdown";
import { ProcessingSourcePicker } from "./processing-source-picker";
import "@/assistant-workspace.css";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import { request, canRetainReadResult } from "@/services/workspace";

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
  error?: { code: string; hint?: string };
};
type Turn = {
  id: string;
  taskId?: string;
  event?: string;
  userText: string;
  assistantText: string;
  status: string;
  errorCode: string | null;
  diagnostics?: {
    diagnosticId: string;
    requestAttempts: number;
    modelRevision: number | null;
    durationMs: number;
    retainedOperations: number;
    retainedCandidates: number | null;
    currentStep: { id: string | null; action: string } | null;
    failure?: {
      layer: string;
      category: string;
      httpStatus: number | null;
      reason: string;
      nextAction: string;
    };
  };
  tools: ToolResult[];
};
type Proposal = {
  id: string;
  turn_id: string;
  action: string;
  summary: {
    title?: string;
    target?: string;
    count?: number;
    revision?: number;
    url?: string;
    range?: "partial" | "task";
  };
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
  taskRevision?: number;
  messageRevision?: string;
  active?: boolean;
  latestTurn?: { id: string; status: string } | null;
  pagination?: { total: number; nextBefore: string | null };
  backgroundDocuments?: BackgroundDocument[];
  title?: string;
  task?: {
    taskId?: string;
    budget?: AssistantBudgetFacts;
    continuation?: { pendingRequest: string | null; remainingSteps: string[] };
    title?: string;
    goal?: string;
    stage: string;
    executionPaused?: boolean;
    overallTargetCount?: number | null;
    deliveries?: {
      id: string;
      name: string;
      count: number;
      countKind: "new" | "final";
      question?: string;
      status: string;
      generatedCount: number | null;
      savedCount: number;
      confirmed: boolean;
      run?: { id: string; status: string; url: string };
      draft?: { id: string; url: string; count: number };
    }[];
    runId?: string;
    runIds?: string[];
    checkedStatus?: string;
    canContinueExecution?: boolean;
    candidateScope?: { hash: string; count: number; sourceCount: number; targetCount: number };
    error?: string;
    recovery?: { kind: string; message: string };
    canRetryTurn?: boolean;
    recoveryDecision?: {
      action: "retry_turn" | "continue_plan" | "continue_execution" | null;
      reason: string;
      revision: number;
      validUntil: number | null;
      canExecutePlan: boolean;
      grantOffers?: { continue: BudgetOffer | null; repair: BudgetOffer | null };
    };
    feedback?: {
      kind: string;
      message: string;
      action?: "background";
      requirementsSaved: boolean;
      requirementsVerified?: boolean;
      planReady: boolean;
      summaryFailed?: boolean;
    };
    transportRecovery?: { turnId: string; retry: number; delayMs: number } | null;
    target?: { kind: string; id?: string };
    targetName?: string;
    requirements?: string[];
    requirementSummary?: string[];
    requirementProblem?: string | null;
    requirementProblemKind?: "business" | "diagnostic";
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
      countUnverified?: boolean;
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
      historicalContent?: {
        checked: number;
        conforms: number;
        nonconforms: number;
        uncertain: number;
      };
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
  candidates?: CandidateSelection | null | undefined;
  turnId?: string;
  status: "submitting" | "accepted" | "failed";
  expectedTaskRevision?: number | undefined;
  operation?: "execute_plan" | "resume" | "save_candidates" | "save_candidates_new";
  taskId?: string | undefined;
  restoreTaskId?: string | undefined;
};
const toolLabels: Record<string, string> = {
  query_project: "查询项目",
  read_records: "读取记录",
  create_draft: "建立草稿",
  preview_selection: "筛选预览",
  submit_processing: "提交处理任务",
  generate_candidates: "依据文档生成",
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
const deliveryStatuses: Record<string, string> = {
  waiting_input: "待补充依据",
  planned: "方案已保存",
  pending: "待执行",
  processing: "处理中",
  awaiting_review: "待审核",
  awaiting_confirmation: "待确认保存",
  partially_saved: "部分已保存",
  saved: "已保存",
  failed: "需要重试",
  paused: "已暂停",
  stopped: "已停止",
  needs_review: "需重新核对",
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
  assistant_delivery_pending: "请先核对并保存当前测试集成果，再继续下一类。",
  assistant_background_required: "请先上传本次生成所依据的背景文档。",
  assistant_background_not_read: "背景尚未核对，请让助手先读取附件要求。",
  assistant_background_capacity: "选用的背景过长，请缩小当前任务的依据范围。",
  assistant_background_changed: "背景已经变化，请重新核对要求。",
  assistant_background_rule_mismatch: "分类规则与选用的文档定义不一致，请先纠正规则。",
  assistant_auto_plan_limit:
    "方案超出本任务已批准的自动续步额度，已暂停。请缩小未完成范围；已有成果和原预算已保留。",
  assistant_auto_limit: "自动执行已暂停，已有进度已保留。请核对剩余工作；继续仍受原预算约束。",
  assistant_tool_input_invalid: "本步未完成，原有要求和成果已保留。可重试未完成步骤。",
  processing_scope_changed: "资料内容已经变化，请重新确定处理范围。",
  processing_already_adopted: "这些候选已采用到相同草稿，请核对剩余结果。",
  processing_results_overlap: "同一记录有两份竞争结果，请先明确保留哪一份或进行局部重改。",
  assistant_stopped: "任务已停止，已有结果仍保留。",
  assistant_task_limit: "任务已达到自动执行上限。已有结果保留，请补充要求后继续。",
  assistant_session_limit: "此会话已达到回合上限。已有结果保留，请在新会话中继续。",
  assistant_retry_parameters_changed: "重试参数与原操作不同，已阻止重复操作。请核对原任务要求。",
  assistant_plan_revalidation_required: "要求已变化，请重新核对当前步骤和已有成果。",
  assistant_step_context_changed:
    "请求的动作与当前步骤不一致，需要修正未执行步骤后继续。已有成果保留。",
  assistant_candidate_selection_changed: "成果已更新，请重新核对并勾选。",
  assistant_turn_running: "本会话还有一条消息正在处理，请稍候。",
  assistant_busy: "当前已有任务正在使用助手，请稍后再试。",
  assistant_session_full: "本会话已达到消息上限，请新建会话继续。",
  assistant_context_unavailable:
    "当前引用的资料不可用或类型不匹配。已有成果保留，请重新选择来源后继续。",
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
  assistant_reference_invalid: "当前资料已不可用，请重新选择来源后继续。",
  assistant_source_invalid: "缺少来源，请明确文件、草稿或版本。",
  processing_scope_invalid: "尚未确定处理记录，请明确范围。",
  processing_still_running: "处理任务仍在运行，可在任务卡中查看进度。",
  processing_retry_unavailable: "本轮无法重试。已有结果保留，请查看处理任务中的恢复操作。",
  processing_not_found: "当前任务不可访问，或来源已被删除。",
};
const errorText = (error: unknown) => {
  if (
    error instanceof Error &&
    "recoveryMessage" in error &&
    typeof error.recoveryMessage === "string"
  )
    return error.recoveryMessage;
  return (
    messages[error instanceof Error ? error.message : ""] ?? "操作未完成，请重试。输入已保留。"
  );
};
const post = <T,>(path: string, body: unknown, key?: string) =>
  request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    body: JSON.stringify(body),
  });

export function ProjectAssistant({
  projectId,
  actorId,
  sessionId,
  pageContext,
  canWrite,
}: {
  projectId: string;
  actorId: string;
  sessionId?: string | undefined;
  pageContext?: AssistantPageContext | undefined;
  canWrite: boolean;
}) {
  const assistantIndex = useRouterState({
    select: (state) =>
      state.location.pathname.replace(/\/$/, "") === `/projects/${projectId}/assistant`,
  });
  const [recoveryNow, setRecoveryNow] = useState(Date.now);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [sessionSearch, setSessionSearch] = useState(""),
    [sessionOffset, setSessionOffset] = useState(0),
    [showSessions, setShowSessions] = useState(true),
    [showWorkspace, setShowWorkspace] = useState(false),
    [expanded, setExpanded] = useState(false),
    [narrow, setNarrow] = useState(false),
    [pane, setPane] = useState<"chat" | "workspace">("chat"),
    [workTab, setWorkTab] = useState<"results" | "sources">("results"),
    [openedTabs, setOpenedTabs] = useState({ results: false, sources: false }),
    [sourcePicker, setSourcePicker] = useState(false),
    [foreground, setForeground] = useState(!document.hidden);
  const scopeKey = `evalbase:assistant:${actorId}:${projectId}:`,
    draftKey = scopeKey + (sessionId ?? "new");
  const [draft, patchDraft] = useAssistantDraft<{
    message: string;
    restore?: { taskId: string; message: string } | undefined;
    pending?: Submission;
    picked?: CandidateSelection | undefined;
  }>(draftKey);
  const message = draft.message ?? "",
    pending = draft.pending,
    picked = draft.picked;
  const setPicked = useCallback(
    (value: CandidateSelection | undefined) => {
      const current = JSON.parse(readAssistantDraft(draftKey));
      writeAssistantDraft(draftKey, { ...current, picked: value });
    },
    [draftKey],
  );
  const setMessage = (value: string | ((old: string) => string)) =>
    patchDraft((current) => ({
      message: typeof value === "function" ? value(current.message ?? "") : value,
    }));
  const queryClient = useQueryClient(),
    navigate = useNavigate(),
    container = useRef<HTMLDivElement>(null),
    candidatePane = useRef<HTMLDivElement>(null),
    historyRef = useRef<HTMLDivElement>(null),
    contentRef = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    paneScroll = useRef({ chat: 0, results: 0, sources: 0 });
  const contextKind = pageContext?.kind,
    contextId = pageContext?.id;
  const go = useCallback(
    function go(
      id?: string,
      context: AssistantPageContext | null | undefined = contextKind && contextId
        ? { kind: contextKind, id: contextId }
        : undefined,
      replace = false,
    ) {
      const search = { sourceKind: context?.kind, sourceId: context?.id };
      return id
        ? navigate({
            to: "/projects/$projectId/assistant/$sessionId",
            params: { projectId, sessionId: id },
            search,
            replace,
          })
        : navigate({
            to: "/projects/$projectId/assistant",
            params: { projectId },
            search,
            replace,
          });
    },
    [navigate, projectId, contextKind, contextId],
  );
  function openWork(tab: "results" | "sources") {
    paneScroll.current.chat = historyRef.current?.scrollTop ?? paneScroll.current.chat;
    if (workTab !== tab && candidatePane.current)
      paneScroll.current[workTab] = candidatePane.current.scrollTop;
    setWorkTab(tab);
    setOpenedTabs((old) => ({ ...old, [tab]: true }));
    setShowWorkspace(true);
    setPane("workspace");
  }
  function showChat() {
    paneScroll.current[workTab] = candidatePane.current?.scrollTop ?? paneScroll.current[workTab];
    setExpanded(false);
    setPane("chat");
  }
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setNarrow((entry?.contentRect.width ?? 1200) < 1100),
    );
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (narrow) setShowSessions(false);
  }, [narrow]);
  useLayoutEffect(() => {
    if (pane === "chat" && historyRef.current)
      historyRef.current.scrollTop = paneScroll.current.chat;
    else if (candidatePane.current) candidatePane.current.scrollTop = paneScroll.current[workTab];
  }, [pane, workTab, expanded]);
  useEffect(() => {
    const change = () => {
      setForeground(!document.hidden);
      if (!document.hidden && sessionId)
        void queryClient.invalidateQueries({
          queryKey: ["assistant-conversation", projectId, sessionId],
        });
    };
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, [projectId, sessionId, queryClient]);
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
    queryKey: [
      "assistant-sessions",
      projectId,
      actorId,
      sessionSearch,
      sessionOffset,
      pageContext?.kind,
      pageContext?.id,
      canWrite,
    ],
    queryFn: ({ signal }) => {
      const query = new URLSearchParams({
        search: sessionSearch.trim(),
        offset: String(sessionOffset),
        limit: "20",
      });
      if (pageContext) {
        query.set("sourceKind", pageContext.kind);
        query.set("sourceId", pageContext.id);
      }
      return request<{
        sessions: { id: string; title?: string; ordinal: number; updated_at: string }[];
        pagination?: { total: number };
        pageContext?: { name: string };
      }>(`${base}/sessions?${query}`, { signal });
    },
    retry: false,
  });
  useEffect(() => {
    if (!assistantIndex || sessionId || sessionSearch || !sessions.data) return;
    let remembered: string | null = null;
    try {
      remembered = sessionStorage.getItem(scopeKey + "last");
    } catch {
      /* optional navigation memory */
    }
    const first = sessions.data.sessions[0]?.id;
    if (!remembered || sessions.data.sessions.some((session) => session.id === remembered)) {
      if (remembered || first) void go(remembered ?? first, undefined, true);
      return;
    }
    const controller = new AbortController();
    void request<Conversation>(`${base}/sessions/${encodeURIComponent(remembered)}?view=status`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        queryClient.setQueryData(
          ["assistant-conversation", projectId, remembered, actorId, canWrite],
          value,
        );
        void go(remembered!, undefined, true);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if ([403, 404, 409].includes(Number(error.status))) {
          try {
            sessionStorage.removeItem(scopeKey + "last");
          } catch {
            /* optional navigation memory */
          }
          if (first) void go(first, undefined, true);
        } else setError(errorText(error));
      });
    return () => controller.abort();
  }, [
    assistantIndex,
    sessionId,
    sessions.data,
    sessionSearch,
    scopeKey,
    go,
    base,
    projectId,
    actorId,
    canWrite,
    queryClient,
  ]);
  const conversation = useQuery<Conversation>({
    queryKey: ["assistant-conversation", projectId, sessionId, actorId, canWrite],
    queryFn: ({ signal }) =>
      request<Conversation>(`${base}/sessions/${encodeURIComponent(sessionId!)}?view=status`, {
        signal,
      }),
    enabled: Boolean(sessionId),
    structuralSharing: (previous, incoming) => {
      const old = previous as Conversation | undefined,
        next = incoming as Conversation;
      return old && Number(old.taskRevision) > Number(next.taskRevision) ? old : next;
    },
    retry: false,
    refetchInterval: (q) =>
      foreground &&
      (q.state.data?.active ||
        q.state.data?.turns?.some((t) => ["queued", "running"].includes(t.status)) ||
        ["inspecting", "yielding", "processing", "checking"].includes(
          q.state.data?.task?.stage ?? "",
        ) ||
        q.state.data?.proposals.some((p) => p.status === "executing"))
        ? 1500
        : false,
  });
  const refreshConversation = useCallback(
    async (id = sessionId) => {
      if (!id) return;
      const queryKey = ["assistant-conversation", projectId, id, actorId, canWrite];
      await queryClient.cancelQueries({ queryKey, exact: true });
      await queryClient.invalidateQueries({ queryKey, exact: true });
    },
    [sessionId, projectId, actorId, canWrite, queryClient],
  );
  const history = useInfiniteQuery({
    queryKey: ["assistant-messages", projectId, sessionId, actorId, canWrite],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      request<Conversation>(
        `${base}/sessions/${encodeURIComponent(sessionId!)}?view=messages&limit=20${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`,
        { signal },
      ),
    getNextPageParam: (page) => page.pagination?.nextBefore ?? undefined,
    enabled: Boolean(sessionId && conversation.data && !conversation.error),
    retry: false,
  });
  useEffect(() => {
    if (conversation.data?.messageRevision)
      void queryClient.invalidateQueries({
        queryKey: ["assistant-messages", projectId, sessionId],
      });
  }, [conversation.data?.messageRevision, projectId, sessionId, queryClient]);
  const visible =
    !canRetainReadResult(conversation.error) || !canRetainReadResult(history.error)
      ? undefined
      : conversation.data && {
          ...conversation.data,
          turns: [
            ...new Map(
              (
                history.data?.pages
                  .slice()
                  .reverse()
                  .flatMap((page) => page.turns ?? []) ??
                conversation.data.turns ??
                []
              ).map((turn) => [turn.id, turn]),
            ).values(),
          ],
          proposals: [
            ...new Map(
              [
                ...(history.data?.pages.flatMap((page) => page.proposals) ?? []),
                ...conversation.data.proposals,
              ].map((proposal) => [proposal.id, proposal]),
            ).values(),
          ],
        };
  const currentTaskId = visible?.task?.taskId ?? (sessionId ? "legacy:" + sessionId : undefined);
  const currentTurn = (turn: Turn) =>
    !currentTaskId || (turn.taskId ?? "legacy:" + sessionId) === currentTaskId;
  const identity = useRef({ sessionId, taskId: currentTaskId });
  identity.current = { sessionId, taskId: currentTaskId };
  const previousTask = useRef<{ sessionId: string; taskId: string } | undefined>(undefined);
  useEffect(() => {
    if (!sessionId || !visible?.task || conversation.data?.sessionId !== sessionId) return;
    const confirmed = visible.task.taskId ?? "legacy:" + sessionId;
    if (
      previousTask.current?.sessionId === sessionId &&
      previousTask.current.taskId !== confirmed
    ) {
      setPicked(undefined);
      setError("");
      void queryClient.cancelQueries({ queryKey: ["assistant-candidates", base, sessionId] });
      const saved = JSON.parse(readAssistantDraft(draftKey));
      writeAssistantDraft(draftKey, { message: saved.message ?? "" });
    }
    previousTask.current = { sessionId, taskId: confirmed };
  }, [
    currentTaskId,
    conversation.data?.sessionId,
    visible?.task,
    base,
    sessionId,
    draftKey,
    setPicked,
    queryClient,
  ]);
  const feedbackRevision = useRef<string | undefined>(undefined);
  useEffect(() => {
    const stamp = conversation.data?.messageRevision;
    const changed = Boolean(
      feedbackRevision.current && stamp && feedbackRevision.current !== stamp,
    );
    feedbackRevision.current = stamp;
    if (
      changed &&
      ["complete", "plan"].includes(visible?.task?.feedback?.kind ?? "") &&
      (visible?.task?.feedback?.requirementsSaved ||
        visible?.task?.feedback?.requirementsVerified ||
        visible?.task?.feedback?.kind === "complete")
    )
      setError("");
  }, [conversation.data?.messageRevision, visible?.task?.feedback]);
  const recovery = visible?.task?.recoveryDecision;
  const recoveryExpired = Boolean(
    recovery?.validUntil !== null &&
    recovery?.validUntil !== undefined &&
    recovery.validUntil <= recoveryNow,
  );
  const recoveryAction =
    recovery?.revision === visible?.taskRevision && !recoveryExpired ? recovery?.action : null;
  const recoveryLabel = recoveryAction
    ? {
        retry_turn: "重试本轮",
        continue_plan: "继续规划",
        continue_execution: "继续执行未完成步骤",
      }[recoveryAction]
    : undefined;
  useEffect(() => {
    if (!recovery?.action || !recovery.validUntil || !sessionId) return;
    const timer = setTimeout(
      () => {
        setRecoveryNow(Date.now());
        void refreshConversation();
      },
      Math.max(0, recovery.validUntil - Date.now()) + 5,
    );
    return () => clearTimeout(timer);
  }, [recovery?.action, recovery?.validUntil, sessionId, refreshConversation]);
  useEffect(() => {
    if (pending?.status !== "accepted" || conversation.isFetching) return;
    const status = conversation.data;
    if (
      status?.latestTurn?.id === pending.turnId ||
      history.data?.pages.some((page) => page.turns?.some((turn) => turn.id === pending.turnId)) ||
      (status?.latestTurn && status.active === false)
    ) {
      const current = JSON.parse(readAssistantDraft(draftKey));
      if (current.pending?.key === pending.key) {
        const rest = { ...current };
        delete rest.pending;
        writeAssistantDraft(draftKey, rest);
      }
    }
  }, [
    pending?.status,
    pending?.turnId,
    pending?.key,
    conversation.data,
    conversation.isFetching,
    history.data,
    draftKey,
  ]);
  useEffect(() => {
    if (conversation.isSuccess && sessionId)
      try {
        sessionStorage.setItem(scopeKey + "last", sessionId);
      } catch {
        /* optional navigation memory */
      }
    if (conversation.error || history.error) {
      const failure = conversation.error ?? history.error;
      if ([403, 404, 409].includes(Number((failure as { status?: number })?.status))) {
        const unsent = JSON.parse(readAssistantDraft(draftKey));
        writeAssistantDraft(draftKey, { message: unsent.message ?? "" });
        setPicked(undefined);
        try {
          if (sessionStorage.getItem(scopeKey + "last") === sessionId)
            sessionStorage.removeItem(scopeKey + "last");
        } catch {
          /* optional navigation memory */
        }
        for (const prefix of [
          "assistant-messages",
          "assistant-candidates",
          "assistant-background",
        ]) {
          void queryClient.cancelQueries({ queryKey: [prefix] });
          queryClient.removeQueries({ queryKey: [prefix], type: "inactive" });
        }
      }
    }
  }, [
    conversation.error,
    history.error,
    conversation.isSuccess,
    sessionId,
    draftKey,
    scopeKey,
    queryClient,
  ]);
  useEffect(() => {
    if (
      visible?.task?.runId &&
      ["awaiting_review", "awaiting_confirmation"].includes(visible.task.stage)
    ) {
      paneScroll.current.chat = historyRef.current?.scrollTop ?? paneScroll.current.chat;
      setOpenedTabs((old) => ({ ...old, results: true }));
      setWorkTab("results");
      setShowWorkspace(true);
      setPane("workspace");
    }
  }, [visible?.task?.runId, visible?.task?.stage]);
  const taskRuns = visible?.task?.runIds ?? (visible?.task?.runId ? [visible.task.runId] : []);
  const processingRecovery = useQueries({
    queries: taskRuns.map((runId) => ({
      ...processingStatusQuery(projectId, runId, actorId, sessionId!),
      enabled:
        foreground &&
        showWorkspace &&
        workTab === "results" &&
        canWrite &&
        visible?.task?.stage === "awaiting_review",
      retry: false,
    })),
  });
  const canRetryProcessing = processingRecovery.some((q) => q.data?.recovery?.canRetry === true);
  const reviewRun = visible?.task?.runId;
  function setPending(submission: Submission) {
    const key = scopeKey + (submission.sessionId ?? "new");
    const current = JSON.parse(readAssistantDraft(key));
    writeAssistantDraft(key, { ...current, pending: submission });
  }
  const running = Boolean(
    visible?.active ||
    visible?.turns.some((t) => currentTurn(t) && ["queued", "running"].includes(t.status)),
  );
  useLayoutEffect(() => {
    follow.current = true;
    const scroll = () => {
      if (follow.current && historyRef.current)
        historyRef.current.scrollTop = historyRef.current.scrollHeight;
    };
    scroll();
    const observer = new ResizeObserver(scroll);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [sessionId]);
  const currentName =
    sessions.data?.pageContext?.name ??
    pageData?.draft?.name ??
    pageData?.testSet?.name ??
    pageData?.fileName;
  const currentCount = pageData?.total ?? pageData?.version?.recordCount ?? pageData?.recordCount;
  const currentLabel = pageContext
    ? `所选${pageContext.kind === "draft" ? "草稿" : pageContext.kind === "asset" ? "原始数据" : pageContext.kind === "version" ? "版本" : "测试集"}：${currentName ?? "正在核对…"}${currentCount !== undefined ? ` · ${currentCount} 条记录` : ""}`
    : undefined;
  const factStage = (
    {
      plan: "方案待执行",
      amendment: "修改待保存",
      input: "等待补充",
      blocked: "需要核对",
      awaiting_review: "候选待审核",
      checking_submission: "核对提交中",
      failed: "任务未完成",
    } as Record<string, string>
  )[visible?.task?.feedback?.kind ?? ""];
  const stageLabel =
    factStage ||
    (visible?.task?.executionPaused && visible.task.stage !== "stopped"
      ? "已暂停"
      : (
          {
            inspecting: "检查资料与要求",
            planning: "方案待执行",
            processing: "处理中",
            checking: "核对结果",
            yielding: "准备继续",
            awaiting_review: "候选待审核",
            awaiting_confirmation: "等待确认",
            waiting_input: "等待补充",
            failed: "任务未完成",
            stopped: "已停止",
            complete: visible?.task?.overallTargetCount ? "当前目标已完成" : "已完成",
          } as Record<string, string>
        )[visible?.task?.stage ?? ""]);
  const validLink = (url: string | undefined) =>
    url?.startsWith(`/projects/${projectId}/`) ? url : undefined;
  async function createSession(preserveInput = false) {
    const value = await post<{ sessionId: string }>(`${base}/sessions`, {});
    if (preserveInput) {
      const old = JSON.parse(readAssistantDraft(draftKey));
      writeAssistantDraft(scopeKey + value.sessionId, {
        ...old,
        ...(old.pending ? { pending: { ...old.pending, sessionId: value.sessionId } } : {}),
      });
    }
    await go(value.sessionId);
    await queryClient.invalidateQueries({ queryKey: ["assistant-sessions", projectId] });
    return value.sessionId;
  }
  async function send(
    retry?: Submission,
    textOverride?: string,
    operation?: Submission["operation"],
  ) {
    if (sessionId && conversation.isPending) return;
    if (retry?.taskId && retry.taskId !== currentTaskId) {
      setError("当前任务已切换，请核对本次要求后重新发送。输入已保留。");
      await refreshConversation();
      return;
    }
    const text = retry?.message ?? textOverride ?? message;
    if (
      !text.trim() ||
      busy ||
      running ||
      (!retry && pending?.status === "submitting") ||
      sessions.error ||
      conversation.error
    )
      return;
    setBusy(true);
    setError("");
    follow.current = true;
    const restoring = !retry && draft.restore?.message === text ? draft.restore.taskId : undefined;
    const retrySame =
      pending?.status === "failed" &&
      pending.message === text &&
      pending.sessionId === sessionId &&
      JSON.stringify(pending.context) === JSON.stringify(restoring ? undefined : pageContext);
    const submission: Submission =
      retry ??
      (retrySame
        ? pending!
        : {
            message: text,
            key: crypto.randomUUID(),
            sessionId,
            taskId: currentTaskId,
            expectedTaskRevision: visible?.taskRevision,
            ...(operation ? { operation } : {}),
            context: restoring ? undefined : pageContext,
            ...(restoring ? { restoreTaskId: restoring } : {}),
            ...(!restoring && picked
              ? { candidates: picked.resultIds.length ? picked : null }
              : {}),
            status: "submitting",
          });
    setPending({ ...submission, status: "submitting" });
    try {
      const id = submission.sessionId ?? (await createSession(true));
      submission.sessionId = id;
      setPending({ ...submission, status: "submitting" });
      const result = await post<{ turnId: string }>(
        `${base}/sessions/${id}/turns`,
        {
          message: text,
          ...(submission.restoreTaskId ? { restoreTaskId: submission.restoreTaskId } : {}),
          ...(submission.context ? { context: submission.context } : {}),
          ...(submission.candidates !== undefined ? { candidates: submission.candidates } : {}),
          ...(submission.operation ? { operation: submission.operation } : {}),
          ...(submission.expectedTaskRevision !== undefined
            ? { expectedTaskRevision: submission.expectedTaskRevision }
            : {}),
        },
        submission.key,
      );
      const key = scopeKey + id,
        saved = JSON.parse(readAssistantDraft(key));
      writeAssistantDraft(key, { ...saved, message: saved.message === text ? "" : saved.message });
      setPending({ ...submission, turnId: result.turnId, status: "accepted" });
      const unsent = JSON.parse(readAssistantDraft(scopeKey + "new"));
      if (unsent.pending?.key === submission.key)
        writeAssistantDraft(scopeKey + "new", {
          message: unsent.message === text ? "" : unsent.message,
        });
      // A pre-submission snapshot must not become the post-202 status.
      await queryClient.cancelQueries({
        queryKey: ["assistant-conversation", projectId, id, actorId, canWrite],
        exact: true,
      });
      await queryClient.invalidateQueries({
        queryKey: ["assistant-conversation", projectId, id, actorId, canWrite],
        exact: true,
      });
      await sessions.refetch();
    } catch (e) {
      if (
        identity.current.sessionId === submission.sessionId &&
        (!submission.taskId || identity.current.taskId === submission.taskId)
      )
        setError(errorText(e));
      setPending({ ...submission, status: "failed" });
      const status = Number((e as { status?: number })?.status);
      if (
        (status >= 400 && status < 500 && status !== 408) ||
        (e instanceof Error && e.message === "assistant_candidate_selection_changed")
      ) {
        const key = scopeKey + (submission.sessionId ?? "new"),
          saved = JSON.parse(readAssistantDraft(key));
        writeAssistantDraft(key, { ...saved, pending: undefined });
        await queryClient.invalidateQueries({
          queryKey: ["assistant-candidates", base, submission.sessionId],
        });
      }
      await refreshConversation(submission.sessionId);
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
      await queryClient.cancelQueries({
        queryKey: ["assistant-conversation", projectId, sessionId, actorId, canWrite],
        exact: true,
      });
      await post(
        `${base}/sessions/${sessionId}/${action}`,
        action === "retry" && recoveryAction
          ? { expectedTaskRevision: recovery!.revision, expectedRecoveryAction: recoveryAction }
          : {},
      );
      await queryClient.invalidateQueries({ queryKey: ["assistant-processing-run", projectId] });
      await refreshConversation();
    } catch (error) {
      setError(errorText(error));
      await refreshConversation();
      if (action === "retry")
        await queryClient.invalidateQueries({ queryKey: ["assistant-processing-run", projectId] });
    } finally {
      setBusy(false);
    }
  }
  if (!canRetainReadResult(conversation.error) || !canRetainReadResult(history.error))
    return (
      <div ref={container} className="assistant-workspace space-y-4">
        <h1 className="text-xl font-semibold">项目助手</h1>
        <p role="alert" className="text-sm text-muted-foreground">
          {errorText(conversation.error ?? history.error)}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void go(undefined, null)}>
            返回我的会话
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              void conversation.refetch();
              void history.refetch();
            }}
          >
            重新读取
          </Button>
        </div>
      </div>
    );
  return (
    <div
      ref={container}
      className="assistant-workspace"
      data-narrow={narrow}
      data-pane={pane}
      data-workspace={showWorkspace}
      data-expanded={expanded}
      data-sessions={showSessions && narrow}
    >
      <header className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            size="icon"
            variant="ghost"
            aria-label={showSessions ? "收起会话列表" : "展开会话列表"}
            onClick={() => setShowSessions(!showSessions)}
          >
            {showSessions ? (
              <PanelLeftClose className="size-4" />
            ) : (
              <PanelLeftOpen className="size-4" />
            )}
          </Button>
          <h1 className="truncate text-xl font-semibold">
            {visible?.title ||
              sessions.data?.sessions.find((s) => s.id === sessionId)?.title ||
              (sessionId ? "项目助手" : "新会话")}
          </h1>
          {stageLabel && (
            <span role="status" className="text-xs text-muted-foreground">
              {stageLabel}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canWrite && sessionId && currentTaskId && visible?.taskRevision !== undefined && (
            <AssistantBudget
              key={sessionId + ":" + currentTaskId}
              base={base}
              sessionId={sessionId}
              taskId={currentTaskId}
              revision={visible.taskRevision}
              title={visible.task?.title ?? visible.task?.goal ?? "当前任务"}
              requirements={visible.task?.requirementSummary}
              scope={visible.task?.continuation}
              offers={
                recovery?.revision === visible.taskRevision ? recovery.grantOffers : undefined
              }
              budget={visible.task?.budget}
              disabled={busy || running}
              onBusy={setBusy}
              onRefresh={refreshConversation}
              onError={(e) => {
                if (
                  identity.current.taskId === currentTaskId &&
                  identity.current.sessionId === sessionId
                )
                  setError(errorText(e));
              }}
            />
          )}
          {(visible?.task?.executionPlan?.mode === "plan" || visible?.task?.executionPaused) &&
            visible.task.stage !== "stopped" &&
            visible.task.recoveryDecision?.canExecutePlan === true &&
            (!visible.task.executionPlan?.needsReview || visible.task.executionPaused) &&
            canWrite && (
              <Button
                size="sm"
                disabled={busy || running || visible.taskRevision === undefined}
                onClick={() =>
                  void send({
                    message: visible.task?.executionPaused
                      ? "继续执行当前任务"
                      : "按当前已保存方案执行",
                    sessionId,
                    key: crypto.randomUUID(),
                    status: "submitting",
                    expectedTaskRevision: visible.taskRevision!,
                    operation: visible.task?.executionPaused ? "resume" : "execute_plan",
                  })
                }
              >
                {visible.task.executionPaused ? "继续执行" : "按方案执行"}
              </Button>
            )}
          {canWrite && (recoveryAction || canRetryProcessing) && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || running}
              onClick={() => void control("retry")}
            >
              {recoveryLabel ?? "重试处理任务"}
            </Button>
          )}
          {canWrite &&
            visible?.task?.goal &&
            !["complete", "stopped"].includes(visible.task.stage) && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void control("stop")}
              >
                停止任务
              </Button>
            )}
          <AssistantSessionActions
            base={base}
            sessionId={sessionId}
            title={visible?.title || "新会话"}
            disabled={busy || Boolean(sessionId && conversation.isPending)}
            setBusy={setBusy}
            onRenamed={async (title) => {
              await queryClient.cancelQueries({
                queryKey: ["assistant-conversation", projectId, sessionId],
              });
              queryClient.setQueryData<Conversation>(
                ["assistant-conversation", projectId, sessionId, actorId, canWrite],
                (old) => old && { ...old, title },
              );
              void conversation.refetch();
              void sessions.refetch();
            }}
            onDeleted={async (id) => {
              writeAssistantDraft(scopeKey + id, {});
              try {
                sessionStorage.removeItem(scopeKey + "last");
              } catch {
                /* optional navigation memory */
              }
              for (const prefix of ["assistant-conversation", "assistant-messages"]) {
                await queryClient.cancelQueries({ queryKey: [prefix, projectId, id] });
                queryClient.removeQueries({ queryKey: [prefix, projectId, id] });
              }
              queryClient.setQueriesData<{
                sessions: { id: string }[];
                pagination?: { total: number };
              }>(
                { queryKey: ["assistant-sessions", projectId] },
                (old) =>
                  old && {
                    ...old,
                    sessions: old.sessions.filter((s) => s.id !== id),
                    ...(old.pagination
                      ? {
                          pagination: {
                            ...old.pagination,
                            total: Math.max(0, old.pagination.total - 1),
                          },
                        }
                      : {}),
                  },
              );
              await go();
              await sessions.refetch();
            }}
          />
          {narrow && (
            <>
              <Button
                variant={pane === "chat" ? "default" : "outline"}
                size="sm"
                onClick={showChat}
              >
                对话
              </Button>
              <Button
                variant={pane === "workspace" ? "default" : "outline"}
                size="sm"
                onClick={() => openWork(workTab)}
              >
                工作区
              </Button>
            </>
          )}
          {!narrow && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (showWorkspace) {
                  setShowWorkspace(false);
                  setExpanded(false);
                } else openWork(workTab);
              }}
            >
              {showWorkspace ? "收起工作区" : "打开工作区"}
            </Button>
          )}
        </div>
      </header>
      <div className="assistant-columns">
        {(showSessions || narrow) && (
          <aside
            aria-label="助手会话列表"
            className="assistant-sessions rounded-md border bg-card shadow-sm"
          >
            <div className="space-y-3 border-b p-3">
              <Button
                className="w-full"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
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
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-3 size-4 text-muted-foreground" />
                <Input
                  aria-label="搜索助手会话"
                  placeholder="搜索会话"
                  value={sessionSearch}
                  maxLength={100}
                  className="pl-8"
                  onChange={(e) => {
                    setSessionSearch(e.target.value);
                    setSessionOffset(0);
                  }}
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
              {sessions.data?.sessions.map((s) => (
                <Button
                  key={s.id}
                  variant={s.id === sessionId ? "secondary" : "ghost"}
                  className="h-auto w-full justify-start whitespace-normal px-3 py-3 text-left"
                  onClick={() => {
                    void go(s.id);
                    setShowSessions(!narrow);
                  }}
                >
                  <span className="min-w-0 truncate">{s.title || `会话 ${s.ordinal}`}</span>
                </Button>
              ))}
              {!sessions.isPending && !sessions.data?.sessions.length && (
                <p className="p-3 text-sm text-muted-foreground">
                  {sessionSearch ? "没有匹配会话" : "还没有会话"}
                </p>
              )}
            </div>
            {(sessions.data?.pagination?.total ?? 0) > 20 && (
              <div className="flex justify-between gap-2 border-t p-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!sessionOffset}
                  onClick={() => setSessionOffset((n) => n - 20)}
                >
                  上一页
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={sessionOffset + 20 >= (sessions.data?.pagination?.total ?? 0)}
                  onClick={() => setSessionOffset((n) => n + 20)}
                >
                  下一页
                </Button>
              </div>
            )}
          </aside>
        )}
        <div className="assistant-main rounded-md border bg-card shadow-sm">
          <div className="assistant-chat" id="assistant-chat">
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
                {history.hasNextPage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={history.isFetchingNextPage}
                    onClick={() => {
                      follow.current = false;
                      const height = historyRef.current?.scrollHeight ?? 0;
                      void history.fetchNextPage().then(() =>
                        requestAnimationFrame(() => {
                          if (historyRef.current)
                            historyRef.current.scrollTop +=
                              historyRef.current.scrollHeight - height;
                        }),
                      );
                    }}
                  >
                    加载更早消息
                  </Button>
                )}
                {(sessions.error || conversation.error || history.error) && (
                  <p role="alert" className="text-sm text-destructive">
                    {errorText(conversation.error ?? history.error ?? sessions.error)}
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
                    <div className="space-y-4 py-8 text-sm">
                      <h2 className="text-lg font-semibold">准备处理什么资料？</h2>
                      <div className="flex flex-wrap gap-2">
                        {["整理这份资料", "基于现有题目扩写", "先帮我设计方案"].map((example) => (
                          <Button
                            key={example}
                            variant="outline"
                            size="sm"
                            onClick={() => setMessage(example)}
                          >
                            {example}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}

                {visible?.turns.map((turn) => (
                  <section key={turn.id} className="space-y-3">
                    {!currentTurn(turn) && turn.taskId && sessionId && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>历史任务</span>
                        <AssistantTaskHistory
                          key={turn.taskId + ":" + currentTaskId}
                          base={base}
                          sessionId={sessionId}
                          taskId={turn.taskId}
                          actorId={actorId}
                          canWrite={canWrite}
                          disabled={busy || running}
                          canFill={!message.trim()}
                          onRestore={(text, taskId) => {
                            setPicked(undefined);
                            patchDraft({ message: text, restore: { taskId, message: text } });
                          }}
                        />
                      </div>
                    )}
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
                      {turn.assistantText && <AssistantMarkdown text={turn.assistantText} />}
                      {["queued", "running"].includes(turn.status) && (
                        <p className="text-muted-foreground">
                          {visible.task?.transportRecovery?.turnId === turn.id
                            ? "模型服务暂时繁忙，正在重试…"
                            : "正在处理… 关闭面板后可再回来查看结果。"}
                        </p>
                      )}
                      {turn.errorCode && (
                        <details className="text-xs text-muted-foreground">
                          <summary className="cursor-pointer">本轮诊断</summary>
                          <div className="mt-2 space-y-2 break-words">
                            <p>
                              {turn.diagnostics?.failure?.reason ??
                                messages[turn.errorCode] ??
                                "本轮未完成，已执行操作保留在下方。"}
                            </p>
                            {turn.diagnostics?.failure?.nextAction && (
                              <p>{turn.diagnostics.failure.nextAction}</p>
                            )}
                            {turn.diagnostics?.failure && (
                              <div className="space-y-1">
                                {turn.diagnostics.currentStep && (
                                  <p>
                                    失败步骤：
                                    {toolLabels[turn.diagnostics.currentStep.action] ?? "当前操作"}
                                  </p>
                                )}
                                <p>
                                  已完成数据操作 {turn.diagnostics.retainedOperations} 项
                                  {turn.diagnostics.retainedCandidates !== null
                                    ? ` · 保留候选 ${turn.diagnostics.retainedCandidates} 条`
                                    : ""}
                                </p>
                                <p>诊断编号：{turn.diagnostics.diagnosticId}</p>
                              </div>
                            )}
                          </div>
                        </details>
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
                                  {item.status === "failed" && item.error?.hint && (
                                    <details className="w-full min-w-0 text-xs text-muted-foreground">
                                      <summary className="cursor-pointer">技术详情</summary>
                                      <p className="mt-2 whitespace-pre-wrap break-words">
                                        {item.error.hint}
                                      </p>
                                    </details>
                                  )}
                                  {validLink(item.result?.url) && (
                                    <Link
                                      to={validLink(item.result?.url)!}
                                      className="text-primary underline-offset-4 hover:underline"
                                      onClick={() => undefined}
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
                              {p.summary.range === "partial" && " · 部分采用"}
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
                                      !canWrite ||
                                      !currentTurn(turn) ||
                                      busy ||
                                      new Date(p.expires_at).getTime() <= Date.now()
                                    }
                                    onClick={() => void confirm(p.id, "confirm")}
                                  >
                                    确认{p.action === "publish" ? "发布" : "采用"}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={busy || !currentTurn(turn)}
                                    onClick={() => void confirm(p.id, "reject")}
                                  >
                                    暂不执行
                                  </Button>
                                  {validLink(p.summary.url) && (
                                    <Button size="sm" variant="ghost" asChild>
                                      <Link
                                        to={validLink(p.summary.url)!}
                                        onClick={() => undefined}
                                      >
                                        查看内容
                                      </Link>
                                    </Button>
                                  )}
                                </div>
                                {new Date(p.expires_at).getTime() <= Date.now() && (
                                  <p className="text-xs text-destructive">
                                    此确认已过期，已有结果保留；请重新核对后确认。
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
                                  : ["executing", "unverified"].includes(p.status)
                                    ? "提交结果正在核对…"
                                    : ["invalid", "expired"].includes(p.status)
                                      ? "此确认已失效，已有结果保留；请重新核对后确认。"
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
                                  onClick={() => undefined}
                                >
                                  查看已发布版本
                                </Link>
                              ) : p.action === "processing" && p.receipt?.receipt?.draftId ? (
                                <Link
                                  to="/projects/$projectId/test-sets/drafts/$draftId"
                                  params={{ projectId, draftId: p.receipt.receipt.draftId }}
                                  className="inline-block text-primary hover:underline"
                                  onClick={() => undefined}
                                >
                                  继续编辑草稿
                                </Link>
                              ) : validLink(p.summary.url) ? (
                                <Link
                                  to={p.summary.url!}
                                  className="inline-block text-primary hover:underline"
                                  onClick={() => undefined}
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
                      {["failed", "submitting"].includes(pending.status) && (
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
              {currentLabel && (
                <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <span className="truncate">{currentLabel}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label="移除所选资料"
                    onClick={() => void go(sessionId, null)}
                  >
                    <X className="size-3" />
                  </Button>
                </div>
              )}
              {visible?.task?.targetName && visible.task.targetName !== currentName && (
                <p className="text-xs text-muted-foreground">任务对象：{visible.task.targetName}</p>
              )}
              {visible?.task?.feedback?.message && (
                <div
                  role="status"
                  className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground"
                >
                  <span className="break-words">{visible.task.feedback.message}</span>
                  {visible.task.feedback.action === "background" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => openWork("sources")}
                    >
                      上传背景文档
                    </Button>
                  )}
                </div>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {picked && Boolean(picked.resultIds.length) && (
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
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSourcePicker(true)}
                  >
                    <Database className="size-4" />
                    选择资料
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => openWork("sources")}
                  >
                    <Paperclip className="size-4" />
                    背景附件
                  </Button>
                  <span className="hidden xl:inline text-xs text-muted-foreground">
                    Ctrl / ⌘ + Enter
                  </span>
                </div>
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    running ||
                    pending?.status === "submitting" ||
                    !message.trim() ||
                    sessions.isPending ||
                    Boolean(sessionId && conversation.isPending) ||
                    Boolean(conversation.error || sessions.error || history.error)
                  }
                >
                  <Send className="size-4" />
                  {busy ? "正在提交…" : "发送"}
                </Button>
              </div>
            </form>
          </div>
          <aside aria-label="任务与背景" className="assistant-workbench" id="assistant-workbench">
            <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
              <Button
                size="sm"
                variant={workTab === "results" ? "default" : "ghost"}
                onClick={() => openWork("results")}
              >
                结果
              </Button>
              <Button
                size="sm"
                variant={workTab === "sources" ? "default" : "ghost"}
                onClick={() => openWork("sources")}
              >
                资料与要求
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="ml-auto"
                aria-label={expanded ? "恢复对话分栏" : "展开结果"}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
              </Button>
              {expanded && (
                <Button size="sm" variant="ghost" onClick={showChat}>
                  <ChevronLeft className="size-4" />
                  对话
                </Button>
              )}
            </div>
            <div
              ref={candidatePane}
              className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-4"
            >
              {openedTabs.sources && (
                <div hidden={workTab !== "sources"}>
                  <AssistantBackground
                    actorId={actorId}
                    active={showWorkspace && workTab === "sources" && foreground}
                    key={sessionId ?? "new"}
                    base={base}
                    projectId={projectId}
                    sessionId={sessionId}
                    documents={visible?.backgroundDocuments ?? []}
                    getSession={async () => sessionId ?? (await createSession(true))}
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
                </div>
              )}
              {visible?.task?.goal && (
                <section
                  aria-label="当前任务"
                  className="space-y-3 rounded-md border bg-card p-4 shadow-sm"
                >
                  {visible.task.budget && <BudgetSummary budget={visible.task.budget} />}
                  {Boolean(visible.task.deliveries?.length) && (
                    <div className="space-y-2 border-b pb-3">
                      <h3 className="text-sm font-medium">交付目标</h3>
                      <ul aria-label="交付目标" className="divide-y">
                        {visible.task.deliveries!.map((delivery) => (
                          <li key={delivery.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
                            <div className="flex flex-wrap items-start justify-between gap-2 text-sm">
                              <span className="min-w-0 break-words font-medium">
                                {delivery.name}
                              </span>
                              <span className="shrink-0 text-xs text-muted-foreground">
                                {deliveryStatuses[delivery.status] ?? "待核对"}
                              </span>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {delivery.countKind === "final" && delivery.draft
                                ? `草稿总数 ${delivery.draft.count} / 目标 ${delivery.count} 条`
                                : `${delivery.countKind === "final" ? "目标总数" : "目标新增"} ${delivery.count} 条`}
                              {delivery.generatedCount !== null &&
                                ` · 候选 ${delivery.generatedCount} 条`}
                              {` · 本次已保存 ${delivery.savedCount} 条`}
                            </p>
                            {delivery.question && (
                              <p className="text-xs text-muted-foreground">{delivery.question}</p>
                            )}
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                              {validLink(delivery.draft?.url) && (
                                <Link
                                  to={validLink(delivery.draft?.url)!}
                                  className="text-primary hover:underline"
                                >
                                  {delivery.savedCount > 0 ? "查看已保存草稿" : "查看草稿"}
                                </Link>
                              )}
                              {validLink(delivery.run?.url) && (
                                <Link
                                  to={validLink(delivery.run?.url)!}
                                  className="text-primary hover:underline"
                                >
                                  查看处理任务
                                </Link>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {workTab === "sources" && Boolean(visible.task.executionPlan?.steps.length) && (
                    <div className="space-y-2">
                      {visible.task.executionPlan?.mode === "plan" && (
                        <p className="text-xs text-muted-foreground">
                          {visible.task.feedback?.kind === "amendment"
                            ? "原方案（本次修改尚未生效）"
                            : "已保存方案（尚未执行）"}
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
                              {step.status === "executed"
                                ? "已执行"
                                : visible.task?.executionPlan?.needsReview
                                  ? "待重新核对"
                                  : step.status === "waiting"
                                    ? step.action.startsWith("request_")
                                      ? "等待确认"
                                      : visible.task?.checkedStatus === "failed"
                                        ? "需要重试"
                                        : "等待结果"
                                    : visible.task?.executionPaused
                                      ? "已暂停"
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
                  {workTab === "sources" && visible.task.requirements === undefined && (
                    <p className="break-words text-sm leading-6">{visible.task.goal}</p>
                  )}
                  {workTab === "sources" &&
                    Boolean(
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
                    <div className="space-y-2 text-sm">
                      {!visible.task.feedback && (
                        <p role="alert" className="break-words text-destructive">
                          {visible.task.requirementProblemKind === "business"
                            ? visible.task.requirementProblem
                            : "本次要求尚未应用，可重试未完成步骤"}
                          。原有要求与已完成结果已保留。
                        </p>
                      )}
                      {visible.task.requirementProblemKind !== "business" && (
                        <details className="text-xs text-muted-foreground">
                          <summary className="cursor-pointer">技术详情</summary>
                          <p className="mt-2 whitespace-pre-wrap break-words">
                            {visible.task.requirementProblem}
                          </p>
                        </details>
                      )}
                    </div>
                  )}
                  {workTab === "sources" && visible.task.target && (
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
                  {workTab === "results" &&
                    visible.task.runId &&
                    (visible.task.stage === "processing" || canRetryProcessing) && (
                      <ProcessingTaskCard
                        projectId={projectId}
                        actorId={actorId}
                        sessionId={sessionId!}
                        runId={visible.task.runId}
                        open={showWorkspace && workTab === "results" && foreground}
                        onReview={() =>
                          candidatePane.current?.scrollIntoView({
                            behavior: "smooth",
                            block: "start",
                          })
                        }
                      />
                    )}
                  {workTab === "results" &&
                    visible.task.review?.runId === visible.task.runId &&
                    visible.task.review && (
                      <div className="space-y-2 border-t pt-3 text-xs">
                        <p>
                          {visible.task.review.countKind === "final" ? "最终总数" : "本次候选"}{" "}
                          {visible.task.review.total}
                          {visible.task.review.expectedCount !== null &&
                            ` / 目标 ${visible.task.review.expectedCount}`}{" "}
                          条 ·{" "}
                          {visible.task.review.countUnverified
                            ? "目标数量待确认"
                            : visible.task.review.expectedCount === null
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
                              核对时：草稿原有 {visible.task.review.baseCount} 条 · 本轮拟采用{" "}
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
                        {visible.task.review.classifications?.map((rule, i) => (
                          <div key={i} className="text-muted-foreground">
                            <p>
                              {rule.key || "期望输出"}：
                              {rule.satisfied
                                ? "分类取值与配额核对通过"
                                : "分类取值或配额未符合要求"}
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
                  {!visible.task.feedback && visible.task.error && (
                    <p role="alert" className="text-sm text-destructive">
                      {messages[visible.task.error] ?? "任务未完成，已有输入与候选仍保留。"}
                    </p>
                  )}
                  {!visible.task.feedback && visible.task.recovery && (
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
                  {visible.task.review?.historicalContent && (
                    <p className="text-xs text-muted-foreground">
                      历史模型核对 {visible.task.review.historicalContent.checked} 条，其中符合{" "}
                      {visible.task.review.historicalContent.conforms}{" "}
                      条；当前要求需重新核对。历史结论不代表人工审核通过。
                    </p>
                  )}
                </section>
              )}
              <div hidden={workTab !== "results"} className="space-y-3">
                {!reviewRun && (
                  <p className="py-5 text-sm text-muted-foreground">处理结果会显示在这里。</p>
                )}
                {openedTabs.results &&
                  canWrite &&
                  sessionId &&
                  reviewRun &&
                  visible?.task &&
                  [
                    "awaiting_review",
                    "awaiting_confirmation",
                    "waiting_input",
                    "failed",
                    "stopped",
                    "complete",
                  ].includes(visible.task.stage) && (
                    <AssistantCandidates
                      key={sessionId}
                      actorId={actorId}
                      active={showWorkspace && workTab === "results" && foreground}
                      base={base}
                      sessionId={sessionId}
                      runId={reviewRun}
                      scopeHash={
                        String(visible.taskRevision ?? 0) +
                        (visible.task.candidateScope?.hash ?? "")
                      }
                      readOnly={visible.task.stage === "complete"}
                      selected={visible.task.stage === "complete" ? undefined : picked}
                      onSelect={setPicked}
                      onSave={
                        running || busy || visible.task.stage === "complete"
                          ? undefined
                          : (text) =>
                              void send(
                                undefined,
                                text,
                                text === "将勾选成果保存回原草稿"
                                  ? "save_candidates"
                                  : text === "将勾选成果保存为新测试集草稿"
                                    ? "save_candidates_new"
                                    : undefined,
                              )
                      }
                    />
                  )}
              </div>
            </div>
          </aside>
        </div>
      </div>
      {sourcePicker && (
        <ProcessingSourcePicker
          projectId={projectId}
          canWrite={canWrite}
          title="选择助手资料"
          onClose={() => setSourcePicker(false)}
          onChoose={(kind, id) => {
            setSourcePicker(false);
            void go(sessionId, { kind: kind === "assets" ? "asset" : kind, id });
          }}
        />
      )}
    </div>
  );
}

type ProcessingStatus = {
  recovery?: {
    canRetry: boolean;
    canContinue: boolean;
    reason: string | null;
    generationBudget?: { exhausted: boolean };
  };
  run: {
    status: string;
    inputCount: number;
    progress: number;
    partial?: boolean;
    executionComplete?: boolean;
    missingCount?: number;
    errorCode?: string;
    options: { operation: string; outputCount?: number };
  };
  total: number;
};

function processingStatusQuery(
  projectId: string,
  runId: string,
  actorId: string,
  sessionId: string,
) {
  return {
    queryKey: ["assistant-processing-run", projectId, runId, actorId, sessionId],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      request<ProcessingStatus>(
        `/api/projects/${encodeURIComponent(projectId)}/processing-runs/${encodeURIComponent(runId)}/status`,
        { signal },
      ),
  };
}

function ProcessingTaskCard({
  projectId,
  actorId,
  sessionId,
  runId,
  open,
  onReview,
}: {
  projectId: string;
  actorId: string;
  sessionId: string;
  runId: string;
  open: boolean;
  onReview: () => void;
}) {
  const task = useQuery({
    ...processingStatusQuery(projectId, runId, actorId, sessionId),
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
          ? `${operations[run.options.operation] ?? "数据处理"} · ${(run.status === "failed" && task.data!.total > 0) || (run.status === "succeeded" && run.executionComplete === false) ? "部分完成" : (statuses[run.status] ?? run.status)} · ${done ? `${task.data!.total} 条结果${run.missingCount ? `，尚缺 ${run.missingCount} 条` : ""}` : `${run.inputCount} 条输入`}`
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
      {done && task.data!.total > 0 && (
        <Button variant="ghost" size="sm" className="h-auto px-0 text-primary" onClick={onReview}>
          预览本任务候选
        </Button>
      )}
      {done && Boolean(run.missingCount) && (
        <>
          {task.data?.recovery?.reason === "budget_exhausted" && (
            <p className="text-xs text-muted-foreground">
              {task.data?.recovery?.generationBudget?.exhausted
                ? "本任务生成额度已用完，已有候选保留。"
                : "本轮重试额度已用完，已有候选保留。"}
            </p>
          )}
          <Link
            className="inline-block text-sm text-primary hover:underline"
            to="/projects/$projectId/processing"
            params={{ projectId }}
            search={{ run: runId }}
          >
            查看处理任务与恢复操作
          </Link>
        </>
      )}
    </div>
  );
}
