import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Paperclip, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { request } from "@/services/workspace";

export type BackgroundDocument = {
  id: string;
  fileName: string;
  format: string;
  fileSize: number;
  units: number;
  fragmentCount: number;
};
type Excerpt = BackgroundDocument & {
  fragments: { index: number; page?: number; startLine?: number; endLine?: number; text: string }[];
};

export function AssistantBackground({
  base,
  projectId,
  sessionId,
  documents,
  getSession,
  disabled,
  canWrite,
  setBusy,
  onError,
}: {
  base: string;
  projectId: string;
  sessionId?: string | undefined;
  documents: BackgroundDocument[];
  getSession: () => Promise<string>;
  disabled: boolean;
  canWrite: boolean;
  setBusy: (busy: boolean) => void;
  onError: (error: unknown) => void;
}) {
  const [view, setView] = useState<BackgroundDocument>(),
    [removing, setRemoving] = useState<BackgroundDocument>(),
    [from, setFrom] = useState(1),
    [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null),
    queryClient = useQueryClient();
  const documentPath = `${base}/sessions/${encodeURIComponent(sessionId ?? "")}/background-documents`;
  const excerpt = useQuery({
    queryKey: ["assistant-background", base, sessionId, view?.id, from],
    queryFn: () =>
      request<Excerpt>(`${documentPath}/${encodeURIComponent(view!.id)}?from=${from}&limit=3`),
    enabled: Boolean(sessionId && view),
    retry: false,
  });
  async function refresh(id: string) {
    await queryClient.invalidateQueries({ queryKey: ["assistant-conversation", projectId, id] });
    await queryClient.invalidateQueries({ queryKey: ["assistant-sessions", projectId] });
  }
  async function upload(file: File) {
    setBusy(true);
    setUploading(true);
    try {
      if (!/\.(pdf|md|txt)$/iu.test(file.name)) throw new Error("assistant_document_format");
      if (
        !file.size ||
        documents.length >= 5 ||
        documents.reduce((size, doc) => size + doc.fileSize, file.size) > 10 * 1024 * 1024
      )
        throw new Error("assistant_document_capacity");
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]!);
        reader.onerror = () => reject(new Error("assistant_document_read_failed"));
        reader.readAsDataURL(file);
      });
      const id = await getSession();
      await request(`${base}/sessions/${encodeURIComponent(id)}/background-documents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: file.name, contentBase64 }),
      });
      await refresh(id);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
      setUploading(false);
    }
  }
  async function remove() {
    if (!sessionId || !removing) return;
    setBusy(true);
    try {
      await request(`${documentPath}/${encodeURIComponent(removing.id)}`, { method: "DELETE" });
      setView(undefined);
      setRemoving(undefined);
      await queryClient.invalidateQueries({ queryKey: ["assistant-background", base, sessionId] });
      await refresh(sessionId);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="会话背景" className="space-y-3 rounded-md border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">背景文档</h3>
        {canWrite && (
          <>
            <input
              ref={fileInput}
              type="file"
              aria-label="上传背景文档"
              accept=".pdf,.md,.txt"
              className="sr-only"
              disabled={disabled}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void upload(file);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || documents.length >= 5}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip className="size-4" />
              {uploading ? "正在提取…" : "添加文档"}
            </Button>
          </>
        )}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        PDF、MD、TXT · 最多 5 份，合计 10 MB。只用于本会话背景，不占数据来源名额。
      </p>
      {!documents.length && (
        <p className="text-sm text-muted-foreground">先添加标准或说明，再说“按附件要求处理”。</p>
      )}
      {documents.map((doc) => (
        <div key={doc.id} className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2">
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm" title={doc.fileName}>
              {doc.fileName}
            </p>
            <p className="text-xs text-muted-foreground">
              {doc.units} {doc.format === "pdf" ? "页" : "行"}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`查看背景 ${doc.fileName}`}
            onClick={() => {
              setView(doc);
              setFrom(1);
            }}
          >
            查看
          </Button>
          {canWrite && (
            <Button
              size="icon"
              variant="ghost"
              className="size-8 shrink-0"
              disabled={disabled}
              aria-label={`移除背景 ${doc.fileName}`}
              onClick={() => setRemoving(doc)}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      ))}
      <Dialog
        open={Boolean(view)}
        onOpenChange={(open) => {
          if (!open) setView(undefined);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{view?.fileName}</DialogTitle>
            <DialogDescription>可定位提取文本；PDF 页号按原文件物理页计算。</DialogDescription>
          </DialogHeader>
          {excerpt.isPending ? (
            <p className="text-sm text-muted-foreground">正在读取文档…</p>
          ) : excerpt.error ? (
            <p role="alert" className="text-sm text-destructive">
              文档暂不可读，请检查权限或重新打开。
            </p>
          ) : (
            excerpt.data?.fragments.map((fragment) => (
              <section key={fragment.index} className="space-y-2 rounded-md border p-4">
                <h4 className="text-xs font-medium text-muted-foreground">
                  {fragment.page
                    ? `第 ${fragment.page} 页`
                    : `第 ${fragment.startLine}–${fragment.endLine} 行`}
                </h4>
                <p className="whitespace-pre-wrap break-words text-sm leading-6">{fragment.text}</p>
              </section>
            ))
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              片段 {from}–{Math.min(from + 2, view?.fragmentCount ?? 0)} /{" "}
              {view?.fragmentCount ?? 0}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={from === 1 || excerpt.isPending}
                onClick={() => setFrom(Math.max(1, from - 3))}
              >
                上一组
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={from + 3 > (view?.fragmentCount ?? 0) || excerpt.isPending}
                onClick={() => setFrom(from + 3)}
              >
                下一组
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>移除背景文档？</AlertDialogTitle>
            <AlertDialogDescription>
              移除后将清除本会话正文和引用该背景的未采用任务正文，旧确认会失效。已采用的数据保留。此操作不能撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disabled}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={disabled}
              onClick={(event) => {
                event.preventDefault();
                void remove();
              }}
            >
              确认移除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
