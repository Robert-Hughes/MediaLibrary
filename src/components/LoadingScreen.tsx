import { useSpinnerSync } from "../hooks/useSpinnerSync";

interface Props {
  folder: string;
  foundSoFar: number;
}

export function LoadingScreen({ folder, foundSoFar }: Props) {
  const spinStyle = useSpinnerSync();
  const label =
    foundSoFar === 0
      ? "Searching for photos…"
      : `${foundSoFar} photo${foundSoFar === 1 ? "" : "s"} found so far`;

  return (
    <div className="loading-screen" data-testid="loading-screen">
      <h2 className="loading-title">Scanning…</h2>
      <p className="loading-folder" data-testid="loading-folder">{folder}</p>
      <p className="loading-progress" data-testid="loading-progress">{label}</p>
      <div style={spinStyle} className="spinner" aria-label="Loading" />
    </div>
  );
}
