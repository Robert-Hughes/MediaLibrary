import type { MetadataTargetDraftEntry } from "./types";
import {
  targetDraftsFromUnknownWire,
  targetDraftsToWire,
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

export async function saveTargetDraftEdits(
  api: TargetDraftTauriApi,
  folderPath: string,
  drafts: TargetDraftEditsByFile,
): Promise<void> {
  const data: Record<string, MetadataTargetDraftEntry[]> =
    targetDraftsToWire(drafts);
  await api.invoke("save_metadata_draft_edits", { folderPath, data });
}
