/** One kind/field contract for model declarations, execution and contextual repair. */
export const projectQueryFields: Record<string, readonly string[]> = {
  project: ["kind"],
  files: ["kind", "search", "offset"],
  testSets: ["kind", "search", "offset"],
  versions: ["kind", "search", "offset", "testSetId"],
  drafts: ["kind", "search", "offset", "testSetId"],
};
export function projectQueryConstraints(name: string) {
  if (name !== "query_project") return {};
  return {
    allOf: Object.entries(projectQueryFields).map(([kind, fields]) => ({
      if: { properties: { kind: { const: kind } }, required: ["kind"] },
      then: {
        properties: Object.fromEntries(
          ["search", "offset", "testSetId"]
            .filter((field) => !fields.includes(field))
            .map((field) => [field, false]),
        ),
      },
    })),
  };
}
