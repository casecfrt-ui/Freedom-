import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listCallLogArtifactFiles } from "../../../src/lib/usage/callLogArtifacts";

test("listCallLogArtifactFiles returns [] for a missing directory", async () => {
  const dir = join(tmpdir(), "omniroute-cla-missing-" + Date.now());
  try {
    assert.deepEqual(await listCallLogArtifactFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listCallLogArtifactFiles finds only .json files in subdirs, newest first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omniroute-cla-"));
  try {
    const a = join(dir, "2026-01-01");
    const b = join(dir, "2026-01-02");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, "old.json"), "{}");
    writeFileSync(join(a, "ignored.txt"), "nope");
    writeFileSync(join(b, "new.json"), "{}");

    // Ensure distinct mtimes (same-second filesystems).
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    const t1 = new Date("2026-01-02T00:00:00Z").getTime();
    utimesSync(join(a, "old.json"), new Date(t0), new Date(t0));
    utimesSync(join(b, "new.json"), new Date(t1), new Date(t1));

    const files = await listCallLogArtifactFiles(dir);
    assert.equal(files.length, 2);
    assert.equal(files[0].relativePath, "2026-01-02/new.json");
    assert.equal(files[1].relativePath, "2026-01-01/old.json");
    assert.ok(files[0].mtimeMs > files[1].mtimeMs);
    assert.ok(files[0].absPath.endsWith("new.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listCallLogArtifactFiles respects maxFiles cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omniroute-cla-cap-"));
  try {
    const sub = join(dir, "d");
    mkdirSync(sub);
    for (let i = 0; i < 10; i++) writeFileSync(join(sub, `f${i}.json`), "{}");
    const files = await listCallLogArtifactFiles(dir, { maxFiles: 4 });
    assert.equal(files.length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listCallLogArtifactFiles returns [] for empty baseDir string", async () => {
  assert.deepEqual(await listCallLogArtifactFiles(""), []);
});
