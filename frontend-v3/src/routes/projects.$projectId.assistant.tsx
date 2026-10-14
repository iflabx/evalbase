import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { ProjectAssistant, type AssistantPageContext } from "@/components/project-assistant";
import { useProjectAccess } from "@/hooks/use-project-access";

export const Route = createFileRoute("/projects/$projectId/assistant")({
  validateSearch: (search: Record<string, unknown>) => ({
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
      pageContext={
        search.sourceKind && search.sourceId
          ? { kind: search.sourceKind, id: search.sourceId }
          : undefined
      }
    />
  );
}
