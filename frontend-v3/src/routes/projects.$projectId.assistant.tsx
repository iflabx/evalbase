import { readInputContext } from "@/services/assistant-input-context";
import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { ProjectAssistant, type AssistantPageContext } from "@/components/project-assistant";
import { useProjectAccess } from "@/hooks/use-project-access";

export const Route = createFileRoute("/projects/$projectId/assistant")({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    selection?: string | undefined;
    sourceKind: AssistantPageContext["kind"] | undefined;
    sourceId: string | undefined;
  } => ({
    selection:
      search["selection"] === undefined
        ? undefined
        : typeof search["selection"] === "string" &&
            search["selection"].length > 0 &&
            search["selection"].length <= 128
          ? search["selection"]
          : "invalid",
    sourceKind: ["asset", "draft", "version", "testSet"].includes(String(search["sourceKind"]))
      ? (String(search["sourceKind"]) as AssistantPageContext["kind"])
      : undefined,
    sourceId:
      typeof search["sourceId"] === "string" && search["sourceId"].length <= 250
        ? search["sourceId"]
        : undefined,
  }),
  component: AssistantPage,
});
function AssistantPage() {
  const { projectId } = Route.useParams(),
    search = Route.useSearch(),
    access = useProjectAccess(projectId);
  const sessionId = useRouterState({
    select: (state) => state.location.pathname.match(/\/assistant\/([^/]+)\/?$/)?.[1],
  });
  return (
    <ProjectAssistant
      key={`${projectId}:${access.actorId}:${access.canWrite}`}
      projectId={projectId}
      actorId={access.actorId}
      canWrite={access.canWrite}
      sessionId={sessionId}
      selectionToken={search["selection"]}
      selectionMissing={Boolean(
        search["selection"] && !readInputContext(search["selection"], projectId, access.actorId),
      )}
      pageContext={
        readInputContext(search["selection"], projectId, access.actorId) ??
        (search.sourceKind && search.sourceId
          ? { kind: search.sourceKind, id: search.sourceId }
          : undefined)
      }
    />
  );
}
