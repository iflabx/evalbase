import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MaterialRecordTable } from "@/components/material-record-table";
import { RecordDensityControl } from "@/components/record-density";
import { EmptyBlock, PageHeader, StateView } from "@/components/state-view";
import { getMaterialFile, getMaterialRawPreview, listUnifiedRecords } from "@/services/workspace";
import { Pagination } from "@/routes/index";

const PAGE_SIZE = 10;

export const Route = createFileRoute("/projects/$projectId/datasets/$collectionId/files/$assetId")({
  component: FileRecordsPage,
});

function FileRecordsPage() {
  const { projectId, collectionId, assetId } = Route.useParams();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [rawOpen, setRawOpen] = useState(false);
  const file = useQuery({
    queryKey: ["material-file", projectId, collectionId, assetId],
    queryFn: () => getMaterialFile(projectId, collectionId, assetId),
  });
  const records = useQuery({
    queryKey: ["file-records", projectId, collectionId, assetId, search, page],
    queryFn: () =>
      listUnifiedRecords(projectId, collectionId, {
        assetId,
        search,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }),
  });
  const total = records.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const raw = useQuery({
    queryKey: ["material-raw-preview", projectId, assetId],
    queryFn: () => getMaterialRawPreview(projectId, assetId),
    enabled: rawOpen,
  });

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={file.data?.fileName ?? "文件记录"}
        {...(file.data
          ? {
              description: `${file.data.format.toUpperCase()} · 共 ${file.data.recordCount} 条记录`,
            }
          : {})}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link
                to="/projects/$projectId/datasets/$collectionId"
                params={{ projectId, collectionId }}
              >
                返回原始数据
              </Link>
            </Button>
            <Button variant="outline" onClick={() => setRawOpen(true)}>
              查看原始内容
            </Button>
          </div>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-1">
        <div className="relative w-80">
          <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="搜索文件记录"
            placeholder="搜索问题、期望输出或 Metadata"
            className="pl-8"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <RecordDensityControl />
      </div>
      <StateView
        isLoading={records.isLoading}
        error={records.error}
        data={records.data}
        isEmpty={(data) => data.items.length === 0}
        onRetry={() => void records.refetch()}
        empty={<EmptyBlock title="没有可浏览的记录" />}
      >
        {(data) => (
          <MaterialRecordTable
            projectId={projectId}
            collectionId={collectionId}
            records={data.items}
          />
        )}
      </StateView>
      {total > 0 && (
        <Pagination total={total} current={page} pages={pages} onChange={setPage} unit="条记录" />
      )}
      <Dialog open={rawOpen} onOpenChange={setRawOpen}>
        <DialogContent className="max-h-[calc(100vh-2rem)] max-w-4xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>原始内容</DialogTitle>
            <DialogDescription>只读预览文件开头，最多 1,000,000 bytes。</DialogDescription>
          </DialogHeader>
          {raw.isLoading ? (
            <p className="text-sm text-muted-foreground">正在读取预览...</p>
          ) : raw.isError ? (
            <p role="alert" className="text-sm text-destructive">
              无法读取原始内容。
            </p>
          ) : raw.data ? (
            <div className="space-y-3">
              <pre className="max-h-[60vh] overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-5 whitespace-pre-wrap">
                {raw.data.rawPreview.text}
              </pre>
              {raw.data.rawPreview.truncated && (
                <p className="text-sm text-amber-700">
                  文件超过预览上限，当前只显示开头 1,000,000 bytes。
                </p>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
