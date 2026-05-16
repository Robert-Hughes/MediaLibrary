interface Props {
  code: string;
  label: string;
  /** Which provenance the badge represents — drives color. */
  variant: "schema" | "value" | "draft";
}

/**
 * Compact monospace pill showing a datatype code (e.g. `S`, `[B]`, `{}`).
 * Color-coded by provenance: neutral for schema-declared, amber-tinted for
 * a value that doesn't match the schema, accent-draft for a draft edit
 * whose type diverges.
 */
export function DatatypeBadge({ code, label, variant }: Props) {
  const titleTag =
    variant === "schema" ? "Schema datatype"
    : variant === "value" ? "Current value datatype"
    : "Draft value datatype";
  return (
    <span
      className={`datatype-badge datatype-badge--${variant}`}
      data-testid={`datatype-badge-${variant}`}
      data-code={code}
      title={`${titleTag}: ${label}`}
    >
      {code}
    </span>
  );
}
