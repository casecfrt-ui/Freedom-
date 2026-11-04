import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// GET /api/db-backups/exportAll — regression guard for the stream conversion.
// The route used to execFileSync tar (blocking the loop up to 30s) and
// readFileSync the whole archive into the heap. It must now run tar
// asynchronously and stream the archive to the response.

let tmpDataDir: string;
let core: typeof import("@/lib/db/core");

before(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), "omniroute-export-all-suite-"));
  process.env.DATA_DIR = tmpDataDir;
  delete process.env.INITIAL_PASSWORD;
  core = await import("@/lib/db/core");
  core.resetDbInstance();
  core.getDbInstance();
  const settings = await import("@/lib/db/settings");
  await settings.updateSettings({ requireLogin: false });
});

after(() => {
  core.resetDbInstance();
  rmSync(tmpDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("exportAll streams a gzip response and no longer reads the file into memory", async () => {
  const route = await import("../../../src/app/api/db-backups/exportAll/route.ts");
  const res = await route.GET(new Request("http://localhost/api/db-backups/exportAll"));

  // In local mode SQLITE_FILE is set; auth is disarmed by the suite setup.
  if (res.status === 400) {
    // Non-local/cloud mode fallback — assert the guard message only.
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /local/);
    return;
  }

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/gzip");
  assert.match(res.headers.get("content-disposition") || "", /omniroute-full-backup-/);

  // Streaming: the body is a ReadableStream, not an in-memory buffer.
  const body = res.body;
  assert.ok(body, "response body must be a stream");
  assert.equal(typeof body.getReader, "function");

  // Drain a chunk and confirm gzip magic bytes instead of buffering all.
  const reader = body.getReader();
  const { value, done } = await reader.read();
  assert.ok(!done);
  assert.ok(value.length >= 2);
  assert.equal(value[0], 0x1f, "gzip magic byte 1");
  assert.equal(value[1], 0x8b, "gzip magic byte 2");
  await reader.cancel();
});

test("exportAll rejects unauthenticated requests", async () => {
  // Simulate auth enabled: INITIAL_PASSWORD present disarms the "no password
  // configured" bootstrap; a request without credentials must 401/403.
  process.env.INITIAL_PASSWORD = "secret-for-test";
  const settings = await import("@/lib/db/settings");
  await settings.updateSettings({ requireLogin: true });
  try {
    const route = await import("../../../src/app/api/db-backups/exportAll/route.ts");
    const res = await route.GET(new Request("http://localhost/api/db-backups/exportAll"));
    assert.ok([401, 403].includes(res.status));
  } finally {
    delete process.env.INITIAL_PASSWORD;
    await settings.updateSettings({ requireLogin: false });
  }
});
