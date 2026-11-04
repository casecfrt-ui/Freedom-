import { NextRequest, NextResponse } from "next/server";
import { getDbInstance, SQLITE_FILE } from "@/lib/db/core";
import { exportAllSummaryRows } from "@/lib/db/backup";
import { CALL_LOGS_DIR } from "@/lib/usage/callLogArtifacts";
import fs from "fs";
import { createReadStream } from "fs";
import { Readable } from "stream";
import path from "path";
import os from "os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

const execFileAsync = promisify(execFile);

/**
 * GET /api/db-backups/exportAll
 * Exports the entire database + settings as a ZIP archive
 * Security: Requires admin authentication.
 */
export async function GET(request: NextRequest) {
  if (!(await isAuthenticated(request)))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    if (!SQLITE_FILE) {
      return NextResponse.json(
        { error: "Export is only available in local (non-cloud) mode" },
        { status: 400 }
      );
    }

    const db = getDbInstance();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    // Use mkdtempSync (exclusive creation, random suffix) instead of a
    // deterministic timestamp path — a predictable path lets a local
    // attacker pre-place a symlink and redirect the write (TOCTOU).
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-export-"));
    const zipPath = path.join(os.tmpdir(), `omniroute-full-backup-${timestamp}.zip`);

    try {
      // 1. Export database using native backup API
      const dbBackupPath = path.join(tempDir, "storage.sqlite");
      await db.backup(dbBackupPath);

      // 2–5. Export settings, combos, provider connections, API keys (via db module)
      const { settings, combos, providers, apiKeys, reasoningRoutingRules } =
        exportAllSummaryRows();
      fs.writeFileSync(path.join(tempDir, "settings.json"), JSON.stringify(settings, null, 2));
      fs.writeFileSync(path.join(tempDir, "combos.json"), JSON.stringify(combos, null, 2));
      fs.writeFileSync(path.join(tempDir, "providers.json"), JSON.stringify(providers, null, 2));
      fs.writeFileSync(path.join(tempDir, "api-keys.json"), JSON.stringify(apiKeys, null, 2));
      fs.writeFileSync(
        path.join(tempDir, "reasoning-routing-rules.json"),
        JSON.stringify(reasoningRoutingRules, null, 2)
      );

      // 6. Export call log artifacts directory
      if (CALL_LOGS_DIR && fs.existsSync(CALL_LOGS_DIR)) {
        fs.cpSync(CALL_LOGS_DIR, path.join(tempDir, "call_logs"), { recursive: true });
      }

      // 7. Export metadata
      const metadata = {
        exportedAt: new Date().toISOString(),
        version: process.env.npm_package_version || "unknown",
        format: "omniroute-full-backup-v1",
        contents: [
          "storage.sqlite - Full database",
          "settings.json - Key-value settings",
          "combos.json - Combo configurations",
          "providers.json - Provider connections (no credentials)",
          "api-keys.json - API key metadata (masked)",
          "reasoning-routing-rules.json - Reasoning routing policies",
          "call_logs/ - Detailed call log artifacts",
        ],
      };
      fs.writeFileSync(path.join(tempDir, "metadata.json"), JSON.stringify(metadata, null, 2));

      // Create ZIP using tar (available on all Linux/macOS, and the archiver npm package is not installed)
      // We'll use Node.js built-in zlib to create a simple tar.gz instead
      const tarPath = zipPath.replace(".zip", ".tar.gz");
      // Async exec: execFileSync blocked the shared event loop for up to
      // timeout (30s) while tar compressed the whole data dir, freezing the
      // LLM proxy and the web UI.
      await execFileAsync(
        "tar",
        ["-czf", tarPath, "-C", path.dirname(tempDir), path.basename(tempDir)],
        {
          timeout: 30000,
        }
      );

      // tempDir is no longer needed once the tar finishes; clean up without
      // blocking the loop.
      fs.rm(tempDir, { recursive: true, force: true }, () => {});

      // Get size for Content-Length without loading the archive into memory.
      const tarStat = await fs.promises.stat(tarPath);

      // Stream the archive instead of readFileSync: a full read held the
      // entire (possibly multi-GB) archive in the heap and blocked the loop.
      const archiveStream = createReadStream(tarPath);
      const archiveWebStream = Readable.toWeb(archiveStream) as ReadableStream<Uint8Array>;

      // Cleanup runs after the response finishes streaming.
      archiveStream.on("close", () => {
        fs.unlink(tarPath, () => {});
      });

      return new NextResponse(archiveWebStream, {
        status: 200,
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": `attachment; filename="omniroute-full-backup-${timestamp}.tar.gz"`,
          "Content-Length": tarStat.size.toString(),
        },
      });
    } catch (innerError) {
      // Cleanup on error
      try {
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      } catch {
        /* ignore cleanup errors */
      }
      throw innerError;
    }
  } catch (error: unknown) {
    console.error("[ExportAll] Error:", error);
    return NextResponse.json(
      {
        error: "Failed to create full export",
        details: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
      },
      { status: 500 }
    );
  }
}
