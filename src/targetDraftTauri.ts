import type { MetadataDraftEntryV5 } from "./types";
import {
  targetDraftsFromUnknownWire,
  targetDraftsToWire,
  type TargetDraftEditsByFile,
} from "./targetDraftEdits";

export interface TargetDraftTauriApi {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

export async function loadTargetDraftEditsV5(
  api: TargetDraftTauriApi,
  folderPath: string,
): Promise<TargetDraftEditsByFile> {
  const raw = await api.invoke("load_metadata_draft_edits_v5", { folderPath });
  return targetDraftsFromUnknownWire(raw);
}

export async function saveTargetDraftEditsV5(
  api: TargetDraftTauriApi,
  folderPath: string,
  drafts: TargetDraftEditsByFile,
): Promise<void> {
  const data: Record<string, MetadataDraftEntryV5[]> =
    targetDraftsToWire(drafts);
  await api.invoke("save_metadata_draft_edits_v5", { folderPath, data });
}
