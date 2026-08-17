export function isMacOS(): boolean {
  return navigator.platform.startsWith("Mac");
}

export function fileManagerName(): string {
  return isMacOS() ? "Finder" : "File Explorer";
}

export function recycleBinName(): string {
  return isMacOS() ? "Trash" : "Recycle Bin";
}
