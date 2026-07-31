import type { MetadataDraftTarget } from "./types";
import type { TargetDraftEditsByFile } from "./targetDraftEdits";
import {
  clearTargetVerifyOutcomes,
  emptyTargetVerifyOutcomes,
  pruneTargetVerifyOutcomesAgainstDrafts,
  removeTargetVerifyOutcome,
  removeTargetVerifyOutcomesForFile,
  replaceTargetVerifyOutcomesForFiles,
  type TargetVerifyOutcome,
  type TargetVerifyOutcomesByFile,
} from "./targetVerifyOutcomes";
import { hasOwnStringKey } from "./utils/stringRecord";

export type TargetVerifyOutcomesListener = (
  snapshot: TargetVerifyOutcomesByFile,
) => void;

export class TargetVerifyOutcomesStore {
  private snapshot = emptyTargetVerifyOutcomes();
  private readonly listeners = new Set<TargetVerifyOutcomesListener>();

  getAll(): TargetVerifyOutcomesByFile {
    return this.snapshot;
  }

  getFile(path: string): Record<string, TargetVerifyOutcome> | undefined {
    return hasOwnStringKey(this.snapshot, path)
      ? this.snapshot[path]
      : undefined;
  }

  replaceFile(path: string, outcomes: readonly TargetVerifyOutcome[]): boolean {
    return this.replaceFiles([{ path, outcomes }]).length > 0;
  }

  replaceFiles(
    replacements: readonly {
      path: string;
      outcomes: readonly TargetVerifyOutcome[];
    }[],
  ): string[] {
    const { next, changedPaths } = replaceTargetVerifyOutcomesForFiles(
      this.snapshot,
      replacements.map(({ path, outcomes }) => ({
        relativePath: path,
        outcomes,
      })),
    );
    this.install(next);
    return changedPaths;
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

  subscribe(listener: TargetVerifyOutcomesListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private install(next: TargetVerifyOutcomesByFile): boolean {
    if (next === this.snapshot) return false;
    this.snapshot = next;
    for (const listener of this.listeners) listener(this.snapshot);
    return true;
  }
}
