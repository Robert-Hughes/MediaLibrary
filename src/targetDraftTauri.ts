import type { MetadataTargetDraftEntry } from "./types";
import {
  targetDraftsFromUnknownWire,
  validateTargetDraftCollection,
  type TargetDraftCollection,
  type TargetDraftEditsByFile,
} from "./targetDraftEdits";

export interface TargetDraftTauriApi {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

export async function loadTargetDraftEdits(
  api: TargetDraftTauriApi,
  folderPath: string,
): Promise<TargetDraftEditsByFile> {
  const raw = await api.invoke("load_metadata_draft_edits", { folderPath });
  return targetDraftsFromUnknownWire(raw);
}

export interface MetadataDraftRowMutation {
  relative_path: string;
  entries: MetadataTargetDraftEntry[];
}

export function targetDraftChangesToMutations(
  changes: readonly {
    path: string;
    edits: TargetDraftCollection | undefined;
  }[],
): MetadataDraftRowMutation[] {
  return changes.map(({ path, edits }) => {
    if (edits !== undefined) validateTargetDraftCollection(path, edits);
    return {
      relative_path: path,
      entries: edits === undefined ? [] : structuredClone(Object.values(edits)),
    };
  });
}

export async function saveTargetDraftRows(
  api: TargetDraftTauriApi,
  folderPath: string,
  mutations: MetadataDraftRowMutation[],
): Promise<void> {
  if (mutations.length === 0) return;
  await api.invoke("save_metadata_draft_rows", {
    folderPath,
    mutations: structuredClone(mutations),
  });
}
