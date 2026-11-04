import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTailLines } from "../../../src/lib/logs/tailNdjson";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "omniroute-tailndjson-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test("readTailLines returns [] for a missing file", async () => {
  const dir = makeDir();
  try {
    const lines = await readTailLines(join(dir, "missing.log"), 10);
    assert.deepEqual(lines, []);
  } finally {
    cleanup(dir);
  }
});

test("readTailLines returns [] for an empty file", async () => {
  const dir = makeDir();
  const file = join(dir, "empty.log");
  try {
    writeFileSync(file, "");
    const lines = await readTailLines(file, 10);
    assert.deepEqual(lines, []);
  } finally {
    cleanup(dir);
  }
});

test("readTailLines returns all lines when file is smaller than minLines", async () => {
  const dir = makeDir();
  const file = join(dir, "small.log");
  try {
    writeFileSync(file, "a\nb\nc\n");
    const lines = await readTailLines(file, 10);
    assert.deepEqual(lines, ["a", "b", "c"]);
  } finally {
    cleanup(dir);
  }
});

test("readTailLines returns only the last minLines lines in file order", async () => {
  const dir = makeDir();
  const file = join(dir, "tail.log");
  try {
    const all = Array.from({ length: 100 }, (_, i) => `line-${i}`);
    writeFileSync(file, all.join("\n") + "\n");
    const lines = await readTailLines(file, 5);
    assert.deepEqual(lines, ["line-95", "line-96", "line-97", "line-98", "line-99"]);
  } finally {
    cleanup(dir);
  }
});

test("readTailLines handles a file without trailing newline", async () => {
  const dir = makeDir();
  const file = join(dir, "notrail.log");
  try {
    writeFileSync(file, "a\nb\nc");
    const lines = await readTailLines(file, 10);
    assert.deepEqual(lines, ["a", "b", "c"]);
  } finally {
    cleanup(dir);
  }
});

test("readTailLines respects chunk boundaries (chunk smaller than file)", async () => {
  const dir = makeDir();
  const file = join(dir, "chunked.log");
  try {
    // 10 lines of 10 bytes + newline = 11 bytes each; chunk of 16 forces
    // a split mid-line, exercising the carried partial-line logic.
    const all = Array.from({ length: 10 }, (_, i) => `line-${String(i).padStart(6, "0")}`);
    writeFileSync(file, all.join("\n") + "\n");
    const lines = await readTailLines(file, 100, { chunkBytes: 16 });
    assert.deepEqual(lines, all);
  } finally {
    cleanup(dir);
  }
});

test("readTailLines collects at least minLines even when chunk returns many lines", async () => {
  const dir = makeDir();
  const file = join(dir, "many.log");
  try {
    const all = Array.from({ length: 50 }, (_, i) => `l${i}`);
    writeFileSync(file, all.join("\n") + "\n");
    const lines = await readTailLines(file, 3, { chunkBytes: 1024 });
    assert.equal(lines.length, 3);
    assert.deepEqual(lines, ["l47", "l48", "l49"]);
  } finally {
    cleanup(dir);
  }
});

test("readTailLines scans bounded bytes (maxScanBytes) and still returns lines", async () => {
  const dir = makeDir();
  const file = join(dir, "bounded.log");
  try {
    const all = Array.from({ length: 200 }, (_, i) => `x${String(i).padStart(5, "0")}`);
    writeFileSync(file, all.join("\n") + "\n");
    // Tiny scan budget: must stop early but still return some lines.
    const lines = await readTailLines(file, 10, { chunkBytes: 64, maxScanBytes: 128 });
    assert.ok(lines.length > 0);
    assert.ok(lines.length <= 10);
    // Newest lines come last in file order.
    assert.equal(lines[lines.length - 1], "x00199");
  } finally {
    cleanup(dir);
  }
});

test("readTailLines skips empty lines", async () => {
  const dir = makeDir();
  const file = join(dir, "blanks.log");
  try {
    writeFileSync(file, "a\n\n\nb\n");
    const lines = await readTailLines(file, 10);
    assert.deepEqual(lines, ["a", "b"]);
  } finally {
    cleanup(dir);
  }
});

test("readTailLines does not create the file", async () => {
  const dir = makeDir();
  try {
    await readTailLines(join(dir, "ghost.log"), 5);
    assert.equal(existsSync(join(dir, "ghost.log")), false);
  } finally {
    cleanup(dir);
  }
});
