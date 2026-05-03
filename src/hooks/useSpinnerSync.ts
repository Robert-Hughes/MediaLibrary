import { useEffect, useRef } from "react";

/**
 * Returns a ref to attach to a spinner element.
 *
 * On mount, finds the element's CSS spin animation via the Web Animations API
 * and sets its startTime to 0 (the document timeline origin). Since all
 * spinners share the same @keyframes and duration, setting startTime = 0
 * means they all rotate in lockstep regardless of when they were mounted.
 */
export function useSpinnerSync<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.getAnimations !== "function") return;

    const animations = el.getAnimations();
    for (const anim of animations) {
      anim.startTime = 0;
    }
  }, []);

  return ref;
}
