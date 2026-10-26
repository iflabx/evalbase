import { createRequestId } from "@/lib/request-id";
import { useEffect, useRef, useState } from "react";
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

export type BudgetUse = {
  modelSteps: number;
  toolCalls: number;
  transportRetries: number;
  requestAttempts: number;
  activeMs: number;
};
export type BudgetOffer = {
  id: string;
  taskId: string;
  revision: number;
  purpose: "continue" | "repair";
  limits: BudgetUse;
  validUntil: number;
};
export type AssistantBudgetFacts = { used: BudgetUse; authorized: BudgetUse; grantCount: number };
const usageText = (v: BudgetUse) =>
  `模型步 ${v.modelSteps} · 工具 ${v.toolCalls} · 请求 ${v.requestAttempts} · 传输重试 ${v.transportRetries} · 活跃时间 ${Math.ceil(v.activeMs / 1000)} 秒`;
export function BudgetSummary({ budget }: { budget: AssistantBudgetFacts }) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">执行额度记录</summary>
      <div className="mt-2 space-y-1 break-words">
        <p>累计已用：{usageText(budget.used)}</p>
        <p>累计获准：{usageText(budget.authorized)}</p>
        <p>原额度与历史消耗保留；等待用户或后台不计活跃时间。</p>
      </div>
    </details>
  );
}
export function AssistantBudget({
  base,
  sessionId,
  taskId,
  revision,
  title,
  requirements,
  scope,
  offers,
  budget,
  disabled,
  onBusy,
  onRefresh,
  onError,
}: {
  base: string;
  sessionId: string;
  taskId: string;
  revision: number;
  title: string;
  requirements?: string[] | undefined;
  scope?: { pendingRequest: string | null; remainingSteps: string[] } | undefined;
  offers?: { continue?: BudgetOffer | null; repair?: BudgetOffer | null } | undefined;
  budget?: AssistantBudgetFacts | undefined;
  disabled: boolean;
  onBusy: (v: boolean) => void;
  onRefresh: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const [selected, setSelected] = useState<{ offer: BudgetOffer; key: string }>();
  const [now, setNow] = useState(Date.now);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState("");
  const inFlight = useRef(false);
  const expires = Math.min(
    ...[
      offers?.continue?.validUntil,
      offers?.repair?.validUntil,
      selected?.offer.validUntil,
    ].filter((v): v is number => v !== undefined && v > now),
  );
  useEffect(() => {
    if (!Number.isFinite(expires)) return;
    const timer = setTimeout(
      () => {
        setNow(Date.now());
        void onRefresh();
      },
      Math.max(0, expires - Date.now()) + 5,
    );
    return () => clearTimeout(timer);
  }, [expires, onRefresh]);
  const offer = selected?.offer;
  const current = offer && offers?.[offer.purpose];
  const valid = Boolean(
    offer &&
    current?.id === offer.id &&
    offer.taskId === taskId &&
    offer.revision === revision &&
    offer.validUntil > now &&
    offer.validUntil > Date.now(),
  );
  async function grant() {
    if (!selected || !valid || disabled || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    onBusy(true);
    setFailure("");
    try {
      await request(base + "/sessions/" + encodeURIComponent(sessionId) + "/grant", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": selected.key },
        body: JSON.stringify({
          expectedTaskRevision: offer!.revision,
          offerId: offer!.id,
          purpose: offer!.purpose,
          accept: true,
        }),
      });
      setSelected(undefined);
    } catch (e) {
      setFailure("未确认追加成功，请核对刷新后的额度；已有输入与成果保留。");
      onError(e);
    } finally {
      try {
        await onRefresh();
      } finally {
        inFlight.current = false;
        setSaving(false);
        onBusy(false);
      }
    }
  }
  return (
    <>
      {(["continue", "repair"] as const).map((p) => {
        const o = offers?.[p];
        return o && o.taskId === taskId && o.revision === revision && o.validUntil > now ? (
          <Button
            key={p}
            size="sm"
            variant="outline"
            disabled={disabled || saving}
            onClick={() => {
              setSelected({ offer: o, key: createRequestId() });
              setFailure("");
            }}
          >
            {p === "repair" ? "查看修复额度" : "查看继续额度"}
          </Button>
        ) : null;
      })}
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open && !saving) setSelected(undefined);
        }}
      >
        <DialogContent
          className="flex max-h-[calc(100dvh-2rem)] max-w-lg flex-col overflow-hidden"
          onEscapeKeyDown={(e) => {
            if (saving) e.preventDefault();
          }}
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {offer?.purpose === "repair" ? "授权一次有限修复" : "授权继续当前任务"}
            </DialogTitle>
            <DialogDescription>
              最多再执行一段；不会清零旧消耗，也不会自动追加下一份额度。
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto break-words text-sm">
            <p className="font-medium">{title}</p>
            {requirements?.length ? (
              <ul className="list-disc pl-5 text-xs text-muted-foreground">
                {requirements.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            ) : null}
            {scope?.pendingRequest && (
              <p className="whitespace-pre-wrap">待保存要求：{scope.pendingRequest}</p>
            )}
            {Boolean(scope?.remainingSteps.length) && (
              <details className="text-xs">
                <summary className="cursor-pointer">
                  未完成步骤（{scope!.remainingSteps.length}）
                </summary>
                <ol className="mt-2 list-decimal pl-5">
                  {scope!.remainingSteps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </details>
            )}
            <p>
              {offer?.purpose === "repair"
                ? "仅对本次未保存修改新建一次有界修复尝试，最多2次纠正，其中最多1次截断重提；旧消耗和失败记录保留。"
                : "从当前未完成位置继续，已完成操作不重复。"}
            </p>
            {offer && <p>本次上限：{usageText(offer.limits)}</p>}
            {budget && <BudgetSummary budget={budget} />}
            {!valid && (
              <p role="status" className="text-muted-foreground">
                额度信息已更新或过期，请关闭后重新查看。
              </p>
            )}
            {failure && (
              <p role="alert" className="text-destructive">
                {failure}
              </p>
            )}
          </div>
          <DialogFooter className="shrink-0">
            <Button
              variant="outline"
              autoFocus
              disabled={saving}
              onClick={() => setSelected(undefined)}
            >
              暂不授权
            </Button>
            <Button disabled={!valid || disabled || saving} onClick={() => void grant()}>
              {saving
                ? "正在提交…"
                : offer?.purpose === "repair"
                  ? "确认授权修复"
                  : "确认授权并继续"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
