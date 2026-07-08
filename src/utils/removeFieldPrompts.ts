export interface ConfirmRemoveFieldArgs {
  tag: string;
  photoCount: number;
  presentCount: number;
  scope: "selection" | "all";
}

export async function confirmRemoveFieldFromPhotos({
  tag,
  photoCount,
  presentCount,
  scope,
}: ConfirmRemoveFieldArgs): Promise<boolean> {
  const photoNoun = photoCount === 1 ? "photo" : "photos";

  if (scope === "all") {
    return window.confirm(
      `Stage removal of ${tag} from all ${photoCount} ${photoNoun} in the current list?\n\n` +
        `This field currently has a value on ${presentCount} of those photos.\n\n` +
        `This will create pending delete edits only. Nothing will be written to the files until you apply edits.`,
    );
  } else {
    return window.confirm(
      `Stage removal of ${tag} from ${photoCount} selected ${photoNoun}?\n\n` +
        `This field currently has a value on ${presentCount} of those photos.\n\n` +
        `This will create pending delete edits only. Nothing will be written to the files until you apply edits.`,
    );
  }
}
