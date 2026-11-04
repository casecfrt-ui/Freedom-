import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// GET /api/cli-tools/logs — regression guard for the tail-read conversion
// (same defect as /api/logs/console: a synchronous full-file read blocked the
// shared event loop as the log grew). Asserts tail-based recent entries,
// filter tokens and the missing-file path.

let tmpDataDir: string;
let settings: typeof import("@/lib/db/settings");
let core: typeof import("@/lib/db/core");

before(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), "omniroute-cli-logs-suite-"));
  process.env.DATA_DIR = tmpDataDir;
  delete process.env.INITIAL_PASSWORD;
  core = await import("@/lib/db/core");
  core.resetDbInstance();
  core.getDbInstance();
  settings = await import("@/lib/db/settings");
  await settings.updateSettings({ requireLogin: false });
});

after(() => {
  core.resetDbInstance();
  rmSync(tmpDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function writeLog(file: string, entries: Array<Record<string, unknown>>): void {
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function entry(i: number, offsetMs: number): Record<string, unknown> {
  return {
    time: new Date(Date.now() - offsetMs).toISOString(),
    level: "info",
    msg: `cli-entry-${i}`,
    component: i % 2 === 0 ? "router" : "oauth",
  };
}

test("cli logs route returns recent entries with filter tokens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omniroute-cli-logs-"));
  const prevLogPath = process.env.APP_LOG_FILE_PATH;
  process.env.APP_LOG_FILE_PATH = join(dir, "app.log");
  try {
    writeLog(process.env.APP_LOG_FILE_PATH, [
      entry(0, 90 * 60 * 1000), // > 1h ago → dropped
      entry(1, 5 * 60 * 1000), // router
      entry(2, 4 * 60 * 1000), // oauth
      entry(3, 3 * 60 * 1000), // router
    ]);

    const route = await import("../../../src/app/api/cli-tools/logs/route.ts");
    const res = await route.GET(
      new Request("http://localhost/api/cli-tools/logs?filter=router&limit=500")
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ msg: string }>;
    // Only recent router-component entries survive time + token filters
    // (even i → "router", odd i → "oauth").
    assert.deepEqual(
      body.map((e) => e.msg),
      ["cli-entry-2"]
    );
  } finally {
    if (prevLogPath === undefined) delete process.env.APP_LOG_FILE_PATH;
    else process.env.APP_LOG_FILE_PATH = prevLogPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli logs route returns [] for a missing log file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omniroute-cli-logs-missing-"));
  const prevLogPath = process.env.APP_LOG_FILE_PATH;
  process.env.APP_LOG_FILE_PATH = join(dir, "nope.log");
  try {
    const route = await import("../../../src/app/api/cli-tools/logs/route.ts");
    const res = await route.GET(new Request("http://localhost/api/cli-tools/logs"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  } finally {
    if (prevLogPath === undefined) delete process.env.APP_LOG_FILE_PATH;
    else process.env.APP_LOG_FILE_PATH = prevLogPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
