import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { MaterialRecordTable } from "./material-record-table";
import { EmptyBlock, StateView } from "./state-view";
import { useProjectAccess } from "@/hooks/use-project-access";
import { registerAssistantFlush } from "@/services/assistant-page-bridge";
import {
  handoffInputContext,
  inputContextKey,
  type InputContext,
} from "@/services/assistant-input-context";
import { request, type UnifiedRecord } from "@/services/workspace";
import type { Source } from "@/services/formal-assistant";

type RecordRef = Pick<UnifiedRecord, "assetId" | "ordinal">;
const key = (r: RecordRef) => `${r.assetId}:${r.ordinal}`;
export function MaterialRecordSelection({
  projectId,
  collectionId,
  assetId,
  records,
  search,
  total,
  includeSourceFile = false,
  isLoading = false,
  error: recordsError = null,
  onRetry,
}: {
  projectId: string;
  collectionId: string;
  assetId?: string;
  records: UnifiedRecord[];
  search: string;
  total: number;
  includeSourceFile?: boolean;
  isLoading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  const access = useProjectAccess(projectId),
    client = useQueryClient(),
    navigate = useNavigate();
  const [selected, setSelected] = useState<RecordRef[]>([]),
    [touched, setTouched] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const contextKey = inputContextKey(projectId, access.actorId);
  async function freeze(mode: "selected" | "matching" | "file") {
    if (mode === "selected" && !selected.length) {
      setError("请先勾选记录，或明确选择其他范围。");
      return false;
    }
    setBusy(true);
    setError("");
    try {
      const fixed = await request<{ source: Source; sourceRevision: string; total: number }>(
        `/api/projects/${encodeURIComponent(projectId)}/assistant-runtime/input-scope`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            collectionId,
            ...(assetId ? { assetId } : {}),
            mode,
            ...(mode === "selected" ? { records: selected } : {}),
            ...(mode === "matching" ? { search } : {}),
          }),
        },
      );
      if (fixed.source.kind !== "assets" || !fixed.source.recordIds?.length || !fixed.total)
        throw Error("empty_scope");
      client.setQueryData<InputContext>(contextKey, {
        kind: "asset",
        id: fixed.source.assetIds[0]!,
        source: fixed.source,
        inputSelection: {
          recordIds: fixed.source.recordIds,
          sourceRevision: fixed.sourceRevision,
          total: fixed.total,
        },
      });
      return true;
    } catch {
      setError("所选范围无法核对。请刷新来源并重新选择，未扩大范围。");
      return false;
    } finally {
      setBusy(false);
    }
  }
  useEffect(
    () =>
      registerAssistantFlush(projectId, access.actorId, async () =>
        touched ? freeze("selected") : true,
      ),
    [projectId, access.actorId, selected, touched],
  );
  useEffect(
    () => () => client.removeQueries({ queryKey: contextKey, exact: true }),
    [client, projectId, access.actorId],
  );
  async function handoff(mode: "selected" | "matching" | "file") {
    if (!(await freeze(mode))) return;
    const handoff = handoffInputContext(client, projectId, access.actorId);
    if (!handoff) return;
    void navigate({
      to: "/projects/$projectId/assistant",
      params: { projectId },
      search: { selection: handoff.token, sourceKind: "asset", sourceId: handoff.context.id },
    });
  }
  function toggle(record: UnifiedRecord) {
    setTouched(true);
    setError("");
    setSelected((current) =>
      current.some((r) => key(r) === key(record))
        ? current.filter((r) => key(r) !== key(record))
        : [...current, { assetId: record.assetId, ordinal: record.ordinal }],
    );
  }
  return (
    <div>
      {access.canRead && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !records.length}
            onClick={() => {
              setTouched(true);
              setSelected((old) => [
                ...new Map(
                  [...old, ...records.map(({ assetId, ordinal }) => ({ assetId, ordinal }))].map(
                    (r) => [key(r), r],
                  ),
                ).values(),
              ]);
            }}
          >
            勾选本页
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !selected.length}
            onClick={() => {
              setTouched(true);
              setSelected([]);
              client.removeQueries({ queryKey: contextKey, exact: true });
            }}
          >
            清空选择
          </Button>
          <span className="text-sm text-muted-foreground">已选 {selected.length} 条</span>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !selected.length}
            onClick={() => void handoff("selected")}
          >
            <MessageSquare className="size-4" />
            交给助手
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" disabled={busy}>
                其他范围
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem disabled={!total} onSelect={() => void handoff("matching")}>
                将全部匹配记录交给助手（{total} 条）
              </DropdownMenuItem>
              {assetId && (
                <DropdownMenuItem onSelect={() => void handoff("file")}>
                  将整个文件交给助手
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {error && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <StateView
        isLoading={isLoading}
        error={recordsError}
        data={records}
        isEmpty={(data) => data.length === 0}
        {...(onRetry ? { onRetry } : {})}
        empty={<EmptyBlock title="没有可浏览的记录" />}
      >
        {(data) => (
          <MaterialRecordTable
            projectId={projectId}
            collectionId={collectionId}
            records={data}
            includeSourceFile={includeSourceFile}
            {...(access.canRead
              ? {
                  selection: {
                    has: (r: UnifiedRecord) => selected.some((s) => key(s) === key(r)),
                    toggle,
                    disabled: busy,
                  },
                }
              : {})}
          />
        )}
      </StateView>
    </div>
  );
}
