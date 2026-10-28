import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  ThreadPrimitive,
  MessagePrimitive,
  useAuiState,
  type ThreadMessageLike,
  type TextMessagePartProps,
} from "@assistant-ui/react";
import {
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  Paperclip,
  Send,
  Square,
  X,
  MoreHorizontal,
  FileText,
  ArrowDown,
  ChevronRight,
  FileUp,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Sheet, SheetContent, SheetTitle } from "./ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "./ui/resizable";
import { AssistantMarkdown } from "./assistant-markdown";
import { AssistantMaterialBridge } from "./assistant-material-bridge";
import {
  api,
  base,
  endpoint,
  json,
  submission,
  acceptedDraft,
  openTab,
  errorText,
  visibleMessages,
  mergeSnapshot,
  mergeMessages,
  type Snapshot,
  type SessionItem,
  type Envelope,
  type Source,
  type WorkspaceTab,
  type NativeAction,
} from "@/services/formal-assistant";
import type { InputContext } from "@/services/assistant-input-context";
import "./formal-assistant.css";

function Message() {
  const role = useAuiState((s) => s.message.role);
  return (
    <MessagePrimitive.Root className={"formal-message " + (role === "user" ? "formal-user" : "")}>
      <div className="mb-2 text-xs text-muted-foreground">
        {role === "user" ? "你" : "项目助手"}
      </div>
      <MessagePrimitive.Parts
        components={{ Text: ({ text }: TextMessagePartProps) => <AssistantMarkdown text={text} /> }}
      />
    </MessagePrimitive.Root>
  );
}
const toolNames: Record<string, string> = {
  read_project: "读取项目",
  list_sources: "查找资料",
  read_records: "读取记录",
  read_attachment: "读取文档",
  list_attachments: "查看背景文档",
  create_collection: "创建资料集合",
  list_projects: "查找项目",
  read_project_access: "读取项目权限",
  list_collections: "查找资料集合",
  list_material_files: "查找原始文件",
  read_material_records: "读取资料记录",
  read_material_record: "读取完整记录",
  read_material_raw: "查看原始内容",
  create_project: "创建项目",
  move_material_file: "移动文件",
  list_pending_uploads: "查看待确认上传",
  open_material_upload: "选择上传文件",
  open_material_mapping: "整理文件字段",
  navigate_project: "打开项目页面",
  create_requirements: "新增交付要求",
  update_requirements: "修改交付要求",
  submit_processing: "提交处理",
  wait_processing: "等待处理",
  prepare_adoption: "准备保存确认",
  wait_confirmation: "等待确认",
};
const statusNames: Record<string, string> = {
  idle: "就绪",
  busy: "正在处理",
  pending: "准备执行",
  running: "正在处理",
  paused: "已暂停",
  waiting: "后台处理中",
  confirmation: "等待确认",
  completed: "本轮完成",
  failed: "本轮未完成",
};
const reasonNames: Record<string, string> = {
  no_progress: "连续操作没有取得新进展，请核对要求后继续。",
  segment_without_progress: "本轮未取得新进展，要求与已有结果已保留。",
  activity_budget_exhausted: "本次验证额度已用完，已停止。",
  processing_not_complete: "处理任务未完成，已有结果已保留。请核对处理结果后继续。",
  task_budget_exhausted: "任务额度已用完，请核对后申请追加。",
  model_request_timeout: "模型响应超时，已有进度已保留。",
  provider_rejected: "模型服务未能处理本次请求，输入和已有进度已保留。",
  user_stopped: "任务已暂停，可以查看进度或继续。",
};
function readLocal<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
export function FormalAssistant({
  projectId,
  actorId,
  canWrite,
  canExport,
  canConfigureModels: _canConfigureModels,
  sessionId,
  pageContext,
  selectionMissing,
  selectionToken,
}: {
  projectId: string;
  actorId: string;
  canWrite: boolean;
  canExport: boolean;
  canConfigureModels: boolean;
  sessionId?: string | undefined;
  pageContext?: InputContext | { kind: string; id: string } | undefined;
  selectionMissing: boolean;
  selectionToken?: string | undefined;
}) {
  const navigate = useNavigate(),
    [sessions, setSessions] = useState<SessionItem[]>([]),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0),
    [next, setNext] = useState<number | null>(null),
    [listOpen, setListOpen] = useState(() => window.innerWidth >= 1100),
    [workOpen, setWorkOpen] = useState(false),
    [narrow, setNarrow] = useState(() => window.innerWidth < 1100),
    [snapshot, rawSetSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [connected, setConnected] = useState(false),
    [busy, setBusy] = useState(false),
    [rename, setRename] = useState(false),
    [deleteOpen, setDeleteOpen] = useState(false),
    [handoffOpen, setHandoffOpen] = useState(false),
    [remainingGoal, setRemainingGoal] = useState(""),
    [title, setTitle] = useState(""),
    [progressOpen, setProgressOpen] = useState(false),
    [hasEarlier, setHasEarlier] = useState(false);
  useEffect(() => {
    if (narrow && workOpen) setListOpen(false);
  }, [narrow, workOpen]);
  useEffect(() => {
    if (narrow) setListOpen(false);
  }, [narrow]);
  const readOnlyHistory =
    !!snapshot?.contentInvalidated ||
    (!!snapshot?.currentRuntime && snapshot.session.runtime_version !== snapshot.currentRuntime);
  const [materialAction, setMaterialAction] = useState<NativeAction | null>(null);
  const [nativeSource, setNativeSource] = useState<{
    source: Source;
    names: string[];
    unmapped: { id: string; fileName: string; collectionId: string }[];
  } | null>(null);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]),
    [active, setActive] = useState("");
  const draftKey = "evalbase:assistant:" + actorId + ":" + projectId + ":" + (sessionId ?? "new");
  const [draft, setDraft] = useState(""),
    [pending, setPending] = useState<Envelope | null>(null),
    [attachmentIds, setAttachmentIds] = useState<string[]>([]),
    [conflict, setConflict] = useState(false);
  const busyOwner = useRef(0),
    sendHTTP = useRef<{ id: string; token: number; controller: AbortController } | null>(null);
  const beginBusy = () => {
    const token = ++busyOwner.current;
    setBusy(true);
    return token;
  };
  const endBusy = (token: number) => {
    if (busyOwner.current === token) setBusy(false);
  };
  const current = useRef(sessionId),
    input = useRef<HTMLTextAreaElement>(null),
    file = useRef<HTMLInputElement>(null),
    viewport = useRef<HTMLDivElement>(null),
    atBottom = useRef(true),
    [newContent, setNewContent] = useState(false),
    scrolls = useRef(new Map<string, number>());
  const restoringScroll = useRef<string | undefined>(undefined);
  const generationRef = useRef(0);
  if (current.current !== sessionId) generationRef.current++;
  current.current = sessionId;
  const generation = generationRef.current;
  const latestSnapshot = useRef(snapshot);
  latestSnapshot.current = snapshot;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const activeSession = (selected: string | undefined) =>
    mounted.current && current.current === selected && generationRef.current === generation;
  const historyInitialized = useRef(false);
  const loadedMessages = useRef<Snapshot["messages"]>([]);
  const historyEpoch = useRef(0);
  const historyGaps = useRef<Array<{ before: string; floor: string }>>([]);
  const historyFlight = useRef<AbortController | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);
  const activeContent = (selected: string | undefined, epoch: number) =>
    activeSession(selected) &&
    historyEpoch.current === epoch &&
    !latestSnapshot.current?.contentInvalidated;
  const fillHistory = async (selected: string) => {
    if (historyFlight.current || !activeSession(selected)) return;
    const epoch = historyEpoch.current,
      controller = new AbortController();
    historyFlight.current = controller;
    setHistoryFailed(false);
    try {
      while (
        historyGaps.current.length &&
        activeSession(selected) &&
        historyEpoch.current === epoch
      ) {
        const gap = historyGaps.current[0]!;
        const page = await api<{ messages: Snapshot["messages"]; hasEarlier: boolean }>(
          endpoint(projectId, selected) + "/history?before=" + gap.before,
          { signal: controller.signal },
        );
        if (!activeSession(selected) || historyEpoch.current !== epoch) return;
        loadedMessages.current = mergeMessages(loadedMessages.current, page.messages);
        rawSetSnapshot((old) =>
          old?.session.id === selected
            ? { ...old, messages: mergeMessages(old.messages, page.messages) }
            : old,
        );
        const first = page.messages[0]?.id;
        if (!first || BigInt(first) <= BigInt(gap.floor) || !page.hasEarlier)
          historyGaps.current.shift();
        else if (BigInt(first) < BigInt(gap.before)) gap.before = first;
        else throw new Error("历史分页未推进，请重试加载。");
      }
    } catch (e) {
      if (activeSession(selected) && historyEpoch.current === epoch && !controller.signal.aborted)
        setHistoryFailed(true);
    } finally {
      if (historyFlight.current === controller) historyFlight.current = null;
    }
  };
  const setSnapshot = (incoming: Snapshot | null) => {
    if (!incoming) {
      historyEpoch.current++;
      historyFlight.current?.abort();
      historyFlight.current = null;
      historyGaps.current = [];
      setHistoryFailed(false);
      loadedMessages.current = [];
      rawSetSnapshot(null);
      return;
    }
    if (!activeSession(incoming.session.id)) return;
    if (latestSnapshot.current?.contentInvalidated && !incoming.contentInvalidated) return;
    if (incoming.contentInvalidated) {
      historyEpoch.current++;
      historyFlight.current?.abort();
      historyFlight.current = null;
      historyGaps.current = [];
      loadedMessages.current = [];
      setTabs([]);
      setActive("");
      setAttachmentIds([]);
      setDraft("");
      setPending(null);
      setNativeSource(null);
      setHasEarlier(false);
      sessionStorage.removeItem(draftKey);
      sessionStorage.removeItem(draftKey + ":materials");
      rawSetSnapshot(incoming);
      return;
    }
    const previous = loadedMessages.current;
    if (!historyInitialized.current) {
      setHasEarlier(incoming.messages.length === 100);
      historyInitialized.current = true;
    }
    loadedMessages.current = mergeMessages(previous, incoming.messages);
    rawSetSnapshot((old) => mergeSnapshot(old, incoming));
    if (
      previous.length &&
      incoming.messages.length === 100 &&
      BigInt(incoming.messages[0]!.id) > BigInt(previous[previous.length - 1]!.id)
    ) {
      historyGaps.current.push({
        before: incoming.messages[0]!.id,
        floor: previous[previous.length - 1]!.id,
      });
    }
    void fillHistory(incoming.session.id);
  };
  const [listVersion, setListVersion] = useState(0);
  const refreshList = () => setListVersion((v) => v + 1);
  useEffect(() => {
    let live = true;
    void api<{ sessions: SessionItem[]; nextOffset: number | null }>(
      base(projectId) + "?search=" + encodeURIComponent(search) + "&offset=" + offset,
    )
      .then((d) => {
        if (live) {
          setSessions(d.sessions);
          setNext(d.nextOffset);
        }
      })
      .catch((e) => {
        if (live) setError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [projectId, actorId, search, offset, listVersion]);
  useEffect(() => {
    const fn = () => setNarrow(window.innerWidth < 1100);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);
  useEffect(() => {
    const saved = readLocal<{ draft: string; pending: Envelope | null; attachments: string[] }>(
      draftKey,
      { draft: "", pending: null, attachments: [] },
    );
    setDraft(saved.draft);
    setPending(saved.pending);
    setAttachmentIds(saved.attachments);
    setNativeSource(readLocal(draftKey + ":materials", null));
    setMaterialAction(null);
    setConflict(false);
    setRename(false);
    setProgressOpen(false);
    setNewContent(false);
    busyOwner.current++;
    setBusy(false);
    setError("");
    historyInitialized.current = false;
    setSnapshot(null);
    setHasEarlier(false);
    setTabs([]);
    setActive("");
    setWorkOpen(false);
    setConnected(false);
    if (!sessionId) return;
    const selected = sessionId;
    let live = true;
    const apply = (s: Snapshot) => {
      if (!live || current.current !== selected || s.session.id !== selected) return;
      setSnapshot(s);
      setConnected(true);
      setTabs((old) =>
        old.map((t) =>
          t.kind === "draft"
            ? { ...t, name: s.receipts.find((r) => r.draftId === t.id)?.fileName ?? t.name }
            : t,
        ),
      );
    };
    let source: EventSource | undefined;
    const connect = async () => {
      try {
        const initial = await api<Snapshot>(endpoint(projectId, selected));
        if (!live) return;
        apply(initial);
        source = new EventSource(endpoint(projectId, selected) + "/events");
        source.addEventListener("snapshot", (event) => {
          if (!live) return;
          try {
            apply(JSON.parse((event as MessageEvent<string>).data));
          } catch {
            setError("无法读取服务端更新，请刷新重试。");
          }
        });
        source.onerror = () => {
          if (live) setConnected(false);
        };
        source.addEventListener("access_lost", () => {
          if (live) {
            setSnapshot(null);
            setTabs([]);
            setActive("");
            setDraft("");
            setPending(null);
            setAttachmentIds([]);
            setNativeSource(null);
            sessionStorage.removeItem(draftKey);
            sessionStorage.removeItem(draftKey + ":materials");
            setError("会话访问已失效，请重新登录或核对权限。");
            source?.close();
          }
        });
      } catch (e) {
        if (live) setError(errorText(e));
      }
    };
    void connect();
    return () => {
      live = false;
      source?.close();
      historyEpoch.current++;
      historyFlight.current?.abort();
      historyFlight.current = null;
    };
  }, [draftKey, projectId, sessionId]);
  const requirementsRevision = snapshot?.session.requirements_revision;
  useEffect(() => {
    if (requirementsRevision !== undefined) setListVersion((v) => v + 1);
  }, [requirementsRevision]);
  const saveDraft = (text: string, envelope: Envelope | null = pending, ids = attachmentIds) => {
    setDraft(text);
    sessionStorage.setItem(
      draftKey,
      JSON.stringify({ draft: text, pending: envelope, attachments: ids }),
    );
  };
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    const el = viewport.current;
    if (!el || !sessionId) return;
    restoringScroll.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    const el = viewport.current;
    if (!el || !snapshot || snapshot.session.id !== sessionId) return;
    if (restoringScroll.current === sessionId) {
      el.scrollTop = scrolls.current.get(sessionId!) ?? el.scrollHeight;
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      restoringScroll.current = undefined;
      return;
    }
    if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
      setNewContent(false);
    } else setNewContent(true);
  }, [snapshot, sessionId]);
  const context = useMemo<Source | undefined>(() => {
    if (nativeSource) return nativeSource.source;
    if (!pageContext) return;
    if ("source" in pageContext && pageContext.source) return pageContext.source;
    const ids = "inputSelection" in pageContext ? pageContext.inputSelection?.recordIds : undefined;
    return pageContext.kind === "asset"
      ? { kind: "assets", assetIds: [pageContext.id], ...(ids ? { recordIds: ids } : {}) }
      : pageContext.kind === "draft" || pageContext.kind === "version"
        ? { kind: pageContext.kind, id: pageContext.id, ...(ids ? { recordIds: ids } : {}) }
        : undefined;
  }, [pageContext, nativeSource]);
  const openSession = (id: string, carry = false) => {
    void navigate({
      to: "/projects/$projectId/assistant/$sessionId",
      params: { projectId, sessionId: id },
      search: {
        sourceKind:
          carry && pageContext
            ? (pageContext.kind as "asset" | "draft" | "version" | "testSet")
            : undefined,
        sourceId: carry ? pageContext?.id : undefined,
        selection: carry ? selectionToken : undefined,
      },
    });
    if (narrow) setListOpen(false);
  };
  const create = async () => {
    const selected = sessionId;
    const busyToken = beginBusy();
    try {
      const data = await api<Snapshot>(base(projectId), json("POST", {}));
      if (!activeSession(selected)) {
        refreshList();
        return;
      }
      openSession(data.session.id, true);
      void refreshList();
    } catch (e) {
      if (activeSession(selected)) setError(errorText(e));
    } finally {
      if (activeSession(selected)) endBusy(busyToken);
    }
  };
  const send = async () => {
    const contentEpoch = historyEpoch.current;
    if (readOnlyHistory) {
      setError("旧会话只读保留，请新建会话继续；原成果与预算不变。");
      return;
    }
    if (
      !sessionId ||
      !snapshot ||
      busy ||
      selectionMissing ||
      snapshot.session.status === "busy" ||
      ["running", "waiting", "confirmation", "pending"].includes(snapshot.execution?.status ?? "")
    )
      return;
    const selected = sessionId,
      key = draftKey,
      envelope =
        pending ??
        submission(
          snapshot.session.revision,
          draft,
          attachmentIds,
          context,
          !nativeSource && pageContext && "inputSelection" in pageContext
            ? pageContext.inputSelection?.sourceRevision
            : undefined,
        );
    setPending(envelope);
    saveDraft(draft, envelope);
    const busyToken = beginBusy();
    setError("");
    try {
      const controller = new AbortController();
      sendHTTP.current = { id: envelope.submissionId, token: busyToken, controller };
      await api(endpoint(projectId, selected) + "/messages", {
        ...json("POST", envelope),
        signal: controller.signal,
      });
      if (activeContent(selected, contentEpoch)) {
        const text = acceptedDraft(draftRef.current, envelope);
        setPending(null);
        setAttachmentIds([]);
        setNativeSource(null);
        sessionStorage.removeItem(key + ":materials");
        setDraft(text);
        sessionStorage.setItem(
          key,
          JSON.stringify({ draft: text, pending: null, attachments: [] }),
        );
        void refreshList();
      }
    } catch (e) {
      if (
        activeContent(selected, contentEpoch) &&
        !latestSnapshot.current?.turns.some((t) => t.submission_id === envelope.submissionId)
      ) {
        setError(errorText(e));
        setConflict(
          [400, 403, 404, 409, 413, 415, 422].includes((e as { status?: number }).status ?? 0),
        );
      }
    } finally {
      if (activeContent(selected, contentEpoch)) endBusy(busyToken);
    }
  };
  const action = async (action: "stop" | "continue") => {
    const contentEpoch = historyEpoch.current;
    if (!sessionId) return;
    const selected = sessionId;
    const busyToken = beginBusy();
    try {
      const s = await api<Snapshot>(
        endpoint(projectId, selected) + "/control",
        json("POST", { action }),
      );
      if (activeContent(selected, contentEpoch)) setSnapshot(s);
    } catch (e) {
      if (activeContent(selected, contentEpoch)) setError(errorText(e));
    } finally {
      if (activeContent(selected, contentEpoch)) endBusy(busyToken);
    }
  };
  const showTab = (tab: WorkspaceTab) => {
    setTabs((old) => openTab(old, tab));
    setActive(tab.id);
    setWorkOpen(true);
    if (narrow) setListOpen(false);
  };
  const document = async (id: string, offset = 0) => {
    const contentEpoch = historyEpoch.current;
    if (!sessionId) return;
    const selected = sessionId;
    try {
      const d = await api<{
        id: string;
        name: string;
        extracted: {
          fragments: { text: string; page?: number; startLine?: number; endLine?: number }[];
        };
        offset?: number;
        nextOffset?: number | null;
        total?: number;
        truncated?: boolean;
      }>(
        endpoint(projectId, selected) +
          "/attachments/" +
          encodeURIComponent(id) +
          "?offset=" +
          offset,
      );
      if (activeContent(selected, contentEpoch))
        showTab({
          id: d.id,
          name: d.name,
          kind: "document",
          document: {
            fragments: d.extracted.fragments,
            offset: d.offset ?? offset,
            nextOffset: d.nextOffset ?? null,
            total: d.total ?? d.extracted.fragments.length,
            truncated: d.truncated ?? false,
          },
        });
    } catch (e) {
      if (activeContent(selected, contentEpoch)) setError(errorText(e));
    }
  };
  const upload = async (files: FileList | null) => {
    const contentEpoch = historyEpoch.current;
    if (!files || !sessionId || !canWrite || readOnlyHistory) return;
    const selected = sessionId;
    const busyToken = beginBusy();
    try {
      for (const f of files) {
        if (!activeContent(selected, contentEpoch)) break;
        if (f.size > 10 * 1024 * 1024) throw Error("attachment_capacity");
        const contentBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
          reader.onerror = reject;
          reader.readAsDataURL(f);
        });
        if (!activeContent(selected, contentEpoch)) break;
        const a = await api<{ id: string; name: string }>(
          endpoint(projectId, selected) + "/attachments",
          json("POST", { fileName: f.name, contentBase64 }),
        );
        if (activeContent(selected, contentEpoch))
          setAttachmentIds((old) => {
            const ids = [...old, a.id];
            sessionStorage.setItem(
              draftKey,
              JSON.stringify({ draft: draftRef.current, pending, attachments: ids }),
            );
            return ids;
          });
      }
      const updated = await api<Snapshot>(endpoint(projectId, selected));
      if (activeContent(selected, contentEpoch)) setSnapshot(updated);
    } catch (e) {
      if (activeContent(selected, contentEpoch)) setError(errorText(e));
    } finally {
      if (activeContent(selected, contentEpoch)) {
        if (file.current) file.current.value = "";
        endBusy(busyToken);
      }
    }
  };
  const removeAttachment = async (id: string) => {
    const contentEpoch = historyEpoch.current;
    if (!sessionId) return;
    const selected = sessionId;
    if (!window.confirm("移除背景文档将清理本会话消息和检查点；已独立保存的成果及累计用量保留。"))
      return;
    try {
      await api(endpoint(projectId, sessionId) + "/attachments/" + encodeURIComponent(id), {
        method: "DELETE",
      });
      if (!activeContent(selected, contentEpoch)) return;
      setSnapshot(await api<Snapshot>(endpoint(projectId, selected)));
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    if (!pending || !snapshot?.turns.some((t) => t.submission_id === pending.submissionId)) return;
    const transport = sendHTTP.current;
    if (transport?.id === pending.submissionId) {
      endBusy(transport.token);
      transport.controller.abort();
      sendHTTP.current = null;
    }
    const text = acceptedDraft(draftRef.current, pending);
    setPending(null);
    setDraft(text);
    setAttachmentIds([]);
    setNativeSource(null);
    sessionStorage.removeItem(draftKey + ":materials");
    setConflict(false);
    setError("");
    sessionStorage.setItem(
      draftKey,
      JSON.stringify({ draft: text, pending: null, attachments: [] }),
    );
  }, [snapshot, pending, draftKey]);
  const previewResult = async (runId: string) => {
    const contentEpoch = historyEpoch.current;
    if (!sessionId) return;
    const selected = sessionId;
    try {
      const data = await api<{ records: NonNullable<WorkspaceTab["rows"]>; total: number }>(
        endpoint(projectId, selected) + "/results/" + encodeURIComponent(runId),
      );
      if (activeContent(selected, contentEpoch))
        showTab({
          id: runId,
          kind: "result",
          name: "处理结果 · " + data.total + " 条",
          rows: data.records,
          href: "/projects/" + projectId + "/processing?run=" + runId,
        });
    } catch (e) {
      if (activeContent(selected, contentEpoch)) setError(errorText(e));
    }
  };
  const offerBudget = async () => {
    if (!sessionId) return;
    const selected = sessionId,
      token = beginBusy();
    try {
      await api(endpoint(projectId, selected) + "/budget-offer", json("POST", {}));
      const updated = await api<Snapshot>(endpoint(projectId, selected));
      if (activeSession(selected)) setSnapshot(updated);
    } catch (e) {
      if (activeSession(selected)) setError(errorText(e));
    } finally {
      if (activeSession(selected)) endBusy(token);
    }
  };
  const confirm = async (id: string, accept: boolean) => {
    if (!sessionId) return;
    const selected = sessionId;
    const busyToken = beginBusy();
    try {
      await api(endpoint(projectId, selected) + "/confirmations/" + id, json("POST", { accept }));
      const updated = await api<Snapshot>(endpoint(projectId, selected));
      if (activeSession(selected)) setSnapshot(updated);
    } catch (e) {
      if (activeSession(selected)) setError(errorText(e));
    } finally {
      if (activeSession(selected)) endBusy(busyToken);
    }
  };
  const refreshCurrent = async () => {
    if (!sessionId) return;
    const selected = sessionId;
    try {
      const updated = await api<Snapshot>(endpoint(projectId, selected));
      if (activeSession(selected)) {
        setSnapshot(updated);
        setPending(null);
        setConflict(false);
        saveDraft(draftRef.current, null);
      }
    } catch (e) {
      if (activeSession(selected)) setError(errorText(e));
    }
  };
  const deleteCurrent = async () => {
    if (!snapshot || !sessionId) return;
    try {
      await api(
        endpoint(projectId, sessionId),
        json("DELETE", { expectedRevision: snapshot.session.revision }),
      );
      sessionStorage.removeItem(draftKey);
      sessionStorage.removeItem(draftKey + ":materials");
      setSnapshot(null);
      setTabs([]);
      setDeleteOpen(false);
      refreshList();
      void navigate({
        to: "/projects/$projectId/assistant",
        search: { sourceKind: undefined, sourceId: undefined, selection: undefined },
        params: { projectId },
      });
    } catch (e) {
      setError(errorText(e));
    }
  };
  const handoffCurrent = async () => {
    if (!snapshot || !sessionId) return;
    try {
      const result = await api<{ sessionId: string }>(
        endpoint(projectId, sessionId) + "/handoff",
        json("POST", {
          expectedRevision: snapshot.session.revision,
          remainingGoal,
          authorizeNewBudget: true,
        }),
      );
      setHandoffOpen(false);
      refreshList();
      void navigate({
        to: "/projects/$projectId/assistant/$sessionId",
        search: { sourceKind: undefined, sourceId: undefined, selection: undefined },
        params: { projectId, sessionId: result.sessionId },
      });
    } catch (e) {
      setError(errorText(e));
    }
  };
  const renameCurrent = async () => {
    if (!snapshot || !sessionId) return;
    const selected = sessionId;
    const busyToken = beginBusy();
    try {
      await api(
        endpoint(projectId, selected),
        json("PATCH", { title, expectedRevision: snapshot.session.revision }),
      );
      if (activeSession(selected)) {
        setRename(false);
        refreshList();
      }
    } catch (e) {
      if (activeSession(selected)) setError(errorText(e));
    } finally {
      if (activeSession(selected)) endBusy(busyToken);
    }
  };
  const inFlight =
    ["pending", "running", "waiting", "confirmation"].includes(snapshot?.execution?.status ?? "") ||
    snapshot?.session.status === "busy";
  const rendered = useMemo<ThreadMessageLike[]>(
    () => (snapshot ? visibleMessages(snapshot) : []),
    [snapshot],
  );
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: rendered,
    convertMessage: (m) => m,
    isRunning: inFlight,
    hasEarlier,
    onLoadEarlier: async () => {
      if (!sessionId || !snapshot) return;
      const before = snapshot.messages[0]?.id;
      if (!before) return;
      const historyRequestEpoch = historyEpoch.current;
      const older = await api<{ messages: Snapshot["messages"]; hasEarlier: boolean }>(
        endpoint(projectId, sessionId) + "/history?before=" + before,
      );
      if (!activeSession(sessionId) || historyRequestEpoch !== historyEpoch.current) return;
      loadedMessages.current = mergeMessages(loadedMessages.current, older.messages);
      rawSetSnapshot((old) =>
        old ? { ...old, messages: mergeMessages(old.messages, older.messages) } : old,
      );
      setHasEarlier(older.hasEarlier);
    },
    onNew: async () => {
      await send();
    },
    onCancel: async () => {
      await action("stop");
    },
  });
  const list = (
    <div className="formal-sessions">
      <div className="p-3">
        <Button className="w-full" variant="outline" disabled={busy} onClick={() => void create()}>
          <Plus className="size-4" />
          新会话
        </Button>
        <div className="relative mt-3">
          <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            aria-label="搜索会话"
            placeholder="搜索会话"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {sessions.map((s) => (
          <button
            key={s.id}
            aria-current={s.id === sessionId ? "page" : undefined}
            className={"formal-session " + (s.id === sessionId ? "selected" : "")}
            onClick={() => openSession(s.id)}
          >
            {s.title}
          </button>
        ))}
        {!sessions.length && (
          <p className="p-3 text-sm text-muted-foreground">
            {search ? "没有匹配会话" : "还没有会话"}
          </p>
        )}
      </div>
      <div className="flex justify-between border-t p-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={!offset}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          上一页
        </Button>
        <Button variant="ghost" size="sm" disabled={next === null} onClick={() => setOffset(next!)}>
          下一页
        </Button>
      </div>
    </div>
  );
  const tab = tabs.find((t) => t.id === active) ?? tabs.at(-1);
  const workspace = (
    <section className="formal-workspace">
      <div className="flex min-h-12 items-center gap-1 overflow-x-auto border-b px-2">
        {tabs.map((t) => (
          <div key={t.id} className={"formal-tab " + (t.id === tab?.id ? "selected" : "")}>
            <button onClick={() => setActive(t.id)} className="max-w-44 truncate">
              {t.name}
            </button>
            <button
              aria-label={"关闭 " + t.name}
              onClick={() => {
                const rest = tabs.filter((a) => a.id !== t.id);
                setTabs(rest);
                if (!rest.length) setWorkOpen(false);
              }}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto shrink-0"
          aria-label="收起工作区"
          onClick={() => setWorkOpen(false)}
        >
          <PanelRight className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {tab ? (
          <>
            <h2 className="mb-4 break-words font-semibold">{tab.name}</h2>
            {tab.content && <AssistantMarkdown text={tab.content} />}
            {tab.document && (
              <div className="space-y-4">
                <p className="text-xs text-muted-foreground">
                  背景文档 · 片段 {tab.document.offset + 1}–
                  {tab.document.offset + tab.document.fragments.length} / {tab.document.total}
                </p>
                {tab.document.fragments.map((fragment, index) => (
                  <section
                    key={`${tab.document!.offset}:${index}`}
                    className="space-y-2 border-b pb-4 last:border-0"
                  >
                    <p className="text-xs text-muted-foreground">
                      {fragment.page
                        ? `第 ${fragment.page} 页`
                        : fragment.startLine
                          ? `第 ${fragment.startLine}–${fragment.endLine ?? fragment.startLine} 行`
                          : `片段 ${tab.document!.offset + index + 1}`}
                    </p>
                    <AssistantMarkdown text={fragment.text} />
                  </section>
                ))}
                {tab.document.truncated && (
                  <p className="text-xs text-muted-foreground">
                    当前显示部分原文，未展示完整文档。
                  </p>
                )}
                <div className="flex justify-end gap-2">
                  <Button
                    aria-label="文档上一页"
                    variant="outline"
                    size="sm"
                    disabled={!tab.document.offset}
                    onClick={() => void document(tab.id, Math.max(0, tab.document!.offset - 5))}
                  >
                    上一页
                  </Button>
                  <Button
                    aria-label="文档下一页"
                    variant="outline"
                    size="sm"
                    disabled={tab.document.nextOffset === null}
                    onClick={() => void document(tab.id, tab.document!.nextOffset!)}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            )}
            {tab.rows && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="p-2">问题</th>
                      <th className="p-2">期望输出</th>
                      <th className="p-2">Metadata</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tab.rows.map((row) => (
                      <tr key={row.id} className="border-b align-top">
                        <td className="max-w-96 break-words p-2">{row.result.question}</td>
                        <td className="break-words p-2">{row.result.expectedOutput}</td>
                        <td className="p-2">
                          <dl>
                            {row.result.metadata.map((m, i) => (
                              <div key={i} className="mb-1 rounded border px-2 py-1">
                                <dt className="inline text-muted-foreground">{m.key}：</dt>
                                <dd className="inline break-words">{m.value}</dd>
                              </div>
                            ))}
                          </dl>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}{" "}
            {tab.href && (
              <a className="text-primary hover:underline" href={tab.href}>
                打开{tab.kind === "draft" ? "草稿" : "处理结果"}
                <ChevronRight className="inline size-4" />
              </a>
            )}
          </>
        ) : (
          <div>
            <p className="mb-4 text-sm text-muted-foreground">打开文档或处理结果后会显示在这里。</p>
            {snapshot?.workspace.attachments.map((a) => (
              <Button
                key={a.id}
                variant="ghost"
                className="mb-2 w-full justify-start"
                onClick={() => void document(a.id)}
              >
                <FileText className="size-4" />
                {a.name}
              </Button>
            ))}
            {snapshot?.results.map((r) => (
              <Button
                key={r.id}
                variant="ghost"
                className="w-full justify-start"
                onClick={() => void previewResult(r.run_id)}
              >
                查看处理结果
              </Button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
  return (
    <div className="formal-assistant">
      <div className="formal-toolbar">
        <Button
          size="icon"
          variant="ghost"
          aria-label="切换会话列表"
          onClick={() => {
            setListOpen(!listOpen);
            if (narrow) setWorkOpen(false);
          }}
        >
          <PanelLeft className="size-4" />
        </Button>
        <h1 className="truncate font-semibold">
          {snapshot?.session.title || sessions.find((s) => s.id === sessionId)?.title || "项目助手"}
        </h1>
        <span className="truncate text-xs text-muted-foreground" role="status">
          {snapshot
            ? (statusNames[snapshot.execution?.status ?? snapshot.session.status] ?? "请核对状态")
            : sessionId
              ? "正在读取"
              : ""}
        </span>
        <div className="ml-auto flex gap-1">
          {snapshot && (
            <Button variant="ghost" size="sm" onClick={() => setProgressOpen(true)}>
              查看进度
            </Button>
          )}
          {inFlight && (
            <Button
              variant="ghost"
              size="sm"
              disabled={readOnlyHistory}
              onClick={() => void action("stop")}
            >
              <Square className="size-3" />
              停止
            </Button>
          )}
          {(snapshot?.execution?.status === "paused" || snapshot?.canResumeCompleted) && (
            <Button
              variant="outline"
              size="sm"
              disabled={readOnlyHistory || busy || !canWrite}
              onClick={() => void action("continue")}
            >
              {snapshot?.canResumeCompleted ? "继续完成保存" : "继续"}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="会话选项">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={!snapshot}
                onSelect={() => {
                  setTitle(snapshot?.session.title ?? "");
                  setRename(true);
                }}
              >
                重命名会话
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!snapshot} onSelect={() => setDeleteOpen(true)}>
                删除会话
              </DropdownMenuItem>
              {readOnlyHistory && !snapshot?.contentInvalidated && (
                <DropdownMenuItem
                  onSelect={() => {
                    setRemainingGoal("");
                    setHandoffOpen(true);
                  }}
                >
                  在新会话承接
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="icon"
            variant="ghost"
            aria-label="切换工作区"
            aria-expanded={workOpen}
            onClick={() => {
              setWorkOpen(!workOpen);
              if (narrow) setListOpen(false);
            }}
          >
            <PanelRight className="size-4" />
          </Button>
        </div>
      </div>
      {snapshot?.contentInvalidated && (
        <p className="px-4 text-sm text-muted-foreground" role="status">
          相关内容已清理，旧任务不能继续；已独立保存的成果和累计用量保留。
        </p>
      )}
      {readOnlyHistory && !snapshot?.contentInvalidated && (
        <p className="px-4 text-sm text-muted-foreground">
          历史会话 · {snapshot?.session.runtime_version} ·
          仅供查看和管理，继续未完成目标请在新会话承接。
        </p>
      )}
      {!!snapshot?.history?.budget && (
        <details className="px-4 text-sm text-muted-foreground">
          <summary>历史累计用量</summary>
          <pre>{JSON.stringify(snapshot.history.budget, null, 2)}</pre>
        </details>
      )}
      <div className="formal-body">
        {!narrow && listOpen && <aside className="formal-history">{list}</aside>}
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel minSize="35%">
            <section className="formal-chat">
              <AssistantRuntimeProvider runtime={runtime}>
                <ThreadPrimitive.Root className="formal-thread">
                  <div
                    className="formal-messages"
                    ref={viewport}
                    onScroll={(e) => {
                      const el = e.currentTarget;
                      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
                      if (sessionId) scrolls.current.set(sessionId, el.scrollTop);
                      if (atBottom.current) setNewContent(false);
                    }}
                  >
                    {!sessionId ? (
                      <div className="formal-empty">
                        <h2 className="text-xl font-semibold">今天想处理什么数据？</h2>
                        <p className="mt-3 text-sm text-muted-foreground">
                          在当前项目中新建会话，描述你的需求。
                        </p>
                        <Button className="mt-5" disabled={busy} onClick={() => void create()}>
                          <Plus className="size-4" />
                          新会话
                        </Button>
                      </div>
                    ) : (
                      <>
                        {hasEarlier && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void runtime.thread.loadEarlier()}
                          >
                            加载更早消息
                          </Button>
                        )}
                        <ThreadPrimitive.Messages components={{ Message }} />
                        {snapshot && (
                          <div className="formal-message">
                            {snapshot.session.requirements.deliveries.length > 0 && (
                              <details className="mb-4">
                                <summary className="cursor-pointer text-sm text-muted-foreground">
                                  已记录的当前要求
                                </summary>
                                <div className="mt-2 space-y-2">
                                  {snapshot.session.requirements.deliveries.map((d, i) => (
                                    <div
                                      key={String(d["id"] ?? i)}
                                      className="rounded-md border p-3 text-sm"
                                    >
                                      <p>
                                        {String(
                                          d["name"] ??
                                            (d["saveTarget"] as { name?: string })?.name ??
                                            "测试集",
                                        )}{" "}
                                        · {String(d["count"] ?? "待确认")} 条 ·{" "}
                                        {(
                                          {
                                            clean: "清洗",
                                            rewrite: "改写",
                                            augment: "扩充",
                                            generate: "生成",
                                          } as Record<string, string>
                                        )[String(d["operation"])] ?? "待确认操作"}
                                      </p>
                                      <p className="mt-1 text-xs text-muted-foreground">
                                        {d["executionSummary"] ? (
                                          <span>{String(d["executionSummary"])} · </span>
                                        ) : null}
                                        {d["status"] === "cancelled"
                                          ? "已取消"
                                          : snapshot.session.requirements.mode === "plan"
                                            ? "仅方案，尚未执行"
                                            : snapshot.executionReadiness?.ready
                                              ? "要求完整，可执行"
                                              : "要求待补充"}{" "}
                                        · {String(d["instructions"] ?? "")}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              </details>
                            )}
                            <details>
                              <summary className="cursor-pointer text-sm text-muted-foreground">
                                执行过程 · {snapshot.workspace.process.length} 项
                              </summary>
                              <div className="mt-3 space-y-2">
                                {snapshot.workspace.process.map((p) => (
                                  <div className="rounded-md border px-3 py-2 text-sm" key={p.id}>
                                    {(p.kind === "parameter_feedback"
                                      ? "正在自动纠正参数"
                                      : p.kind === "correction_rejected"
                                        ? "参数纠正未通过"
                                        : toolNames[p.name ?? ""]) ??
                                      (
                                        {
                                          requirements_saved: "保存当前要求",
                                          parameter_feedback: "正在自动纠正参数",
                                          execution_paused: "任务暂停",
                                          execution_error: "本轮未完成",
                                        } as Record<string, string>
                                      )[p.kind] ??
                                      "执行记录"}{" "}
                                    ·{" "}
                                    {[
                                      "tool_error",
                                      "correction_rejected",
                                      "execution_error",
                                    ].includes(p.kind)
                                      ? "未完成"
                                      : p.kind === "tool_call"
                                        ? "已调用"
                                        : p.kind === "tool_result"
                                          ? "已完成"
                                          : p.kind === "parameter_feedback"
                                            ? "要求尚未保存"
                                            : "已记录"}
                                  </div>
                                ))}
                              </div>
                            </details>
                            {snapshot.execution?.reason && (
                              <p className="mt-3 text-sm text-muted-foreground">
                                {reasonNames[snapshot.execution.reason] ??
                                  (snapshot.execution.status === "paused"
                                    ? "任务已暂停，已有输入和进度已保留，请核对后继续。"
                                    : "本轮未完成，输入和已有进度已保留。请核对当前要求后重试。")}
                              </p>
                            )}
                            {snapshot.execution?.status === "paused" &&
                              snapshot.execution.reason === "task_budget_exhausted" &&
                              !snapshot.confirmations.some(
                                (c) =>
                                  c.action === "budget" &&
                                  c.status === "pending" &&
                                  new Date(c.expires_at).getTime() > Date.now(),
                              ) && (
                                <Button
                                  variant="outline"
                                  className="mt-3"
                                  disabled={busy || !canWrite || readOnlyHistory}
                                  onClick={() => void offerBudget()}
                                >
                                  申请追加额度
                                </Button>
                              )}
                            {snapshot.confirmations
                              .filter(
                                (c) =>
                                  c.action === "budget" &&
                                  c.status === "pending" &&
                                  snapshot.execution?.status === "paused",
                              )
                              .map((c) => (
                                <div key={c.id} className="mt-4 rounded-xl border bg-card p-4">
                                  <h2 className="font-semibold">确认追加任务额度</h2>
                                  <p className="my-3 text-sm text-muted-foreground">
                                    已用 {snapshot.execution?.requests} /{" "}
                                    {snapshot.execution?.request_limit} 次请求；本次追加{" "}
                                    {Number(c.payload["requests"])} 次请求、
                                    {Number(c.payload["activeMs"]) / 1000}{" "}
                                    秒运行时间。确认后可继续原任务。
                                  </p>
                                  <Button
                                    disabled={
                                      busy ||
                                      !canWrite ||
                                      readOnlyHistory ||
                                      new Date(c.expires_at).getTime() <= Date.now()
                                    }
                                    onClick={() => void confirm(c.id, true)}
                                  >
                                    确认追加
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    disabled={busy || readOnlyHistory}
                                    onClick={() => void confirm(c.id, false)}
                                  >
                                    取消
                                  </Button>
                                </div>
                              ))}
                            {snapshot.receipts
                              .filter((r) => r.grantId)
                              .map((r) => (
                                <p key={r.grantId} className="mt-3 text-sm text-muted-foreground">
                                  已追加 {r.addedRequests} 次请求、{Number(r.addedActiveMs) / 1000}{" "}
                                  秒运行时间 · 服务端已确认
                                </p>
                              ))}
                            {snapshot.confirmations
                              .filter(
                                (c) =>
                                  c.action === "adopt" &&
                                  c.status === "pending" &&
                                  snapshot.execution?.status === "confirmation",
                              )
                              .map((c) => (
                                <div key={c.id} className="mt-4 rounded-xl border bg-card p-4">
                                  <h2 className="font-semibold">确认保存处理结果</h2>
                                  <p className="my-3 text-sm text-muted-foreground">
                                    {String(
                                      (c.payload["input"] as { target?: { name?: string } })?.target
                                        ?.name ?? "测试集草稿",
                                    )}{" "}
                                    · 仅保存当前确认卡中的结果。
                                  </p>
                                  {typeof c.payload["runId"] === "string" && (
                                    <Button
                                      variant="outline"
                                      className="mr-2"
                                      onClick={() =>
                                        void previewResult(c.payload["runId"] as string)
                                      }
                                    >
                                      预览结果
                                    </Button>
                                  )}
                                  <Button
                                    disabled={
                                      readOnlyHistory ||
                                      !canWrite ||
                                      busy ||
                                      new Date(c.expires_at).getTime() <= Date.now()
                                    }
                                    onClick={() => void confirm(c.id, true)}
                                  >
                                    确认保存
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    disabled={readOnlyHistory || busy}
                                    onClick={() => void confirm(c.id, false)}
                                  >
                                    取消
                                  </Button>
                                </div>
                              ))}
                            {snapshot.receipts
                              .filter((r) => r.acceptanceId)
                              .map((r) => (
                                <div
                                  key={r.acceptanceId}
                                  className="mt-4 rounded-xl border bg-card p-4"
                                >
                                  <h2 className="font-semibold">已保存 · {r.fileName}</h2>
                                  <p className="my-2 text-sm text-muted-foreground">
                                    {r.adopted} 条 · 服务端已确认
                                    {r.isCurrent ? "" : " · 历史保存记录"}
                                  </p>
                                  {r.draftId && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() =>
                                        showTab({
                                          id: r.draftId!,
                                          kind: "draft",
                                          name: r.fileName ?? "测试集草稿",
                                          href:
                                            "/projects/" +
                                            projectId +
                                            "/test-sets/drafts/" +
                                            r.draftId,
                                        })
                                      }
                                    >
                                      查看草稿
                                    </Button>
                                  )}
                                  {r.assetId && canExport && (
                                    <a
                                      className="ml-3 text-sm text-primary hover:underline"
                                      href={
                                        "/api/projects/" +
                                        encodeURIComponent(projectId) +
                                        "/assets/" +
                                        encodeURIComponent(r.assetId) +
                                        "/download?view=raw"
                                      }
                                    >
                                      下载处理文件
                                    </a>
                                  )}
                                </div>
                              ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </ThreadPrimitive.Root>
              </AssistantRuntimeProvider>
              {newContent && (
                <Button
                  className="formal-new"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (viewport.current)
                      viewport.current.scrollTop = viewport.current.scrollHeight;
                    atBottom.current = true;
                    setNewContent(false);
                  }}
                >
                  <ArrowDown className="size-3" />
                  查看新内容
                </Button>
              )}
              {sessionId && (
                <div className="formal-compose">
                  {!connected && snapshot && (
                    <p className="mb-2 text-xs text-muted-foreground">
                      连接中断，正在重连。后台任务保持原状态。
                    </p>
                  )}
                  {selectionMissing && (
                    <p role="alert" className="mb-2 text-sm text-destructive">
                      所选记录范围已失效，请返回来源重新选择。
                    </p>
                  )}
                  {historyFailed && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <span>部分历史消息未加载。</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => sessionId && void fillHistory(sessionId)}
                      >
                        重试加载
                      </Button>
                    </div>
                  )}
                  {error && (
                    <p role="alert" className="mb-2 text-sm text-destructive">
                      {error}
                    </p>
                  )}
                  {conflict && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mb-2"
                      onClick={() => void refreshCurrent()}
                    >
                      核对最新状态并重新提交
                    </Button>
                  )}
                  {readOnlyHistory && (
                    <p className="mb-2 text-sm text-muted-foreground">
                      旧会话只读保留；请点“新会话”继续，原成果与预算不变。
                    </p>
                  )}
                  <div className="formal-composer">
                    {!nativeSource &&
                      pageContext &&
                      "inputSelection" in pageContext &&
                      pageContext.inputSelection && (
                        <p className="mb-2 text-xs text-muted-foreground">
                          页面已选 {pageContext.inputSelection.recordIds.length} 条记录
                        </p>
                      )}
                    {snapshot?.workspace.nativeActions?.map((a) => (
                      <div key={a.id} className="mb-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={
                            readOnlyHistory || busy || (a.kind !== "navigation" && !canWrite)
                          }
                          onClick={() => {
                            if (a.kind === "navigation") {
                              if (a.href?.startsWith("/projects/") && !a.href.startsWith("//"))
                                window.location.assign(a.href);
                            } else setMaterialAction(a);
                          }}
                        >
                          {a.name ??
                            (a.kind === "upload"
                              ? "选择上传文件"
                              : a.kind === "mapping"
                                ? "整理文件字段"
                                : "打开页面")}
                        </Button>
                      </div>
                    ))}
                    {nativeSource && (
                      <div className="mb-3 rounded-md border bg-muted/30 p-3 text-sm">
                        <div className="flex items-start gap-2">
                          <p className="min-w-0 flex-1 break-words">
                            本条消息的资料：{nativeSource.names.join("、")}
                          </p>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-6"
                            aria-label="移除本条消息的资料"
                            disabled={busy || !!pending}
                            onClick={() => {
                              setNativeSource(null);
                              sessionStorage.removeItem(draftKey + ":materials");
                            }}
                          >
                            <X className="size-3" />
                          </Button>
                        </div>
                        {nativeSource.unmapped.map((a) => (
                          <Button
                            key={a.id}
                            variant="link"
                            size="sm"
                            disabled={busy || readOnlyHistory}
                            onClick={() =>
                              setMaterialAction({
                                id: a.id,
                                kind: "mapping",
                                assetId: a.id,
                                collectionId: a.collectionId,
                                name: a.fileName,
                              })
                            }
                          >
                            整理 {a.fileName} 的字段
                          </Button>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {snapshot?.workspace.attachments.map((a) => (
                        <div key={a.id} className="formal-attachment">
                          <button onClick={() => void document(a.id)}>
                            <FileText className="inline size-3" /> {a.name}
                          </button>
                          {attachmentIds.includes(a.id) && (
                            <button
                              disabled={readOnlyHistory || busy || !!pending}
                              aria-label={"移除 " + a.name}
                              onClick={() => void removeAttachment(a.id)}
                            >
                              <X className="size-3" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    <Textarea
                      ref={input}
                      disabled={readOnlyHistory}
                      aria-label="描述你的需求"
                      placeholder="描述你想处理的数据和要求…"
                      value={draft}
                      onChange={(e) => saveDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                          e.preventDefault();
                          void send();
                        }
                      }}
                      className="min-h-24 resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
                    />
                    <div className="flex items-center gap-2">
                      <input
                        ref={file}
                        className="hidden"
                        type="file"
                        accept=".txt,.md,.pdf"
                        multiple
                        onChange={(e) => void upload(e.target.files)}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        disabled={!canWrite || readOnlyHistory || busy || !!pending}
                        aria-label="添加背景文档"
                        onClick={() => file.current?.click()}
                      >
                        <Paperclip className="size-4" />
                      </Button>
                      <span className="text-xs text-muted-foreground">Ctrl / ⌘ + Enter</span>
                      {canWrite && (
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="上传原始数据"
                          disabled={readOnlyHistory || busy || !!pending}
                          onClick={() =>
                            setMaterialAction({ id: "upload-" + Date.now(), kind: "upload" })
                          }
                        >
                          <FileUp className="size-4" />
                        </Button>
                      )}
                      <Button
                        className="ml-auto"
                        aria-label={pending ? "重试原提交" : "发送"}
                        disabled={
                          readOnlyHistory ||
                          busy ||
                          !draft.trim() ||
                          selectionMissing ||
                          inFlight ||
                          conflict
                        }
                        onClick={() => void send()}
                      >
                        <Send className="size-4" />
                        {pending ? "重试提交" : "发送"}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </section>
          </ResizablePanel>
          {!narrow && workOpen && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize="38%" minSize="25%">
                {workspace}
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
      <Sheet open={narrow && listOpen} onOpenChange={setListOpen}>
        <SheetContent side="left" className="w-72 p-0 pt-10">
          <SheetTitle className="sr-only">会话列表</SheetTitle>
          {list}
        </SheetContent>
      </Sheet>
      <Sheet open={narrow && workOpen} onOpenChange={setWorkOpen}>
        <SheetContent side="right" className="w-full p-0 pt-10 sm:max-w-xl">
          <SheetTitle className="sr-only">工作区</SheetTitle>
          {workspace}
        </SheetContent>
      </Sheet>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除会话</DialogTitle>
          </DialogHeader>
          <p>会话消息、背景文档和检查点将清理。已独立保存的成果及累计用量保留。</p>
          <Button variant="outline" onClick={() => setDeleteOpen(false)}>
            取消
          </Button>
          <Button variant="destructive" onClick={() => void deleteCurrent()}>
            确认删除会话
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog open={handoffOpen} onOpenChange={setHandoffOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>在新会话承接</DialogTitle>
          </DialogHeader>
          <p>
            请先核对已有成果，仅填写尚未完成的目标。新会话使用独立的默认任务额度，旧用量、余额和确认不转移；此操作不会运行模型或重做成果。
          </p>
          <Textarea
            aria-label="尚未完成的目标"
            value={remainingGoal}
            onChange={(e) => setRemainingGoal(e.target.value)}
          />
          <Button variant="outline" onClick={() => setHandoffOpen(false)}>
            取消
          </Button>
          <Button disabled={!remainingGoal.trim()} onClick={() => void handoffCurrent()}>
            确认新授权并承接
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog open={rename} onOpenChange={setRename}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
          </DialogHeader>
          <Input
            aria-label="会话名称"
            maxLength={80}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Button disabled={!title.trim() || busy} onClick={() => void renameCurrent()}>
            保存名称
          </Button>
        </DialogContent>
      </Dialog>
      <AssistantMaterialBridge
        projectId={projectId}
        canWrite={canWrite && !readOnlyHistory}
        action={materialAction}
        onClose={() => setMaterialAction(null)}
        onUploaded={(source, names, unmapped) => {
          if (!activeSession(sessionId)) return;
          const mappedId = materialAction?.kind === "mapping" ? materialAction.assetId : undefined;
          const next =
            mappedId &&
            nativeSource?.source.kind === "assets" &&
            nativeSource.source.assetIds.includes(mappedId)
              ? {
                  ...nativeSource,
                  unmapped: nativeSource.unmapped.filter((item) => item.id !== mappedId),
                }
              : { source, names, unmapped };
          setNativeSource(next);
          sessionStorage.setItem(draftKey + ":materials", JSON.stringify(next));
          setMaterialAction(null);
        }}
      />
      <Dialog open={progressOpen} onOpenChange={setProgressOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>当前进度</DialogTitle>
          </DialogHeader>
          <p>{statusNames[snapshot?.execution?.status ?? "idle"] ?? "请核对状态"}</p>
          <p className="text-sm text-muted-foreground">
            {snapshot?.execution?.status === "paused"
              ? "当前任务保持暂停，查看进度不会自动继续。"
              : "以下状态来自服务端。"}
          </p>
          {snapshot?.results.map((r) => (
            <p key={r.id}>
              处理结果：{r.output_count} 条 ·{" "}
              {r.status === "succeeded" ? "已完成" : r.status === "cancelled" ? "已停止" : "处理中"}
            </p>
          ))}
          <p className="text-sm">
            保存状态：
            {snapshot?.receipts.some((r) => r.isCurrent && r.acceptanceId)
              ? "服务端已确认保存"
              : "本次尚未保存"}
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
