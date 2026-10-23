import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { request } from "@/services/workspace";
import { BudgetSummary, type AssistantBudgetFacts } from "./assistant-budget";
export function AssistantTaskHistory({
  base,
  sessionId,
  taskId,
  actorId,
  canWrite,
  disabled,
  canFill,
  onRestore,
}: {
  base: string;
  sessionId: string;
  taskId: string;
  actorId: string;
  canWrite: boolean;
  disabled: boolean;
  canFill: boolean;
  onRestore: (message: string, taskId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const checkpoint = useQuery({
    queryKey: ["assistant-task-history", base, sessionId, taskId, actorId, canWrite],
    enabled: open,
    retry: false,
    queryFn: ({ signal }) =>
      request<{
        task: {
          title?: string;
          goal?: string;
          requirementSummary?: string[];
          budget?: AssistantBudgetFacts;
          executionPlan?: { steps: { title: string; status: string }[] };
        };
      }>(
        base +
          "/sessions/" +
          encodeURIComponent(sessionId) +
          "/tasks/" +
          encodeURIComponent(taskId),
        { signal },
      ),
  });
  const task = checkpoint.error ? undefined : checkpoint.data?.task;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        查看历史任务
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-lg flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>{task?.title ?? "历史任务"}</DialogTitle>
            <DialogDescription>只读查看，不改变当前任务、原额度或确认归属。</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto break-words text-sm">
            {checkpoint.isPending && <p>正在读取…</p>}
            {checkpoint.error && (
              <p role="alert">历史任务当前不可读取，请核对访问权限或稍后重试。</p>
            )}
            {task && (
              <>
                <p>{task.goal}</p>
                <ul className="list-disc pl-5">
                  {task.requirementSummary?.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
                <ol className="list-decimal pl-5">
                  {task.executionPlan?.steps.map((s, i) => (
                    <li key={i}>
                      {s.title} · {s.status === "executed" ? "已执行" : "未完成"}
                    </li>
                  ))}
                </ol>
                {task.budget && <BudgetSummary budget={task.budget} />}
              </>
            )}
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setOpen(false)}>
              关闭
            </Button>
            {canWrite && task?.title && (
              <Button
                disabled={disabled || !canFill}
                onClick={() => {
                  onRestore(`恢复任务“${task.title}”`, taskId);
                  setOpen(false);
                }}
              >
                填入恢复请求
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
