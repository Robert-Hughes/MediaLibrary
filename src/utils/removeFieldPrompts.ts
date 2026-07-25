import { ask, message } from "@tauri-apps/plugin-dialog";
import type { MetadataRemovalFilesPreview } from "../metadataRemovalTargets";

export interface ConfirmRemoveFieldArgs {
  tag: string;
  preview: Extract<MetadataRemovalFilesPreview, { kind: "ready" }>;
  scope: "selection" | "all";
}

export async function confirmRemoveFieldFromFiles({
  tag,
  preview,
  scope,
}: ConfirmRemoveFieldArgs): Promise<boolean> {
  const {
    fileCount,
    existingFieldsToDelete,
    stagedCreationsToCancel,
    noOpFileCount,
  } = preview;
  const fileNoun = fileCount === 1 ? "file" : "files";
  const lines: string[] = [];
  if (existingFieldsToDelete > 0) {
    const fieldNoun = existingFieldsToDelete === 1 ? "field" : "fields";
    const editNoun = existingFieldsToDelete === 1 ? "edit" : "edits";
    lines.push(
      `${existingFieldsToDelete} existing ${fieldNoun} will receive pending delete ${editNoun}.`,
    );
  }
  if (stagedCreationsToCancel > 0) {
    const additionNoun =
      stagedCreationsToCancel === 1 ? "addition" : "additions";
    lines.push(
      `${stagedCreationsToCancel} staged new-property ${additionNoun} will be cancelled.`,
    );
  }
  if (noOpFileCount > 0) {
    const noOpFileNoun = noOpFileCount === 1 ? "file" : "files";
    const noOpVerb = noOpFileCount === 1 ? "requires" : "require";
    lines.push(`${noOpFileCount} ${noOpFileNoun} ${noOpVerb} no change.`);
  }

  const prompt =
    scope === "all"
      ? `Stage removal of ${tag} from all ${fileCount} ${fileNoun} in the current list?\n\n` +
        `${lines.join("\n")}\n\n` +
        `Nothing will be written to the image files until edits are applied.`
      : `Stage removal of ${tag} from ${fileCount} selected ${fileNoun}?\n\n` +
        `${lines.join("\n")}\n\n` +
        `Nothing will be written to the image files until edits are applied.`;

  return ask(prompt, {
    title: "Remove Field",
    kind: "warning",
  });
}

export async function showMetadataRemovalPreviewBlocked({
  tag,
  relativePath,
  reason,
}: {
  tag: string;
  relativePath: string;
  reason: string;
}): Promise<void> {
  const path = relativePath === "" ? "the requested selection" : relativePath;
  await message(`Cannot remove ${tag} from ${path}.\n\n${reason}`, {
    title: "Remove Field Unavailable",
    kind: "error",
  });
}

export async function showNoMetadataRemovalNeeded(tag: string): Promise<void> {
  await message(`No change is needed for ${tag}.`, {
    title: "Remove Field",
    kind: "info",
  });
}
