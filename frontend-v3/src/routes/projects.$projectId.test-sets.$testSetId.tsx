import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import { Input } from "@/components/ui/input";
import { MetadataEditor } from "@/components/metadata-editor";
import { MetadataSummary } from "@/components/material-record-table";
import { RecordDensityControl, useRecordDensity } from "@/components/record-density";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageHeader, StateView } from "@/components/state-view";
import { createRequestId } from "@/lib/request-id";
import {
  deriveSoloTestSetVersion,
  getSoloVersionRecord,
  getSoloVersionChange,
  getSoloVersionProvenance,
  getSoloTestSetVersion,
  listTestSets,
  listAllSoloVersionRecords,
  listSoloVersionRecords,
  listTestSetSources,
  soloVersionDownloadUrl,
  tombstoneSoloTestSetVersion,
  trashSoloVersionBranch,
  type ProvenanceChange,
  type SoloTestSetVersionDetail,
  type TestSetRecord,
  type TestSetSource,
  type VersionRecord,
} from "@/services/workspace";
import { Pagination } from "@/routes/index";

const DERIVE_STEPS = ["添加资料（可选）", "选择新增记录（可选）", "编辑并创建新版本"];

export const Route = createFileRoute("/projects/$projectId/test-sets/$testSetId")({
  validateSearch: (search: Record<string, unknown>) => ({
    version: typeof search["version"] === "string" ? search["version"] : undefined,
  }),
  component: TestSetDetailPage,
});

function TestSetDetailPage() {
  const { projectId, testSetId } = Route.useParams();
  const { version } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [selectedVersionId, setSelectedVersionId] = useState(version);
  const [deriving, setDeriving] = useState(false);
  const [view, setView] = useState<"records" | "provenance">("records");
  const [deleteTarget, setDeleteTarget] = useState<"version">();
  const fallback = useQuery({
    queryKey: ["solo-test-sets", projectId, "detail-fallback"],
    queryFn: () => listTestSets(projectId, { limit: 100, offset: 0 }),
    enabled: !selectedVersionId,
  });
  const fallbackVersionId = fallback.data?.items.find(
    (item) => item.id === testSetId,
  )?.currentVersionId;
  const versionId = selectedVersionId ?? fallbackVersionId;
  const detail = useQuery({
    queryKey: ["solo-test-set-version", projectId, testSetId, versionId],
    queryFn: () => getSoloTestSetVersion(projectId, testSetId, versionId!),
    enabled: Boolean(versionId),
  });
  useEffect(() => {
    if (version && version !== selectedVersionId) setSelectedVersionId(version);
  }, [selectedVersionId, version]);
  function selectVersion(id: string) {
    setSelectedVersionId(id);
    void navigate({
      to: "/projects/$projectId/test-sets/$testSetId",
      params: { projectId, testSetId },
      search: { version: id },
    });
  }
  if (!versionId && fallback.data)
    return <main className="mx-auto max-w-7xl py-8">未找到这个测试集。</main>;
  return (
    <main className="mx-auto max-w-7xl">
      <StateView
        isLoading={fallback.isLoading || detail.isLoading}
        error={fallback.error ?? detail.error}
        data={detail.data}
        isEmpty={() => false}
        onRetry={() => {
          void fallback.refetch();
          void detail.refetch();
        }}
      >
        {(data) => {
          const selectedHasChild = data.graph.nodes.some(
            (node) => node.parentVersionId === data.version.id,
          );
          const actionLabel = selectedHasChild ? "基于此版本创建分支" : "继续创建新版本";
          return view === "provenance" ? (
            <>
              <PageHeader
                title="来源与修改"
                description={`${data.testSet.name} · ${data.version.label} · 查看本版本的数据来源和改动。`}
                actions={
                  <>
                    <Button variant="outline" onClick={() => setView("records")}>
                      返回测试集
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => downloadBoth(projectId, testSetId, data.version.id)}
                    >
                      下载数据与溯源
                    </Button>
                  </>
                }
              />
              <ProvenanceView
                projectId={projectId}
                testSetId={testSetId}
                versionId={data.version.id}
                testSetName={data.testSet.name}
                versionLabel={data.version.label}
                onSelectParent={(id) => {
                  selectVersion(id);
                  setView("records");
                }}
              />
            </>
          ) : (
            <>
              <PageHeader
                eyebrow="测试集"
                title={data.testSet.name}
                {...(data.testSet.purpose ? { description: data.testSet.purpose } : {})}
                actions={
                  <>
                    <Button variant="outline" asChild>
                      <Link to="/projects/$projectId/test-sets" params={{ projectId }}>
                        返回测试集
                      </Link>
                    </Button>
                    <Button variant="outline" onClick={() => setView("provenance")}>
                      查看来源与修改
                    </Button>
                    <a
                      className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-3 text-sm font-medium shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground"
                      href={soloVersionDownloadUrl(
                        projectId,
                        testSetId,
                        data.version.id,
                        "data.csv",
                      )}
                      download
                    >
                      下载 CSV
                    </a>
                    <Button
                      variant="outline"
                      onClick={() => downloadBoth(projectId, testSetId, data.version.id)}
                    >
                      下载数据与溯源
                    </Button>
                    <Button onClick={() => setDeriving(true)}>{actionLabel}</Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          aria-label="删除选项"
                          title="删除选项"
                        >
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          className="text-destructive"
                          onSelect={() => setDeleteTarget("version")}
                        >
                          {selectedHasChild ? "处理中间版本" : "删除此版本"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                }
              />
              <VersionSummary data={data} />
              <VersionGraph data={data} onSelect={selectVersion} />
              <VersionRecordBrowser
                projectId={projectId}
                testSetId={testSetId}
                versionId={data.version.id}
              />
              <DeriveVersionDialog
                open={deriving}
                onOpenChange={setDeriving}
                projectId={projectId}
                testSetId={testSetId}
                parent={data}
                onPublished={selectVersion}
              />
              <DeleteTestSetDialog
                target={deleteTarget}
                onOpenChange={(open) => !open && setDeleteTarget(undefined)}
                projectId={projectId}
                data={data}
                onDeleted={(nextVersionId) => {
                  setDeleteTarget(undefined);
                  if (nextVersionId) selectVersion(nextVersionId);
                  else
                    void navigate({
                      to: "/projects/$projectId/test-sets",
                      params: { projectId },
                    });
                }}
              />
            </>
          );
        }}
      </StateView>
    </main>
  );
}

function downloadBoth(projectId: string, testSetId: string, versionId: string) {
  for (const file of ["data.csv", "provenance.csv"] as const) {
    const link = document.createElement("a");
    link.href = soloVersionDownloadUrl(projectId, testSetId, versionId, file);
    link.download = "";
    link.click();
  }
}

function VersionSummary({ data }: { data: SoloTestSetVersionDetail }) {
  const { version, versionSummary, dataCheck } = data;
  const parentLabel = data.graph.nodes.find((node) => node.id === version.parentVersionId)?.label;
  const sourceSummary =
    [
      versionSummary.sourceFiles.join("、"),
      versionSummary.manualRecordCount ? `手工新增 ${versionSummary.manualRecordCount} 条` : "",
    ]
      .filter(Boolean)
      .join("；") || "未记录";
  const changed = [
    versionSummary.changes.modified ? `修改 ${versionSummary.changes.modified} 条` : "",
    versionSummary.changes.added ? `新增 ${versionSummary.changes.added} 条` : "",
    versionSummary.changes.removed ? `移除 ${versionSummary.changes.removed} 条` : "",
  ].filter(Boolean);
  const changeSummary = parentLabel
    ? changed.length
      ? `从 ${parentLabel} 创建：${changed.join("、")}记录。`
      : `从 ${parentLabel} 创建：未修改记录。`
    : `${version.label}：新增 ${versionSummary.changes.added} 条记录。`;
  const hasDataCheckWarning =
    dataCheck.missingQuestionCount > 0 ||
    dataCheck.exactDuplicateCount > 0 ||
    dataCheck.traceableRecordCount !== version.recordCount;
  return (
    <Card className="version-summary-card mb-4 rounded-md">
      <div className="version-summary-head">
        <strong>当前版本摘要</strong>
        <span className="text-xs text-muted-foreground">
          已发布版本不会被覆盖；编辑会创建新版本。
        </span>
      </div>
      <dl className="version-summary-grid">
        <SummaryCell
          label="版本关系"
          value={
            parentLabel ? `${version.label} · 父版本 ${parentLabel}` : `${version.label} · 首个版本`
          }
        />
        <SummaryCell label="创建时间" value={version.createdAt.slice(0, 16).replace("T", " ")} />
        <SummaryCell label="记录总数" value={`${version.recordCount} 条`} />
        <SummaryCell wide label="用途说明" value={data.testSet.purpose || "未填写"} />
        <SummaryCell label="资料来源" value={sourceSummary} />
        <SummaryCell wide label="本版本修改" value={changeSummary} />
      </dl>
      <div className={`version-checks ${hasDataCheckWarning ? "warning" : ""}`}>
        <b>数据核对</b>
        <span>当前版本 {version.recordCount} 条记录</span>
        <span>
          问题未填写 <b>{dataCheck.missingQuestionCount}</b>
        </span>
        <span>
          完全重复 <b>{dataCheck.exactDuplicateCount}</b>
        </span>
        <span>
          来源已记录{" "}
          <b>
            {dataCheck.traceableRecordCount}/{version.recordCount}
          </b>
        </span>
        <small>仅提示，不阻止创建或下载。</small>
      </div>
    </Card>
  );
}
function SummaryCell({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "wide" : undefined}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function DeleteTestSetDialog({
  target,
  onOpenChange,
  projectId,
  data,
  onDeleted,
}: {
  target: "version" | undefined;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  data: SoloTestSetVersionDetail;
  onDeleted: (nextVersionId?: string) => void;
}) {
  const queryClient = useQueryClient();
  const [working, setWorking] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const descendants = useMemo(() => {
    const byParent = new Map<string, string[]>();
    for (const node of data.graph.nodes) {
      if (!node.parentVersionId) continue;
      byParent.set(node.parentVersionId, [...(byParent.get(node.parentVersionId) ?? []), node.id]);
    }
    const collect = (id: string): string[] => [id, ...(byParent.get(id) ?? []).flatMap(collect)];
    return collect(data.version.id);
  }, [data.graph.nodes, data.version.id]);
  const isMiddle = descendants.length > 1;
  async function refreshList() {
    await queryClient.invalidateQueries({ queryKey: ["solo-test-sets", projectId] });
  }
  async function moveVersionBranch() {
    setWorking(true);
    try {
      await trashSoloVersionBranch(projectId, data.testSet.id, data.version.id, isMiddle);
      await refreshList();
      toast.success("已移入回收站。");
      onDeleted();
    } catch (error) {
      toast.error("操作失败", { description: error instanceof Error ? error.message : "请重试" });
    } finally {
      setWorking(false);
    }
  }
  async function tombstone() {
    setWorking(true);
    try {
      await tombstoneSoloTestSetVersion(projectId, data.testSet.id, data.version.id, confirmation);
      toast.success("已删除内容，保留版本关系。");
      onDeleted(descendants[1]);
      void queryClient.invalidateQueries({
        queryKey: ["solo-test-set-version", projectId, data.testSet.id],
      });
    } catch (error) {
      toast.error("操作失败", { description: error instanceof Error ? error.message : "请重试" });
    } finally {
      setWorking(false);
    }
  }
  const title = isMiddle ? "处理中间版本" : "删除此版本";
  return (
    <Dialog
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) setConfirmation("");
        onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {data.testSet.name} · {data.version.label}
          </DialogDescription>
        </DialogHeader>
        {isMiddle ? (
          <div className="space-y-3 text-sm">
            <p>
              <strong>{data.version.label}</strong> 是中间版本，后续版本有 {descendants.length - 1}{" "}
              个。不能从版本图中直接抹掉或改挂后代父版本。
            </p>
            <p>请选择一种符合你真实意图的处理方式：</p>
            <div className="flex flex-wrap gap-2">
              <div className="grid gap-2">
                <Input
                  aria-label={`输入 ${data.version.label} 以确认删除内容`}
                  placeholder={`输入 ${data.version.label} 以确认`}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
                <Button
                  variant="destructive"
                  disabled={working || confirmation !== data.version.label}
                  onClick={() => void tombstone()}
                >
                  删除 {data.version.label} 内容，保留关系
                </Button>
              </div>
              <Button
                variant="destructive"
                disabled={working}
                onClick={() => void moveVersionBranch()}
              >
                删除此版本及 {descendants.length - 1} 个后续版本
              </Button>
            </div>
          </div>
        ) : (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <strong>{data.version.label}</strong>{" "}
            没有后续版本。移入回收站后可恢复；永久删除要在回收站中再次确认。
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={working} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          {!isMiddle ? (
            <Button
              variant="destructive"
              disabled={working}
              onClick={() => void moveVersionBranch()}
            >
              移入回收站
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CHANGE_FILTERS = [
  ["changed", "本次有变化"],
  ["all", "全部"],
  ["unchanged", "未改变"],
  ["modified", "已修改"],
  ["added", "新增"],
  ["removed", "已移除"],
] as const;

function ProvenanceView({
  projectId,
  testSetId,
  versionId,
  testSetName,
  versionLabel,
  onSelectParent,
}: {
  projectId: string;
  testSetId: string;
  versionId: string;
  testSetName: string;
  versionLabel: string;
  onSelectParent: (id: string) => void;
}) {
  const [status, setStatus] = useState<(typeof CHANGE_FILTERS)[number][0]>("changed");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [selectedChange, setSelectedChange] = useState<string>();
  const provenance = useQuery({
    queryKey: ["solo-version-provenance", projectId, testSetId, versionId, status, search, offset],
    queryFn: () =>
      getSoloVersionProvenance(projectId, testSetId, versionId, {
        status,
        search,
        limit: 10,
        offset,
      }),
  });
  const detail = useQuery({
    queryKey: ["solo-version-provenance-change", projectId, testSetId, versionId, selectedChange],
    queryFn: () => getSoloVersionChange(projectId, testSetId, versionId, selectedChange!),
    enabled: Boolean(selectedChange),
  });
  return (
    <>
      <StateView
        isLoading={provenance.isLoading}
        error={provenance.error}
        data={provenance.data}
        onRetry={() => void provenance.refetch()}
      >
        {(data) => (
          <>
            <Card className="mb-4 overflow-hidden rounded-md">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b bg-muted/50 px-4 py-3">
                <strong>本版本如何形成</strong>
                <span className="text-xs text-muted-foreground">
                  只说明这一版从哪里来、改了什么。
                </span>
              </div>
              <CardContent className="grid gap-0 p-0 text-sm sm:grid-cols-3">
                <div className="border-b px-4 py-3 sm:border-b-0 sm:border-r">
                  <p className="text-xs text-muted-foreground">基于版本</p>
                  {data.summary.parentVersion ? (
                    <Button
                      className="mt-1 h-auto px-0"
                      variant="link"
                      onClick={() => onSelectParent(data.summary.parentVersion!.id)}
                    >
                      {data.summary.parentVersion.label}
                    </Button>
                  ) : (
                    <p className="mt-1">这是首个版本</p>
                  )}
                </div>
                <SummaryCell
                  label="当前版本"
                  value={
                    data.summary.currentVersion.label +
                    " · " +
                    data.summary.currentVersion.recordCount +
                    " 条记录"
                  }
                />
                <SummaryCell
                  label="本次结果"
                  value={
                    "未改变 " +
                    data.summary.counts.unchanged +
                    " · 已修改 " +
                    data.summary.counts.modified +
                    " · 新增 " +
                    data.summary.counts.added +
                    " · 已移除 " +
                    data.summary.counts.removed
                  }
                />
                <div className="border-b px-4 py-3 sm:col-span-3 sm:border-b-0">
                  <p className="text-xs text-muted-foreground">本次新加入的资料</p>
                  {data.summary.addedFiles.length ? (
                    <div className="mt-1 grid gap-2">
                      {data.summary.addedFiles.map((file) => (
                        <details key={file.assetId} className="rounded border px-3 py-2">
                          <summary className="cursor-pointer font-medium">
                            {file.fileName}
                            {file.recordCount !== undefined ? ` · ${file.recordCount} 条记录` : ""}
                          </summary>
                          <p className="mt-2 text-xs text-muted-foreground">
                            问题：{file.mapping.question ?? "不导入"} · 期望输出：
                            {file.mapping.expectedOutput ?? "不导入"} · Metadata：
                            {file.mapping.metadata.join("、") || "不导入"}
                          </p>
                        </details>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-1">本次没有新加入资料。</p>
                  )}
                  {data.summary.manualAddedCount ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      另有 {data.summary.manualAddedCount} 条手工新增记录。
                    </p>
                  ) : null}
                </div>
              </CardContent>
            </Card>
            <section className="mb-3">
              <h2 className="text-base font-semibold">逐条查看变化</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                默认只显示本次新增、修改或移除的记录；需要时可查看全部记录。
              </p>
            </section>
            <Card className="overflow-hidden rounded-md">
              <div className="flex flex-wrap items-center gap-2 border-b bg-muted/50 px-4 py-3">
                <div className="flex flex-wrap gap-1" aria-label="变化筛选">
                  {CHANGE_FILTERS.map(([value, label]) => (
                    <Button
                      key={value}
                      size="sm"
                      variant={status === value ? "default" : "ghost"}
                      onClick={() => {
                        setStatus(value);
                        setOffset(0);
                      }}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                <Input
                  className="ml-auto max-w-xs"
                  aria-label="搜索记录或来源"
                  placeholder="搜索记录或来源"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setOffset(0);
                  }}
                />
              </div>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full min-w-3xl text-sm">
                  <thead className="bg-muted/30 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">记录</th>
                      <th className="px-4 py-2 font-medium">状态</th>
                      <th className="px-4 py-2 font-medium">来源</th>
                      <th className="px-4 py-2 font-medium">变更字段</th>
                      <th className="px-4 py-2 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.changes.length ? (
                      data.changes.map((change) => (
                        <tr key={change.id} className="border-t border-border">
                          <td className="max-w-md px-4 py-3 whitespace-pre-wrap">
                            {change.current?.question ?? change.previous?.question ?? "（无内容）"}
                          </td>
                          <td className="px-4 py-3">
                            <ChangeBadge changeType={change.changeType} />
                          </td>
                          <td className="px-4 py-3">
                            {change.source ? (
                              <>
                                <span className="block">
                                  {change.source.fileName ?? "原始资料"}
                                </span>
                                <span className="mt-1 block text-xs text-muted-foreground">
                                  第 {change.source.ordinal + 1} 条记录
                                </span>
                              </>
                            ) : (
                              "手工新增"
                            )}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {change.changedFields.length
                              ? change.changedFields.map(changeFieldLabel).join("、")
                              : "-"}
                          </td>
                          <td className="px-4 py-3">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setSelectedChange(change.id)}
                            >
                              查看
                            </Button>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td
                          className="px-4 py-8 text-center text-sm text-muted-foreground"
                          colSpan={5}
                        >
                          没有匹配的记录。可切换筛选条件或调整搜索内容。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </CardContent>
              <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
                <span>
                  共 {data.pagination.total} 条记录 · 第 {Math.floor(offset / 10) + 1}/
                  {Math.max(1, Math.ceil(data.pagination.total / 10))} 页
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={offset === 0}
                    onClick={() => setOffset((value) => Math.max(0, value - 10))}
                  >
                    上一页
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={offset + 10 >= data.pagination.total}
                    onClick={() => setOffset((value) => value + 10)}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            </Card>
          </>
        )}
      </StateView>
      <ChangeDetailDialog
        projectId={projectId}
        testSetName={testSetName}
        versionLabel={versionLabel}
        {...(detail.data ? { change: detail.data.change } : {})}
        loading={detail.isLoading}
        open={Boolean(selectedChange)}
        onOpenChange={(open) => {
          if (!open) setSelectedChange(undefined);
        }}
      />
    </>
  );
}

function changeLabel(changeType: ProvenanceChange["changeType"]) {
  return { unchanged: "未改变", modified: "已修改", added: "新增", removed: "已移除" }[changeType];
}

function ChangeBadge({ changeType }: { changeType: ProvenanceChange["changeType"] }) {
  const tone = {
    unchanged: "bg-muted text-muted-foreground",
    modified: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
    added: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
    removed: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
  }[changeType];
  return (
    <span className={`inline-flex rounded px-2 py-1 text-xs font-medium ${tone}`}>
      {changeLabel(changeType)}
    </span>
  );
}

function ChangeDetailDialog({
  projectId,
  testSetName,
  versionLabel,
  change,
  loading,
  open,
  onOpenChange,
}: {
  projectId: string;
  testSetName: string;
  versionLabel: string;
  change?: ProvenanceChange;
  loading: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>记录来源与修改</DialogTitle>
          <DialogDescription>
            {loading
              ? "正在加载…"
              : change
                ? `${testSetName} · ${versionLabel} · ${changeLabel(change.changeType)}`
                : "无法加载记录详情。"}
          </DialogDescription>
        </DialogHeader>
        {change ? (
          <div className="grid gap-4 text-sm">
            <ChangeContent title="当前内容" record={change.current} />
            {change.previous ? (
              <ChangeContent
                title={change.changeType === "removed" ? "移除前内容" : "修改前内容"}
                record={change.previous}
              />
            ) : null}
            <div>
              <p className="text-xs text-muted-foreground">来源与本次修改</p>
              <dl className="mt-1 grid gap-1 rounded border p-3">
                <div>
                  <dt className="inline text-muted-foreground">来源资料：</dt>
                  <dd className="inline">
                    {change.source?.fileName ?? (change.source ? "原始资料" : "手工新增")}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">来源记录：</dt>
                  <dd className="inline">
                    {change.source ? `第 ${change.source.ordinal + 1} 条记录` : "本次编辑"}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">本次修改：</dt>
                  <dd className="inline">
                    {change.changedFields.length
                      ? change.changedFields.map(changeFieldLabel).join("、")
                      : "无字段内容修改"}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        ) : null}
        <DialogFooter className="flex-row justify-between sm:space-x-0">
          {change?.source?.collectionId ? (
            <Button variant="outline" asChild>
              <Link
                to="/projects/$projectId/datasets/$collectionId/files/$assetId"
                params={{
                  projectId,
                  collectionId: change.source.collectionId,
                  assetId: change.source.assetId,
                }}
              >
                查看原始资料
              </Link>
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={() => onOpenChange(false)}>返回来源与修改</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function changeFieldLabel(field: string) {
  return (
    {
      question: "问题",
      expectedOutput: "期望输出",
      metadata: "Metadata",
      source: "来源",
    }[field] ?? field
  );
}

function ChangeContent({ title, record }: { title: string; record: ProvenanceChange["current"] }) {
  if (!record) return null;
  return (
    <div>
      <p className="text-xs text-muted-foreground">{title}</p>
      <dl className="mt-1 grid gap-1 rounded border p-3">
        <div>
          <dt className="inline text-muted-foreground">问题：</dt>
          <dd className="inline whitespace-pre-wrap">{record.question}</dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">期望输出：</dt>
          <dd className="inline whitespace-pre-wrap">{record.expectedOutput}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Metadata：</dt>
          <dd>
            <MetadataEntries entries={record.metadata} />
          </dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">来源：</dt>
          <dd className="inline">
            {record.source
              ? (record.source.fileName ?? "原始资料") +
                " 第 " +
                (record.source.ordinal + 1) +
                " 条记录"
              : "手工新增"}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function VersionGraph({
  data,
  onSelect,
}: {
  data: SoloTestSetVersionDetail;
  onSelect: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [scale, setScale] = useState(1);
  const [fitted, setFitted] = useState(false);
  const [fittedHeight, setFittedHeight] = useState<number>();
  const parents = useMemo(() => {
    const result = new Set<string>();
    const nodes = new Map(data.graph.nodes.map((node) => [node.id, node]));
    let current = data.version.id;
    while (nodes.get(current)?.parentVersionId) {
      const parent = nodes.get(current)!.parentVersionId!;
      result.add(parent);
      current = parent;
    }
    return result;
  }, [data.graph.nodes, data.version.id]);
  useEffect(() => {
    const measure = () => {
      const scroll = scrollRef.current;
      const tree = treeRef.current;
      if (!scroll || !tree) return;
      const styles = getComputedStyle(scroll);
      const availableWidth =
        scroll.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
      const isOverflowing = tree.scrollWidth > availableWidth;
      setOverflow(isOverflowing);
      if (!isOverflowing) {
        setScale(1);
        setFitted(false);
        setFittedHeight(undefined);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (scrollRef.current) observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, [data.graph.nodes]);
  const byParent = new Map<string | null, typeof data.graph.nodes>();
  for (const node of data.graph.nodes) {
    const children = byParent.get(node.parentVersionId) ?? [];
    children.push(node);
    byParent.set(node.parentVersionId, children);
  }
  return (
    <Card className="version-graph-card mb-4 overflow-hidden rounded-md">
      <div className="flex flex-wrap items-center gap-3 border-b bg-muted/50 px-4 py-3">
        <strong className="text-sm">版本关系</strong>
        <span className="text-xs text-muted-foreground">当前版本的来源路径已高亮</span>
        <div className="ml-auto flex gap-2">
          {overflow ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const scroll = scrollRef.current;
                const tree = treeRef.current;
                if (!scroll || !tree) return;
                if (fitted) {
                  setScale(1);
                  setFitted(false);
                  setFittedHeight(undefined);
                  return;
                }
                const styles = getComputedStyle(scroll);
                const availableWidth =
                  scroll.clientWidth -
                  parseFloat(styles.paddingLeft) -
                  parseFloat(styles.paddingRight);
                const nextScale = Math.min(1, availableWidth / tree.scrollWidth);
                if (nextScale < 0.72) {
                  toast("版本图较宽，保留横向滚动以保证文字可读。");
                  return;
                }
                setScale(nextScale);
                setFitted(true);
                setFittedHeight(Math.ceil(tree.offsetHeight * nextScale + 32));
              }}
            >
              {fitted ? "实际大小" : "适应视图"}
            </Button>
          ) : null}
        </div>
      </div>
      <div
        ref={scrollRef}
        className="version-graph-scroll overflow-x-auto p-4"
        style={fitted ? { height: fittedHeight, overflowX: "hidden" } : undefined}
      >
        <div
          ref={treeRef}
          className="version-tree min-w-max origin-top-left"
          style={{ transform: `scale(${scale})` }}
        >
          {(byParent.get(null) ?? []).map((node) => (
            <VersionBranch
              key={node.id}
              node={node}
              byParent={byParent}
              active={data.version.id}
              parents={parents}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </Card>
  );
}
function VersionBranch({
  node,
  byParent,
  active,
  parents,
  onSelect,
}: {
  node: SoloTestSetVersionDetail["graph"]["nodes"][number];
  byParent: Map<string | null, SoloTestSetVersionDetail["graph"]["nodes"]>;
  active: string;
  parents: Set<string>;
  onSelect: (id: string) => void;
}) {
  const children = byParent.get(node.id) ?? [];
  const onPath = node.id === active || parents.has(node.id);
  return (
    <div className="version-branch">
      <button
        type="button"
        disabled={node.tombstoned}
        onClick={() => onSelect(node.id)}
        className={`version-node ${node.id === active ? "selected" : onPath ? "on-path" : "dimmed"}${node.tombstoned ? " tombstoned" : ""}`}
      >
        <strong className="block">{node.label}</strong>
        <span className="mt-1 block text-xs text-muted-foreground">
          {node.tombstoned
            ? `内容已删除${node.tombstonedAt ? ` · 删除于 ${node.tombstonedAt.slice(0, 16).replace("T", " ")}` : ""}`
            : `${node.recordCount} 条记录`}
        </span>
      </button>
      {children.length ? (
        <div className="version-children">
          {children.map((child) => {
            const childOnPath = child.id === active || parents.has(child.id);
            return (
              <div
                key={child.id}
                className={`version-child ${onPath && childOnPath ? "on-path" : "dimmed"}`}
              >
                <VersionBranch
                  node={child}
                  byParent={byParent}
                  active={active}
                  parents={parents}
                  onSelect={onSelect}
                />
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
type VersionFilters = {
  sourceAssetIds: string[];
  question: "all" | "present" | "missing";
  origin: "all" | "source" | "manual";
  metadataField: string;
  metadata: string;
};

const emptyVersionFilters: VersionFilters = {
  sourceAssetIds: [],
  question: "all",
  origin: "all",
  metadataField: "",
  metadata: "",
};

function VersionRecordBrowser({
  projectId,
  testSetId,
  versionId,
}: {
  projectId: string;
  testSetId: string;
  versionId: string;
}) {
  const { density } = useRecordDensity();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<VersionFilters>(emptyVersionFilters);
  const [draft, setDraft] = useState<VersionFilters>(emptyVersionFilters);
  const [filterOpen, setFilterOpen] = useState(false);
  const [detailOrdinal, setDetailOrdinal] = useState<number>();
  const detail = useQuery({
    queryKey: ["solo-version-record-detail", projectId, testSetId, versionId, detailOrdinal],
    queryFn: () => getSoloVersionRecord(projectId, testSetId, versionId, detailOrdinal!),
    enabled: detailOrdinal !== undefined,
  });
  useEffect(() => {
    setSearch("");
    setPage(1);
    setFilters(emptyVersionFilters);
    setDraft(emptyVersionFilters);
    setDetailOrdinal(undefined);
  }, [versionId]);
  const records = useQuery({
    queryKey: ["solo-version-records", projectId, testSetId, versionId, search, page, filters],
    queryFn: () =>
      listSoloVersionRecords(projectId, testSetId, versionId, {
        limit: 10,
        offset: (page - 1) * 10,
        search,
        ...filters,
      }),
  });
  const items = records.data?.items ?? [];
  const total = records.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 10));
  const options = records.data?.filterOptions ?? { sourceFiles: [], metadataFields: [] };
  const chips = [
    ...filters.sourceAssetIds.flatMap((id) => {
      const name = options.sourceFiles.find((file) => file.id === id)?.name;
      return name ? [{ kind: "source" as const, id, label: `来源文件：${name}` }] : [];
    }),
    ...(filters.question === "all"
      ? []
      : [
          {
            kind: "question" as const,
            label: `问题：${filters.question === "missing" ? "未填写" : "已填写"}`,
          },
        ]),
    ...(filters.origin === "all"
      ? []
      : [
          {
            kind: "origin" as const,
            label: `记录来源：${filters.origin === "source" ? "原始资料" : "手工新增"}`,
          },
        ]),
    ...(filters.metadata.trim()
      ? [
          {
            kind: "metadata" as const,
            label: `Metadata · ${filters.metadataField || "任意字段"}包含“${filters.metadata.trim()}”`,
          },
        ]
      : []),
  ];

  function applyFilters() {
    setFilters(draft);
    setPage(1);
    setFilterOpen(false);
  }

  function clearFilters() {
    setFilters(emptyVersionFilters);
    setDraft(emptyVersionFilters);
    setPage(1);
    setFilterOpen(false);
  }

  function removeFilter(kind: (typeof chips)[number]["kind"], id?: string) {
    setFilters((current) => {
      if (kind === "source")
        return { ...current, sourceAssetIds: current.sourceAssetIds.filter((item) => item !== id) };
      if (kind === "question") return { ...current, question: "all" };
      if (kind === "origin") return { ...current, origin: "all" };
      return { ...current, metadataField: "", metadata: "" };
    });
    setPage(1);
  }

  return (
    <section className="mb-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[15rem] flex-1">
          <Input
            aria-label="搜索当前版本记录"
            placeholder="搜索问题、期望输出或 Metadata"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <Popover open={filterOpen} onOpenChange={setFilterOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              onClick={() => setDraft(filters)}
              aria-label="筛选当前版本记录"
            >
              筛选{chips.length ? ` ${chips.length}` : ""}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-[min(30rem,calc(100vw-2rem))] space-y-4"
            aria-label="筛选当前版本记录"
          >
            <div>
              <h3 className="font-medium">筛选当前版本记录</h3>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">来源文件</legend>
              {options.sourceFiles.length ? (
                <div className="grid gap-2">
                  {options.sourceFiles.map((file) => (
                    <label key={file.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={draft.sourceAssetIds.includes(file.id)}
                        onCheckedChange={(checked) =>
                          setDraft((current) => ({
                            ...current,
                            sourceAssetIds:
                              checked === true
                                ? [...current.sourceAssetIds, file.id]
                                : current.sourceAssetIds.filter((id) => id !== file.id),
                          }))
                        }
                      />
                      {file.name}
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">当前版本没有可筛选的原始资料。</p>
              )}
            </fieldset>
            <div className="grid gap-1 text-sm">
              <label htmlFor="version-question-filter">问题</label>
              <Select
                value={draft.question}
                onValueChange={(question: VersionFilters["question"]) =>
                  setDraft((current) => ({ ...current, question }))
                }
              >
                <SelectTrigger id="version-question-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">不限</SelectItem>
                  <SelectItem value="present">已填写</SelectItem>
                  <SelectItem value="missing">未填写</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1 text-sm">
              <label htmlFor="version-origin-filter">记录来源</label>
              <Select
                value={draft.origin}
                onValueChange={(origin: VersionFilters["origin"]) =>
                  setDraft((current) => ({ ...current, origin }))
                }
              >
                <SelectTrigger id="version-origin-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">不限</SelectItem>
                  <SelectItem value="source">原始资料</SelectItem>
                  <SelectItem value="manual">手工新增</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <label htmlFor="version-metadata-filter" className="text-sm">
                Metadata
              </label>
              <Select
                value={draft.metadataField || "all"}
                onValueChange={(metadataField) =>
                  setDraft((current) => ({
                    ...current,
                    metadataField: metadataField === "all" ? "" : metadataField,
                  }))
                }
              >
                <SelectTrigger id="version-metadata-filter">
                  <SelectValue placeholder="全部字段" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部字段</SelectItem>
                  {options.metadataFields.map((field) => (
                    <SelectItem key={field} value={field}>
                      {field}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                aria-label="Metadata 包含"
                placeholder="输入要匹配的文字"
                value={draft.metadata}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, metadata: event.target.value }))
                }
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setFilterOpen(false)}>
                取消
              </Button>
              <Button variant="outline" onClick={clearFilters}>
                清除
              </Button>
              <Button onClick={applyFilters}>应用筛选</Button>
            </div>
          </PopoverContent>
        </Popover>
        <RecordDensityControl />
        <span className="ml-auto text-sm text-muted-foreground">
          匹配 <strong>{total}</strong> 条记录
        </span>
      </div>
      {chips.length ? (
        <div className="mb-3 flex flex-wrap items-center gap-2" aria-label="已应用筛选">
          {chips.map((chip) => (
            <span
              key={`${chip.kind}-${chip.label}`}
              className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-1 text-xs"
            >
              {chip.label}
              <button
                type="button"
                aria-label={`移除筛选：${chip.label}`}
                onClick={() => removeFilter(chip.kind, "id" in chip ? chip.id : undefined)}
              >
                ×
              </button>
            </span>
          ))}
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            清除全部
          </Button>
        </div>
      ) : null}
      <Card className="overflow-hidden rounded-md">
        <CardContent className="overflow-x-auto p-0">
          <table className={`material-record-table record-table-density-${density} w-full text-sm`}>
            <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
              <tr>
                {["序号", "问题", "期望输出", "Metadata"].map((heading) => (
                  <th key={heading} className="px-4 py-2 font-medium">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.length ? (
                items.map((record) => (
                  <tr key={record.ordinal} className="border-t border-border">
                    <td className="px-4 py-2">
                      <Button
                        variant="link"
                        className="h-auto p-0 font-mono"
                        onClick={() => setDetailOrdinal(record.ordinal)}
                      >
                        {record.ordinal}
                      </Button>
                    </td>
                    <td className="px-4 py-2">
                      <span className="record-cell-content">{record.question || "未填写"}</span>
                    </td>
                    <td className="px-4 py-2">
                      <span className="record-cell-content">
                        {record.expectedOutput || "未填写"}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <MetadataSummary entries={record.metadata} />
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    没有匹配的记录。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
      {total ? (
        <Pagination total={total} current={page} pages={pages} onChange={setPage} unit="条记录" />
      ) : null}
      <VersionRecordDetail
        ordinal={detailOrdinal}
        record={detail.data?.record}
        error={detail.isError}
        onOpenChange={(open) => !open && setDetailOrdinal(undefined)}
      />
    </section>
  );
}

function VersionRecordDetail({
  ordinal,
  record,
  error,
  onOpenChange,
}: {
  ordinal: number | undefined;
  record: VersionRecord | undefined;
  error: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={ordinal !== undefined} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>第 {ordinal ?? ""} 条记录</DialogTitle>
          <DialogDescription>{record?.source?.fileName ?? "正在读取记录..."}</DialogDescription>
        </DialogHeader>
        {record ? (
          <div className="grid gap-4 text-sm">
            <section>
              <h3 className="font-medium">问题</h3>
              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                {record.question || "未填写"}
              </p>
            </section>
            <section>
              <h3 className="font-medium">期望输出</h3>
              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                {record.expectedOutput || "未填写"}
              </p>
            </section>
            <section>
              <h3 className="font-medium">Metadata · {record.metadata.length} 项</h3>
              <MetadataEntries entries={record.metadata} />
            </section>
            <section>
              <h3 className="font-medium">来源</h3>
              <p className="mt-1 text-muted-foreground">
                {record.source
                  ? `${record.source.fileName ?? "原始资料"} · 第 ${record.source.ordinal + 1} 条记录`
                  : "手工新增"}
              </p>
            </section>
          </div>
        ) : error ? (
          <p role="alert" className="text-sm text-destructive">
            读取记录失败。
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function MetadataEntries({ entries }: { entries: TestSetRecord["metadata"] }) {
  return entries.length ? (
    <dl className="mt-2 grid gap-2">
      {entries.map((entry, index) => (
        <div
          key={`${entry.key}-${index}`}
          className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-3 border-b pb-2 last:border-0"
        >
          <dt className="font-medium">{entry.key}</dt>
          <dd className="whitespace-pre-wrap text-muted-foreground">{entry.value || "(空)"}</dd>
        </div>
      ))}
    </dl>
  ) : (
    <p className="mt-1 text-muted-foreground">未填写</p>
  );
}

function DeriveVersionDialog({
  open,
  onOpenChange,
  projectId,
  testSetId,
  parent,
  onPublished,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  testSetId: string;
  parent: SoloTestSetVersionDetail;
  onPublished: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [fileIds, setFileIds] = useState<string[]>([]);
  const [selections, setSelections] = useState<Array<{ assetId: string; ordinal: number }>>([]);
  const [records, setRecords] = useState<TestSetRecord[]>([]);
  const [metadataEditingIndex, setMetadataEditingIndex] = useState<number>();
  const [publishing, setPublishing] = useState(false);
  const sources = useQuery({
    queryKey: ["solo-test-set-sources", projectId],
    queryFn: () => listTestSetSources(projectId),
    enabled: open,
  });
  const parentRecords = useQuery({
    queryKey: ["solo-version-records-for-edit", projectId, testSetId, parent.version.id],
    queryFn: () => listAllSoloVersionRecords(projectId, testSetId, parent.version.id),
    enabled: open,
  });
  useEffect(() => {
    if (open && parentRecords.data) {
      setStep(0);
      setFileIds([]);
      setSelections([]);
      setMetadataEditingIndex(undefined);
      setRecords(
        parentRecords.data.map((record) => ({
          question: record.question,
          expectedOutput: record.expectedOutput,
          metadata: record.metadata.map((entry) => ({ ...entry })),
          ...(record.source
            ? { source: { assetId: record.source.assetId, ordinal: record.source.ordinal } }
            : {}),
          parentOrdinal: record.parentOrdinal,
        })),
      );
    }
  }, [open, parentRecords.data]);
  function sourceFile(file: TestSetSource["files"][number]) {
    const selected = fileIds.includes(file.id);
    setFileIds((items) => (selected ? items.filter((id) => id !== file.id) : [...items, file.id]));
    if (selected) {
      const removing = new Set(
        selections.filter((item) => item.assetId === file.id).map((item) => item.ordinal),
      );
      setSelections((items) => items.filter((item) => item.assetId !== file.id));
      setRecords((items) =>
        items.filter(
          (item) => item.source?.assetId !== file.id || !removing.has(item.source.ordinal),
        ),
      );
    }
  }
  function toggleRecord(record: TestSetSource["files"][number]["records"][number]) {
    const selected = selections.some(
      (item) => item.assetId === record.assetId && item.ordinal === record.ordinal,
    );
    const inherited = (parentRecords.data ?? []).some(
      (item) => item.source?.assetId === record.assetId && item.source.ordinal === record.ordinal,
    );
    if (selected) {
      setSelections((items) =>
        items.filter((item) => item.assetId !== record.assetId || item.ordinal !== record.ordinal),
      );
      if (!inherited)
        setRecords((items) =>
          items.filter(
            (item) =>
              item.source?.assetId !== record.assetId || item.source.ordinal !== record.ordinal,
          ),
        );
    } else {
      setSelections((items) => [...items, { assetId: record.assetId, ordinal: record.ordinal }]);
      if (!inherited)
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
  }
  async function publish() {
    if (publishing) return;
    setPublishing(true);
    try {
      const result = await deriveSoloTestSetVersion(projectId, testSetId, parent.version.id, {
        selections,
        records,
        idempotencyKey: createRequestId(),
      });
      await queryClient.invalidateQueries({ queryKey: ["solo-test-sets", projectId] });
      await queryClient.invalidateQueries({
        queryKey: ["solo-test-set-version", projectId, testSetId],
      });
      toast.success(`已创建 ${result.version.label}`);
      onOpenChange(false);
      onPublished(result.version.id);
    } catch (error) {
      toast.error("创建失败", { description: error instanceof Error ? error.message : "请重试" });
    } finally {
      setPublishing(false);
    }
  }
  const selectedFiles =
    sources.data?.flatMap((dataset) =>
      dataset.files.filter((file) => fileIds.includes(file.id)).map((file) => ({ dataset, file })),
    ) ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-4xl gap-0 overflow-hidden p-0">
        <DialogHeader className="px-6 pb-4 pt-6">
          <DialogTitle>基于 {parent.version.label} 创建版本</DialogTitle>
          <DialogDescription>从所选版本的完整记录开始，可选添加资料后编辑发布。</DialogDescription>
        </DialogHeader>
        <ol className="flex gap-3 border-b px-6 pb-4 text-xs" aria-label="创建版本步骤">
          {DERIVE_STEPS.map((label, index) => (
            <li
              key={label}
              className={index === step ? "font-medium text-primary" : "text-muted-foreground"}
            >
              {index + 1}. {label}
            </li>
          ))}
        </ol>
        <div className="max-h-[calc(100vh-18rem)] overflow-y-auto px-6 py-5">
          {parentRecords.isLoading ? (
            <p className="text-sm text-muted-foreground">正在读取继承记录…</p>
          ) : null}
          {step === 0 ? (
            <SourceStep sources={sources.data ?? []} selected={fileIds} onToggle={sourceFile} />
          ) : null}
          {step === 1 ? (
            <RecordSelectionStep
              files={selectedFiles}
              selections={selections}
              onToggle={toggleRecord}
            />
          ) : null}
          {step === 2 ? (
            <EditStep
              records={records}
              onChange={(index, field, value) =>
                setRecords((items) =>
                  items.map((item, current) =>
                    current === index ? { ...item, [field]: value } : item,
                  ),
                )
              }
              onEditMetadata={setMetadataEditingIndex}
              onRemove={(index) =>
                setRecords((items) => items.filter((_, current) => current !== index))
              }
              onAdd={() =>
                setRecords((items) => [
                  ...items,
                  { question: "", expectedOutput: "", metadata: [] },
                ])
              }
            />
          ) : null}
        </div>
        <DialogFooter className="flex-row justify-between px-6 pb-6 pt-4 sm:space-x-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={step === 0}
              onClick={() => setStep((current) => current - 1)}
            >
              上一步
            </Button>
            <Button
              disabled={parentRecords.isLoading || publishing || (step === 2 && !records.length)}
              onClick={() => (step === 2 ? void publish() : setStep((current) => current + 1))}
            >
              {step === 2 && publishing ? "正在创建…" : step === 2 ? "创建新版本" : "下一步"}
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
            if (metadataEditingIndex !== undefined)
              setRecords((items) =>
                items.map((item, index) =>
                  index === metadataEditingIndex ? { ...item, metadata } : item,
                ),
              );
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
function SourceStep({
  sources,
  selected,
  onToggle,
}: {
  sources: TestSetSource[];
  selected: string[];
  onToggle: (file: TestSetSource["files"][number]) => void;
}) {
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">可跳过此步，直接编辑继承的记录。</p>
      {sources.map((dataset) => (
        <section key={dataset.id} className="overflow-hidden rounded-md border">
          <h3 className="border-b bg-muted/50 px-3 py-2 text-xs font-medium">{dataset.name}</h3>
          {dataset.files.map((file) => (
            <label
              key={file.id}
              className="flex cursor-pointer items-center gap-3 border-t px-3 py-3 text-sm first:border-t-0"
            >
              <Checkbox
                checked={selected.includes(file.id)}
                onCheckedChange={() => onToggle(file)}
              />
              {file.fileName}
              <span className="ml-auto text-xs text-muted-foreground">
                {file.records.length} 条记录
              </span>
            </label>
          ))}
        </section>
      ))}
    </div>
  );
}
function RecordSelectionStep({
  files,
  selections,
  onToggle,
}: {
  files: Array<{ dataset: TestSetSource; file: TestSetSource["files"][number] }>;
  selections: Array<{ assetId: string; ordinal: number }>;
  onToggle: (record: TestSetSource["files"][number]["records"][number]) => void;
}) {
  return (
    <div className="grid gap-4">
      {files.length ? (
        files.map(({ dataset, file }) => (
          <section key={file.id} className="overflow-hidden rounded-md border">
            <h3 className="border-b bg-muted/50 px-3 py-2 text-xs font-medium">
              {dataset.name} › {file.fileName}
            </h3>
            {file.records.map((record) => (
              <label
                key={`${record.assetId}-${record.ordinal}`}
                className="grid cursor-pointer grid-cols-[auto_1fr] gap-3 border-t px-3 py-2 text-sm"
              >
                <Checkbox
                  checked={selections.some(
                    (item) => item.assetId === record.assetId && item.ordinal === record.ordinal,
                  )}
                  onCheckedChange={() => onToggle(record)}
                />
                <span>
                  {record.ordinal + 1}. {record.question || "（未填写问题）"}
                </span>
              </label>
            ))}
          </section>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">未添加资料。下一步可直接编辑继承的记录。</p>
      )}
    </div>
  );
}
function EditStep({
  records,
  onChange,
  onEditMetadata,
  onRemove,
  onAdd,
}: {
  records: TestSetRecord[];
  onChange: (index: number, field: "question" | "expectedOutput", value: string) => void;
  onEditMetadata: (index: number) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
}) {
  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          已从父版本完整继承 {records.length} 条记录。
        </p>
        <Button variant="outline" size="sm" onClick={onAdd}>
          <Plus className="size-4" />
          新增记录
        </Button>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <div className="min-w-3xl">
          {records.map((record, index) => (
            <div
              key={`${record.source?.assetId ?? "manual"}-${record.source?.ordinal ?? index}-${index}`}
              className="grid grid-cols-[32px_minmax(150px,1fr)_minmax(150px,1fr)_minmax(120px,1fr)_auto] gap-2 border-b p-2 last:border-b-0"
            >
              <span className="pt-2 text-sm text-muted-foreground">{index + 1}</span>
              <Input
                aria-label={`第 ${index + 1} 行问题`}
                value={record.question}
                onChange={(event) => onChange(index, "question", event.target.value)}
              />
              <Input
                aria-label={`第 ${index + 1} 行预测输出`}
                value={record.expectedOutput}
                onChange={(event) => onChange(index, "expectedOutput", event.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onEditMetadata(index)}
              >
                {record.metadata.length ? `${record.metadata.length} 项 Metadata` : "添加 Metadata"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onRemove(index)}>
                删除
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
