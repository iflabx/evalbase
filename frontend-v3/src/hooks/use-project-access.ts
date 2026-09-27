import { useQuery } from "@tanstack/react-query";
import { request } from "@/services/workspace";

export function useProjectAccess(projectId: string) {
  const query = useQuery({
    queryKey: ["project-access", projectId],
    queryFn: async () =>
      (
        await request<{
          access: {
            role: string;
            capabilities: { read: boolean; write: boolean; export: boolean; manage: boolean };
          };
        }>(`/api/projects/${encodeURIComponent(projectId)}/access`)
      ).access,
    enabled: !!projectId,
  });
  return {
    ...query,
    canWrite: query.data?.capabilities.write === true,
    canManage: query.data?.capabilities.manage === true,
  };
}
