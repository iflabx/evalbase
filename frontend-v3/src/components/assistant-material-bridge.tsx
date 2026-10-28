import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ConfirmedUploadDialog } from "./confirmed-upload-dialog";
import { MaterialPreparation } from "./material-preparation";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { listCollections } from "@/services/workspace";
import type { NativeAction, Source } from "@/services/formal-assistant";

export function AssistantMaterialBridge({
  projectId,
  action,
  canWrite,
  onClose,
  onUploaded,
}: {
  projectId: string;
  action: NativeAction | null;
  canWrite: boolean;
  onClose: () => void;
  onUploaded: (
    source: Source,
    names: string[],
    unmapped: { id: string; fileName: string; collectionId: string }[],
  ) => void;
}) {
  const client = useQueryClient();
  const collections = useQuery({
    queryKey: ["assistant-upload-targets", projectId],
    queryFn: () => listCollections(projectId, { limit: 100, offset: 0 }),
    enabled: !!action && action.kind === "upload" && canWrite,
  });
  if (!action || !canWrite) return null;
  if (action.kind === "upload")
    return (
      <>
        {collections.isError ? (
          <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>上传原始数据</DialogTitle>
              </DialogHeader>
              <p role="alert">无法读取上传位置。</p>
              <Button variant="outline" onClick={() => void collections.refetch()}>
                重试
              </Button>
            </DialogContent>
          </Dialog>
        ) : (
          <ConfirmedUploadDialog
            key={`${projectId}:${action.id}`}
            open
            projectId={projectId}
            collections={(collections.data?.items ?? []).map(({ id, name }) => ({ id, name }))}
            defaultCollectionId={
              action.collectionId ?? collections.data?.items.find((c) => c.isUnfiled)?.id ?? ""
            }
            onOpenChange={(open) => !open && onClose()}
            onConfirmed={async (assets, collectionId, mode) => {
              await client.invalidateQueries({ queryKey: ["collections", projectId] });
              await client.invalidateQueries({ queryKey: ["material-files", projectId] });
              onUploaded(
                { kind: "assets", assetIds: assets.map((a) => a.id) },
                assets.map((a) => a.fileName),
                mode === "raw" ? assets.map((a) => ({ ...a, collectionId })) : [],
              );
            }}
          />
        )}
      </>
    );
  if (action.kind === "mapping" && action.assetId)
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-h-[calc(100vh-2rem)] w-[min(1180px,calc(100vw-2rem))] max-w-none overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{action.name ? `整理 ${action.name}` : "整理文件字段"}</DialogTitle>
          </DialogHeader>
          <MaterialPreparation
            projectId={projectId}
            assetId={action.assetId}
            canWrite={canWrite}
            onPrepared={async () => {
              onUploaded(
                { kind: "assets", assetIds: [action.assetId!] },
                [action.name ?? "已整理文件"],
                [],
              );
              onClose();
            }}
          />
        </DialogContent>
      </Dialog>
    );
  return null;
}
