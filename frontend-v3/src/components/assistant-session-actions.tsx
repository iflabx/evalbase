import { useState } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { request } from "@/services/workspace";

export function AssistantSessionActions({
  base,
  sessionId,
  title,
  disabled,
  setBusy,
  onRenamed,
  onDeleted,
}: {
  base: string;
  sessionId: string | undefined;
  title: string;
  disabled: boolean;
  setBusy: (busy: boolean) => void;
  onRenamed: (title: string) => Promise<void>;
  onDeleted: (id: string) => Promise<void>;
}) {
  const [action, setAction] = useState<"rename" | "delete">(),
    [name, setName] = useState(""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  async function submit() {
    if (!sessionId || saving || (action === "rename" && !name.trim())) return;
    const id = sessionId;
    setSaving(true);
    setBusy(true);
    setError("");
    try {
      if (action === "rename") {
        const result = await request<{ title: string }>(
          `${base}/sessions/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: name.trim() }),
          },
        );
        await onRenamed(result.title);
      } else {
        await request(`${base}/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
        await onDeleted(id);
      }
      setAction(undefined);
    } catch {
      if (action === "delete") {
        try {
          const current = await request<{ exists: boolean }>(
            `${base}/sessions/${encodeURIComponent(id)}/status`,
          );
          if (current.exists === false) {
            await onDeleted(id);
            setAction(undefined);
            return;
          }
        } catch {
          // An unavailable status cannot prove deletion; retain the dialog and input.
        }
      }
      setError(
        action === "rename"
          ? "重命名未完成，名称已保留，请重试。"
          : "删除未完成，请重试或刷新核对会话。已创建的数据不会删除。",
      );
    } finally {
      setSaving(false);
      setBusy(false);
    }
  }
  function close(open: boolean) {
    if (!open && !saving) setAction(undefined);
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            aria-label="会话操作"
            disabled={disabled || !sessionId}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              setName(title);
              setError("");
              setAction("rename");
            }}
          >
            <Pencil className="mr-2 size-4" />
            重命名
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => {
              setError("");
              setAction("delete");
            }}
          >
            <Trash2 className="mr-2 size-4" />
            删除会话
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={action === "rename"} onOpenChange={close}>
        <DialogContent
          className="max-w-md"
          onEscapeKeyDown={(e) => {
            if (saving) e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
            <DialogDescription>为会话取一个容易识别的名称，最多 80 字。</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="assistant-session-name">会话名称</Label>
              <Input
                id="assistant-session-name"
                value={name}
                maxLength={80}
                disabled={saving}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => setAction(undefined)}
              >
                取消
              </Button>
              <Button type="submit" disabled={saving || !name.trim()}>
                {saving ? "保存中…" : "保存名称"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={action === "delete"} onOpenChange={close}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>删除会话？</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              “{title}
              ”的消息、背景文档和未确认操作将删除，未完成任务将停止，此操作无法撤销。已创建的资料、草稿和正式版本保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={saving}
              onClick={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              {saving ? "删除中…" : "确认删除会话"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
