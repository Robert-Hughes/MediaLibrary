import { useSpinnerSync } from "../hooks/useSpinnerSync";

interface Props {
  className: string;
  "aria-label"?: string;
  "data-testid"?: string;
}

/** A single spinner element that syncs its animation phase on mount. */
export function Spinner(props: Props) {
  const ref = useSpinnerSync<HTMLSpanElement>();
  return <span ref={ref} {...props} />;
}
