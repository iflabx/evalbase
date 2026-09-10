export type SourceAttributionInput = {
  sourceType: string;
  sourceName: string;
  responsiblePerson: string;
  purpose: string;
  licenseStatus: string;
  sensitivity: string;
  sourceAddress: string | null;
  acquiredAt: string | null;
  deidentificationConfirmed: boolean;
};

export function validateSourceAttribution(
  value: SourceAttributionInput,
): "source_attribution_incomplete" | undefined {
  if (
    !value.sourceType ||
    !value.sourceName ||
    !value.responsiblePerson ||
    !value.purpose ||
    !value.licenseStatus ||
    !value.sensitivity
  ) {
    return "source_attribution_incomplete";
  }
  if (
    ["public", "deidentified"].includes(value.sourceType) &&
    (!value.sourceAddress ||
      !value.acquiredAt ||
      Number.isNaN(Date.parse(value.acquiredAt)))
  ) {
    return "source_attribution_incomplete";
  }
  return undefined;
}

export function isAllowedSourceAttribution(
  value: SourceAttributionInput,
): boolean {
  const allowed =
    (value.sourceType === "synthetic" &&
      value.licenseStatus === "not_applicable") ||
    (value.sourceType === "owner_confirmed_nonproduction" &&
      value.licenseStatus === "environment_confirmed") ||
    (value.sourceType === "public" && value.licenseStatus === "clear") ||
    (value.sourceType === "deidentified" &&
      value.licenseStatus === "confirmed" &&
      value.deidentificationConfirmed);
  return allowed && value.sensitivity === "non_sensitive";
}
