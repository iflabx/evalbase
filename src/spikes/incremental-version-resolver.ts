export interface VersionMember {
  caseId: string;
  revisionId: string;
  position: number;
}

export type VersionChange =
  | {
      kind: "upsert";
      caseId: string;
      revisionId: string;
      position: number;
    }
  | { kind: "delete"; caseId: string };

export function resolveSpikeVersion(
  checkpoint: readonly VersionMember[],
  deltaChain: readonly (readonly VersionChange[])[],
): VersionMember[] {
  const members = new Map<string, VersionMember>();
  for (const member of checkpoint) members.set(member.caseId, member);
  for (const changes of deltaChain) {
    const changedCases = new Set<string>();
    for (const change of changes) {
      if (changedCases.has(change.caseId))
        throw new Error(`Duplicate change for ${change.caseId}`);
      changedCases.add(change.caseId);
      if (change.kind === "delete") members.delete(change.caseId);
      else
        members.set(change.caseId, {
          caseId: change.caseId,
          revisionId: change.revisionId,
          position: change.position,
        });
    }
  }
  const resolved = [...members.values()].sort(
    (left, right) => left.position - right.position,
  );
  const positions = new Set<number>();
  for (const member of resolved) {
    if (positions.has(member.position))
      throw new Error(`Duplicate position ${member.position}`);
    positions.add(member.position);
  }
  return resolved;
}
