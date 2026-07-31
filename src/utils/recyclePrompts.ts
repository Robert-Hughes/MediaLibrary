import { ask } from "@tauri-apps/plugin-dialog";

export async function confirmRecycleFiles({
  fileCount,
  singleFilename,
  draftFileCount,
  editCount,
}: {
  fileCount: number;
  singleFilename?: string;
  draftFileCount: number;
  editCount: number;
}): Promise<boolean> {
  const target =
    fileCount === 1 && singleFilename
      ? `“${singleFilename}”`
      : `${fileCount} files`;
  const draftWarning =
    editCount === 0
      ? ""
      : `\n\n${draftFileCount} ${
          draftFileCount === 1 ? "file has" : "files have"
        } ${editCount} pending metadata ${
          editCount === 1 ? "edit" : "edits"
        }. Pending edits for successfully recycled files will be discarded.`;
  return ask(`Move ${target} to the Recycle Bin?${draftWarning}`, {
    title: "Move to Recycle Bin",
    kind: "warning",
  });
}
