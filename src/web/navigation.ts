export type RoutePage =
  | "assets"
  | "asset-detail"
  | "workbench"
  | "test-sets"
  | "test-set-detail"
  | "deliveries"
  | "not-found";

export type AppRoute = {
  page: RoutePage;
  id?: string;
  query: Record<string, string>;
};

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

export function parseRoute(input: string): AppRoute {
  const url = new URL(input, "http://agentbench.local");
  const query = Object.fromEntries(url.searchParams.entries());
  const segments: string[] = [];
  for (const segment of url.pathname.split("/").filter(Boolean)) {
    const decoded = decodeSegment(segment);
    if (decoded === undefined) return { page: "not-found", query };
    segments.push(decoded);
  }

  if (
    segments.length === 0 ||
    (segments.length === 1 && segments[0] === "assets")
  )
    return { page: "assets", query };
  if (segments[0] === "assets" && segments.length === 2)
    return { page: "asset-detail", id: segments[1], query };
  if (segments[0] === "workbench" && segments.length === 2)
    return { page: "workbench", id: segments[1], query };
  if (segments.length === 1 && segments[0] === "test-sets")
    return { page: "test-sets", query };
  if (segments[0] === "test-sets" && segments.length === 2)
    return { page: "test-set-detail", id: segments[1], query };
  if (segments.length === 1 && segments[0] === "deliveries")
    return { page: "deliveries", query };
  return { page: "not-found", query };
}
