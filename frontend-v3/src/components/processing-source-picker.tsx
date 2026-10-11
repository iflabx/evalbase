import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getSoloTestSetVersion,
  listCollections,
  listMaterialFiles,
  listTestSets,
  request,
} from "@/services/workspace";
import { Pagination } from "@/routes/index";

export function ProcessingSourcePicker({
  projectId,
  onClose,
  onChoose,
}: {
  projectId: string;
  onClose: () => void;
  onChoose: (kind: "assets" | "version" | "draft", id: string) => void;
}) {
  const [kind, setKind] = useState<"assets" | "version" | "draft">("assets");
  const [parent, setParent] = useState("");
  const [text, setText] = useState("");
  const [page, setPage] = useState(1);
  const [parentPage, setParentPage] = useState(1);
  const parents = useQuery({
    queryKey: ["processing-source-parents", projectId, kind, parentPage],
    queryFn: async () => {
      const data = await (kind === "assets"
        ? listCollections(projectId, { limit: 20, offset: (parentPage - 1) * 20 })
        : listTestSets(projectId, { limit: 20, offset: (parentPage - 1) * 20 }));
      return {
        total: data.total,
        items: data.items.map((item) => ({
          id: item.id,
          name: item.name,
          currentVersionId: "currentVersionId" in item ? item.currentVersionId : null,
        })),
      };
    },
    enabled: kind !== "draft",
  });
  const options = useQuery({
    queryKey: ["processing-source-options", projectId, kind, parent, page, text],
    queryFn: async () => {
      if (kind === "assets") {
        const files = await listMaterialFiles(projectId, parent, {
          limit: 20,
          offset: (page - 1) * 20,
          name: text,
        });
        return {
          items: files.items.map((file) => ({ id: file.id, label: file.fileName })),
          total: files.total,
        };
      }
      if (kind === "draft") {
        const result = await request<{
          drafts: {
            id: string;
            name: string;
            paused: boolean;
            parentVersionLabel: string | null;
          }[];
        }>(`/api/projects/${encodeURIComponent(projectId)}/collaborative-drafts`);
        const items = result.drafts
          .filter((draft) => !draft.paused && (draft.name || "未命名草稿").includes(text.trim()))
          .map((draft) => ({
            id: draft.id,
            label: `${draft.name || "未命名草稿"}${draft.parentVersionLabel ? ` · 基于 ${draft.parentVersionLabel}` : " · 新建草稿"}`,
          }));
        return { items: items.slice((page - 1) * 20, page * 20), total: items.length };
      }
      const current = parents.data?.items.find((item) => item.id === parent);
      if (!current?.currentVersionId) return { items: [], total: 0 };
      const result = await getSoloTestSetVersion(projectId, parent, current.currentVersionId);
      const items = result.graph.nodes
        .filter((version) => !version.tombstoned && version.label.includes(text.trim()))
        .map((version) => ({
          id: version.id,
          label: `${version.label} · ${version.recordCount} 条记录`,
        }));
      return { items: items.slice((page - 1) * 20, page * 20), total: items.length };
    },
    enabled: kind === "draft" || Boolean(parent),
    retry: false,
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建处理</DialogTitle>
          <DialogDescription>选择一个已有来源，核对输入和要求后再开始。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Select
            value={kind}
            onValueChange={(value) => {
              setKind(value as typeof kind);
              setParent("");
              setPage(1);
              setParentPage(1);
              setText("");
            }}
          >
            <SelectTrigger aria-label="处理来源类型">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="assets">原始文件</SelectItem>
              <SelectItem value="version">测试集版本</SelectItem>
              <SelectItem value="draft">测试集草稿</SelectItem>
            </SelectContent>
          </Select>
          {kind !== "draft" && (
            <div className="space-y-2">
              <Select
                value={parent}
                onValueChange={(value) => {
                  setParent(value);
                  setPage(1);
                  setText("");
                }}
                disabled={parents.isPending || parents.isError}
              >
                <SelectTrigger aria-label={kind === "assets" ? "原始数据集合" : "测试集"}>
                  <SelectValue
                    placeholder={kind === "assets" ? "选择原始数据集合" : "选择测试集"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {parents.data?.items.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(parents.data?.total ?? 0) > 20 && (
                <Pagination
                  current={parentPage}
                  pages={Math.ceil(parents.data!.total / 20)}
                  total={parents.data!.total}
                  unit="项"
                  onChange={(value) => {
                    setParentPage(value);
                    setParent("");
                  }}
                />
              )}
              {parents.isError && (
                <Button variant="outline" size="sm" onClick={() => void parents.refetch()}>
                  重试读取来源
                </Button>
              )}
            </div>
          )}
          {(parent || kind === "draft") && (
            <>
              <Input
                aria-label="搜索处理来源"
                placeholder="搜索来源名称"
                value={text}
                maxLength={200}
                onChange={(event) => {
                  setText(event.target.value);
                  setPage(1);
                }}
              />
              {options.isPending ? (
                <p className="text-sm text-muted-foreground">正在读取来源…</p>
              ) : options.isError ? (
                <div role="alert">
                  <p>读取失败，请重试。</p>
                  <Button variant="outline" onClick={() => void options.refetch()}>
                    重试
                  </Button>
                </div>
              ) : (
                <div className="max-h-64 overflow-y-auto rounded-md border">
                  {options.data?.items.map((item) => (
                    <Button
                      key={item.id}
                      variant="ghost"
                      className="h-auto w-full justify-start whitespace-normal border-b px-4 py-3 text-left last:border-0"
                      onClick={() => onChoose(kind, item.id)}
                    >
                      {item.label}
                    </Button>
                  ))}
                  {!options.data?.items.length && (
                    <p className="p-4 text-sm text-muted-foreground">没有可选择的来源。</p>
                  )}
                </div>
              )}
              <Pagination
                current={page}
                pages={Math.max(1, Math.ceil((options.data?.total ?? 0) / 20))}
                total={options.data?.total ?? 0}
                unit="项"
                onChange={setPage}
              />
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
