import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
import { PageHeader, StateView } from "@/components/state-view";
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
  const [name, setName] = useState<string>();
  const [purpose, setPurpose] = useState<string>();
  const [edit, setEdit] = useState<{
    question: string;
    expectedOutput: string;
    metadata: MetadataEntry[];
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving" | "failed">("saved");
  const [fileSearch, setFileSearch] = useState("");
  const [filePage, setFilePage] = useState(0);
  const [fileId, setFileId] = useState<string>();
  const [sourceSearch, setSourceSearch] = useState("");
  const [sourcePage, setSourcePage] = useState(0);
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
  const selected = data?.records.find((record) => record.id === selectedId);
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
    enabled: tab === "sources",
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
    }
  }, [data, name]);
  const lastSelectedId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!selected) {
      lastSelectedId.current = undefined;
      return;
    }
    if (selected.id !== lastSelectedId.current) {
      lastSelectedId.current = selected.id;
      setEdit({
        question: selected.question,
        expectedOutput: selected.expectedOutput,
        metadata: selected.metadata.length
          ? selected.metadata.map((entry) => ({ ...entry }))
          : [{ key: "", value: "" }],
      });
    }
  }, [selected]);
  const dirty = Boolean(
    data &&
    ((name ?? data.draft.name) !== data.draft.name ||
      (purpose ?? data.draft.purpose) !== data.draft.purpose ||
      (selected &&
        edit &&
        (edit.question !== selected.question ||
          edit.expectedOutput !== selected.expectedOutput ||
          JSON.stringify(edit.metadata.filter((entry) => entry.key.trim() || entry.value)) !==
            JSON.stringify(selected.metadata)))),
  );
  useEffect(() => {
    if (dirty) setSaveState("dirty");
  }, [dirty]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    if (recordFilterInput === recordSearch) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        if (dirty && !(await save())) return;
        setRecordSearch(recordFilterInput);
        setRecordPage(0);
      })();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [recordFilterInput, recordSearch, dirty]);
  async function refresh() {
    const result = await draftQuery.refetch();
    if (selectedId) {
      const fresh = result.data?.records.find((record) => record.id === selectedId);
      if (fresh)
        setEdit({
          question: fresh.question,
          expectedOutput: fresh.expectedOutput,
          metadata: fresh.metadata.length
            ? fresh.metadata.map((entry) => ({ ...entry }))
            : [{ key: "", value: "" }],
        });
    }
    await queryClient.invalidateQueries({ queryKey: ["shared-drafts", projectId] });
    return result.data;
  }
  async function save(): Promise<boolean> {
    if (!data || busy || conflict) return false;
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
      if ((name ?? data.draft.name) !== data.draft.name)
        await saveSharedDraftField(projectId, draftId, "name", name ?? "", data.draft.nameRevision);
      if ((purpose ?? data.draft.purpose) !== data.draft.purpose)
        await saveSharedDraftField(
          projectId,
          draftId,
          "purpose",
          purpose ?? "",
          data.draft.purposeRevision,
        );
      if (selected && edit) {
        if (edit.question !== selected.question)
          await saveSharedDraftRecordField(
            projectId,
            draftId,
            selected.id,
            "question",
            edit.question,
            selected.questionRevision,
          );
        if (edit.expectedOutput !== selected.expectedOutput)
          await saveSharedDraftRecordField(
            projectId,
            draftId,
            selected.id,
            "expectedOutput",
            edit.expectedOutput,
            selected.expectedOutputRevision,
          );
        if (JSON.stringify(metadata) !== JSON.stringify(selected.metadata))
          await saveSharedDraftRecordField(
            projectId,
            draftId,
            selected.id,
            "metadata",
            metadata,
            selected.metadataRevision,
          );
      }
      await refresh();
      setSaveState("saved");
      return true;
    } catch (cause) {
      await draftQuery.refetch().catch(() => undefined);
      const code = cause instanceof Error ? cause.message : "";
      const collided = code === "draft_field_conflict" || code === "draft_row_conflict";
      setConflict(collided);
      setError(
        collided
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
      const result = await publishSharedDraft(projectId, draftId, latest.draft.revision);
      await queryClient.invalidateQueries({ queryKey: ["solo-test-sets", projectId] });
      await navigate({
        to: "/projects/$projectId/test-sets/$testSetId",
        params: { projectId, testSetId: result.testSet.id },
        search: { version: result.version.id },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发布失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  async function discard() {
    if (!window.confirm("删除当前草稿？未发布的修改无法恢复；已发布版本不受影响。")) return;
    setBusy(true);
    try {
      await discardSharedDraft(projectId, draftId);
      await queryClient.invalidateQueries({ queryKey: ["shared-drafts", projectId] });
      toast.success("草稿已删除。");
      await navigate({ to: "/projects/$projectId/test-sets", params: { projectId } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  async function selectRecord(record: SharedDraftRecord) {
    if (dirty && !(await save())) return;
    setSelectedId(record.id);
    setEdit({
      question: record.question,
      expectedOutput: record.expectedOutput,
      metadata: record.metadata.length
        ? record.metadata.map((entry) => ({ ...entry }))
        : [{ key: "", value: "" }],
    });
  }
  async function addRecord() {
    if (dirty && !(await save())) return;
    setBusy(true);
    try {
      const created = await addSharedDraftRecord(projectId, draftId);
      setRecordFilterInput("");
      setRecordSearch("");
      setRecordPage(Math.floor((data?.total ?? 0) / 20));
      await queryClient.invalidateQueries({ queryKey: ["shared-draft", projectId, draftId] });
      setSelectedId(created.record.id);
      setEdit({ question: "", expectedOutput: "", metadata: [{ key: "", value: "" }] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "新增记录失败。");
    } finally {
      setBusy(false);
    }
  }
  async function removeRecord() {
    if (!selected || !window.confirm("从当前草稿移除这条记录？")) return;
    setBusy(true);
    try {
      await removeSharedDraftRecord(projectId, draftId, selected.id, selected.rowRevision);
      setSelectedId(undefined);
      setEdit(undefined);
      await refresh();
    } catch (cause) {
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
    if (dirty && !(await save())) return;
    setRecordPage(page);
  }
  async function changeTab(next: "records" | "sources") {
    if (dirty && !(await save())) return;
    setTab(next);
  }
  const canEdit = access.canWrite && data?.draft.status === "editing" && !data.draft.suspended;
  const pager = (total: number, page: number, setPage: (value: number) => void, size: number) => (
    <div className="flex items-center justify-end gap-2 border-t px-4 py-3 text-sm text-muted-foreground">
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
  return (
    <main className="mx-auto max-w-7xl pb-12">
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
                  ? `基于父版本创建 · 最近由 ${draft.updatedByName} 于 ${new Date(draft.updatedAt).toLocaleString("zh-CN")} 保存`
                  : `最近由 ${draft.updatedByName} 于 ${new Date(draft.updatedAt).toLocaleString("zh-CN")} 保存`
              }
              actions={
                <>
                  <Button variant="outline" disabled={busy} onClick={() => void exit()}>
                    保存并退出
                  </Button>
                  <Button variant="outline" disabled={busy || !canEdit} onClick={() => void save()}>
                    保存草稿
                  </Button>
                  <Button
                    variant="outline"
                    className="text-destructive"
                    disabled={busy || !canEdit}
                    onClick={() => void discard()}
                  >
                    <Trash2 className="size-4" />
                    删除当前草稿
                  </Button>
                  <Button disabled={busy || !canEdit} onClick={() => void publish()}>
                    {draft.parentVersionId ? "创建新版本" : "创建 v1"}
                  </Button>
                </>
              }
            />
            <div className="mb-4 flex items-center gap-2 text-sm">
              <Badge variant="outline">
                {draft.suspended
                  ? "已暂停"
                  : saveState === "saving"
                    ? "保存中"
                    : saveState === "failed"
                      ? "保存失败"
                      : dirty
                        ? "未保存修改"
                        : "已保存"}
              </Badge>
              {draft.suspended && (
                <span className="text-muted-foreground">恢复父对象后可继续编辑。</span>
              )}
            </div>
            {error && (
              <div
                role="alert"
                className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              >
                <p>{error} 输入内容仍保留在页面上。</p>
                {conflict && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setConflict(false);
                        setError("已选择保留本地输入。请点击“保存草稿”再次提交。");
                      }}
                    >
                      保留本地输入
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setName(draft.name);
                        setPurpose(draft.purpose);
                        if (selected)
                          setEdit({
                            question: selected.question,
                            expectedOutput: selected.expectedOutput,
                            metadata: selected.metadata.length
                              ? selected.metadata.map((entry) => ({ ...entry }))
                              : [{ key: "", value: "" }],
                          });
                        setConflict(false);
                        setError("");
                        setSaveState("saved");
                      }}
                    >
                      加载服务器内容
                    </Button>
                  </div>
                )}
              </div>
            )}
            <Card className="mb-4">
              <CardContent className="grid gap-4 pt-5 md:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="draft-name">测试集名称</Label>
                  <Input
                    id="draft-name"
                    value={name ?? draft.name}
                    disabled={!canEdit}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="填写测试集名称"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="draft-purpose">用途</Label>
                  <Input
                    id="draft-purpose"
                    value={purpose ?? draft.purpose}
                    disabled={!canEdit}
                    onChange={(event) => setPurpose(event.target.value)}
                    placeholder="选填"
                  />
                </div>
              </CardContent>
            </Card>
            <div className="mb-4 flex gap-2">
              <Button
                variant={tab === "records" ? "default" : "outline"}
                onClick={() => void changeTab("records")}
              >
                草稿记录
              </Button>
              <Button
                variant={tab === "sources" ? "default" : "outline"}
                onClick={() => void changeTab("sources")}
              >
                添加资料
              </Button>
            </div>
            {tab === "records" ? (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(340px,1fr)]">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between">
                    <div>
                      <CardTitle>草稿记录</CardTitle>
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
                    <div className="flex items-center gap-2 border-t px-4 py-3">
                      <Search className="size-4 text-muted-foreground" />
                      <Input
                        aria-label="搜索草稿记录"
                        placeholder="搜索问题、输出或来源"
                        value={recordFilterInput}
                        onChange={(event) => setRecordFilterInput(event.target.value)}
                      />
                      <span className="shrink-0 text-xs text-muted-foreground">每页 20 条</span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[650px] text-sm">
                        <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                          <tr>
                            <th className="px-4 py-2">序号</th>
                            <th className="px-4 py-2">问题 / 最近修改</th>
                            <th className="px-4 py-2">预测输出</th>
                            <th className="px-4 py-2">来源</th>
                          </tr>
                        </thead>
                        <tbody>
                          {records.length ? (
                            records.map((record) => (
                              <tr
                                key={record.id}
                                tabIndex={0}
                                aria-selected={selectedId === record.id}
                                className={`cursor-pointer border-t hover:bg-accent/40 ${selectedId === record.id ? "bg-accent/50" : ""}`}
                                onClick={() => void selectRecord(record)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") void selectRecord(record);
                                }}
                              >
                                <td className="px-4 py-3">{record.position}</td>
                                <td className="max-w-[260px] px-4 py-3">
                                  <p className="truncate">{record.question || "未填写"}</p>
                                  <small className="text-muted-foreground">
                                    {new Date(record.updatedAt).toLocaleString("zh-CN")}
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
                <Card>
                  <CardHeader>
                    <CardTitle>编辑记录</CardTitle>
                    <p className="text-sm text-muted-foreground">
                      {selected
                        ? `${sourceLabel(selected)} · 第 ${selected.position} 条`
                        : "在左侧表格选择记录后，可在这里编辑长文本和 Metadata。"}
                    </p>
                  </CardHeader>
                  {selected && edit && (
                    <CardContent className="grid gap-5">
                      <div className="grid gap-2">
                        <Label htmlFor="draft-question">问题</Label>
                        <Textarea
                          id="draft-question"
                          rows={5}
                          disabled={!canEdit}
                          value={edit.question}
                          onChange={(event) => setEdit({ ...edit, question: event.target.value })}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="draft-answer">预测输出</Label>
                        <Textarea
                          id="draft-answer"
                          rows={5}
                          disabled={!canEdit}
                          value={edit.expectedOutput}
                          onChange={(event) =>
                            setEdit({ ...edit, expectedOutput: event.target.value })
                          }
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label>Metadata</Label>
                        <div className="grid grid-cols-[1fr_1fr_2rem] gap-2 text-xs text-muted-foreground">
                          <span>字段名</span>
                          <span>值</span>
                          <span />
                        </div>
                        {edit.metadata.map((entry, index) => (
                          <div key={index} className="grid grid-cols-[1fr_1fr_2rem] gap-2">
                            <Input
                              aria-label={`第 ${index + 1} 项 Metadata 字段名`}
                              placeholder="例如：渠道"
                              disabled={!canEdit}
                              value={entry.key}
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
                              disabled={!canEdit}
                              value={entry.value}
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
                              disabled={!canEdit}
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
                        {metadataProblem(edit.metadata) && (
                          <p role="alert" className="text-sm text-destructive">
                            {metadataProblem(edit.metadata)}
                          </p>
                        )}
                        <Button
                          variant="outline"
                          className="w-fit"
                          disabled={!canEdit}
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
                          disabled={!canEdit || busy}
                          onClick={() => void removeRecord()}
                        >
                          移除记录
                        </Button>
                      </div>
                    </CardContent>
                  )}
                </Card>
              </div>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
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
                        disabled={!canEdit}
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
                        disabled={!canEdit}
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
                        disabled={!canEdit}
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
                                  checked={(selectedSources.data ?? []).some(
                                    (source) => source.assetId === file.id,
                                  )}
                                  disabled={!canEdit}
                                  onCheckedChange={(checked) =>
                                    void chooseSources([file.id], checked ? "add" : "remove")
                                  }
                                />
                              </td>
                              <td className="px-4 py-3">{file.fileName}</td>
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
                <Card>
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
                                  disabled={!canEdit}
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
    </main>
  );
}
