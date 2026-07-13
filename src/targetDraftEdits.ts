import type {
  MetadataDraftEdit,
  MetadataDraftEntryV5,
  MetadataDraftTarget,
  MetadataValue,
  SetDraftOutcome,
} from "./types";
import { metadataValueEqual } from "./types";
import {
  compareMetadataDraftTargetsBySlot,
  metadataDraftTargetSlotToken,
} from "./utils/metadataDraftTarget";
import { isMetadataDraftEntryV5, isRecord } from "./utils/metadataWireGuards";
import { hasOwnStringKey, recordFromEntries } from "./utils/stringRecord";
import { compareUnicodeScalarStrings } from "./utils/unicodeOrdering";

/**
 * The record key is logical slot identity used only for collection mechanics.
 * Every stored value retains the complete persisted target snapshot.
 */
export type TargetDraftCollection = Record<string, MetadataDraftEntryV5>;

export type TargetDraftEditsByFile = Record<string, TargetDraftCollection>;

export interface TargetDraftEditsChange {
  path: string;
  edits: TargetDraftCollection | undefined;
}

export type TargetDraftEditsListener = (
  changes: TargetDraftEditsChange[],
) => void;

function cloneTarget(target: MetadataDraftTarget): MetadataDraftTarget {
  if (target.kind === "NewProperty") {
    return {
      kind: "NewProperty",
      schema_id: { ...target.schema_id },
    };
  }

  return {
    kind: "ExistingOccurrence",
    occurrence_id: { ...target.occurrence_id },
    schema_id: { ...target.schema_id },
    write_target: { ...target.write_target },
  };
}

function cloneEntry(entry: MetadataDraftEntryV5): MetadataDraftEntryV5 {
  return { target: cloneTarget(entry.target), edit: entry.edit };
}

export function validateTargetDraftCollection(
  path: string,
  collection: TargetDraftCollection,
): void {
  const described = Object.entries(collection).map(([recordKey, entry]) => ({
    recordKey,
    entry,
    expectedSlot: metadataDraftTargetSlotToken(entry.target),
  }));
  const seen = new Map<
    string,
    { recordKey: string; target: MetadataDraftTarget }
  >();

  for (const { recordKey, entry, expectedSlot } of described) {
    if (seen.has(expectedSlot)) {
      const previous = seen.get(expectedSlot)!;
      throw new Error(
        `Duplicate target draft slot for '${path}': supplied record key '${recordKey}', expected slot token '${expectedSlot}', complete target ${JSON.stringify(entry.target)}, duplicate target ${JSON.stringify(previous.target)} supplied under record key '${previous.recordKey}'`,
      );
    }
    seen.set(expectedSlot, { recordKey, target: entry.target });
  }

  for (const { recordKey, entry, expectedSlot } of described) {
    if (recordKey !== expectedSlot) {
      throw new Error(
        `Malformed target draft collection for '${path}': supplied record key '${recordKey}', expected slot token '${expectedSlot}', complete target ${JSON.stringify(entry.target)}`,
      );
    }
  }
}

/** Strict schema-v5 wire conversion; duplicate logical slots are rejected. */
export function targetDraftsFromWire(
  wire: Record<string, MetadataDraftEntryV5[]>,
): TargetDraftEditsByFile {
  const draftEntries: Array<readonly [string, TargetDraftCollection]> = [];

  for (const [path, entries] of Object.entries(wire)) {
    if (entries.length === 0) continue;

    const collectionEntries: Array<readonly [string, MetadataDraftEntryV5]> =
      [];
    const seenSlots = new Map<string, MetadataDraftEntryV5>();
    for (const entry of entries) {
      const slot = metadataDraftTargetSlotToken(entry.target);
      if (seenSlots.has(slot)) {
        const previous = seenSlots.get(slot)!;
        throw new Error(
          `Duplicate target draft slot for '${path}' (${slot}); first target ${JSON.stringify(previous.target)}, duplicate target ${JSON.stringify(entry.target)}`,
        );
      }
      seenSlots.set(slot, entry);
      collectionEntries.push([slot, cloneEntry(entry)]);
    }
    draftEntries.push([path, recordFromEntries(collectionEntries)]);
  }

  return recordFromEntries(draftEntries);
}

export function targetDraftsFromUnknownWire(
  raw: unknown,
): TargetDraftEditsByFile {
  if (!isRecord(raw)) {
    throw new Error("Invalid schema-v5 draft wire payload: expected an object");
  }

  const wireEntries: Array<readonly [string, MetadataDraftEntryV5[]]> = [];
  for (const [path, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) {
      throw new Error(
        `Invalid schema-v5 draft wire payload for '${path}': expected an array`,
      );
    }
    for (const [index, entry] of value.entries()) {
      if (!isMetadataDraftEntryV5(entry)) {
        throw new Error(
          `Invalid schema-v5 draft entry for '${path}' at array index ${index}`,
        );
      }
    }
    wireEntries.push([path, value]);
  }

  return targetDraftsFromWire(recordFromEntries(wireEntries));
}

/** Deterministic schema-v5 wire conversion ordered exactly by Rust slot order. */
export function targetDraftsToWire(
  drafts: TargetDraftEditsByFile,
): Record<string, MetadataDraftEntryV5[]> {
  for (const [path, collection] of Object.entries(drafts)) {
    validateTargetDraftCollection(path, collection);
  }

  const paths = Object.keys(drafts).sort(compareUnicodeScalarStrings);
  const wireEntries: Array<readonly [string, MetadataDraftEntryV5[]]> = [];

  for (const path of paths) {
    if (!hasOwnStringKey(drafts, path)) continue;
    const entries = Object.values(drafts[path]);
    if (entries.length === 0) continue;
    wireEntries.push([
      path,
      entries
        .slice()
        .sort((left, right) =>
          compareMetadataDraftTargetsBySlot(left.target, right.target),
        )
        .map(cloneEntry),
    ]);
  }

  return recordFromEntries(wireEntries);
}

/**
 * Inactive observable target-aware draft store. It is intentionally not wired
 * into AppState, React, persistence, apply, or search-worker indexing.
 */
export class TargetDraftEditsStore {
  private snapshot: TargetDraftEditsByFile = recordFromEntries([]);
  private listeners = new Set<TargetDraftEditsListener>();
  private currentValueResolver?: (
    path: string,
    target: MetadataDraftTarget,
  ) => MetadataValue | undefined;

  setCurrentValueResolver(
    resolver: (
      path: string,
      target: MetadataDraftTarget,
    ) => MetadataValue | undefined,
  ): void {
    this.currentValueResolver = resolver;
  }

  /** Bulk replacement is silent and defensively clones target snapshots. */
  resetMetadata(initial: TargetDraftEditsByFile): void {
    for (const [path, collection] of Object.entries(initial)) {
      validateTargetDraftCollection(path, collection);
    }

    const nextEntries: Array<readonly [string, TargetDraftCollection]> = [];
    for (const [path, collection] of Object.entries(initial)) {
      const cloned = recordFromEntries(
        Object.entries(collection).map(
          ([slot, entry]) => [slot, cloneEntry(entry)] as const,
        ),
      );
      if (Object.keys(cloned).length > 0) nextEntries.push([path, cloned]);
    }
    this.snapshot = recordFromEntries(nextEntries);
  }

  getAllMetadata(): TargetDraftEditsByFile {
    return this.snapshot;
  }

  getMetadataFile(path: string): TargetDraftCollection | undefined {
    return hasOwnStringKey(this.snapshot, path)
      ? this.snapshot[path]
      : undefined;
  }

  private removeSlot(path: string, slot: string): void {
    if (!hasOwnStringKey(this.snapshot, path)) return;
    const current = this.snapshot[path];
    if (!hasOwnStringKey(current, slot)) return;

    const updated = recordFromEntries(Object.entries(current));
    delete updated[slot];
    const next =
      Object.keys(updated).length === 0
        ? recordFromEntries(
            Object.entries(this.snapshot).filter(([key]) => key !== path),
          )
        : recordFromEntries([
            ...Object.entries(this.snapshot),
            [path, updated] as const,
          ]);
    this.snapshot = next;
  }

  private applyOne(
    path: string,
    target: MetadataDraftTarget,
    edit: MetadataDraftEdit,
  ): SetDraftOutcome {
    const slot = metadataDraftTargetSlotToken(target);
    const currentCollection = hasOwnStringKey(this.snapshot, path)
      ? this.snapshot[path]
      : undefined;
    const existing =
      currentCollection && hasOwnStringKey(currentCollection, slot)
        ? currentCollection[slot]
        : undefined;

    if (edit.intent === "Set" && this.currentValueResolver) {
      const current = this.currentValueResolver(path, target);
      if (metadataValueEqual(current, edit.value ?? undefined)) {
        if (existing) {
          this.removeSlot(path, slot);
          return "cleared";
        }
        return "redundant";
      }
    }

    const stored: MetadataDraftEntryV5 = {
      target: cloneTarget(target),
      edit,
    };
    const collection = recordFromEntries([
      ...Object.entries(currentCollection ?? {}),
      [slot, stored] as const,
    ]);
    this.snapshot = recordFromEntries([
      ...Object.entries(this.snapshot),
      [path, collection] as const,
    ]);
    return "written";
  }

  setMetadataTarget(
    path: string,
    target: MetadataDraftTarget,
    edit: MetadataDraftEdit,
  ): SetDraftOutcome {
    const outcome = this.applyOne(path, target, edit);
    if (outcome !== "redundant") {
      this.notify([{ path, edits: this.getMetadataFile(path) }]);
    }
    return outcome;
  }

  /**
   * Throws before mutation when the input contains duplicate logical slots.
   * A valid batch is applied in input order and emits at most one notification.
   */
  setMetadataBatch(
    path: string,
    entries: MetadataDraftEntryV5[],
  ): Array<{ target: MetadataDraftTarget; outcome: SetDraftOutcome }> {
    if (entries.length === 0) return [];

    const seen = new Map<string, MetadataDraftTarget>();
    for (const entry of entries) {
      const slot = metadataDraftTargetSlotToken(entry.target);
      const previous = seen.get(slot);
      if (previous) {
        throw new Error(
          `Duplicate target draft slot in batch for '${path}' (${slot}); first target ${JSON.stringify(previous)}, duplicate target ${JSON.stringify(entry.target)}`,
        );
      }
      seen.set(slot, entry.target);
    }

    const results = entries.map(({ target, edit }) => ({
      target,
      outcome: this.applyOne(path, target, edit),
    }));
    if (results.some(({ outcome }) => outcome !== "redundant")) {
      this.notify([{ path, edits: this.getMetadataFile(path) }]);
    }
    return results;
  }

  deleteTarget(path: string, target: MetadataDraftTarget): void {
    this.deleteTargets(path, [target]);
  }

  deleteTargets(path: string, targets: MetadataDraftTarget[]): void {
    this.deleteSlots(path, targets.map(metadataDraftTargetSlotToken));
  }

  deletePath(path: string): void {
    if (!hasOwnStringKey(this.snapshot, path)) return;
    const next = recordFromEntries(Object.entries(this.snapshot));
    delete next[path];
    this.snapshot = next;
    this.notify([{ path, edits: undefined }]);
  }

  deletePaths(paths: string[]): void {
    const existing = [...new Set(paths)].filter((path) =>
      hasOwnStringKey(this.snapshot, path),
    );
    if (existing.length === 0) return;

    const next = recordFromEntries(Object.entries(this.snapshot));
    for (const path of existing) delete next[path];
    this.snapshot = next;
    this.notify(existing.map((path) => ({ path, edits: undefined })));
  }

  clear(): void {
    const paths = Object.keys(this.snapshot);
    if (paths.length === 0) return;
    this.snapshot = recordFromEntries([]);
    this.notify(paths.map((path) => ({ path, edits: undefined })));
  }

  pruneTargets(path: string, targets: MetadataDraftTarget[]): void {
    this.deleteSlots(path, targets.map(metadataDraftTargetSlotToken));
  }

  subscribe(listener: TargetDraftEditsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private deleteSlots(path: string, slots: string[]): void {
    if (!hasOwnStringKey(this.snapshot, path) || slots.length === 0) return;
    const current = this.snapshot[path];

    const updated = recordFromEntries(Object.entries(current));
    let changed = false;
    for (const slot of new Set(slots)) {
      if (hasOwnStringKey(updated, slot)) {
        delete updated[slot];
        changed = true;
      }
    }
    if (!changed) return;

    const next =
      Object.keys(updated).length === 0
        ? recordFromEntries(
            Object.entries(this.snapshot).filter(([key]) => key !== path),
          )
        : recordFromEntries([
            ...Object.entries(this.snapshot),
            [path, updated] as const,
          ]);
    this.snapshot = next;
    this.notify([{ path, edits: this.getMetadataFile(path) }]);
  }

  private notify(changes: TargetDraftEditsChange[]): void {
    this.listeners.forEach((listener) => listener(changes));
  }
}
