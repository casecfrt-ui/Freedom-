import { test } from "node:test";
import assert from "node:assert/strict";

import { startVisibilityAwarePolling, type VisibilitySource } from "../../../src/hooks/pollingLoop";

/**
 * Stub visibility source + fake timers. The dashboard's previous bare
 * setInterval loops kept firing heavy endpoints with the tab hidden and could
 * overlap slow responses — these tests pin the fixed loop behavior.
 */
class FakeClock {
  private now = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }

  clearTimeout(id: number | null | undefined): void {
    if (id === null || id === undefined) return;
    this.timers.delete(id);
  }

  /** Advance the clock, firing due timers in schedule order. */
  async advance(ms: number): Promise<void> {
    // Drain pending microtasks first: a tick started outside this call
    // (e.g. a visibility-change catch-up) finishes its `finally` block in a
    // microtask chain, which is what schedules the next timer.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const end = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [, t] = due;
      this.timers.delete(due[0]);
      this.now = Math.max(this.now, t.at);
      t.fn();
      // Allow the async tick to run to completion (await callback → finally
      // → schedules the next timer) before considering the next due timer.
      // An async fn with one awaited sync callback needs ~3-4 rounds; 8 is a
      // deterministic budget for the chain lengths used here.
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
    this.now = end;
  }
}

class FakeDoc implements VisibilitySource {
  hidden = false;
  listeners: Array<() => void> = [];

  addEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.push(listener);
  }

  removeEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  setHidden(value: boolean): void {
    this.hidden = value;
    for (const l of [...this.listeners]) l();
  }
}

test("fires immediately then on the interval cadence", async () => {
  const clock = new FakeClock();
  const doc = new FakeDoc();
  let calls = 0;

  const g = globalThis as typeof globalThis & {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  const realSetTimeout = g.setTimeout;
  const realClearTimeout = g.clearTimeout;
  g.setTimeout = ((fn: () => void, ms: number) =>
    clock.setTimeout(fn, ms)) as unknown as typeof setTimeout;
  g.clearTimeout = ((id: number) => clock.clearTimeout(id)) as unknown as typeof clearTimeout;

  try {
    const handle = startVisibilityAwarePolling(
      () => {
        calls += 1;
      },
      1000,
      doc
    );

    await clock.advance(0);
    assert.equal(calls, 1);

    await clock.advance(2500);
    // Ticks at t=0 (initial), t=1000, t=2000; the next would be t=3000.
    assert.equal(calls, 3);

    handle.stop();
  } finally {
    g.setTimeout = realSetTimeout;
    g.clearTimeout = realClearTimeout;
  }
});

test("does not start a new tick while the previous is still running", async () => {
  const clock = new FakeClock();
  const doc = new FakeDoc();
  let calls = 0;
  const { promise, resolve } = Promise.withResolvers<void>();

  const g = globalThis as typeof globalThis & {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  const realSetTimeout = g.setTimeout;
  const realClearTimeout = g.clearTimeout;
  g.setTimeout = ((fn: () => void, ms: number) =>
    clock.setTimeout(fn, ms)) as unknown as typeof setTimeout;
  g.clearTimeout = ((id: number) => clock.clearTimeout(id)) as unknown as typeof clearTimeout;

  try {
    const handle = startVisibilityAwarePolling(
      () => {
        calls += 1;
        return promise;
      },
      1000,
      doc
    );

    await clock.advance(0);
    assert.equal(calls, 1);

    // Interval elapses while the first callback is pending: no overlap.
    await clock.advance(5000);
    assert.equal(calls, 1);

    resolve();
    await clock.advance(1000);
    assert.equal(calls, 2);

    handle.stop();
  } finally {
    g.setTimeout = realSetTimeout;
    g.clearTimeout = realClearTimeout;
  }
});

test("pauses while hidden, resumes on visible with immediate catch-up", async () => {
  const clock = new FakeClock();
  const doc = new FakeDoc();
  let calls = 0;

  const g = globalThis as typeof globalThis & {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  const realSetTimeout = g.setTimeout;
  const realClearTimeout = g.clearTimeout;
  g.setTimeout = ((fn: () => void, ms: number) =>
    clock.setTimeout(fn, ms)) as unknown as typeof setTimeout;
  g.clearTimeout = ((id: number) => clock.clearTimeout(id)) as unknown as typeof clearTimeout;

  try {
    const handle = startVisibilityAwarePolling(
      () => {
        calls += 1;
      },
      1000,
      doc
    );

    await clock.advance(0);
    assert.equal(calls, 1);

    doc.setHidden(true);
    await clock.advance(10000);
    assert.equal(calls, 1, "no ticks while hidden");

    doc.setHidden(false);
    assert.equal(calls, 2, "immediate catch-up on visible");

    await clock.advance(1000);
    assert.equal(calls, 3, "cadence resumes");

    handle.stop();
  } finally {
    g.setTimeout = realSetTimeout;
    g.clearTimeout = realClearTimeout;
  }
});

test("starts paused when document starts hidden", async () => {
  const clock = new FakeClock();
  const doc = new FakeDoc();
  doc.hidden = true;
  let calls = 0;

  const g = globalThis as typeof globalThis & {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  const realSetTimeout = g.setTimeout;
  const realClearTimeout = g.clearTimeout;
  g.setTimeout = ((fn: () => void, ms: number) =>
    clock.setTimeout(fn, ms)) as unknown as typeof setTimeout;
  g.clearTimeout = ((id: number) => clock.clearTimeout(id)) as unknown as typeof clearTimeout;

  try {
    const handle = startVisibilityAwarePolling(
      () => {
        calls += 1;
      },
      1000,
      doc
    );

    await clock.advance(10000);
    assert.equal(calls, 0, "no initial tick when hidden at start");

    doc.setHidden(false);
    assert.equal(calls, 1);

    handle.stop();
  } finally {
    g.setTimeout = realSetTimeout;
    g.clearTimeout = realClearTimeout;
  }
});

test("stop() prevents further ticks and detaches the visibility listener", async () => {
  const clock = new FakeClock();
  const doc = new FakeDoc();
  let calls = 0;

  const g = globalThis as typeof globalThis & {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  const realSetTimeout = g.setTimeout;
  const realClearTimeout = g.clearTimeout;
  g.setTimeout = ((fn: () => void, ms: number) =>
    clock.setTimeout(fn, ms)) as unknown as typeof setTimeout;
  g.clearTimeout = ((id: number) => clock.clearTimeout(id)) as unknown as typeof clearTimeout;

  try {
    const handle = startVisibilityAwarePolling(
      () => {
        calls += 1;
      },
      1000,
      doc
    );

    await clock.advance(0);
    assert.equal(calls, 1);

    handle.stop();
    assert.equal(doc.listeners.length, 0, "visibility listener removed");

    await clock.advance(10000);
    assert.equal(calls, 1, "no ticks after stop");

    doc.setHidden(false);
    assert.equal(calls, 1, "no catch-up after stop");
  } finally {
    g.setTimeout = realSetTimeout;
    g.clearTimeout = realClearTimeout;
  }
});

test("keeps the loop alive when the callback throws", async () => {
  const clock = new FakeClock();
  const doc = new FakeDoc();
  let calls = 0;

  const g = globalThis as typeof globalThis & {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
  const realSetTimeout = g.setTimeout;
  const realClearTimeout = g.clearTimeout;
  g.setTimeout = ((fn: () => void, ms: number) =>
    clock.setTimeout(fn, ms)) as unknown as typeof setTimeout;
  g.clearTimeout = ((id: number) => clock.clearTimeout(id)) as unknown as typeof clearTimeout;

  try {
    const handle = startVisibilityAwarePolling(
      () => {
        calls += 1;
        throw new Error("boom");
      },
      1000,
      doc
    );

    await clock.advance(0);
    await clock.advance(1000);
    await clock.advance(1000);
    assert.equal(calls, 3, "loop survives throwing callbacks");

    handle.stop();
  } finally {
    g.setTimeout = realSetTimeout;
    g.clearTimeout = realClearTimeout;
  }
});
