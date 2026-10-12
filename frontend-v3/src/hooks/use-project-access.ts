import { useQuery, useQueryClient } from "@tanstack/react-query";
import { canRetainReadResult, request } from "@/services/workspace";

export function useProjectAccess(projectId: string, enabled = true) {
  const actorId =
    useQueryClient().getQueryData<{ actor: { id: string } }>(["session"])?.actor.id ?? "";
  const query = useQuery({
    queryKey: ["project-access", projectId, actorId],
    queryFn: async () =>
      (
        await request<{
          access: {
            role: string;
            capabilities: { read: boolean; write: boolean; export: boolean; manage: boolean };
          };
        }>(`/api/projects/${encodeURIComponent(projectId)}/access`)
      ).access,
    enabled: !!projectId && !!actorId && enabled,
  });
  return {
    ...query,
    actorId,
    canRead: canRetainReadResult(query.error) && query.data?.capabilities.read === true,
    canWrite: canRetainReadResult(query.error) && query.data?.capabilities.write === true,
    canManage: canRetainReadResult(query.error) && query.data?.capabilities.manage === true,
  };
}
