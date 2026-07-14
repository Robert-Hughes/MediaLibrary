export function verificationDialogToShow(
  targetOutcomeCount: number,
  legacyOutcomeFileCount: number,
): "target" | "legacy" | null {
  if (targetOutcomeCount > 0) return "target";
  if (legacyOutcomeFileCount > 0) return "legacy";
  return null;
}
