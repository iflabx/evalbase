import { useState } from "react";
import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyBlock, PageHeader, StateView } from "@/components/state-view";
import { ConfirmedUploadDialog } from "@/components/confirmed-upload-dialog";
import { useProjectAccess } from "@/hooks/use-project-access";
import { MaterialRecordTable } from "@/components/material-record-table";
import { RecordDensityControl } from "@/components/record-density";
import {
  listCollections,
  listMaterialFiles,
  listUnifiedRecords,
  moveMaterialFile,
  type MaterialFile,
} from "@/services/workspace";
import { Pagination } from "@/routes/index";

const PAGE_SIZE = 10;

export const Route = createFileRoute("/projects/$projectId/datasets/$collectionId")({
  component: CollectionRoute,
});

function CollectionRoute() {
  const { projectId, collectionId } = Route.useParams();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return pathname === `/projects/${projectId}/datasets/${collectionId}` ? (
    <CollectionBrowser />
  ) : (
    <Outlet />
  );
}

function CollectionBrowser() {
  const { projectId, collectionId } = Route.useParams();
  const queryClient = useQueryClient();
  const access = useProjectAccess(projectId);
  const [tab, setTab] = useState<"files" | "records">("files");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selectedAssetId, setSelectedAssetId] = useState<string>();
  const [moving, setMoving] = useState<MaterialFile>();
  const [uploading, setUploading] = useState(false);
  const collections = useQuery({
    queryKey: ["collections", projectId],
    queryFn: () => listCollections(projectId, { limit: 100, offset: 0 }),
  });
  const collection = collections.data?.items.find((item) => item.id === collectionId);
  const moveTargets = (collections.data?.items ?? []).filter((item) => item.id !== collectionId);
  const input = { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE };
  const files = useQuery({
    queryKey: ["material-files", projectId, collectionId, search, page],
    queryFn: () => listMaterialFiles(projectId, collectionId, { ...input, name: search }),
    enabled: tab === "files",
  });
  const records = useQuery({
    queryKey: ["collection-records", projectId, collectionId, search, page],
    queryFn: () => listUnifiedRecords(projectId, collectionId, { ...input, search }),
    enabled: tab === "records",
  });
  const total = (tab === "files" ? files.data : records.data)?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function switchTab(next: "files" | "records") {
    setTab(next);
    setSearch("");
    setPage(1);
    setSelectedAssetId(undefined);
  }

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={collection?.name ?? "数据集"}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/projects/$projectId/datasets" params={{ projectId }}>
                返回数据集
              </Link>
            </Button>
            {access.canWrite && <Button onClick={() => setUploading(true)}>上传文件</Button>}
          </>
        }
      />
      <div className="mb-4 border-b border-border">
        <Button variant={tab === "files" ? "default" : "ghost"} onClick={() => switchTab("files")}>
          文件 {collection?.fileCount ?? 0}
        </Button>
        <Button
          variant={tab === "records" ? "default" : "ghost"}
          onClick={() => switchTab("records")}
        >
          全部记录 {collection?.unifiedRecordCount ?? 0}
        </Button>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-1">
        <div className="relative w-64">
          <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label={tab === "files" ? "搜索文件" : "搜索记录"}
            placeholder={tab === "files" ? "搜索文件名" : "搜索问题、期望输出或 Metadata"}
            className="pl-8"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </div>
        {tab === "records" ? <RecordDensityControl /> : null}
      </div>
      {tab === "files" ? (
        <StateView
          isLoading={files.isLoading}
          error={files.error}
          data={files.data}
          isEmpty={(data) => data.items.length === 0}
          onRetry={() => void files.refetch()}
          empty={<EmptyBlock title="没有文件" />}
        >
          {(data) => (
            <FileTable
              projectId={projectId}
              collectionId={collectionId}
              files={data.items}
              selectedAssetId={selectedAssetId}
              onSelect={setSelectedAssetId}
              onMove={setMoving}
              canMove={moveTargets.length > 0}
              canWrite={access.canWrite}
            />
          )}
        </StateView>
      ) : (
        <StateView
          isLoading={records.isLoading}
          error={records.error}
          data={records.data}
          isEmpty={(data) => data.items.length === 0}
          onRetry={() => void records.refetch()}
          empty={<EmptyBlock title="没有记录" />}
        >
          {(data) => (
            <MaterialRecordTable
              projectId={projectId}
              collectionId={collectionId}
              records={data.items}
              includeSourceFile
            />
          )}
        </StateView>
      )}
      {total > 0 && (
        <Pagination
          total={total}
          current={page}
          pages={pages}
          onChange={setPage}
          unit={tab === "files" ? "个文件" : "条记录"}
        />
      )}
      {access.canWrite && (
        <MoveFileDialog
          projectId={projectId}
          file={moving}
          targets={moveTargets.map(({ id, name }) => ({ id, name }))}
          onOpenChange={(open) => {
            if (!open) setMoving(undefined);
          }}
        />
      )}
      {access.canWrite && (
        <ConfirmedUploadDialog
          open={uploading}
          projectId={projectId}
          collections={(collections.data?.items ?? []).map(({ id, name }) => ({ id, name }))}
          defaultCollectionId={collectionId}
          onOpenChange={setUploading}
          onConfirmed={async () => {
            await queryClient.invalidateQueries({ queryKey: ["material-files", projectId] });
            await queryClient.invalidateQueries({ queryKey: ["collection-records", projectId] });
            await queryClient.invalidateQueries({ queryKey: ["collections", projectId] });
          }}
        />
      )}
    </div>
  );
}

function FileTable({
  projectId,
  collectionId,
  files,
  selectedAssetId,
  onSelect,
  onMove,
  canMove,
  canWrite,
}: {
  projectId: string;
  collectionId: string;
  files: MaterialFile[];
  selectedAssetId: string | undefined;
  onSelect: (assetId: string) => void;
  onMove: (file: MaterialFile) => void;
  canMove: boolean;
  canWrite: boolean;
}) {
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full min-w-5xl text-sm">
          <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
            <tr>
              {["名称", "格式", "大小", "记录数", "上传时间", "状态"].map((heading) => (
                <th key={heading} className="px-4 py-2 font-medium">
                  {heading}
                </th>
              ))}
              <th className="px-4 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr
                key={file.id}
                className={`cursor-pointer border-t border-border hover:bg-accent/40 ${selectedAssetId === file.id ? "bg-accent/60" : ""}`}
                onClick={() => onSelect(file.id)}
              >
                <td className="px-4 py-3">
                  <span className="flex items-center gap-2">
                    <FileText className="size-4 text-primary" />
                    {file.fileName}
                  </span>
                </td>
                <td className="px-4 py-3">{file.format.toUpperCase()}</td>
                <td className="mono px-4 py-3">{file.size}</td>
                <td className="mono px-4 py-3">{file.recordCount}</td>
                <td className="mono px-4 py-3">{file.uploadedAt.slice(0, 10)}</td>
                <td className="px-4 py-3">{file.status}</td>
                <td className="px-4 py-3 text-right">
                  <span className="inline-flex items-center justify-end gap-2">
                    {canWrite && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canMove}
                        title={canMove ? "移动到其他数据集" : "当前项目中没有其他数据集"}
                        onClick={(event) => {
                          event.stopPropagation();
                          onMove(file);
                        }}
                      >
                        移动
                      </Button>
                    )}
                    <Button variant="outline" size="sm" asChild>
                      <Link
                        to="/projects/$projectId/datasets/$collectionId/files/$assetId"
                        params={{ projectId, collectionId, assetId: file.id }}
                        onClick={(event) => event.stopPropagation()}
                      >
                        查看
                      </Link>
                    </Button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function MoveFileDialog({
  projectId,
  file,
  targets,
  onOpenChange,
}: {
  projectId: string;
  file: MaterialFile | undefined;
  targets: Array<{ id: string; name: string }>;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [targetId, setTargetId] = useState("");
  const move = useMutation({
    mutationFn: () => moveMaterialFile(projectId, file!.id, targetId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["material-files", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["collection-records", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["collections", projectId] });
      setTargetId("");
      onOpenChange(false);
    },
  });

  function close(open: boolean) {
    if (!open) {
      setTargetId("");
      move.reset();
    }
    onOpenChange(open);
  }

  return (
    <Dialog open={Boolean(file)} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>移动文件</DialogTitle>
          <DialogDescription>只会改变文件在当前项目中的归类。</DialogDescription>
        </DialogHeader>
        <p className="move-file-name">{file?.fileName}</p>
        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor="move-target">
            目标数据集
          </label>
          <Select value={targetId} onValueChange={setTargetId}>
            <SelectTrigger id="move-target" aria-label="目标数据集">
              <SelectValue placeholder="请选择数据集" />
            </SelectTrigger>
            <SelectContent>
              {targets.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-sm text-muted-foreground">
          文件内容、字段映射和已创建测试集中的来源信息不会改变。
        </p>
        {move.error && (
          <p role="alert" className="text-sm text-destructive">
            移动失败，请重试。
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => close(false)}>
            取消
          </Button>
          <Button disabled={!targetId || move.isPending} onClick={() => move.mutate()}>
            移动
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
