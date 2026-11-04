import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// GET /api/logs/console — regression guard for the tail-read conversion.
// The route used to readFileSync the whole log file and JSON.parse every line;
// the log grows unboundedly during a session and the synchronous full read
// blocked the event loop shared with the LLM proxy. It must now read only a
// bounded tail asynchronously and still return recent parsed entries.

let tmpDataDir: string;
let settings: typeof import("@/lib/db/settings");
let core: typeof import("@/lib/db/core");

before(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), "omniroute-console-logs-suite-"));
  process.env.DATA_DIR = tmpDataDir;
  delete process.env.INITIAL_PASSWORD;
  core = await import("@/lib/db/core");
  core.resetDbInstance();
  core.getDbInstance();
  settings = await import("@/lib/db/settings");
  // Fresh isolated DB: disarms requireManagementAuth (cf. isAuthRequired).
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
    msg: `log-entry-${i}`,
    component: "test",
  };
}

test("console logs route returns recent entries from the tail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omniroute-console-logs-"));
  const prevLogPath = process.env.APP_LOG_FILE_PATH;
  process.env.APP_LOG_FILE_PATH = join(dir, "app.log");
  try {
    writeLog(process.env.APP_LOG_FILE_PATH, [
      entry(0, 90 * 60 * 1000), // 90 min ago → filtered out (> 1h)
      entry(1, 30 * 60 * 1000), // recent
      entry(2, 10 * 60 * 1000), // recent
      entry(3, 0), // now
    ]);

    const route = await import("../../../src/app/api/logs/console/route.ts");
    const res = await route.GET(new Request("http://localhost/api/logs/console?limit=500"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ msg: string }>;
    const msgs = body.map((e) => e.msg);
    assert.deepEqual(msgs, ["log-entry-1", "log-entry-2", "log-entry-3"]);
  } finally {
    if (prevLogPath === undefined) delete process.env.APP_LOG_FILE_PATH;
    else process.env.APP_LOG_FILE_PATH = prevLogPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("console logs route respects the limit param (returns newest)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omniroute-console-logs-limit-"));
  const prevLogPath = process.env.APP_LOG_FILE_PATH;
  process.env.APP_LOG_FILE_PATH = join(dir, "app.log");
  try {
    writeLog(
      process.env.APP_LOG_FILE_PATH,
      [1, 2, 3, 4, 5].map((i) => entry(i, 60_000 * (6 - i)))
    );

    const route = await import("../../../src/app/api/logs/console/route.ts");
    const res = await route.GET(new Request("http://localhost/api/logs/console?limit=2"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ msg: string }>;
    assert.deepEqual(
      body.map((e) => e.msg),
      ["log-entry-4", "log-entry-5"]
    );
  } finally {
    if (prevLogPath === undefined) delete process.env.APP_LOG_FILE_PATH;
    else process.env.APP_LOG_FILE_PATH = prevLogPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("console logs route returns [] when the log file is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omniroute-console-logs-missing-"));
  const prevLogPath = process.env.APP_LOG_FILE_PATH;
  process.env.APP_LOG_FILE_PATH = join(dir, "does-not-exist.log");
  try {
    const route = await import("../../../src/app/api/logs/console/route.ts");
    const res = await route.GET(new Request("http://localhost/api/logs/console"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  } finally {
    if (prevLogPath === undefined) delete process.env.APP_LOG_FILE_PATH;
    else process.env.APP_LOG_FILE_PATH = prevLogPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
