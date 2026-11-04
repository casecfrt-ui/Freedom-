/**
 * Framework-free visibility-aware polling loop.
 *
 * Extracted from usePolling so the behavior (pause when hidden, no overlapping
 * ticks, cleanup on stop) can be unit-tested without a React/DOM test harness
 * — the dashboard's bare setInterval loops kept firing heavy endpoints with
 * the tab hidden and could overlap slow responses.
 *
 * `doc` defaults to the browser `document`; tests pass a stub with
 * `hidden` + `addEventListener`/`removeEventListener`.
 */

export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface PollingLoopHandle {
  stop(): void;
}

export function startVisibilityAwarePolling(
  callback: () => void | Promise<void>,
  intervalMs: number,
  doc: VisibilitySource
): PollingLoopHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await callback();
    } catch {
      // Polling callbacks handle their own errors; keep the loop alive.
    } finally {
      running = false;
      if (!stopped && !doc.hidden) {
        timer = setTimeout(tick, intervalMs);
      }
    }
  };

  const onVisibilityChange = () => {
    if (stopped) return;
    if (doc.hidden) {
      clearTimeout(timer);
      timer = null;
      return;
    }
    // Visible again: fire immediately, then resume the cadence.
    if (timer === null && !running) void tick();
  };

  if (!doc.hidden) {
    timer = setTimeout(tick, 0);
  }
  doc.addEventListener("visibilitychange", onVisibilityChange);

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      doc.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}
