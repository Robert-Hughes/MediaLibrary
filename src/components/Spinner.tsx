import { useSpinnerSync } from "../hooks/useSpinnerSync";

interface Props {
  className: string;
  "aria-label"?: string;
  "data-testid"?: string;
}

/** A single spinner element whose animation phase is locked to the document timeline. */
export function Spinner(props: Props) {
  const style = useSpinnerSync();
  return <span style={style} {...props} />;
}
