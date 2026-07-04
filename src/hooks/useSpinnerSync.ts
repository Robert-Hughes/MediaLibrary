import { useState } from "react";

/**
 * Returns an inline style that phase-locks a CSS spin animation to the document
 * timeline origin.
 *
 * Implementation: read `document.timeline.currentTime` once at construction and
 * set `animation-delay` to its negation. The animation then behaves as if it
 * began at time 0, regardless of when the element actually mounts. Because
 * every spinner shares the same `@keyframes` and duration, they all stay in
 * phase modulo the animation period.
 *
 * Why not `el.getAnimations()`? That call forces a synchronous style flush per
 * element. With many spinners on screen that's O(N) full-document recalcs — a
 * pathological cost that dominated initial render in profiling. Reading
 * `document.timeline.currentTime` is a cheap timestamp read with no layout
 * side-effects.
 */
export function useSpinnerSync(): React.CSSProperties {
  const [animationDelay] = useState<string>(() => {
    const t =
      typeof document !== "undefined"
        ? Number(document.timeline?.currentTime ?? 0)
        : 0;
    return `${-t}ms`;
  });
  return { animationDelay };
}
