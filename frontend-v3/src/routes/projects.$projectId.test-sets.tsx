import { useMemo, useState } from "react";
import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Plus, Search, Trash2 } from "lucide-react";
import { useProjectAccess } from "@/hooks/use-project-access";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MetadataEditor } from "@/components/metadata-editor";
import { MetadataSummary } from "@/components/material-record-table";
import { createRequestId } from "@/lib/request-id";
import { EmptyBlock, PageHeader, StateView } from "@/components/state-view";
import {
  createSoloTestSet,
  listTestSets,
  listTestSetSources,
  listSoloTestSetTrash,
  permanentlyDeleteSoloTestSetTrash,
  restoreSoloTestSetTrash,
  trashSoloTestSet,
  type TestSet,
  type TestSetRecord,
  type TestSetTrashEntry,
  type TestSetSource,
} from "@/services/workspace";
import { Pagination } from "@/routes/index";

const PAGE_SIZE = 10;
const CREATE_STEPS = ["选择资料", "选择记录", "编辑并创建 v1"];

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value.slice(0, 10);
  const today = new Date();
  const startOfDay = (day: Date) =>
    new Date(day.getFullYear(), day.getMonth(), day.getDate()).valueOf();
  const daysAgo = Math.round((startOfDay(today) - startOfDay(date)) / 86_400_000);
  const time = date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (daysAgo === 0) return `今天 ${time}`;
  if (daysAgo === 1) return `昨天 ${time}`;
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function SelectionSummary({
  datasets,
  files,
  records,
}: {
  datasets: number;
  files: number;
  records: number;
}) {
  return (
    <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
      已选择 {datasets} 个数据集 · {files} 个文件 · {records} 条记录
    </p>
  );
}

export const Route = createFileRoute("/projects/$projectId/test-sets")({
  component: TestSetsRoute,
});

function TestSetsRoute() {
  const { projectId } = Route.useParams();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return pathname === `/projects/${projectId}/test-sets` ? <TestSetsPage /> : <Outlet />;
}

function TestSetsPage() {
  const { projectId } = Route.useParams();
  const access = useProjectAccess(projectId);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashTarget, setTrashTarget] = useState<TestSet>();
  const [trashing, setTrashing] = useState(false);
  const queryClient = useQueryClient();
  const testSets = useQuery({
    queryKey: ["solo-test-sets", projectId, search, page],
    queryFn: () =>
      listTestSets(projectId, {
        name: search,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }),
  });
  const rows = testSets.data?.items ?? [];
  const total = testSets.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  async function moveToTrash() {
    if (!trashTarget) return;
    setTrashing(true);
    try {
      await trashSoloTestSet(projectId, trashTarget.id);
      await queryClient.invalidateQueries({ queryKey: ["solo-test-sets", projectId] });
      setTrashTarget(undefined);
      toast.success("已移入回收站。");
    } catch (error) {
      toast.error("操作失败", {
        description: error instanceof Error ? error.message : "请重试",
      });
    } finally {
      setTrashing(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="测试集"
        actions={
          <>
            {access.canManage && (
              <Button variant="outline" onClick={() => setTrashOpen(true)}>
                <Trash2 className="size-4" />
                回收站
              </Button>
            )}
            {access.canWrite && (
              <Button onClick={() => setCreating(true)}>
                <Plus className="size-4" />
                新建测试集
              </Button>
            )}
          </>
        }
      />
      <div className="relative mb-4 w-64">
        <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
        <Input
          aria-label="搜索测试集"
          placeholder="搜索测试集"
          className="pl-8"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
        />
      </div>
      <StateView
        isLoading={testSets.isLoading}
        error={testSets.error}
        data={rows}
        isEmpty={(items) => items.length === 0}
        onRetry={() => void testSets.refetch()}
        empty={
          <EmptyBlock
            title="还没有测试集"
            action={
              access.canWrite ? (
                <Button onClick={() => setCreating(true)}>新建测试集</Button>
              ) : undefined
            }
          />
        }
      >
        {(items) => (
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full min-w-[980px] text-sm">
                <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">名称</th>
                    <th className="px-4 py-2 font-medium">当前版本</th>
                    <th className="px-4 py-2 font-medium">记录数</th>
                    <th className="px-4 py-2 font-medium">来源</th>
                    <th className="px-4 py-2 font-medium">状态</th>
                    <th className="px-4 py-2 font-medium">更新时间</th>
                    <th className="px-4 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className="border-t border-border hover:bg-accent/40">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <FileText className="size-4 text-primary" />
                          <span className="font-medium">{item.name}</span>
                        </div>
                      </td>
                      <td className="mono px-4 py-3">{item.currentVersion}</td>
                      <td className="mono px-4 py-3">{item.recordCount}</td>
                      <td className="max-w-[340px] px-4 py-3 text-[13px] text-muted-foreground">
                        {item.source}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant="outline"
                          className="border-chart-2/30 bg-chart-2/10 text-chart-2"
                        >
                          {item.status}
                        </Badge>
                      </td>
                      <td className="mono px-4 py-3 text-muted-foreground">
                        {formatUpdatedAt(item.updatedAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="inline-flex gap-2">
                          <Button variant="outline" size="sm" asChild>
                            <Link
                              to="/projects/$projectId/test-sets/$testSetId"
                              params={{ projectId, testSetId: item.id }}
                              search={{ version: item.currentVersionId }}
                            >
                              查看
                            </Link>
                          </Button>
                          {access.canManage && (
                            <Button
                              variant="outline"
                              size="icon"
                              aria-label={`移入回收站：${item.name}`}
                              title="移入回收站"
                              onClick={() => setTrashTarget(item)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </StateView>
      {total > 0 && (
        <Pagination total={total} current={page} pages={pages} onChange={setPage} unit="个测试集" />
      )}
      {access.canWrite && (
        <CreateTestSetDialog open={creating} onOpenChange={setCreating} projectId={projectId} />
      )}
      {access.canManage && (
        <TrashDialog open={trashOpen} onOpenChange={setTrashOpen} projectId={projectId} />
      )}
      {access.canManage && (
        <AlertDialog
          open={Boolean(trashTarget)}
          onOpenChange={(open) => !open && setTrashTarget(undefined)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>移入回收站</AlertDialogTitle>
              <AlertDialogDescription>{trashTarget?.name}</AlertDialogDescription>
            </AlertDialogHeader>
            <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
              测试集会从正常列表隐藏；其中的版本和数据溯源都会保留在回收站中。数据集中的原始文件不会被删除。
            </p>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={trashing}>取消</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={trashing}
                onClick={(event) => {
                  event.preventDefault();
                  void moveToTrash();
                }}
              >
                {trashing ? "正在移入…" : "移入回收站"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

function TrashDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const [permanent, setPermanent] = useState<TestSetTrashEntry>();
  const [confirmation, setConfirmation] = useState("");
  const [workingEntryId, setWorkingEntryId] = useState<string>();
  const trash = useQuery({
    queryKey: ["solo-test-set-trash", projectId],
    queryFn: () => listSoloTestSetTrash(projectId, { limit: 100, offset: 0 }),
    enabled: open,
  });
  async function restore(entry: TestSetTrashEntry) {
    setWorkingEntryId(entry.id);
    try {
      await restoreSoloTestSetTrash(projectId, entry.id);
      await queryClient.invalidateQueries({ queryKey: ["solo-test-set-trash", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["solo-test-sets", projectId] });
      toast.success("已恢复。");
    } catch (error) {
      toast.error("恢复失败", { description: error instanceof Error ? error.message : "请重试" });
    } finally {
      setWorkingEntryId(undefined);
    }
  }
  async function permanentlyDelete() {
    if (!permanent) return;
    setWorkingEntryId(permanent.id);
    try {
      await permanentlyDeleteSoloTestSetTrash(projectId, permanent.id, confirmation);
      await queryClient.invalidateQueries({ queryKey: ["solo-test-set-trash", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["solo-test-sets", projectId] });
      setPermanent(undefined);
      setConfirmation("");
      toast.success("已永久删除。");
    } catch (error) {
      toast.error("永久删除失败", {
        description: error instanceof Error ? error.message : "请重试",
      });
    } finally {
      setWorkingEntryId(undefined);
    }
  }
  const testSetEntries = trash.data?.items.filter((entry) => entry.type === "test_set") ?? [];
  const versionEntries = trash.data?.items.filter((entry) => entry.type === "version_branch") ?? [];
  const renderEntries = (entries: TestSetTrashEntry[], emptyLabel: string) =>
    entries.length ? (
      <div className="divide-y rounded-md border">
        {entries.map((entry) => (
          <div key={entry.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="font-medium">
                {entry.testSetName}
                {entry.rootVersionLabel ? ` · ${entry.rootVersionLabel}` : ""}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {entry.type === "test_set"
                  ? `整个测试集 · ${entry.versionCount} 个版本`
                  : entry.versionCount === 1
                    ? "单个末端版本"
                    : `版本分支 · 含 ${entry.versionCount} 个版本`}
                {" · 移入时间 "}
                {entry.trashedAt.slice(0, 16).replace("T", " ")}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={entry.pendingCleanup || Boolean(workingEntryId)}
                onClick={() => void restore(entry)}
              >
                {workingEntryId === entry.id ? "正在恢复…" : "恢复"}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={Boolean(workingEntryId)}
                onClick={() => setPermanent(entry)}
              >
                永久删除
              </Button>
            </div>
          </div>
        ))}
      </div>
    ) : (
      <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
        没有移入回收站的{emptyLabel}。
      </p>
    );
  const expectedConfirmation =
    permanent?.type === "test_set" ? permanent.testSetName : (permanent?.rootVersionLabel ?? "");
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>回收站</DialogTitle>
            <DialogDescription>
              这里的测试集或末端版本可以恢复；永久删除后无法恢复。
            </DialogDescription>
          </DialogHeader>
          {trash.isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">正在加载…</p>
          ) : trash.error ? (
            <p className="py-8 text-center text-sm text-destructive">无法加载回收站。</p>
          ) : (
            <div className="space-y-5">
              <section>
                <div className="mb-2 flex items-baseline justify-between">
                  <strong className="text-sm">测试集</strong>
                  <span className="text-xs text-muted-foreground">整套版本和来源会一起恢复</span>
                </div>
                {renderEntries(testSetEntries, "测试集")}
              </section>
              <section>
                <div className="mb-2 flex items-baseline justify-between">
                  <strong className="text-sm">版本与版本分支</strong>
                  <span className="text-xs text-muted-foreground">仅恢复到原测试集</span>
                </div>
                {renderEntries(versionEntries, "版本或版本分支")}
              </section>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={Boolean(permanent)}
        onOpenChange={(next) => {
          if (!next) {
            setPermanent(undefined);
            setConfirmation("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>永久删除</AlertDialogTitle>
            <AlertDialogDescription>
              将永久删除{permanent?.type === "test_set" ? "测试集“" : "版本或版本分支“"}
              {expectedConfirmation}”。此操作无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="permanent-confirmation">
              请输入 <strong>{expectedConfirmation}</strong> 以确认
            </Label>
            <Input
              id="permanent-confirmation"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(workingEntryId)}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={confirmation !== expectedConfirmation || Boolean(workingEntryId)}
              onClick={(event) => {
                event.preventDefault();
                void permanentlyDelete();
              }}
            >
              {workingEntryId ? "正在删除…" : "永久删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function CreateTestSetDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [step, setStep] = useState(0);
  const [sourceFileIds, setSourceFileIds] = useState<string[]>([]);
  const [selections, setSelections] = useState<Array<{ assetId: string; ordinal: number }>>([]);
  const [records, setRecords] = useState<TestSetRecord[]>([]);
  const [metadataEditingIndex, setMetadataEditingIndex] = useState<number>();
  const [idempotencyKey, setIdempotencyKey] = useState(createRequestId);
  const sources = useQuery({
    queryKey: ["solo-test-set-sources", projectId],
    queryFn: () => listTestSetSources(projectId),
    enabled: open,
  });
  const check = useMemo(() => {
    const fingerprints = records.map(({ question, expectedOutput, metadata }) =>
      JSON.stringify({ question, expectedOutput, metadata }),
    );
    return {
      missingQuestionCount: records.filter((record) => !record.question.trim()).length,
      exactDuplicateCount: fingerprints.length - new Set(fingerprints).size,
      traceableRecordCount: records.filter((record) => record.source).length,
    };
  }, [records]);

  function reset() {
    setName("");
    setPurpose("");
    setStep(0);
    setSourceFileIds([]);
    setSelections([]);
    setRecords([]);
    setMetadataEditingIndex(undefined);
    setIdempotencyKey(createRequestId());
  }

  function close(value: boolean) {
    if (!value) reset();
    onOpenChange(value);
  }

  function toggleSourceFile(file: TestSetSource["files"][number]) {
    const selected = sourceFileIds.includes(file.id);
    setSourceFileIds((items) =>
      selected ? items.filter((item) => item !== file.id) : [...items, file.id],
    );
    if (!selected) return;
    setSelections((items) => items.filter((item) => item.assetId !== file.id));
    setRecords((items) => items.filter((item) => item.source?.assetId !== file.id));
  }

  function toggleRecord(record: TestSetSource["files"][number]["records"][number]) {
    const selected = selections.some(
      (item) => item.assetId === record.assetId && item.ordinal === record.ordinal,
    );
    if (selected) {
      setSelections((items) =>
        items.filter((item) => item.assetId !== record.assetId || item.ordinal !== record.ordinal),
      );
      setRecords((items) =>
        items.filter(
          (item) =>
            item.source?.assetId !== record.assetId || item.source.ordinal !== record.ordinal,
        ),
      );
      return;
    }
    setSelections((items) => [...items, { assetId: record.assetId, ordinal: record.ordinal }]);
    setRecords((items) => [
      ...items,
      {
        question: record.question,
        expectedOutput: record.expectedOutput,
        metadata: record.metadata,
        source: { assetId: record.assetId, ordinal: record.ordinal },
      },
    ]);
  }

  function toggleAllFileRecords(file: TestSetSource["files"][number], checked: boolean) {
    setSelections((items) => [
      ...items.filter((item) => item.assetId !== file.id),
      ...(checked
        ? file.records.map((record) => ({ assetId: record.assetId, ordinal: record.ordinal }))
        : []),
    ]);
    setRecords((items) => [
      ...items.filter((item) => item.source?.assetId !== file.id),
      ...(checked
        ? file.records.map((record) => ({
            question: record.question,
            expectedOutput: record.expectedOutput,
            metadata: record.metadata,
            source: { assetId: record.assetId, ordinal: record.ordinal },
          }))
        : []),
    ]);
  }

  function updateRecord(index: number, field: "question" | "expectedOutput", value: string) {
    setRecords((items) =>
      items.map((item, itemIndex) => (itemIndex === index ? { ...item, [field]: value } : item)),
    );
  }

  function removeRecord(index: number) {
    const source = records[index]?.source;
    setRecords((items) => items.filter((_, itemIndex) => itemIndex !== index));
    if (source)
      setSelections((items) =>
        items.filter((item) => item.assetId !== source.assetId || item.ordinal !== source.ordinal),
      );
  }

  function updateMetadata(index: number, metadata: TestSetRecord["metadata"]) {
    setRecords((items) =>
      items.map((item, itemIndex) => (itemIndex === index ? { ...item, metadata } : item)),
    );
  }

  async function publish() {
    try {
      const result = await createSoloTestSet(projectId, {
        name,
        purpose,
        selections,
        records,
        idempotencyKey,
      });
      await queryClient.invalidateQueries({ queryKey: ["solo-test-sets", projectId] });
      close(false);
      toast.success("已创建 v1");
      await navigate({
        to: "/projects/$projectId/test-sets/$testSetId",
        params: { projectId, testSetId: result.testSet.id },
        search: { version: undefined },
      });
    } catch (error) {
      toast.error("创建失败", { description: error instanceof Error ? error.message : "请重试" });
    }
  }

  function next() {
    if (step === 0 && !name.trim()) {
      toast.error("请先填写测试集名称。");
      return;
    }
    if (step === 0 && !sourceFileIds.length) {
      toast.error("请先选择至少一个资料文件。");
      return;
    }
    if (step === 1 && !selections.length) {
      toast.error("请先选择至少一条记录。");
      return;
    }
    if (step < CREATE_STEPS.length - 1) setStep((value) => value + 1);
    else void publish();
  }

  const selectedDatasetCount =
    sources.data?.filter((dataset) => dataset.files.some((file) => sourceFileIds.includes(file.id)))
      .length ?? 0;
  const selectedFiles =
    sources.data?.flatMap((dataset) =>
      dataset.files
        .filter((file) => sourceFileIds.includes(file.id))
        .map((file) => ({ dataset, file })),
    ) ?? [];
  const editableGroups = [
    ...selectedFiles.map(({ dataset, file }) => ({
      key: file.id,
      title: `${dataset.name} › ${file.fileName}`,
      records: records.flatMap((record, index) =>
        record.source?.assetId === file.id ? [{ record, index }] : [],
      ),
    })),
    {
      key: "manual",
      title: "手工新增",
      records: records.flatMap((record, index) => (!record.source ? [{ record, index }] : [])),
    },
  ].filter((group) => group.records.length > 0);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-[860px] gap-0 overflow-hidden p-0">
        <DialogHeader className="px-6 pb-4 pt-6">
          <DialogTitle>新建测试集</DialogTitle>
          <DialogDescription>从资料选择记录，编辑后创建第一个版本。</DialogDescription>
        </DialogHeader>
        <ol className="flex gap-3 border-b px-6 pb-4 text-xs" aria-label="创建测试集步骤">
          {CREATE_STEPS.map((label, index) => (
            <li
              key={label}
              className={
                index === step
                  ? "flex items-center gap-2 font-medium text-primary"
                  : "flex items-center gap-2 text-muted-foreground"
              }
            >
              <span
                className={
                  index === step
                    ? "grid size-5 place-items-center rounded-md bg-primary text-[11px] text-primary-foreground"
                    : "grid size-5 place-items-center rounded-md bg-muted text-[11px]"
                }
              >
                {index + 1}
              </span>
              <span className="hidden sm:inline">{label}</span>
            </li>
          ))}
        </ol>
        <div className="max-h-[calc(100vh-19rem)] overflow-y-auto px-6 py-5">
          {step === 0 && (
            <div className="grid gap-5">
              <div className="grid gap-2">
                <Label htmlFor="test-set-name">测试集名称</Label>
                <Input
                  id="test-set-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如：客服基础问答"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="test-set-purpose">用途说明（可选）</Label>
                <Textarea
                  id="test-set-purpose"
                  value={purpose}
                  onChange={(event) => setPurpose(event.target.value)}
                  placeholder="例如：核对客服常见问题的问答表现"
                />
              </div>
              <p className="text-sm text-muted-foreground">
                按“数据集 → 文件 → 记录”逐步选择；下一步会显示所选文件真实解析出的记录。
              </p>
              <SelectionSummary
                datasets={selectedDatasetCount}
                files={sourceFileIds.length}
                records={selections.length}
              />
              {sources.isLoading ? (
                <p className="text-sm text-muted-foreground">正在读取可用资料…</p>
              ) : sources.error ? (
                <div className="flex items-center gap-2 text-sm text-destructive">
                  无法读取可用资料。
                  <Button variant="outline" size="sm" onClick={() => void sources.refetch()}>
                    重试
                  </Button>
                </div>
              ) : sources.data?.length ? (
                <div className="grid gap-4">
                  {sources.data.map((dataset) => {
                    const recordCount = dataset.files.reduce(
                      (count, file) => count + file.records.length,
                      0,
                    );
                    return (
                      <section
                        key={dataset.id}
                        className="overflow-hidden rounded-md border shadow-sm"
                      >
                        <h3 className="border-b bg-muted/60 px-3 py-2 text-xs font-medium text-muted-foreground">
                          {dataset.name}
                          <span className="font-normal">
                            {" "}
                            · {dataset.files.length} 个文件 · {recordCount} 条记录
                          </span>
                        </h3>
                        {dataset.files.map((file) => {
                          const selected = sourceFileIds.includes(file.id);
                          return (
                            <label
                              key={file.id}
                              className={`flex cursor-pointer items-start gap-3 border-t px-3 py-3 text-sm first:border-t-0 ${
                                selected ? "bg-accent" : "hover:bg-muted/30"
                              }`}
                            >
                              <Checkbox
                                checked={selected}
                                onCheckedChange={() => toggleSourceFile(file)}
                                aria-label={`选择资料 ${file.fileName}`}
                              />
                              <span>
                                <span className="block font-medium">{file.fileName}</span>
                                <span className="block text-xs text-muted-foreground">
                                  {file.records.length} 条可选记录
                                </span>
                              </span>
                            </label>
                          );
                        })}
                      </section>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">当前项目还没有可选择的已解析文件。</p>
              )}
            </div>
          )}
          {step === 1 && (
            <div className="grid gap-4">
              <p className="text-sm text-muted-foreground">
                以下是所选文件已解析出的真实统一记录。勾选需要纳入测试集的记录。
              </p>
              <SelectionSummary
                datasets={selectedDatasetCount}
                files={sourceFileIds.length}
                records={selections.length}
              />
              {selectedFiles.length ? (
                selectedFiles.map(({ dataset, file }) => {
                  const allSelected =
                    file.records.length > 0 &&
                    file.records.every((record) =>
                      selections.some(
                        (item) =>
                          item.assetId === record.assetId && item.ordinal === record.ordinal,
                      ),
                    );
                  return (
                    <section key={file.id} className="overflow-hidden rounded-md border shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/60 px-3 py-2">
                        <h3 className="text-xs font-medium text-muted-foreground">
                          {dataset.name}{" "}
                          <span className="font-normal">
                            › {file.fileName} · {file.records.length} 条记录
                          </span>
                        </h3>
                        <label className="flex cursor-pointer items-center gap-2 text-sm">
                          <Checkbox
                            checked={allSelected}
                            onCheckedChange={(checked) =>
                              toggleAllFileRecords(file, checked === true)
                            }
                            aria-label={`全选 ${file.fileName}`}
                          />
                          全选本文件
                        </label>
                      </div>
                      <div className="divide-y">
                        {file.records.map((record) => {
                          const checked = selections.some(
                            (item) =>
                              item.assetId === record.assetId && item.ordinal === record.ordinal,
                          );
                          return (
                            <label
                              key={`${record.assetId}-${record.ordinal}`}
                              className={`grid cursor-pointer gap-1 px-3 py-2 text-sm sm:grid-cols-[auto_34px_minmax(0,1.2fr)_minmax(0,1.5fr)_minmax(0,0.8fr)] sm:items-start sm:gap-3 ${
                                checked ? "bg-accent" : "hover:bg-muted/30"
                              }`}
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={() => toggleRecord(record)}
                                aria-label={`选择 ${file.fileName} 的记录 ${record.ordinal + 1}`}
                              />
                              <span className="text-muted-foreground">{record.ordinal + 1}.</span>
                              <span className="min-w-0 truncate">
                                {record.question || "（未填写问题）"}
                              </span>
                              <span className="min-w-0 truncate text-muted-foreground">
                                {record.expectedOutput || "（未填写期望输出）"}
                              </span>
                              <span className="min-w-0 text-muted-foreground">
                                <MetadataSummary entries={record.metadata} />
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </section>
                  );
                })
              ) : (
                <p className="rounded-md border border-dashed px-3 py-5 text-sm text-muted-foreground">
                  尚未选择资料。请返回上一步选择至少一个文件。
                </p>
              )}
            </div>
          )}
          {step === 2 && (
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  直接修改单元格，或新增、删除记录。创建后会生成 v1，不会改动数据集中的原始文件。
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setRecords((items) => [
                      ...items,
                      { question: "", expectedOutput: "", metadata: [] },
                    ])
                  }
                >
                  <Plus className="size-4" /> 新增记录
                </Button>
              </div>
              {editableGroups.length ? (
                <div className="grid gap-4">
                  {editableGroups.map((group) => (
                    <section
                      key={group.key}
                      className="overflow-x-auto rounded-md border shadow-sm"
                    >
                      <h3 className="border-b bg-muted/60 px-3 py-2 text-xs font-medium text-muted-foreground">
                        {group.title}
                        <span className="font-normal"> · {group.records.length} 条记录</span>
                      </h3>
                      <div className="min-w-3xl">
                        <div className="grid grid-cols-[34px_minmax(150px,1.2fr)_minmax(150px,1.5fr)_minmax(100px,0.8fr)_auto] gap-3 border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
                          <span>序号</span>
                          <span>问题</span>
                          <span>期望输出</span>
                          <span>Metadata</span>
                          <span className="sr-only">操作</span>
                        </div>
                        {group.records.map(({ record, index }) => (
                          <div
                            key={`${record.source?.assetId ?? "manual"}-${record.source?.ordinal ?? index}-${index}`}
                            className="grid grid-cols-[34px_minmax(150px,1.2fr)_minmax(150px,1.5fr)_minmax(100px,0.8fr)_auto] items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0"
                          >
                            <span className="text-muted-foreground">{index + 1}</span>
                            <Input
                              aria-label={`第 ${index + 1} 行问题`}
                              value={record.question}
                              onChange={(event) =>
                                updateRecord(index, "question", event.target.value)
                              }
                            />
                            <Input
                              aria-label={`第 ${index + 1} 行期望输出`}
                              value={record.expectedOutput}
                              onChange={(event) =>
                                updateRecord(index, "expectedOutput", event.target.value)
                              }
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setMetadataEditingIndex(index)}
                            >
                              {record.metadata.length
                                ? `${record.metadata.length} 项 Metadata`
                                : "添加 Metadata"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`删除第 ${index + 1} 行`}
                              onClick={() => removeRecord(index)}
                              className="text-destructive hover:text-destructive"
                            >
                              删除
                            </Button>
                          </div>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <p className="rounded-md border border-dashed px-3 py-5 text-sm text-muted-foreground">
                  先从来源中选择记录，或新增记录。
                </p>
              )}
              <section
                className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
                aria-label="数据核对"
              >
                数据核对：缺少问题 {check.missingQuestionCount} 条 · 完全重复{" "}
                {check.exactDuplicateCount} 条 · 已记录来源 {check.traceableRecordCount}{" "}
                条。仅提示，不阻止创建。
              </section>
            </div>
          )}
        </div>
        <DialogFooter className="flex-row justify-between px-6 pb-6 pt-4 sm:space-x-0">
          <Button variant="outline" onClick={() => close(false)}>
            取消
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={step === 0}
              onClick={() => setStep((value) => value - 1)}
            >
              上一步
            </Button>
            <Button disabled={step === 2 && !records.length} onClick={next}>
              {step === 2 ? "创建 v1" : "下一步"}
            </Button>
          </div>
        </DialogFooter>
        <MetadataEditor
          open={metadataEditingIndex !== undefined}
          entries={
            metadataEditingIndex === undefined
              ? []
              : (records[metadataEditingIndex]?.metadata ?? [])
          }
          onOpenChange={(value) => !value && setMetadataEditingIndex(undefined)}
          onSave={(metadata) => {
            if (metadataEditingIndex !== undefined) updateMetadata(metadataEditingIndex, metadata);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
