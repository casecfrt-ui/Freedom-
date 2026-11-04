import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Batched proxy-resolution endpoint (?resolveIds=id1,id2,...). The dashboard's
// provider page used to fire one HTTP request per connection (Promise.all over
// every connection) on every sync; this asserts the single-request batch path.
let tmpDataDir: string;
let core: typeof import("@/lib/db/core");
let settings: typeof import("@/lib/db/settings");
let route: typeof import("@/app/api/settings/proxy/route");

before(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), "omniroute-proxy-batch-"));
  process.env.DATA_DIR = tmpDataDir;
  delete process.env.REQUIRE_API_KEY;
  delete process.env.INITIAL_PASSWORD;
  core = await import("@/lib/db/core");
  core.resetDbInstance();
  core.getDbInstance();
  settings = await import("@/lib/db/settings");
  // Fresh isolated DB: no password configured and requireLogin=false disarms
  // requireManagementAuth (cf. isAuthRequired in apiAuth.ts).
  await settings.updateSettings({ requireLogin: false });
  route = await import("@/app/api/settings/proxy/route");
});

after(() => {
  core.resetDbInstance();
  if (tmpDataDir)
    rmSync(tmpDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function req(url: string): Request {
  return new Request(`http://localhost${url}`);
}

describe("GET /api/settings/proxy resolveIds batch", () => {
  test("returns a results map with null for unknown connections", async () => {
    const res = await route.GET(req("/api/settings/proxy?resolveIds=a,b,c"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { results: Record<string, unknown> };
    assert.deepEqual(Object.keys(body.results).sort(), ["a", "b", "c"]);
    assert.equal(body.results.a, null);
    assert.equal(body.results.b, null);
    assert.equal(body.results.c, null);
  });

  test("resolves connections that have a proxy assigned", async () => {
    // Seed a proxy and assign it at key level for connection conn-1.
    const proxy = await settings.setProxyForLevel("key", "conn-1", {
      protocol: "http",
      host: "127.0.0.1",
      port: 8080,
    } as never);
    assert.ok(proxy, "proxy seed failed");

    const res = await route.GET(req("/api/settings/proxy?resolveIds=conn-1,conn-2"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      results: Record<string, { proxy?: unknown; level?: string } | null>;
    };
    assert.ok(body.results["conn-1"], "conn-1 should resolve");
    assert.ok((body.results["conn-1"] as { proxy: unknown }).proxy);
    assert.equal(body.results["conn-2"], null);
  });

  test("caps the number of ids at 200", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `id-${i}`);
    const res = await route.GET(req(`/api/settings/proxy?resolveIds=${ids.join(",")}`));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { results: Record<string, unknown> };
    assert.equal(Object.keys(body.results).length, 200);
  });

  test("empty resolveIds value falls through to the full-config branch", async () => {
    // Empty string is falsy in JS, so the batch branch must not trigger.
    const res = await route.GET(req("/api/settings/proxy?resolveIds="));
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    // Full proxy config shape (not a { results } map).
    assert.ok(!("results" in body));
  });
});
