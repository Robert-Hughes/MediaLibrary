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

/** Strict schema-v5 wire conversion; duplicate logical slots are rejected. */
export function targetDraftsFromWire(
  wire: Record<string, MetadataDraftEntryV5[]>,
): TargetDraftEditsByFile {
  const drafts: TargetDraftEditsByFile = {};

  for (const [path, entries] of Object.entries(wire)) {
    if (entries.length === 0) continue;

    const collection: TargetDraftCollection = {};
    for (const entry of entries) {
      const slot = metadataDraftTargetSlotToken(entry.target);
      const previous = collection[slot];
      if (previous) {
        throw new Error(
          `Duplicate target draft slot for '${path}' (${slot}); first target ${JSON.stringify(previous.target)}, duplicate target ${JSON.stringify(entry.target)}`,
        );
      }
      collection[slot] = cloneEntry(entry);
    }
    drafts[path] = collection;
  }

  return drafts;
}

/** Deterministic schema-v5 wire conversion ordered exactly by Rust slot order. */
export function targetDraftsToWire(
  drafts: TargetDraftEditsByFile,
): Record<string, MetadataDraftEntryV5[]> {
  const wire: Record<string, MetadataDraftEntryV5[]> = {};
  const paths = Object.keys(drafts).sort(compareUnicodeScalarStrings);

  for (const path of paths) {
    const entries = Object.values(drafts[path]);
    if (entries.length === 0) continue;
    wire[path] = entries
      .slice()
      .sort((left, right) =>
        compareMetadataDraftTargetsBySlot(left.target, right.target),
      )
      .map(cloneEntry);
  }

  return wire;
}

/**
 * Inactive observable target-aware draft store. It is intentionally not wired
 * into AppState, React, persistence, apply, or search-worker indexing.
 */
export class TargetDraftEditsStore {
  private snapshot: TargetDraftEditsByFile = {};
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
    const next: TargetDraftEditsByFile = {};
    for (const [path, collection] of Object.entries(initial)) {
      const cloned: TargetDraftCollection = {};
      for (const entry of Object.values(collection)) {
        const stored = cloneEntry(entry);
        cloned[metadataDraftTargetSlotToken(stored.target)] = stored;
      }
      if (Object.keys(cloned).length > 0) next[path] = cloned;
    }
    this.snapshot = next;
  }

  getAllMetadata(): TargetDraftEditsByFile {
    return this.snapshot;
  }

  getMetadataFile(path: string): TargetDraftCollection | undefined {
    return this.snapshot[path];
  }

  private removeSlot(path: string, slot: string): void {
    const current = this.snapshot[path];
    if (!current || !(slot in current)) return;

    const updated = { ...current };
    delete updated[slot];
    const next = { ...this.snapshot };
    if (Object.keys(updated).length === 0) delete next[path];
    else next[path] = updated;
    this.snapshot = next;
  }

  private applyOne(
    path: string,
    target: MetadataDraftTarget,
    edit: MetadataDraftEdit,
  ): SetDraftOutcome {
    const slot = metadataDraftTargetSlotToken(target);
    const existing = this.snapshot[path]?.[slot];

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
    const collection = {
      ...(this.snapshot[path] ?? {}),
      [slot]: stored,
    };
    this.snapshot = { ...this.snapshot, [path]: collection };
    return "written";
  }

  setMetadataTarget(
    path: string,
    target: MetadataDraftTarget,
    edit: MetadataDraftEdit,
  ): SetDraftOutcome {
    const outcome = this.applyOne(path, target, edit);
    if (outcome !== "redundant") {
      this.notify([{ path, edits: this.snapshot[path] }]);
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
      this.notify([{ path, edits: this.snapshot[path] }]);
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
    if (!this.snapshot[path]) return;
    const next = { ...this.snapshot };
    delete next[path];
    this.snapshot = next;
    this.notify([{ path, edits: undefined }]);
  }

  deletePaths(paths: string[]): void {
    const existing = [...new Set(paths)].filter((path) => this.snapshot[path]);
    if (existing.length === 0) return;

    const next = { ...this.snapshot };
    for (const path of existing) delete next[path];
    this.snapshot = next;
    this.notify(existing.map((path) => ({ path, edits: undefined })));
  }

  clear(): void {
    const paths = Object.keys(this.snapshot);
    if (paths.length === 0) return;
    this.snapshot = {};
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
    const current = this.snapshot[path];
    if (!current || slots.length === 0) return;

    const updated = { ...current };
    let changed = false;
    for (const slot of new Set(slots)) {
      if (slot in updated) {
        delete updated[slot];
        changed = true;
      }
    }
    if (!changed) return;

    const next = { ...this.snapshot };
    if (Object.keys(updated).length === 0) delete next[path];
    else next[path] = updated;
    this.snapshot = next;
    this.notify([{ path, edits: this.snapshot[path] }]);
  }

  private notify(changes: TargetDraftEditsChange[]): void {
    this.listeners.forEach((listener) => listener(changes));
  }
}
