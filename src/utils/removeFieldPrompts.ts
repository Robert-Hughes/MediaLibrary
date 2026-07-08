export interface ConfirmRemoveFieldArgs {
  tag: string;
  selectedCount: number;
  presentCount: number;
}

export async function confirmRemoveFieldFromPhotos({
  tag,
  selectedCount,
  presentCount,
}: ConfirmRemoveFieldArgs): Promise<boolean> {
  const photoNoun = selectedCount === 1 ? "photo" : "photos";
  const presentNoun = presentCount === 1 ? "photo" : "photos";

  return window.confirm(
    `Stage removal of ${tag} from ${selectedCount} ${photoNoun}?\n\n` +
      `This field currently has a value on ${presentCount} selected ${presentNoun}.\n\n` +
      `This will create pending delete edits only. Nothing will be written to the files until you apply edits.`,
  );
}
