import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Card, CardContent } from "@/components/ui/card";
import { useRecordDensity } from "@/components/record-density";
import { getMaterialRecord, type UnifiedRecord } from "@/services/workspace";
import { useQuery } from "@tanstack/react-query";

export function MaterialRecordTable({
  projectId,
  collectionId,
  records,
  includeSourceFile = false,
}: {
  projectId: string;
  collectionId: string;
  records: UnifiedRecord[];
  includeSourceFile?: boolean;
}) {
  const { density } = useRecordDensity();
  const [detailTarget, setDetailTarget] = useState<Pick<UnifiedRecord, "assetId" | "ordinal">>();
  const detail = useQuery({
    queryKey: [
      "material-record",
      projectId,
      collectionId,
      detailTarget?.assetId,
      detailTarget?.ordinal,
    ],
    queryFn: () =>
      getMaterialRecord(projectId, collectionId, detailTarget!.assetId, detailTarget!.ordinal),
    enabled: Boolean(detailTarget),
  });

  return (
    <>
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className={`material-record-table record-table-density-${density} w-full text-sm`}>
            <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">序号</th>
                {includeSourceFile && <th className="px-4 py-2 font-medium">来源文件</th>}
                {["问题", "期望输出", "Metadata"].map((heading) => (
                  <th key={heading} className="px-4 py-2 font-medium">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={`${record.assetId}-${record.ordinal}`} className="border-t border-border">
                  <td className="px-4 py-2">
                    <Button
                      variant="link"
                      className="h-auto p-0 font-mono"
                      onClick={() => setDetailTarget(record)}
                    >
                      {record.ordinal}
                    </Button>
                  </td>
                  {includeSourceFile && (
                    <td className="px-4 py-2">
                      <RecordCell value={record.sourceFile} />
                    </td>
                  )}
                  <td className="px-4 py-2">
                    <RecordCell value={record.question} />
                  </td>
                  <td className="px-4 py-2">
                    <RecordCell value={record.expectedOutput} />
                  </td>
                  <td className="px-4 py-2">
                    <MetadataSummary entries={record.metadata} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <RecordDetail
        open={Boolean(detailTarget)}
        record={detail.data}
        loading={detail.isLoading}
        error={detail.isError}
        onOpenChange={(open) => !open && setDetailTarget(undefined)}
      />
    </>
  );
}

export function MetadataSummary({ entries }: { entries: UnifiedRecord["metadata"] }) {
  const { density } = useRecordDensity();
  const visible = entries.slice(0, 2);
  const hidden = entries.slice(2);
  if (!entries.length)
    return <span className={`metadata-empty record-table-density-${density}`}>未填写</span>;
  return (
    <span className={`metadata-cell record-table-density-${density}`}>
      <span className="metadata-summary">
        {visible.map((entry, index) => (
          <span
            key={`${entry.key}-${index}`}
            className="metadata-tag"
            title={`${entry.key}: ${entry.value}`}
          >
            <span className="metadata-tag-key">{entry.key}：</span>
            <span className="metadata-tag-value">{entry.value || "(空)"}</span>
          </span>
        ))}
        {hidden.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="metadata-more">
                +{hidden.length} 项
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="metadata-popover" aria-label="全部 Metadata">
              <h3>Metadata · {entries.length} 项</h3>
              <dl className="metadata-list">
                {entries.map((entry, index) => (
                  <div key={`${entry.key}-${index}`}>
                    <dt>{entry.key}</dt>
                    <dd>{entry.value || "(空)"}</dd>
                  </div>
                ))}
              </dl>
            </PopoverContent>
          </Popover>
        )}
      </span>
    </span>
  );
}

function RecordCell({ value }: { value: string }) {
  return <span className="record-cell-content">{value || "未填写"}</span>;
}

function RecordDetail({
  open,
  record,
  loading,
  error,
  onOpenChange,
}: {
  open: boolean;
  record: UnifiedRecord | undefined;
  loading: boolean;
  error: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>记录 {record?.ordinal ?? ""}</DialogTitle>
          <DialogDescription>{record?.sourceFile}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <p className="text-sm text-muted-foreground">正在读取记录...</p>
        ) : error ? (
          <p role="alert" className="text-sm text-destructive">
            无法读取记录详情。
          </p>
        ) : record ? (
          <div className="space-y-4 text-sm">
            <section>
              <h3 className="mb-1 font-medium">问题</h3>
              <p className="whitespace-pre-wrap text-muted-foreground">
                {record.question || "(空)"}
              </p>
            </section>
            <section>
              <h3 className="mb-1 font-medium">期望输出</h3>
              <p className="whitespace-pre-wrap text-muted-foreground">
                {record.expectedOutput || "(空)"}
              </p>
            </section>
            <section>
              <h3 className="mb-2 font-medium">Metadata · {record.metadata.length} 项</h3>
              <div className="space-y-2">
                {record.metadata.length ? (
                  record.metadata.map((entry, index) => (
                    <MetadataEntryLine key={`${entry.key}-${index}`} entry={entry} />
                  ))
                ) : (
                  <p className="text-muted-foreground">无</p>
                )}
              </div>
            </section>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function MetadataEntryLine({ entry }: { entry: UnifiedRecord["metadata"][number] }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-3 border-b pb-2 last:border-0">
      <span className="font-medium">{entry.key}</span>
      <span className="whitespace-pre-wrap text-muted-foreground">{entry.value || "(空)"}</span>
    </div>
  );
}
