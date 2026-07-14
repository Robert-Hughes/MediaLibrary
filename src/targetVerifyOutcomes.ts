import type {
  MetadataDraftReconciliation,
  MetadataDraftTarget,
  MetadataTargetOutcome,
  MetadataValue,
} from "./types";
import type { TargetDraftEditsByFile } from "./targetDraftEdits";
import {
  metadataDraftTargetEquals,
  metadataDraftTargetSlotToken,
} from "./utils/metadataDraftTarget";
import { hasOwnStringKey, recordFromEntries } from "./utils/stringRecord";
import { wireStructuralEqual } from "./utils/wireStructuralEquality";

export interface TargetVerifyOutcomeV5 {
  relativePath: string;
  originalTarget: MetadataDraftTarget;
  currentTarget: MetadataDraftTarget;
  reconciliation: MetadataDraftReconciliation;
  displayName: string;
  kind: string;
  sent: MetadataValue | null;
  before: MetadataValue | null;
  observed: MetadataValue | null;
  message: string | null;
}

export type TargetVerifyOutcomesByFileV5 = Record<
  string,
  Record<string, TargetVerifyOutcomeV5>
>;

function immutableClone<T>(value: T): T {
  const cloned = structuredClone(value);
  return deepFreeze(cloned);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function freezeRecord<T>(
  entries: Iterable<readonly [string, T]>,
): Record<string, T> {
  return Object.freeze(recordFromEntries(entries));
}

export function emptyTargetVerifyOutcomesV5(): TargetVerifyOutcomesByFileV5 {
  return freezeRecord([]);
}

export function targetVerifyOutcomeFromBackend(
  relativePath: string,
  outcome: MetadataTargetOutcome,
): TargetVerifyOutcomeV5 | null {
  if (outcome.draft_reconciliation.kind === "Clear") return null;

  const currentTarget =
    outcome.draft_reconciliation.kind === "Replace"
      ? outcome.draft_reconciliation.target
      : outcome.target;
  return immutableClone({
    relativePath,
    originalTarget: outcome.target,
    currentTarget,
    reconciliation: outcome.draft_reconciliation,
    displayName: outcome.display_name,
    kind: outcome.kind,
    sent: outcome.sent,
    before: outcome.before,
    observed: outcome.observed,
    message: outcome.message,
  });
}

export function targetVerifyOutcomesFromBackend(
  relativePath: string,
  outcomes: readonly MetadataTargetOutcome[],
): TargetVerifyOutcomeV5[] {
  return outcomes.flatMap((outcome) => {
    const entry = targetVerifyOutcomeFromBackend(relativePath, outcome);
    return entry === null ? [] : [entry];
  });
}

export function validateTargetVerifyOutcomesAgainstDrafts(
  relativePath: string,
  outcomes: readonly TargetVerifyOutcomeV5[],
  targetDrafts: TargetDraftEditsByFile,
): void {
  const fileDrafts = hasOwnStringKey(targetDrafts, relativePath)
    ? targetDrafts[relativePath]
    : undefined;
  const seen = new Set<string>();

  for (const outcome of outcomes) {
    if (outcome.relativePath !== relativePath) {
      throw new Error(
        `Target verification contract error for '${relativePath}': outcome belongs to '${outcome.relativePath}'`,
      );
    }
    const slot = metadataDraftTargetSlotToken(outcome.currentTarget);
    if (seen.has(slot)) {
      throw new Error(
        `Target verification contract error for '${relativePath}': multiple outcomes resolve to slot ${slot}`,
      );
    }
    seen.add(slot);

    const persisted =
      fileDrafts && hasOwnStringKey(fileDrafts, slot)
        ? fileDrafts[slot]
        : undefined;
    if (!persisted) {
      throw new Error(
        `Target verification contract error for '${relativePath}': persisted draft slot is absent for ${slot}`,
      );
    }
    if (!metadataDraftTargetEquals(persisted.target, outcome.currentTarget)) {
      throw new Error(
        `Target verification contract error for '${relativePath}': persisted target snapshot changed at slot ${slot}`,
      );
    }
  }
}

function fileCollectionFromOutcomes(
  relativePath: string,
  outcomes: readonly TargetVerifyOutcomeV5[],
): Record<string, TargetVerifyOutcomeV5> | undefined {
  const entries: Array<readonly [string, TargetVerifyOutcomeV5]> = [];
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome.relativePath !== relativePath) {
      throw new Error(
        `Cannot store target verification for '${relativePath}' from '${outcome.relativePath}'`,
      );
    }
    const slot = metadataDraftTargetSlotToken(outcome.currentTarget);
    if (seen.has(slot)) {
      throw new Error(
        `Duplicate target verification slot for '${relativePath}' (${slot})`,
      );
    }
    seen.add(slot);
    entries.push([slot, immutableClone(outcome)]);
  }
  return entries.length === 0 ? undefined : freezeRecord(entries);
}

function fileCollectionsEqualExact(
  left: Record<string, TargetVerifyOutcomeV5> | undefined,
  right: Record<string, TargetVerifyOutcomeV5> | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftSlots = Object.keys(left);
  const rightSlots = Object.keys(right);
  return (
    leftSlots.length === rightSlots.length &&
    leftSlots.every(
      (slot) =>
        hasOwnStringKey(right, slot) &&
        wireStructuralEqual(left[slot], right[slot]),
    )
  );
}

export function replaceTargetVerifyOutcomesForFile(
  current: TargetVerifyOutcomesByFileV5,
  relativePath: string,
  outcomes: readonly TargetVerifyOutcomeV5[],
): TargetVerifyOutcomesByFileV5 {
  const candidate = fileCollectionFromOutcomes(relativePath, outcomes);
  const existing = hasOwnStringKey(current, relativePath)
    ? current[relativePath]
    : undefined;
  if (fileCollectionsEqualExact(existing, candidate)) return current;

  const retained = Object.entries(current).filter(
    ([path]) => path !== relativePath,
  );
  return candidate
    ? freezeRecord([...retained, [relativePath, candidate] as const])
    : freezeRecord(retained);
}

export function removeTargetVerifyOutcome(
  current: TargetVerifyOutcomesByFileV5,
  relativePath: string,
  target: MetadataDraftTarget,
): TargetVerifyOutcomesByFileV5 {
  if (!hasOwnStringKey(current, relativePath)) return current;
  const slot = metadataDraftTargetSlotToken(target);
  const file = current[relativePath];
  if (!hasOwnStringKey(file, slot)) return current;
  if (!metadataDraftTargetEquals(file[slot].currentTarget, target))
    return current;

  const retainedFile = Object.entries(file).filter(([key]) => key !== slot);
  return replaceTargetVerifyOutcomesForFile(
    current,
    relativePath,
    retainedFile.map(([, outcome]) => outcome),
  );
}

export function removeTargetVerifyOutcomesForFile(
  current: TargetVerifyOutcomesByFileV5,
  relativePath: string,
): TargetVerifyOutcomesByFileV5 {
  if (!hasOwnStringKey(current, relativePath)) return current;
  return freezeRecord(
    Object.entries(current).filter(([path]) => path !== relativePath),
  );
}

export function pruneTargetVerifyOutcomesAgainstDrafts(
  current: TargetVerifyOutcomesByFileV5,
  targetDrafts: TargetDraftEditsByFile,
): TargetVerifyOutcomesByFileV5 {
  let next = current;
  for (const [path, outcomes] of Object.entries(current)) {
    const drafts = hasOwnStringKey(targetDrafts, path)
      ? targetDrafts[path]
      : undefined;
    const retained = Object.entries(outcomes)
      .filter(([slot, outcome]) => {
        const draft =
          drafts && hasOwnStringKey(drafts, slot) ? drafts[slot] : undefined;
        return (
          !!draft &&
          metadataDraftTargetEquals(draft.target, outcome.currentTarget)
        );
      })
      .map(([, outcome]) => outcome);
    next = replaceTargetVerifyOutcomesForFile(next, path, retained);
  }
  return next;
}

export function clearTargetVerifyOutcomes(
  current: TargetVerifyOutcomesByFileV5,
): TargetVerifyOutcomesByFileV5 {
  return Object.keys(current).length === 0
    ? current
    : emptyTargetVerifyOutcomesV5();
}
