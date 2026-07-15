import { ask, message } from "@tauri-apps/plugin-dialog";
import type { MetadataRemovalFilesPreviewV5 } from "../metadataRemovalTargets";

export interface ConfirmRemoveFieldArgs {
  tag: string;
  preview: Extract<MetadataRemovalFilesPreviewV5, { kind: "ready" }>;
  scope: "selection" | "all";
}

export async function confirmRemoveFieldFromPhotos({
  tag,
  preview,
  scope,
}: ConfirmRemoveFieldArgs): Promise<boolean> {
  const {
    photoCount,
    existingFieldsToDelete,
    stagedCreationsToCancel,
    noOpPhotoCount,
  } = preview;
  const photoNoun = photoCount === 1 ? "photo" : "photos";
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
  if (noOpPhotoCount > 0) {
    const noOpPhotoNoun = noOpPhotoCount === 1 ? "photo" : "photos";
    const noOpVerb = noOpPhotoCount === 1 ? "requires" : "require";
    lines.push(`${noOpPhotoCount} ${noOpPhotoNoun} ${noOpVerb} no change.`);
  }

  const prompt =
    scope === "all"
      ? `Stage removal of ${tag} from all ${photoCount} ${photoNoun} in the current list?\n\n` +
        `${lines.join("\n")}\n\n` +
        `Nothing will be written to the image files until edits are applied.`
      : `Stage removal of ${tag} from ${photoCount} selected ${photoNoun}?\n\n` +
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
