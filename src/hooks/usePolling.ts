"use client";

import { useEffect, useRef } from "react";
import { startVisibilityAwarePolling } from "./pollingLoop";

/**
 * Visibility-aware, overlap-safe polling hook.
 *
 * Delegates to startVisibilityAwarePolling (framework-free, unit-tested);
 * pauses while the tab is hidden, never overlaps ticks, cleans up on unmount.
 * The callback must be stable (useCallback) or reads will re-arm the loop.
 */
export function usePolling(callback: () => void | Promise<void>, intervalMs: number): void {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    return startVisibilityAwarePolling(() => callbackRef.current(), intervalMs, document).stop;
  }, [intervalMs]);
}
