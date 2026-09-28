import { useState } from "react";
import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Plus, Search, Trash2 } from "lucide-react";
import { useProjectAccess } from "@/hooks/use-project-access";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyBlock, ErrorBlock, PageHeader, StateView } from "@/components/state-view";
import {
  listTestSets,
  listSoloTestSetTrash,
  permanentlyDeleteSoloTestSetTrash,
  restoreSoloTestSetTrash,
  trashSoloTestSet,
  type TestSet,
  type TestSetTrashEntry,
} from "@/services/workspace";
import { Pagination } from "@/routes/index";
import { createSharedDraft, listSharedDrafts } from "@/services/drafts";

const PAGE_SIZE = 10;

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
  const navigate = useNavigate();
  const drafts = useQuery({
    queryKey: ["shared-drafts", projectId],
    queryFn: () => listSharedDrafts(projectId),
    enabled: access.canWrite,
  });
  async function startCreate() {
    setCreating(true);
    try {
      const created = await createSharedDraft(projectId);
      await queryClient.invalidateQueries({ queryKey: ["shared-drafts", projectId] });
      await navigate({
        to: "/projects/$projectId/test-sets/drafts/$draftId",
        params: { projectId, draftId: created.draft.id },
      });
    } catch (error) {
      toast.error("创建草稿失败", {
        description: error instanceof Error ? error.message : "请重试",
      });
    } finally {
      setCreating(false);
    }
  }
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
  const newDrafts =
    page === 1 && access.canWrite
      ? (drafts.data?.filter(
          (draft) => !draft.testSetId && (draft.name || "未命名草稿").includes(search.trim()),
        ) ?? [])
      : [];
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
        description="从数据集选择记录，编辑后创建或迭代测试集版本。"
        actions={
          <>
            {access.canManage && (
              <Button variant="outline" onClick={() => setTrashOpen(true)}>
                <Trash2 className="size-4" />
                回收站
              </Button>
            )}
            {access.canWrite && (
              <Button disabled={creating} onClick={() => void startCreate()}>
                <Plus className="size-4" />
                新建测试集
              </Button>
            )}
          </>
        }
      />
      {access.canWrite && drafts.isError && (
        <div className="mb-4">
          <ErrorBlock message="无法读取草稿，请重试。" onRetry={() => void drafts.refetch()} />
        </div>
      )}
      <div className="relative mb-4 w-full max-w-64">
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
        isEmpty={(items) => items.length === 0 && newDrafts.length === 0}
        onRetry={() => void testSets.refetch()}
        empty={
          <EmptyBlock
            title="还没有测试集"
            action={
              access.canWrite ? (
                <Button disabled={creating} onClick={() => void startCreate()}>
                  新建测试集
                </Button>
              ) : undefined
            }
          />
        }
      >
        {(items) => (
          <Card className="min-w-0">
            <CardContent className="max-w-full overflow-x-auto p-0">
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
                  {newDrafts.map((draft) => (
                    <tr key={draft.id} className="border-t border-border hover:bg-accent/40">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <FileText className="size-4 text-primary" />
                          <span className="font-medium">{draft.name || "未命名草稿"}</span>
                        </div>
                      </td>
                      <td className="mono px-4 py-3">—</td>
                      <td className="mono px-4 py-3">—</td>
                      <td className="px-4 py-3">—</td>
                      <td className="px-4 py-3">
                        <Badge variant="outline">草稿</Badge>
                      </td>
                      <td className="mono px-4 py-3 text-muted-foreground">
                        {formatUpdatedAt(draft.updatedAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button variant="outline" size="sm" asChild>
                          <Link
                            to="/projects/$projectId/test-sets/drafts/$draftId"
                            params={{ projectId, draftId: draft.id }}
                          >
                            继续编辑草稿
                          </Link>
                        </Button>
                      </td>
                    </tr>
                  ))}
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
        <Pagination
          total={total}
          current={page}
          pages={pages}
          onChange={setPage}
          unit="个正式测试集"
        />
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
