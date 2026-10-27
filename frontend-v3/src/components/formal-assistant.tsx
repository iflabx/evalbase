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
  type Snapshot,
  type SessionItem,
  type Envelope,
  type Source,
  type WorkspaceTab,
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
  update_requirements: "保存要求",
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
  task_budget_exhausted: "任务额度已用完，请核对后申请追加。",
  model_request_timeout: "模型响应超时，已有进度已保留。",
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
  canConfigureModels,
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
    [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [connected, setConnected] = useState(false),
    [busy, setBusy] = useState(false),
    [rename, setRename] = useState(false),
    [title, setTitle] = useState(""),
    [progressOpen, setProgressOpen] = useState(false),
    [earlier, setEarlier] = useState<Snapshot["messages"]>([]),
    [hasEarlier, setHasEarlier] = useState(false);
  useEffect(() => {
    if (narrow && workOpen) setListOpen(false);
  }, [narrow, workOpen]);
  useEffect(() => {
    if (narrow) setListOpen(false);
  }, [narrow]);
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
    setConflict(false);
    setRename(false);
    setProgressOpen(false);
    setNewContent(false);
    busyOwner.current++;
    setBusy(false);
    setError("");
    setSnapshot(null);
    setEarlier([]);
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
      if (s.messages.length === 100) setHasEarlier(true);
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
    if (!pageContext) return;
    const ids = "inputSelection" in pageContext ? pageContext.inputSelection?.recordIds : undefined;
    return pageContext.kind === "asset"
      ? { kind: "assets", assetIds: [pageContext.id], ...(ids ? { recordIds: ids } : {}) }
      : pageContext.kind === "draft" || pageContext.kind === "version"
        ? { kind: pageContext.kind, id: pageContext.id, ...(ids ? { recordIds: ids } : {}) }
        : undefined;
  }, [pageContext]);
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
          pageContext && "inputSelection" in pageContext
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
      if (activeSession(selected)) {
        const text = acceptedDraft(draftRef.current, envelope);
        setPending(null);
        setAttachmentIds([]);
        setDraft(text);
        sessionStorage.setItem(
          key,
          JSON.stringify({ draft: text, pending: null, attachments: [] }),
        );
        void refreshList();
      }
    } catch (e) {
      if (
        activeSession(selected) &&
        !latestSnapshot.current?.turns.some((t) => t.submission_id === envelope.submissionId)
      ) {
        setError(errorText(e));
        setConflict(
          [400, 403, 404, 409, 413, 415, 422].includes((e as { status?: number }).status ?? 0),
        );
      }
    } finally {
      if (activeSession(selected)) endBusy(busyToken);
    }
  };
  const action = async (action: "stop" | "continue") => {
    if (!sessionId) return;
    const selected = sessionId;
    const busyToken = beginBusy();
    try {
      const s = await api<Snapshot>(
        endpoint(projectId, selected) + "/control",
        json("POST", { action }),
      );
      if (activeSession(selected)) setSnapshot(s);
    } catch (e) {
      if (activeSession(selected)) setError(errorText(e));
    } finally {
      if (activeSession(selected)) endBusy(busyToken);
    }
  };
  const showTab = (tab: WorkspaceTab) => {
    setTabs((old) => openTab(old, tab));
    setActive(tab.id);
    setWorkOpen(true);
    if (narrow) setListOpen(false);
  };
  const document = async (id: string) => {
    if (!sessionId) return;
    const selected = sessionId;
    try {
      const d = await api<{
        id: string;
        name: string;
        extracted: { fragments: { text: string }[] };
      }>(endpoint(projectId, selected) + "/attachments/" + encodeURIComponent(id));
      if (activeSession(selected))
        showTab({
          id: d.id,
          name: d.name,
          kind: "document",
          content: d.extracted.fragments.map((f) => f.text).join("\n\n"),
        });
    } catch (e) {
      if (activeSession(selected)) setError(errorText(e));
    }
  };
  const upload = async (files: FileList | null) => {
    if (!files || !sessionId) return;
    const selected = sessionId;
    const busyToken = beginBusy();
    try {
      for (const f of files) {
        if (!activeSession(selected)) break;
        if (f.size > 10 * 1024 * 1024) throw Error("attachment_capacity");
        const contentBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
          reader.onerror = reject;
          reader.readAsDataURL(f);
        });
        const a = await api<{ id: string; name: string }>(
          endpoint(projectId, selected) + "/attachments",
          json("POST", { fileName: f.name, contentBase64 }),
        );
        if (activeSession(selected))
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
      if (activeSession(selected)) setSnapshot(updated);
    } catch (e) {
      if (activeSession(selected)) setError(errorText(e));
    } finally {
      if (activeSession(selected)) {
        if (file.current) file.current.value = "";
        endBusy(busyToken);
      }
    }
  };
  const removeAttachment = async (id: string) => {
    if (!sessionId) return;
    const selected = sessionId;
    try {
      await api(endpoint(projectId, sessionId) + "/attachments/" + encodeURIComponent(id), {
        method: "DELETE",
      });
      if (!activeSession(selected)) return;
      const ids = attachmentIds.filter((a) => a !== id);
      setAttachmentIds(ids);
      saveDraft(draftRef.current, pending, ids);
      setTabs((old) => old.filter((t) => t.id !== id));
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
    setConflict(false);
    setError("");
    sessionStorage.setItem(
      draftKey,
      JSON.stringify({ draft: text, pending: null, attachments: [] }),
    );
  }, [snapshot, pending, draftKey]);
  const previewResult = async (runId: string) => {
    if (!sessionId) return;
    const selected = sessionId;
    try {
      const data = await api<{ records: NonNullable<WorkspaceTab["rows"]>; total: number }>(
        endpoint(projectId, selected) + "/results/" + encodeURIComponent(runId),
      );
      if (activeSession(selected))
        showTab({
          id: runId,
          kind: "result",
          name: "处理结果 · " + data.total + " 条",
          rows: data.records,
          href: "/projects/" + projectId + "/processing?run=" + runId,
        });
    } catch (e) {
      if (activeSession(selected)) setError(errorText(e));
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
    () => (snapshot ? visibleMessages(snapshot, earlier) : []),
    [snapshot, earlier],
  );
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: rendered,
    convertMessage: (m) => m,
    isRunning: inFlight,
    hasEarlier,
    onLoadEarlier: async () => {
      if (!sessionId || !snapshot) return;
      const before = earlier[0]?.id ?? snapshot.messages[0]?.id;
      if (!before) return;
      const older = await api<{ messages: Snapshot["messages"]; hasEarlier: boolean }>(
        endpoint(projectId, sessionId) + "/history?before=" + before,
      );
      if (!activeSession(sessionId)) return;
      setEarlier((old) => [...older.messages, ...old]);
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
            <Button variant="ghost" size="sm" onClick={() => void action("stop")}>
              <Square className="size-3" />
              停止
            </Button>
          )}
          {snapshot?.execution?.status === "paused" && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void action("continue")}
            >
              继续
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
                                        {d["status"] === "cancelled"
                                          ? "已取消"
                                          : snapshot.session.requirements.mode === "plan"
                                            ? "仅方案，尚未执行"
                                            : "按当前要求执行"}{" "}
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
                                    {toolNames[p.name ?? ""] ??
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
                                    {p.kind === "tool_error"
                                      ? "未完成"
                                      : p.kind === "tool_call"
                                        ? "已调用"
                                        : p.kind === "tool_result"
                                          ? "已完成"
                                          : "已记录"}
                                  </div>
                                ))}
                              </div>
                            </details>
                            {snapshot.execution?.reason && (
                              <p className="mt-3 text-sm text-muted-foreground">
                                {reasonNames[snapshot.execution.reason] ??
                                  "任务已暂停，已有输入和进度已保留，请核对后继续。"}
                              </p>
                            )}
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
                                    disabled={busy}
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
                  <div className="formal-composer">
                    <div className="flex flex-wrap gap-2">
                      {snapshot?.workspace.attachments.map((a) => (
                        <div key={a.id} className="formal-attachment">
                          <button onClick={() => void document(a.id)}>
                            <FileText className="inline size-3" /> {a.name}
                          </button>
                          {attachmentIds.includes(a.id) && (
                            <button
                              disabled={busy || !!pending}
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
                        disabled={busy || !!pending}
                        aria-label="添加背景文档"
                        onClick={() => file.current?.click()}
                      >
                        <Paperclip className="size-4" />
                      </Button>
                      <span className="text-xs text-muted-foreground">Ctrl / ⌘ + Enter</span>
                      <Button
                        className="ml-auto"
                        aria-label={pending ? "重试原提交" : "发送"}
                        disabled={busy || !draft.trim() || selectionMissing || inFlight || conflict}
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
