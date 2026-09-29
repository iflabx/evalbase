import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useBlocker, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PageHeader, StateView } from "@/components/state-view";
import { OnlineAvatars } from "@/components/online-avatars";
import {
  draftEvents,
  heartbeat,
  projectPresence,
  setPresenceFocus,
  type OnlineUser,
} from "@/services/collaboration";
import { mergeRecordSnapshot, type FieldConflict, type RecordField } from "@/services/merge-draft";
import { useProjectAccess } from "@/hooks/use-project-access";
import {
  addSharedDraftRecord,
  discardSharedDraft,
  getSharedDraft,
  listDraftSourceFiles,
  listDraftSourceRecords,
  listSelectedDraftSources,
  publishSharedDraft,
  removeSharedDraftRecord,
  saveSharedDraftField,
  saveSharedDraftRecordField,
  selectDraftSources,
  type SharedDraftRecord,
} from "@/services/drafts";
import type { MetadataEntry } from "@/services/workspace";
import "@/draft-workspace.css";

export const Route = createFileRoute("/projects/$projectId/test-sets/drafts/$draftId")({
  component: DraftWorkspaceRoute,
});
function DraftWorkspaceRoute() {
  const { projectId, draftId } = Route.useParams();
  return <DraftWorkspace key={`${projectId}:${draftId}`} />;
}
const keyOf = (assetId: string, ordinal: number) => `${assetId}:${ordinal}`;
const sourceLabel = (record: SharedDraftRecord) =>
  record.source
    ? `${record.sourceFileName ?? "资料文件"} · 第 ${record.source.ordinal + 1} 条${record.caseId ? " · 继承自父版本" : ""}`
    : record.caseId
      ? "原版本手工新增 · 继承自父版本"
      : "手工新增 · 本草稿添加";
function metadataProblem(entries: MetadataEntry[]) {
  const values = entries.filter((entry) => entry.key.trim() || entry.value);
  if (values.some((entry) => !entry.key.trim())) return "请填写 Metadata 字段名。";
  const keys = values.map((entry) => entry.key.trim().toLocaleLowerCase());
  return new Set(keys).size === keys.length ? "" : "Metadata 字段名不能重复。";
}

function DraftWorkspace() {
  const { projectId, draftId } = Route.useParams();
  const access = useProjectAccess(projectId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"records" | "sources">("records");
  const [recordSearch, setRecordSearch] = useState("");
  const [recordFilterInput, setRecordFilterInput] = useState("");
  const [recordPage, setRecordPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedSnapshot, setSelectedSnapshot] = useState<SharedDraftRecord>();
  const [removedRecord, setRemovedRecord] = useState(false);
  const [name, setName] = useState<string>();
  const [purpose, setPurpose] = useState<string>();
  const [nameBaseline, setNameBaseline] = useState<{ value: string; revision: number }>();
  const [purposeBaseline, setPurposeBaseline] = useState<{ value: string; revision: number }>();
  const [edit, setEdit] = useState<{
    question: string;
    expectedOutput: string;
    metadata: MetadataEntry[];
  }>();
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<"draft" | "record" | null>(null);
  const editorPanelRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [fieldConflicts, setFieldConflicts] = useState<
    Partial<Record<RecordField | "name" | "purpose", FieldConflict>>
  >({});
  const [syncIssue, setSyncIssue] = useState("");
  const [accessLost, setAccessLost] = useState(false);
  const cursorRef = useRef<number | undefined>(undefined);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "failed">("saved");
  const [fileSearch, setFileSearch] = useState("");
  const [filePage, setFilePage] = useState(0);
  const [fileId, setFileId] = useState<string>();
  const [sourceSearch, setSourceSearch] = useState("");
  const [sourcePage, setSourcePage] = useState(0);
  const allowNavigation = useRef(false);
  const draftQuery = useQuery({
    queryKey: ["shared-draft", projectId, draftId, recordSearch, recordPage],
    queryFn: () =>
      getSharedDraft(projectId, draftId, {
        search: recordSearch,
        limit: 20,
        offset: recordPage * 20,
      }),
  });
  const data = draftQuery.data;
  const draftPresence = useQuery({
    queryKey: ["draft-presence", projectId, draftId],
    queryFn: () => projectPresence(projectId, draftId),
    enabled: data?.draft.status === "editing" && !accessLost,
    refetchInterval: 2000,
    retry: false,
  });
  const editingUsers = (recordId: string, field?: string): OnlineUser[] =>
    (draftPresence.data ?? []).filter(
      (user) => user.focus?.recordId === recordId && (!field || user.focus.field === field),
    );
  const focusField = (
    recordId: string | undefined,
    field: "question" | "expectedOutput" | "metadata" | "name" | "purpose",
  ) => {
    setPresenceFocus({ draftId, ...(recordId ? { recordId } : {}), field });
    void heartbeat(projectId).catch(() => undefined);
  };
  const clearFocus = () => {
    setPresenceFocus({ draftId });
    void heartbeat(projectId).catch(() => undefined);
  };
  useEffect(() => {
    if (!data?.draft.id) return;
    if (cursorRef.current === undefined) cursorRef.current = data.draft.revision;
    setPresenceFocus({ draftId });
    void heartbeat(projectId).catch(() => undefined);
    let closed = false;
    let running = false;
    const poll = async () => {
      if (closed || running || accessLost) return;
      if (!navigator.onLine) {
        setSyncIssue("连接已中断，输入暂存在当前页面。");
        return;
      }
      running = true;
      try {
        const response = await draftEvents(projectId, draftId, cursorRef.current ?? 0);
        if (closed) return;
        if (response.status !== "editing") {
          setConflict(true);
          setError(
            response.status === "published"
              ? "草稿已由其他成员发布。当前输入未提交，请从正式版本重新开始。"
              : "草稿已结束，当前输入未提交。",
          );
          setAccessLost(true);
          return;
        }
        if (response.events.length || response.needsSnapshot) {
          await draftQuery.refetch();
          await queryClient.invalidateQueries({
            queryKey: ["draft-selected-sources", projectId, draftId],
          });
        }
        cursorRef.current = response.cursor;
        setSyncIssue("");
      } catch (cause) {
        if (closed) return;
        if (
          cause instanceof Error &&
          (cause.message === "project_not_found" || cause.message === "draft_not_found")
        ) {
          setAccessLost(true);
          setError("项目权限或草稿状态已变更，无法继续编辑。当前输入仍保留在页面上。");
        } else setSyncIssue("实时同步中断，正在重连；输入暂存在当前页面。");
      } finally {
        running = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 1000);
    window.addEventListener("online", poll);
    return () => {
      closed = true;
      window.clearInterval(timer);
      window.removeEventListener("online", poll);
      setPresenceFocus({});
      void heartbeat(projectId).catch(() => undefined);
    };
  }, [projectId, draftId, data?.draft.id, recordSearch, recordPage, accessLost]);
  useEffect(() => {
    if (!data?.draft.id || accessLost) return;
    const syncWindowFocus = () => {
      const element = document.activeElement as HTMLElement | null;
      const field = !document.hidden ? element?.dataset["presenceField"] : undefined;
      const focus = field
        ? {
            draftId,
            field: field as "question" | "expectedOutput" | "metadata" | "name" | "purpose",
            ...(element?.dataset["presenceRecordId"]
              ? { recordId: element.dataset["presenceRecordId"] }
              : {}),
          }
        : { draftId };
      setPresenceFocus(focus);
      void heartbeat(projectId).catch(() => undefined);
    };
    const clearWindowFocus = () => {
      setPresenceFocus({ draftId });
      void heartbeat(projectId).catch(() => undefined);
    };
    window.addEventListener("blur", clearWindowFocus);
    window.addEventListener("focus", syncWindowFocus);
    document.addEventListener("visibilitychange", syncWindowFocus);
    return () => {
      window.removeEventListener("blur", clearWindowFocus);
      window.removeEventListener("focus", syncWindowFocus);
      document.removeEventListener("visibilitychange", syncWindowFocus);
    };
  }, [data?.draft.id, projectId, draftId, accessLost]);
  const unsavedRecordInput = Boolean(
    selectedSnapshot &&
    edit &&
    (edit.question !== selectedSnapshot.question ||
      edit.expectedOutput !== selectedSnapshot.expectedOutput ||
      JSON.stringify(edit.metadata.filter((entry) => entry.key.trim() || entry.value)) !==
        JSON.stringify(selectedSnapshot.metadata)),
  );
  const selected =
    data?.records.find((record) => record.id === selectedId) ??
    ((removedRecord || unsavedRecordInput) && selectedSnapshot?.id === selectedId
      ? selectedSnapshot
      : undefined);
  const selectedIndex = data?.records.findIndex((record) => record.id === selectedId) ?? -1;
  const selectedNumber =
    selected?.activeOrdinal ??
    (selectedIndex < 0 ? undefined : recordPage * 20 + selectedIndex + 1);
  const authorMarkup = (userId: string | null, at: string, unknown: string) => {
    const person = userId ? data?.authors?.[userId] : undefined;
    if (!person) return <span>{unknown}</span>;
    return (
      <span className="inline-flex items-center gap-1">
        <span
          aria-hidden="true"
          className="inline-grid size-[22px] place-items-center rounded-full text-[10px] font-semibold text-white"
          style={{ backgroundColor: person.avatarColor }}
        >
          {Array.from(person.name.trim())[0]?.toLocaleUpperCase() ?? "?"}
        </span>
        {person.name} · {new Date(at).toLocaleString("zh-CN")}
      </span>
    );
  };
  const fieldAuthor = (record: SharedDraftRecord, field: RecordField) => {
    const revision = {
      question: record.questionRevision,
      expectedOutput: record.expectedOutputRevision,
      metadata: record.metadataRevision,
    }[field];
    if (record.caseId && revision === 0) return <span>本草稿尚未修改</span>;
    const fact = record.fieldAttribution?.[field];
    return fact?.userId ? (
      authorMarkup(fact.userId, fact.at, "修改者未记录")
    ) : (
      <span>修改者未记录</span>
    );
  };
  const files = useQuery({
    queryKey: ["draft-files", projectId, fileSearch, filePage],
    queryFn: () =>
      listDraftSourceFiles(projectId, { search: fileSearch, limit: 10, offset: filePage * 10 }),
    enabled: tab === "sources",
  });
  const sourceRows = useQuery({
    queryKey: ["draft-source-records", projectId, fileId, sourceSearch, sourcePage],
    queryFn: () =>
      listDraftSourceRecords(projectId, fileId!, {
        search: sourceSearch,
        limit: 20,
        offset: sourcePage * 20,
      }),
    enabled: tab === "sources" && Boolean(fileId),
  });
  const selectedSources = useQuery({
    queryKey: ["draft-selected-sources", projectId, draftId],
    queryFn: () => listSelectedDraftSources(projectId, draftId),
    enabled: Boolean(data),
  });
  const sourceSet = useMemo(
    () =>
      new Set((selectedSources.data ?? []).map((source) => keyOf(source.assetId, source.ordinal))),
    [selectedSources.data],
  );
  useEffect(() => {
    if (data && name === undefined) {
      setName(data.draft.name);
      setPurpose(data.draft.purpose);
      setNameBaseline({ value: data.draft.name, revision: data.draft.nameRevision });
      setPurposeBaseline({ value: data.draft.purpose, revision: data.draft.purposeRevision });
    }
  }, [data, name]);
  const lastSelectedId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (removedRecord) return;
    if (!selected) {
      lastSelectedId.current = undefined;
      return;
    }
    if (selected.id !== lastSelectedId.current) {
      setSelectedSnapshot(selected);
      lastSelectedId.current = selected.id;
      setEdit({
        question: selected.question,
        expectedOutput: selected.expectedOutput,
        metadata: selected.metadata.length
          ? selected.metadata.map((entry) => ({ ...entry }))
          : [{ key: "", value: "" }],
      });
    }
  }, [selected, removedRecord]);
  useEffect(() => {
    if (!data) return;
    const nextConflicts: Partial<Record<RecordField | "name" | "purpose", FieldConflict>> = {};
    if (nameBaseline && name !== undefined && data.draft.nameRevision > nameBaseline.revision) {
      if (name === nameBaseline.value || name === data.draft.name) setName(data.draft.name);
      else
        nextConflicts.name = {
          local: name,
          remote: data.draft.name,
          authorId: data.draft.nameUpdatedBy ?? undefined,
          at: data.draft.updatedAt,
        };
      setNameBaseline({ value: data.draft.name, revision: data.draft.nameRevision });
    }
    if (
      purposeBaseline &&
      purpose !== undefined &&
      data.draft.purposeRevision > purposeBaseline.revision
    ) {
      if (purpose === purposeBaseline.value || purpose === data.draft.purpose)
        setPurpose(data.draft.purpose);
      else
        nextConflicts.purpose = {
          local: purpose,
          remote: data.draft.purpose,
          authorId: data.draft.purposeUpdatedBy ?? undefined,
          at: data.draft.updatedAt,
        };
      setPurposeBaseline({ value: data.draft.purpose, revision: data.draft.purposeRevision });
    }
    if (selectedSnapshot && edit) {
      const fresh = data.records.find((record) => record.id === selectedSnapshot.id);
      if (fresh && fresh.rowRevision > selectedSnapshot.rowRevision) {
        const merged = mergeRecordSnapshot(selectedSnapshot, edit, fresh);
        setSelectedSnapshot(fresh);
        setEdit(merged.edit);
        Object.assign(nextConflicts, merged.conflicts);
      }
    }
    if (Object.keys(nextConflicts).length) {
      setFieldConflicts((current) => ({ ...current, ...nextConflicts }));
      setConflict(true);
      setError("其他成员同时修改了相同字段。请逐项选择，当前输入已保留。");
    }
  }, [data, edit, name, nameBaseline, purpose, purposeBaseline, selectedSnapshot]);
  const dirty = Boolean(
    data &&
    (removedRecord ||
      (nameBaseline && name !== undefined && name !== nameBaseline.value) ||
      (purposeBaseline && purpose !== undefined && purpose !== purposeBaseline.value) ||
      unsavedRecordInput),
  );
  useEffect(() => {
    if (dirty) setSaveState("dirty");
  }, [dirty]);
  useBlocker({
    shouldBlockFn: () =>
      dirty &&
      !allowNavigation.current &&
      !window.confirm("草稿有未保存的修改。离开页面会丢失这些输入，确定离开吗？"),
    enableBeforeUnload: () => dirty && !allowNavigation.current,
    disabled: !dirty,
  });
  useEffect(() => {
    if (recordFilterInput === recordSearch) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        if (dirty && !conflict && !(await save())) return;
        setRecordSearch(recordFilterInput);
        setRecordPage(0);
      })();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [recordFilterInput, recordSearch, dirty]);
  async function refresh() {
    const result = await draftQuery.refetch();
    if (result.data) {
      setName(result.data.draft.name);
      setPurpose(result.data.draft.purpose);
      setNameBaseline({ value: result.data.draft.name, revision: result.data.draft.nameRevision });
      setPurposeBaseline({
        value: result.data.draft.purpose,
        revision: result.data.draft.purposeRevision,
      });
    }
    if (selectedId) {
      const fresh = result.data?.records.find((record) => record.id === selectedId);
      if (fresh) {
        setSelectedSnapshot(fresh);
        setEdit({
          question: fresh.question,
          expectedOutput: fresh.expectedOutput,
          metadata: fresh.metadata.length
            ? fresh.metadata.map((entry) => ({ ...entry }))
            : [{ key: "", value: "" }],
        });
      }
    }
    await queryClient.invalidateQueries({ queryKey: ["shared-drafts", projectId] });
    return result.data;
  }
  async function save(): Promise<boolean> {
    if (!data || busy || conflict || removedRecord || accessLost || syncIssue) return false;
    const metadata = edit?.metadata.filter((entry) => entry.key.trim() || entry.value) ?? [];
    const problem = metadataProblem(metadata);
    if (problem) {
      setError(problem);
      setSaveState("failed");
      return false;
    }
    setBusy(true);
    setSaveState("saving");
    setError("");
    try {
      if (nameBaseline && name !== undefined && name !== nameBaseline.value)
        await saveSharedDraftField(projectId, draftId, "name", name, nameBaseline.revision);
      if (purposeBaseline && purpose !== undefined && purpose !== purposeBaseline.value)
        await saveSharedDraftField(
          projectId,
          draftId,
          "purpose",
          purpose,
          purposeBaseline.revision,
        );
      if (selected && edit && selectedSnapshot?.id === selected.id) {
        if (edit.question !== selectedSnapshot.question)
          await saveSharedDraftRecordField(
            projectId,
            draftId,
            selected.id,
            "question",
            edit.question,
            selectedSnapshot.questionRevision,
          );
        if (edit.expectedOutput !== selectedSnapshot.expectedOutput)
          await saveSharedDraftRecordField(
            projectId,
            draftId,
            selected.id,
            "expectedOutput",
            edit.expectedOutput,
            selectedSnapshot.expectedOutputRevision,
          );
        if (JSON.stringify(metadata) !== JSON.stringify(selectedSnapshot.metadata))
          await saveSharedDraftRecordField(
            projectId,
            draftId,
            selected.id,
            "metadata",
            metadata,
            selectedSnapshot.metadataRevision,
          );
      }
      await refresh();
      setSaveState("saved");
      return true;
    } catch (cause) {
      await draftQuery.refetch().catch(() => undefined);
      const code = cause instanceof Error ? cause.message : "";
      const rowRemoved = code === "draft_record_removed";
      const collided =
        rowRemoved || code === "draft_field_conflict" || code === "draft_row_conflict";
      if (rowRemoved) {
        setSelectedSnapshot(selected);
        setRemovedRecord(true);
      }
      setConflict(collided);
      setError(
        rowRemoved
          ? "这条记录已被其他成员移除。可将当前输入保存为新记录，或放弃本地输入。"
          : collided
            ? "同一字段已被其他成员修改。请选择如何处理冲突。"
            : cause instanceof Error
              ? cause.message
              : "保存失败，请重试。",
      );
      setSaveState("failed");
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function exit() {
    if (!(await save())) return;
    allowNavigation.current = true;
    if (data?.draft.testSetId)
      await navigate({
        to: "/projects/$projectId/test-sets/$testSetId",
        params: { projectId, testSetId: data.draft.testSetId },
        search: { version: data.draft.parentVersionId ?? undefined },
      });
    else await navigate({ to: "/projects/$projectId/test-sets", params: { projectId } });
  }
  async function publish() {
    if (!(await save())) return;
    setBusy(true);
    setError("");
    try {
      const latest = await getSharedDraft(projectId, draftId, { limit: 1 });
      setPublishing(true);
      const result = await publishSharedDraft(projectId, draftId, latest.draft.revision);
      await queryClient.invalidateQueries({ queryKey: ["solo-test-sets", projectId] });
      allowNavigation.current = true;
      await navigate({
        to: "/projects/$projectId/test-sets/$testSetId",
        params: { projectId, testSetId: result.testSet.id },
        search: { version: result.version.id },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发布失败，请重试。");
    } finally {
      setPublishing(false);
      setBusy(false);
    }
  }
  async function discard() {
    setBusy(true);
    try {
      await discardSharedDraft(projectId, draftId);
      await queryClient.invalidateQueries({ queryKey: ["shared-drafts", projectId] });
      setConfirmTarget(null);
      toast.success("草稿已删除。");
      allowNavigation.current = true;
      await navigate({ to: "/projects/$projectId/test-sets", params: { projectId } });
    } catch (cause) {
      setConfirmTarget(null);
      setError(cause instanceof Error ? cause.message : "删除失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  async function selectRecord(record: SharedDraftRecord) {
    if (dirty && !(await save())) return;
    setSelectedId(record.id);
    setSelectedSnapshot(record);
    setRemovedRecord(false);
    setEdit({
      question: record.question,
      expectedOutput: record.expectedOutput,
      metadata: record.metadata.length
        ? record.metadata.map((entry) => ({ ...entry }))
        : [{ key: "", value: "" }],
    });
    if (window.innerWidth <= 1080)
      window.requestAnimationFrame(() =>
        editorPanelRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }),
      );
  }
  async function collapseRecord() {
    if (dirty && !(await save())) return;
    setSelectedId(undefined);
    setSelectedSnapshot(undefined);
    setEdit(undefined);
  }
  async function addRecord() {
    if (dirty && !(await save())) return;
    setBusy(true);
    try {
      const created = await addSharedDraftRecord(projectId, draftId);
      const unfiltered = await getSharedDraft(projectId, draftId, { limit: 1 });
      setRecordFilterInput("");
      setRecordSearch("");
      setRecordPage(Math.floor((unfiltered.total - 1) / 20));
      await queryClient.invalidateQueries({ queryKey: ["shared-draft", projectId, draftId] });
      setSelectedId(created.record.id);
      setSelectedSnapshot(created.record);
      setRemovedRecord(false);
      setEdit({ question: "", expectedOutput: "", metadata: [{ key: "", value: "" }] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "新增记录失败。");
    } finally {
      setBusy(false);
    }
  }
  async function recoverRemovedAsNew() {
    if (!edit || busy) return;
    const metadata = edit.metadata.filter((entry) => entry.key.trim() || entry.value);
    const problem = metadataProblem(metadata);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      const created = await addSharedDraftRecord(projectId, draftId, {
        question: edit.question,
        expectedOutput: edit.expectedOutput,
        metadata,
      });
      const unfiltered = await getSharedDraft(projectId, draftId, { limit: 1 });
      setRecordFilterInput("");
      setRecordSearch("");
      setRecordPage(Math.floor((unfiltered.total - 1) / 20));
      await queryClient.invalidateQueries({ queryKey: ["shared-draft", projectId, draftId] });
      setSelectedId(created.record.id);
      setSelectedSnapshot(created.record);
      setEdit({
        question: created.record.question,
        expectedOutput: created.record.expectedOutput,
        metadata: created.record.metadata.length
          ? created.record.metadata.map((entry) => ({ ...entry }))
          : [{ key: "", value: "" }],
      });
      setRemovedRecord(false);
      setConflict(false);
      setError("");
      setSaveState("saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复输入失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  async function removeRecord() {
    if (!selected) return;
    setBusy(true);
    try {
      await removeSharedDraftRecord(projectId, draftId, selected.id, selected.rowRevision);
      setConfirmTarget(null);
      setSelectedId(undefined);
      setSelectedSnapshot(undefined);
      setRemovedRecord(false);
      setEdit(undefined);
      await refresh();
    } catch (cause) {
      setConfirmTarget(null);
      setError(cause instanceof Error ? cause.message : "移除失败，请刷新后重试。");
    } finally {
      setBusy(false);
    }
  }
  async function chooseSources(
    assetIds: string[],
    mode: "add" | "remove",
    ordinals?: number[],
    search?: string,
  ) {
    if (!assetIds.length) return;
    if (dirty && !(await save())) return;
    setBusy(true);
    setError("");
    try {
      await selectDraftSources(projectId, draftId, {
        assetIds,
        mode,
        ...(search ? { search } : {}),
        ...(ordinals ? { ordinals } : {}),
      });
      await Promise.all([draftQuery.refetch(), selectedSources.refetch()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "选择资料失败。");
    } finally {
      setBusy(false);
    }
  }
  async function changeRecordPage(page: number) {
    if (dirty && !conflict && !(await save())) return;
    setRecordPage(page);
  }
  async function changeTab(next: "records" | "sources") {
    if (dirty && !(await save())) return;
    setTab(next);
  }
  function resolveFieldConflict(
    field: RecordField | "name" | "purpose",
    choice: "remote" | "local",
  ) {
    const item = fieldConflicts[field];
    if (!item) return;
    if (choice === "remote") {
      if (field === "name") setName(String(item.remote));
      else if (field === "purpose") setPurpose(String(item.remote));
      else if (field === "metadata")
        setEdit((current) =>
          current
            ? {
                ...current,
                metadata: (item.remote as MetadataEntry[]).map((entry) => ({ ...entry })),
              }
            : current,
        );
      else setEdit((current) => (current ? { ...current, [field]: String(item.remote) } : current));
    }
    const remaining = { ...fieldConflicts };
    delete remaining[field];
    setFieldConflicts(remaining);
    if (!Object.keys(remaining).length) {
      setConflict(false);
      setError(
        choice === "local"
          ? "已保留本地输入；再次保存会基于对方最新版本提交。"
          : "已采用对方输入。请核对后保存。",
      );
    }
  }
  function keepLocalConflict() {
    if (!data) return;
    const latestRecord = data.records.find((record) => record.id === selectedId);
    if (unsavedRecordInput && !latestRecord) {
      setError("记录已不在当前搜索结果。请保留本页输入并联系管理员，或清除筛选后重新选择。");
      return;
    }
    setName((current) => (current === nameBaseline?.value ? data.draft.name : current));
    setPurpose((current) => (current === purposeBaseline?.value ? data.draft.purpose : current));
    setNameBaseline({ value: data.draft.name, revision: data.draft.nameRevision });
    setPurposeBaseline({
      value: data.draft.purpose,
      revision: data.draft.purposeRevision,
    });
    if (latestRecord && selectedSnapshot?.id === latestRecord.id) {
      setEdit((current) => {
        if (!current) return current;
        const oldMetadata = JSON.stringify(
          current.metadata.filter((entry) => entry.key.trim() || entry.value),
        );
        return {
          question:
            current.question === selectedSnapshot.question
              ? latestRecord.question
              : current.question,
          expectedOutput:
            current.expectedOutput === selectedSnapshot.expectedOutput
              ? latestRecord.expectedOutput
              : current.expectedOutput,
          metadata:
            oldMetadata === JSON.stringify(selectedSnapshot.metadata)
              ? latestRecord.metadata.length
                ? latestRecord.metadata.map((entry) => ({ ...entry }))
                : [{ key: "", value: "" }]
              : current.metadata,
        };
      });
      setSelectedSnapshot(latestRecord);
    }
    setConflict(false);
    setError("已保留本地修改，请再次点击“保存草稿”提交。");
  }
  function loadServerConflict() {
    if (!data) return;
    setName(data.draft.name);
    setPurpose(data.draft.purpose);
    setNameBaseline({ value: data.draft.name, revision: data.draft.nameRevision });
    setPurposeBaseline({
      value: data.draft.purpose,
      revision: data.draft.purposeRevision,
    });
    const latestRecord = data.records.find((record) => record.id === selectedId);
    setSelectedId(latestRecord?.id);
    setSelectedSnapshot(latestRecord);
    setEdit(
      latestRecord
        ? {
            question: latestRecord.question,
            expectedOutput: latestRecord.expectedOutput,
            metadata: latestRecord.metadata.length
              ? latestRecord.metadata.map((entry) => ({ ...entry }))
              : [{ key: "", value: "" }],
          }
        : undefined,
    );
    setConflict(false);
    setError("");
    setSaveState("saved");
  }
  const canEdit =
    access.canWrite && !accessLost && data?.draft.status === "editing" && !data.draft.suspended;
  const pager = (total: number, page: number, setPage: (value: number) => void, size: number) => (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3 text-sm text-muted-foreground">
      <span>
        第 {page + 1} / {Math.max(1, Math.ceil(total / size))} 页 · 共 {total} 条
      </span>
      <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
        上一页
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={(page + 1) * size >= total}
        onClick={() => setPage(page + 1)}
      >
        下一页
      </Button>
    </div>
  );
  if (accessLost) {
    const localInputs = [
      nameBaseline && name !== undefined && name !== nameBaseline.value
        ? { label: "测试集名称", value: name }
        : null,
      purposeBaseline && purpose !== undefined && purpose !== purposeBaseline.value
        ? { label: "用途说明", value: purpose }
        : null,
      selectedSnapshot && edit && edit.question !== selectedSnapshot.question
        ? { label: "问题", value: edit.question }
        : null,
      selectedSnapshot && edit && edit.expectedOutput !== selectedSnapshot.expectedOutput
        ? { label: "期望输出", value: edit.expectedOutput }
        : null,
      selectedSnapshot &&
      edit &&
      JSON.stringify(edit.metadata) !== JSON.stringify(selectedSnapshot.metadata)
        ? { label: "Metadata", value: JSON.stringify(edit.metadata, null, 2) }
        : null,
    ].filter((item): item is { label: string; value: string } => item !== null);
    return (
      <main className="draft-workspace mx-auto w-full max-w-7xl pb-12">
        <PageHeader
          eyebrow="测试集草稿"
          title="草稿访问已结束"
          description={error || "项目权限或草稿状态已改变，无法继续查看与编辑。"}
        />
        <Card>
          <CardContent className="grid gap-4 p-5">
            <p className="text-sm text-muted-foreground">
              已停止同步，草稿正文不再显示。下方只列出本页面未提交的输入，供你复制留存。
            </p>
            {localInputs.length ? (
              localInputs.map((item) => (
                <div key={item.label} className="rounded-md border bg-background p-3">
                  <strong className="text-sm">{item.label} · 未提交</strong>
                  <pre className="mt-2 whitespace-pre-wrap break-words text-sm">{item.value}</pre>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">没有未提交的输入。</p>
            )}
            <Button
              variant="outline"
              className="w-fit"
              onClick={() => window.location.assign("/projects")}
            >
              返回项目列表
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }
  return (
    <main className="draft-workspace mx-auto w-full max-w-7xl pb-12">
      <StateView
        isLoading={draftQuery.isLoading}
        error={draftQuery.error}
        data={data}
        isEmpty={() => false}
        onRetry={() => void draftQuery.refetch()}
      >
        {({ draft, records, total }) => (
          <>
            <PageHeader
              eyebrow="测试集草稿"
              title={
                draft.testSetId ? `继续创建新版本 · ${draft.name}` : draft.name || "新建测试集草稿"
              }
              description={
                draft.parentVersionId
                  ? `基于 ${draft.parentVersionLabel ?? "父版本"} 创建草稿`
                  : "从资料中选择记录，也可以手动新增。"
              }
              actions={
                <div className="draft-page-actions">
                  <Button
                    variant="outline"
                    className="text-destructive"
                    disabled={busy || !canEdit}
                    onClick={() => setConfirmTarget("draft")}
                  >
                    <Trash2 className="size-4" />
                    删除当前草稿
                  </Button>
                  <Button variant="outline" disabled={busy || conflict} onClick={() => void exit()}>
                    保存并退出
                  </Button>
                  <Button disabled={busy || !canEdit || conflict} onClick={() => void publish()}>
                    {draft.parentVersionId ? "创建新版本" : "创建 v1"}
                  </Button>
                </div>
              }
            />
            <Card className="mb-5 min-w-0">
              <CardContent className="flex flex-wrap items-center justify-between gap-4 px-5 py-[18px]">
                <div className="min-w-0">
                  <strong className="text-sm font-semibold">
                    {draft.parentVersionId
                      ? `草稿基于 ${draft.parentVersionLabel ?? "父版本"} · 计划发布新版本`
                      : "测试集 v1 草稿"}
                  </strong>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {draft.testSetId ? "" : `创建者 ${draft.createdByName ?? "未记录"} · `}
                    最近由 {draft.updatedByName} 于{" "}
                    {new Date(draft.updatedAt).toLocaleString("zh-CN")} 保存
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {draft.suspended
                      ? "父版本或测试集已回收；恢复父对象后可继续编辑。"
                      : draft.parentVersionId
                        ? `已继承父版本${draft.parentRecordCount == null ? "" : ` ${draft.parentRecordCount} 条`}记录。编辑仅作用于草稿；发布后生成新版本。`
                        : "从资料中选择记录，也可以手动新增。发布后生成第一个版本。"}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Badge variant="outline" role="status">
                    {publishing
                      ? "发布中"
                      : draft.suspended
                        ? "已暂停"
                        : saveState === "saving"
                          ? "保存中"
                          : saveState === "failed"
                            ? "保存失败"
                            : dirty
                              ? "未保存修改"
                              : "已保存草稿"}
                  </Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !canEdit || conflict}
                    onClick={() => void save()}
                  >
                    {saveState === "failed" && !conflict ? "重试保存" : "保存草稿"}
                  </Button>
                </div>
              </CardContent>
              {syncIssue && (
                <p role="status" className="border-t px-5 py-3 text-sm text-amber-700">
                  {syncIssue}
                </p>
              )}
              {error && (
                <div
                  role="alert"
                  className="border-t border-destructive/30 bg-destructive/5 px-5 py-3 text-sm text-destructive"
                >
                  <p>{error} 输入内容仍保留在页面上。</p>
                  {Object.entries(fieldConflicts).map(
                    ([field, item]) =>
                      item && (
                        <div
                          key={field}
                          className="mt-3 rounded-md border border-destructive/20 bg-card p-3 text-foreground"
                        >
                          <strong className="text-sm">
                            {
                              {
                                name: "测试集名称",
                                purpose: "用途说明",
                                question: "问题",
                                expectedOutput: "期望输出",
                                metadata: "Metadata",
                              }[field as RecordField | "name" | "purpose"]
                            }
                            冲突
                          </strong>
                          <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">
                            对方当前输入（{data?.authors?.[item.authorId ?? ""]?.name ?? "其他成员"}
                            ）：
                            {typeof item.remote === "string"
                              ? item.remote
                              : JSON.stringify(item.remote)}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                            我的未保存输入：
                            {typeof item.local === "string"
                              ? item.local
                              : JSON.stringify(item.local)}
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                resolveFieldConflict(
                                  field as RecordField | "name" | "purpose",
                                  "remote",
                                )
                              }
                            >
                              采用对方输入
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                resolveFieldConflict(
                                  field as RecordField | "name" | "purpose",
                                  "local",
                                )
                              }
                            >
                              保留我的输入
                            </Button>
                          </div>
                        </div>
                      ),
                  )}
                  {conflict && removedRecord && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void recoverRemovedAsNew()}
                      >
                        作为新记录保留输入
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelectedId(undefined);
                          setSelectedSnapshot(undefined);
                          setEdit(undefined);
                          setRemovedRecord(false);
                          setConflict(false);
                          setError("");
                          setSaveState("saved");
                        }}
                      >
                        放弃本地输入
                      </Button>
                    </div>
                  )}
                  {conflict && !removedRecord && !Object.keys(fieldConflicts).length && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" onClick={keepLocalConflict}>
                        保留本地输入
                      </Button>
                      <Button variant="outline" size="sm" onClick={loadServerConflict}>
                        加载服务器内容
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </Card>
            {!draft.testSetId && (
              <Card className="mb-5 min-w-0">
                <CardContent className="draft-identity grid gap-5 p-5">
                  <div className="grid min-w-0 gap-2">
                    <Label htmlFor="draft-name">测试集名称</Label>
                    <Input
                      id="draft-name"
                      value={name ?? draft.name}
                      disabled={!canEdit || busy}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="例如：客服基础问答"
                      data-presence-field="name"
                      onFocus={() => focusField(undefined, "name")}
                      onBlur={clearFocus}
                    />
                  </div>
                  <div className="grid min-w-0 gap-2">
                    <Label htmlFor="draft-purpose">用途说明（可选）</Label>
                    <Textarea
                      id="draft-purpose"
                      rows={2}
                      className="min-h-10"
                      value={purpose ?? draft.purpose}
                      disabled={!canEdit || busy}
                      onChange={(event) => setPurpose(event.target.value)}
                      placeholder="简述测试集用途"
                      data-presence-field="purpose"
                      onFocus={() => focusField(undefined, "purpose")}
                      onBlur={clearFocus}
                    />
                  </div>
                </CardContent>
              </Card>
            )}
            <div role="tablist" aria-label="测试集草稿工作区" className="draft-tabs mb-5">
              <button
                id="draft-records-tab"
                type="button"
                role="tab"
                aria-controls="draft-workspace-panel"
                aria-selected={tab === "records"}
                className={tab === "records" ? "active" : ""}
                onClick={() => void changeTab("records")}
              >
                草稿记录 <span>{total}</span>
              </button>
              <button
                id="draft-sources-tab"
                type="button"
                role="tab"
                aria-controls="draft-workspace-panel"
                aria-selected={tab === "sources"}
                className={tab === "sources" ? "active" : ""}
                onClick={() => void changeTab("sources")}
              >
                添加资料{" "}
                <span>
                  {selectedSources.data
                    ? new Set(selectedSources.data.map((source) => source.assetId)).size
                    : "…"}
                </span>
              </button>
            </div>
            {tab === "records" ? (
              <div
                id="draft-workspace-panel"
                role="tabpanel"
                aria-labelledby="draft-records-tab"
                className="draft-record-layout"
              >
                <Card className="min-w-0">
                  <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0 px-5 py-[18px]">
                    <div>
                      <CardTitle className="text-[15px]">草稿记录</CardTitle>
                      <p className="mt-1 text-sm text-muted-foreground">
                        共 {total} 条 · 点击整行在右侧编辑
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      disabled={!canEdit || busy}
                      onClick={() => void addRecord()}
                    >
                      <Plus className="size-4" />
                      新增记录
                    </Button>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
                      <Search className="size-4 text-muted-foreground" />
                      <Input
                        aria-label="搜索草稿记录"
                        placeholder="搜索问题、输出或来源"
                        value={recordFilterInput}
                        onChange={(event) => setRecordFilterInput(event.target.value)}
                      />
                      <span className="shrink-0 text-xs text-muted-foreground">每页 20 条</span>
                    </div>
                    <div className="max-w-full overflow-x-auto">
                      <table className="w-full min-w-[660px] table-fixed text-sm">
                        <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                          <tr>
                            <th className="px-4 py-2">序号</th>
                            <th className="px-4 py-2">问题 / 最近修改</th>
                            <th className="px-4 py-2">期望输出</th>
                            <th className="px-4 py-2">来源</th>
                          </tr>
                        </thead>
                        <tbody>
                          {records.length ? (
                            records.map((record, index) => (
                              <tr
                                key={record.id}
                                tabIndex={0}
                                aria-selected={selectedId === record.id}
                                className={`cursor-pointer border-t hover:bg-accent/40 ${selectedId === record.id ? "bg-accent/50" : ""}`}
                                onClick={() => void selectRecord(record)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    void selectRecord(record);
                                  }
                                }}
                              >
                                <td className="px-4 py-3">
                                  <span className="inline-flex items-center gap-1">
                                    {record.activeOrdinal ?? recordPage * 20 + index + 1}
                                    <OnlineAvatars
                                      users={editingUsers(record.id)}
                                      small
                                      editingField="此记录"
                                    />
                                  </span>
                                </td>
                                <td className="max-w-[260px] px-4 py-3">
                                  <p className="truncate">{record.question || "未填写"}</p>
                                  <small className="text-muted-foreground">
                                    {record.caseId && record.rowRevision === 0
                                      ? "本草稿尚未修改"
                                      : authorMarkup(
                                          record.updatedBy,
                                          record.updatedAt,
                                          "修改者未记录",
                                        )}
                                  </small>
                                </td>
                                <td className="max-w-[220px] truncate px-4 py-3">
                                  {record.expectedOutput || "未填写"}
                                </td>
                                <td className="px-4 py-3 text-xs text-muted-foreground">
                                  {sourceLabel(record)}
                                </td>
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td
                                colSpan={4}
                                className="px-4 py-8 text-center text-muted-foreground"
                              >
                                {total
                                  ? "没有匹配的记录。"
                                  : "草稿还没有记录；可在“添加资料”中选择，或手动新增。"}
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    {pager(total, recordPage, (page) => void changeRecordPage(page), 20)}
                  </CardContent>
                </Card>
                <Card
                  ref={editorPanelRef}
                  className="draft-editor-panel min-w-0"
                  aria-label="记录编辑区"
                >
                  <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 px-5 py-[18px]">
                    <div className="min-w-0">
                      <CardTitle className="text-[15px]">
                        {selected ? "编辑记录" : "选择一条记录"}
                      </CardTitle>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {selected
                          ? `${sourceLabel(selected)}${selectedNumber ? ` · 第 ${selectedNumber} 条` : ""}`
                          : "在左侧表格选择记录后，可在这里编辑长文本和 Metadata。"}
                      </p>
                    </div>
                    {selected && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || conflict}
                        onClick={() => void collapseRecord()}
                      >
                        收起
                      </Button>
                    )}
                  </CardHeader>
                  {selected && edit && (
                    <CardContent className="grid gap-5 border-t p-5">
                      <div className="grid gap-2">
                        <div className="flex items-center gap-1">
                          <Label htmlFor="draft-question">问题</Label>
                          <OnlineAvatars
                            users={editingUsers(selected.id, "question")}
                            small
                            editingField="问题"
                          />
                        </div>
                        <Textarea
                          id="draft-question"
                          rows={5}
                          disabled={!canEdit || busy}
                          value={edit.question}
                          data-presence-field="question"
                          data-presence-record-id={selected.id}
                          onFocus={() => focusField(selected.id, "question")}
                          onBlur={clearFocus}
                          onChange={(event) => setEdit({ ...edit, question: event.target.value })}
                        />
                        <small className="text-xs text-muted-foreground">
                          最近修改：{fieldAuthor(selected, "question")}
                        </small>
                      </div>
                      <div className="grid gap-2">
                        <div className="flex items-center gap-1">
                          <Label htmlFor="draft-answer">期望输出</Label>
                          <OnlineAvatars
                            users={editingUsers(selected.id, "expectedOutput")}
                            small
                            editingField="期望输出"
                          />
                        </div>
                        <Textarea
                          id="draft-answer"
                          rows={5}
                          disabled={!canEdit || busy}
                          value={edit.expectedOutput}
                          data-presence-field="expectedOutput"
                          data-presence-record-id={selected.id}
                          onFocus={() => focusField(selected.id, "expectedOutput")}
                          onBlur={clearFocus}
                          onChange={(event) =>
                            setEdit({ ...edit, expectedOutput: event.target.value })
                          }
                        />
                        <small className="text-xs text-muted-foreground">
                          最近修改：{fieldAuthor(selected, "expectedOutput")}
                        </small>
                      </div>
                      <div className="grid gap-2">
                        <div className="flex items-center gap-1">
                          <Label>Metadata</Label>
                          <OnlineAvatars
                            users={editingUsers(selected.id, "metadata")}
                            small
                            editingField="Metadata"
                          />
                        </div>
                        <div className="draft-metadata-row gap-2 text-xs text-muted-foreground">
                          <span>字段名</span>
                          <span>值</span>
                          <span />
                        </div>
                        {edit.metadata.map((entry, index) => (
                          <div key={index} className="draft-metadata-row gap-2">
                            <Input
                              aria-label={`第 ${index + 1} 项 Metadata 字段名`}
                              placeholder="例如：渠道"
                              disabled={!canEdit || busy}
                              value={entry.key}
                              data-presence-field="metadata"
                              data-presence-record-id={selected.id}
                              onFocus={() => focusField(selected.id, "metadata")}
                              onBlur={clearFocus}
                              onChange={(event) =>
                                setEdit({
                                  ...edit,
                                  metadata: edit.metadata.map((item, i) =>
                                    i === index ? { ...item, key: event.target.value } : item,
                                  ),
                                })
                              }
                            />
                            <Input
                              aria-label={`第 ${index + 1} 项 Metadata 值`}
                              placeholder="例如：帮助中心"
                              disabled={!canEdit || busy}
                              value={entry.value}
                              data-presence-field="metadata"
                              data-presence-record-id={selected.id}
                              onFocus={() => focusField(selected.id, "metadata")}
                              onBlur={clearFocus}
                              onChange={(event) =>
                                setEdit({
                                  ...edit,
                                  metadata: edit.metadata.map((item, i) =>
                                    i === index ? { ...item, value: event.target.value } : item,
                                  ),
                                })
                              }
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`删除第 ${index + 1} 项 Metadata`}
                              disabled={!canEdit || busy}
                              onClick={() =>
                                setEdit({
                                  ...edit,
                                  metadata: edit.metadata.filter((_, i) => i !== index),
                                })
                              }
                            >
                              <X className="size-4" />
                            </Button>
                          </div>
                        ))}
                        <small className="text-xs text-muted-foreground">
                          最近修改：{fieldAuthor(selected, "metadata")}
                        </small>
                        {metadataProblem(edit.metadata) && (
                          <p role="alert" className="text-sm text-destructive">
                            {metadataProblem(edit.metadata)}
                          </p>
                        )}
                        <Button
                          variant="outline"
                          className="w-fit"
                          disabled={!canEdit || busy}
                          onClick={() =>
                            setEdit({
                              ...edit,
                              metadata: [...edit.metadata, { key: "", value: "" }],
                            })
                          }
                        >
                          <Plus className="size-4" />
                          添加字段
                        </Button>
                      </div>
                      <div className="flex justify-between border-t pt-4 text-xs text-muted-foreground">
                        <span>字段修改会保存到当前草稿。</span>
                        <Button
                          variant="ghost"
                          className="text-destructive"
                          disabled={!canEdit || busy || removedRecord}
                          onClick={() => setConfirmTarget("record")}
                        >
                          移除记录
                        </Button>
                      </div>
                    </CardContent>
                  )}
                </Card>
              </div>
            ) : (
              <div
                id="draft-workspace-panel"
                role="tabpanel"
                aria-labelledby="draft-sources-tab"
                className="draft-sources-layout"
              >
                <Card className="min-w-0">
                  <CardHeader>
                    <CardTitle>1. 选择资料文件</CardTitle>
                    <p className="text-sm text-muted-foreground">
                      已选{" "}
                      {new Set((selectedSources.data ?? []).map((source) => source.assetId)).size}{" "}
                      个文件。勾选文件时默认纳入其全部记录。
                    </p>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="border-t px-4 py-3">
                      <Input
                        aria-label="搜索资料文件"
                        placeholder="搜索数据集或文件"
                        value={fileSearch}
                        onChange={(event) => {
                          setFileSearch(event.target.value);
                          setFilePage(0);
                        }}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3 text-xs">
                      <span className="mr-auto text-muted-foreground">
                        当前搜索结果 {files.data?.total ?? 0} 个文件
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canEdit || busy}
                        onClick={() =>
                          void chooseSources(
                            (files.data?.files ?? []).map((file) => file.id),
                            "add",
                          )
                        }
                      >
                        选择本页
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canEdit || busy}
                        onClick={async () => {
                          const all = await listDraftSourceFiles(projectId, {
                            search: fileSearch,
                            limit: 100,
                          });
                          if (all.total > 5) {
                            setError("一个草稿最多选择 5 个资料文件，请缩小搜索范围。");
                            return;
                          }
                          await chooseSources(
                            all.files.map((file) => file.id),
                            "add",
                          );
                        }}
                      >
                        选择全部结果
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!canEdit || busy}
                        onClick={() =>
                          void chooseSources(
                            (files.data?.files ?? []).map((file) => file.id),
                            "remove",
                          )
                        }
                      >
                        取消本页
                      </Button>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[420px] text-sm">
                        <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                          <tr>
                            <th className="px-4 py-2"></th>
                            <th className="px-4 py-2">文件</th>
                            <th className="px-4 py-2">数据集</th>
                            <th className="px-4 py-2">记录数</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(files.data?.files ?? []).map((file) => (
                            <tr
                              key={file.id}
                              className={`cursor-pointer border-t hover:bg-accent/40 ${fileId === file.id ? "bg-accent/50" : ""}`}
                              onClick={() => {
                                setFileId(file.id);
                                setSourcePage(0);
                              }}
                            >
                              <td className="px-4 py-3">
                                <Checkbox
                                  aria-label={`选择 ${file.fileName}`}
                                  onClick={(event) => event.stopPropagation()}
                                  checked={(selectedSources.data ?? []).some(
                                    (source) => source.assetId === file.id,
                                  )}
                                  disabled={!canEdit || busy}
                                  onCheckedChange={(checked) => {
                                    setFileId(file.id);
                                    setSourcePage(0);
                                    void chooseSources([file.id], checked ? "add" : "remove");
                                  }}
                                />
                              </td>
                              <td className="px-4 py-3">
                                <button
                                  type="button"
                                  className="text-left hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                                  onClick={() => {
                                    setFileId(file.id);
                                    setSourcePage(0);
                                  }}
                                >
                                  {file.fileName}
                                </button>
                              </td>
                              <td className="px-4 py-3">{file.collectionName}</td>
                              <td className="px-4 py-3">{file.recordCount}</td>
                            </tr>
                          ))}
                          {!files.data?.files.length && (
                            <tr>
                              <td
                                colSpan={4}
                                className="px-4 py-8 text-center text-muted-foreground"
                              >
                                没有匹配的文件。
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    {pager(files.data?.total ?? 0, filePage, setFilePage, 10)}
                  </CardContent>
                </Card>
                <Card className="min-w-0">
                  <CardHeader>
                    <CardTitle>2. 选择记录</CardTitle>
                    <p className="text-sm text-muted-foreground">
                      已选 {selectedSources.data?.length ?? 0} 条资料记录；父版本记录会自动继承。
                    </p>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="border-t px-4 py-3">
                      <Input
                        aria-label="搜索资料记录"
                        placeholder="搜索问题、输出或文件"
                        value={sourceSearch}
                        onChange={(event) => {
                          setSourceSearch(event.target.value);
                          setSourcePage(0);
                        }}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3 text-xs">
                      <span className="mr-auto text-muted-foreground">
                        当前搜索结果 {sourceRows.data?.total ?? 0} 条
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canEdit || !fileId}
                        onClick={() =>
                          void chooseSources(
                            [fileId!],
                            "add",
                            sourceRows.data?.records.map((record) => record.ordinal) ?? [],
                          )
                        }
                      >
                        选择本页
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canEdit || !fileId}
                        onClick={() =>
                          void chooseSources([fileId!], "add", undefined, sourceSearch)
                        }
                      >
                        选择全部结果
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!canEdit || !fileId}
                        onClick={() =>
                          void chooseSources([fileId!], "remove", undefined, sourceSearch)
                        }
                      >
                        取消全部结果
                      </Button>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[420px] text-sm">
                        <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                          <tr>
                            <th className="px-4 py-2"></th>
                            <th className="px-4 py-2">问题</th>
                            <th className="px-4 py-2">文件</th>
                            <th className="px-4 py-2">序号</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(sourceRows.data?.records ?? []).map((record) => (
                            <tr key={keyOf(record.assetId, record.ordinal)} className="border-t">
                              <td className="px-4 py-3">
                                <Checkbox
                                  aria-label={`选择第 ${record.ordinal + 1} 条`}
                                  checked={sourceSet.has(keyOf(record.assetId, record.ordinal))}
                                  disabled={!canEdit || busy}
                                  onCheckedChange={(checked) =>
                                    void chooseSources(
                                      [record.assetId],
                                      checked ? "add" : "remove",
                                      [record.ordinal],
                                    )
                                  }
                                />
                              </td>
                              <td className="max-w-[240px] truncate px-4 py-3">
                                {record.question || "未填写"}
                              </td>
                              <td className="px-4 py-3">
                                {files.data?.files.find((file) => file.id === record.assetId)
                                  ?.fileName ?? "资料文件"}
                              </td>
                              <td className="px-4 py-3">{record.ordinal + 1}</td>
                            </tr>
                          ))}
                          {!sourceRows.data?.records.length && (
                            <tr>
                              <td
                                colSpan={4}
                                className="px-4 py-8 text-center text-muted-foreground"
                              >
                                {fileId ? "没有匹配的记录。" : "先选择资料文件。"}
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    {pager(sourceRows.data?.total ?? 0, sourcePage, setSourcePage, 20)}
                  </CardContent>
                </Card>
              </div>
            )}
          </>
        )}
      </StateView>
      <AlertDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => !open && !busy && setConfirmTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmTarget === "draft" ? "删除当前草稿" : "移除记录"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmTarget === "draft"
                ? "未发布的共享修改无法恢复；已发布版本不受影响。"
                : `从当前草稿移除${selectedNumber ? `第 ${selectedNumber} 条` : "所选"}记录。此行尚未保存的输入也会丢失。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy || (confirmTarget === "record" && !selected)}
              onClick={(event) => {
                event.preventDefault();
                if (confirmTarget === "draft") void discard();
                if (confirmTarget === "record") void removeRecord();
              }}
            >
              {busy ? "正在处理…" : confirmTarget === "draft" ? "删除草稿" : "移除记录"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
