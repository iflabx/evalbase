import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ModelConnectionSettings } from "./model-connection-settings";
import { request } from "@/services/workspace";
import type { NativeAction } from "@/services/formal-assistant";

/** Credentials stay inside the native form, outside assistant envelopes and events. */
export function AssistantManagementBridge({
  action,
  onClose,
  projectId,
}: {
  action: NativeAction | null;
  onClose: () => void;
  projectId: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [done, setDone] = useState(false);
  if (!action || !["model_settings", "sign_out", "recycle_management"].includes(action.kind))
    return null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{action.name ?? "账号与项目设置"}</DialogTitle>
        </DialogHeader>
        {action.kind === "model_settings" ? (
          <ModelConnectionSettings prepared={action.configuration} />
        ) : action.kind === "sign_out" ? (
          <>
            <p className="text-sm text-muted-foreground">
              退出当前浏览器登录，已保存成果仍会保留。
            </p>
            {error && <p role="alert">{error}</p>}
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await request("/api/session", { method: "DELETE" });
                  window.location.assign("/login");
                } catch {
                  setError("登出失败，请重试。");
                  setBusy(false);
                }
              }}
            >
              确认登出
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {action.operation === "tombstone"
                ? "删除中间版本内容，保留版本关系；此操作不可恢复。"
                : "永久删除该回收站条目及其内容，此操作不可恢复。"}
            </p>
            <label className="text-sm" htmlFor="management-confirmation">
              输入 {action.confirmationName} 以确认
            </label>
            <Input
              id="management-confirmation"
              value={confirmation}
              disabled={busy || done}
              onChange={(e) => setConfirmation(e.target.value)}
            />
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {done ? (
              <p role="status">操作已完成 · 服务端已确认</p>
            ) : (
              <Button
                variant="destructive"
                disabled={
                  busy || !action.confirmationName || confirmation !== action.confirmationName
                }
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const url =
                      action.operation === "tombstone"
                        ? `/api/projects/${projectId}/solo-test-sets/${encodeURIComponent(action.testSetId!)}/versions/${encodeURIComponent(action.versionId!)}/tombstone`
                        : `/api/projects/${projectId}/solo-test-set-trash/${encodeURIComponent(action.entryId!)}/permanent-delete`;
                    await request(url, {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ confirmation }),
                    });
                    setDone(true);
                  } catch {
                    setError("操作未确认完成，输入已保留。请先核对原生页面中的状态。");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy
                  ? "正在处理…"
                  : action.operation === "tombstone"
                    ? "删除版本内容，保留关系"
                    : "永久删除"}
              </Button>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
