import type { MetadataDraftTarget } from "./types";
import type { TargetDraftEditsByFile } from "./targetDraftEdits";
import {
  clearTargetVerifyOutcomes,
  emptyTargetVerifyOutcomesV5,
  pruneTargetVerifyOutcomesAgainstDrafts,
  removeTargetVerifyOutcome,
  removeTargetVerifyOutcomesForFile,
  replaceTargetVerifyOutcomesForFile,
  type TargetVerifyOutcomeV5,
  type TargetVerifyOutcomesByFileV5,
} from "./targetVerifyOutcomes";
import { hasOwnStringKey } from "./utils/stringRecord";

export type TargetVerifyOutcomesListenerV5 = (
  snapshot: TargetVerifyOutcomesByFileV5,
) => void;

export class TargetVerifyOutcomesStoreV5 {
  private snapshot = emptyTargetVerifyOutcomesV5();
  private readonly listeners = new Set<TargetVerifyOutcomesListenerV5>();

  getAll(): TargetVerifyOutcomesByFileV5 {
    return this.snapshot;
  }

  getFile(path: string): Record<string, TargetVerifyOutcomeV5> | undefined {
    return hasOwnStringKey(this.snapshot, path)
      ? this.snapshot[path]
      : undefined;
  }

  replaceFile(
    path: string,
    outcomes: readonly TargetVerifyOutcomeV5[],
  ): boolean {
    return this.install(
      replaceTargetVerifyOutcomesForFile(this.snapshot, path, outcomes),
    );
  }

  deleteOutcome(path: string, target: MetadataDraftTarget): boolean {
    return this.install(removeTargetVerifyOutcome(this.snapshot, path, target));
  }

  deletePath(path: string): boolean {
    return this.install(removeTargetVerifyOutcomesForFile(this.snapshot, path));
  }

  pruneAgainstDrafts(targetDrafts: TargetDraftEditsByFile): boolean {
    return this.install(
      pruneTargetVerifyOutcomesAgainstDrafts(this.snapshot, targetDrafts),
    );
  }

  clear(): boolean {
    return this.install(clearTargetVerifyOutcomes(this.snapshot));
  }

  subscribe(listener: TargetVerifyOutcomesListenerV5): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private install(next: TargetVerifyOutcomesByFileV5): boolean {
    if (next === this.snapshot) return false;
    this.snapshot = next;
    for (const listener of this.listeners) listener(this.snapshot);
    return true;
  }
}
