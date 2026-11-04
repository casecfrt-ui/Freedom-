import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// GET /api/storage/health — endpoint polled by the dashboard every 15s.
// Regression guard for the async-fs conversion: the handler must read the
// data dir with fs/promises (no statSync/readdirSync on the shared event
// loop) and still report sizeBytes/lastBackupAt/backupCount.
//
// Single test (single DATA_DIR) because resolveDataDir caches the first
// resolved path per process; switching DATA_DIR between tests would re-point
// the DB at a directory it can no longer open.

let core: typeof import("@/lib/db/core");

test("storage/health reports size/backup info and tolerates no backups", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "omniroute-storage-health-"));
  process.env.DATA_DIR = dataDir;
  try {
    core = await import("@/lib/db/core");
    core.resetDbInstance();
    core.getDbInstance(); // creates a real storage.sqlite (probe needs one)
    const route = await import("../../../src/app/api/storage/health/route.ts");

    // 1) No backups dir yet.
    const first = await route.GET();
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as {
      driver: string;
      sizeBytes: number;
      backupCount: number;
      lastBackupAt: string | null;
    };
    assert.equal(firstBody.driver, "sqlite");
    assert.ok(firstBody.sizeBytes >= statSync(join(dataDir, "storage.sqlite")).size);
    assert.equal(firstBody.backupCount, 0);
    assert.equal(firstBody.lastBackupAt, null);

    // 2) With backups: only db_*.sqlite files count; latest mtime is reported.
    const backupsDir = join(dataDir, "db_backups");
    mkdirSync(backupsDir);
    writeFileSync(join(backupsDir, "db_2026-01-01.sqlite"), "x");
    writeFileSync(join(backupsDir, "db_2026-01-02.sqlite"), "y");
    writeFileSync(join(backupsDir, "unrelated.txt"), "z");

    const second = await route.GET();
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as {
      sizeBytes: number;
      backupCount: number;
      lastBackupAt: string | null;
    };
    assert.equal(secondBody.backupCount, 2);
    assert.ok(typeof secondBody.lastBackupAt === "string" && secondBody.lastBackupAt.length > 0);
  } finally {
    core.resetDbInstance();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
