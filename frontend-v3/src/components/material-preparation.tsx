import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { FieldMappingEditor } from "@/components/field-mapping-editor";
import { MetadataSummary } from "@/components/material-record-table";
import { request, type DisplayMapping, type MetadataEntry } from "@/services/workspace";
import { Pagination } from "@/routes/index";

type PreparedPreview = { question: string; expectedOutput: string; metadata: MetadataEntry[] };
type Material = {
  parsedViewId: string;
  mappingRevision: number;
  mappingReady: boolean;
  mapping: DisplayMapping;
  fields: Array<{ path: string; sample: unknown }>;
  records: Array<{ ordinal: number; value: unknown; parseStatus: string }>;
  total: number;
};
const messages: Record<string, string> = {
  display_mapping_invalid:
    "请检查字段映射。Metadata 名称不能重复，问题和期望输出不能使用同一字段。",
  mapping_already_prepared: "其他成员已完成字段整理，请重新载入文件。",
  mapping_revision_conflict: "文件解析视图已变化，请重新载入后整理。",
};
export function MaterialPreparation({
  projectId,
  assetId,
  canWrite,
  onPrepared,
}: {
  projectId: string;
  assetId: string;
  canWrite: boolean;
  onPrepared: () => Promise<void>;
}) {
  const [page, setPage] = useState(1);
  const path = `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/mapping`;
  const data = useQuery({
    queryKey: ["material-preparation", projectId, assetId, page],
    queryFn: () => request<Material>(`${path}?offset=${(page - 1) * 20}&limit=20`),
    refetchOnWindowFocus: false,
  });
  if (data.isPending) return <p className="text-sm text-muted-foreground">正在读取原始字段…</p>;
  if (data.error || !data.data)
    return (
      <div role="alert">
        <p>无法读取原始字段。</p>
        <Button variant="outline" onClick={() => void data.refetch()}>
          重试
        </Button>
      </div>
    );
  return (
    <div className="space-y-5">
      <PreparationForm
        key={data.data.parsedViewId}
        material={data.data}
        path={path}
        canWrite={canWrite}
        onPrepared={async () => {
          await data.refetch();
          await onPrepared();
        }}
      />
      <section className="overflow-hidden rounded-md border bg-card shadow-sm">
        <div className="border-b px-5 py-4">
          <h2 className="font-semibold">原始记录</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            原件保持不变。整理字段后，可从这些记录中选取测试数据。
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-muted-foreground">
              <tr>
                <th className="w-20 px-4 py-3">序号</th>
                <th className="px-4 py-3">原始内容</th>
              </tr>
            </thead>
            <tbody>
              {data.data.records.map((row) => (
                <tr key={row.ordinal} className="border-t">
                  <td className="px-4 py-3 align-top">{row.ordinal}</td>
                  <td className="px-4 py-3">
                    <details>
                      <summary className="cursor-pointer break-all">
                        {JSON.stringify(row.value).slice(0, 160)}
                        {JSON.stringify(row.value).length > 160 ? "…" : ""}
                      </summary>
                      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-3 text-xs">
                        {JSON.stringify(row.value, null, 2)}
                      </pre>
                    </details>
                    {row.parseStatus !== "valid" && (
                      <p className="text-destructive">该条记录解析失败，不会加入测试集。</p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <Pagination
        total={data.data.total}
        current={page}
        pages={Math.max(1, Math.ceil(data.data.total / 20))}
        onChange={setPage}
        unit="条记录"
      />
    </div>
  );
}
function PreparationForm({
  material,
  path,
  canWrite,
  onPrepared,
}: {
  material: Material;
  path: string;
  canWrite: boolean;
  onPrepared: () => Promise<void>;
}) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [mapping, setMapping] = useState<DisplayMapping>({ metadata: [] });
  const [preview, setPreview] = useState<PreparedPreview[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [previewReady, setPreviewReady] = useState(false);
  async function update(next: DisplayMapping) {
    setMapping(next);
    setBusy(true);
    setError("");
    setPreviewReady(false);
    try {
      const response = await request<{ preview: PreparedPreview[] }>(`${path}/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parsedViewId: material.parsedViewId, mapping: next }),
      });
      setPreview(response.preview);
      setPreviewReady(true);
    } catch (cause) {
      setError(
        messages[cause instanceof Error ? cause.message : ""] ?? "预览失败，映射已保留，请重试。",
      );
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      await request(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parsedViewId: material.parsedViewId,
          expectedRevision: material.mappingRevision,
          mapping,
        }),
      });
      await client.invalidateQueries({ queryKey: ["material-preparation"] });
      await client.invalidateQueries({ queryKey: ["material-files"] });
      await client.invalidateQueries({ queryKey: ["collections"] });
      await onPrepared();
    } catch (cause) {
      setError(
        messages[cause instanceof Error ? cause.message : ""] ??
          "保存失败，当前映射已保留，请重试。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="overflow-hidden rounded-md border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <h2 className="font-semibold">待整理字段</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            选择哪些原始字段作为问题、期望输出和 Metadata。
          </p>
        </div>
        {canWrite && !editing && <Button onClick={() => setEditing(true)}>整理字段</Button>}
      </div>
      {editing && (
        <div className="space-y-4 border-t p-5">
          <FieldMappingEditor
            fields={material.fields}
            mapping={mapping}
            pending={busy}
            onChange={update}
          />
          {previewReady && (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">问题</th>
                    <th className="px-3 py-2">期望输出</th>
                    <th className="px-3 py-2">Metadata</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-2">{row.question}</td>
                      <td className="px-3 py-2">{row.expectedOutput}</td>
                      <td className="px-3 py-2">
                        <MetadataSummary entries={row.metadata} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {error && (
              <Button variant="outline" disabled={busy} onClick={() => void onPrepared()}>
                重新载入文件
              </Button>
            )}
            <Button variant="outline" disabled={busy} onClick={() => void update(mapping)}>
              更新预览
            </Button>
            <Button
              disabled={busy || !previewReady || material.mappingReady}
              onClick={() => void save()}
            >
              {busy ? "正在处理…" : "确认字段映射"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">确认后用于后续测试集选取；原始文件不变。</p>
        </div>
      )}
    </section>
  );
}
