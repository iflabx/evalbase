/** One kind/field contract for model declarations, execution and contextual repair. */
export const projectQueryFields: Record<string, readonly string[]> = {
  project: ["kind"],
  files: ["kind", "search", "offset"],
  testSets: ["kind", "search", "offset"],
  versions: ["kind", "search", "offset", "testSetId"],
  drafts: ["kind", "search", "offset", "testSetId"],
};
export function projectQueryConstraints(
  name: string,
  properties: Record<string, unknown>,
) {
  if (name !== "query_project") return {};
  // The configured compatible provider misdecodes if/then and boolean schemas.
  // Enumerated object variants express the same restrictions for every caller.
  return {
    anyOf: Object.entries(projectQueryFields).map(([kind, fields]) => ({
      type: "object",
      properties: Object.fromEntries(
        fields.map((field) => [
          field,
          field === "kind"
            ? { type: "string", enum: [kind] }
            : properties[field],
        ]),
      ),
      additionalProperties: false,
    })),
  };
}
