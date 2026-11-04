/**
 * Async, bounded tail reader for NDJSON log files.
 *
 * The dashboard polls /api/logs/console (and the CLI polls /api/cli-tools/logs)
 * every ~15s. Both routes used to readFileSync the whole app log and
 * JSON.parse every line, which is O(file size) and synchronous — the log file
 * grows unboundedly during a session, so this progressively blocked the Node
 * event loop (the same process serves the LLM proxy) until the web UI stopped
 * responding.
 *
 * This helper reads only the tail of the file with async fs APIs, back to
 * front, in bounded chunks, and stops as soon as it has enough candidate
 * lines. The caller still parses/filters/limits — parsing only the lines it
 * needs.
 */

import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

/** Default back-to-front chunk size (64 KiB). */
const DEFAULT_CHUNK_BYTES = 64 * 1024;
/** Hard cap on bytes scanned per read so a pathological single huge line cannot OOM. */
const MAX_CHUNK_BYTES = 1024 * 1024;
/** Hard cap on total bytes scanned per read; keeps worst-case latency bounded. */
const DEFAULT_MAX_SCAN_BYTES = 32 * 1024 * 1024;

/**
 * Read the tail of a UTF-8 file as complete lines, back to front.
 *
 * Returns lines in file order (oldest → newest of the tail). Completes after
 * collecting at least `minLines` lines, hitting EOF, or scanning
 * `maxScanBytes` bytes. A trailing incomplete line at EOF is included as-is
 * (log writers flush line-by-line, so this is rare).
 */
export async function readTailLines(
  filePath: string,
  minLines: number,
  opts?: { chunkBytes?: number; maxScanBytes?: number }
): Promise<string[]> {
  const chunkBytes = Math.min(
    Math.max(opts?.chunkBytes ?? DEFAULT_CHUNK_BYTES, 1),
    MAX_CHUNK_BYTES
  );
  const maxScanBytes = Math.max(opts?.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES, chunkBytes);

  let handle: FileHandle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return [];
  }

  try {
    const stat = await handle.stat();
    const fileSize = stat.size;
    if (fileSize === 0) return [];

    const lines: string[] = [];
    // Fragment at the END of the previously-read (newer) chunk: the tail end
    // of a line whose beginning sits in the next (older) chunk.
    let pendingTail = "";
    let position = fileSize;
    let scanned = 0;

    while (position > 0 && lines.length < minLines && scanned < maxScanBytes) {
      const length = Math.min(chunkBytes, position);
      position -= length;
      scanned += length;

      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, position);

      const text = buffer.toString("utf-8");
      const parts = text.split("\n");

      // The last piece is the start of a line that continues (as pendingTail)
      // in the newer chunk already processed.
      const lastPiece = parts.pop() ?? "";
      const joinedTail = lastPiece + pendingTail;

      // The first piece is the start of a line whose end lies in the next
      // (older) chunk — carry it forward.
      pendingTail = parts.shift() ?? "";

      // Collect newest-first: joinedTail completes the previous chunk's head
      // line (or is a standalone trailing line at EOF when the file does not
      // end with a newline and this is the first chunk).
      if (joinedTail.length > 0) {
        lines.push(joinedTail);
        if (lines.length >= minLines) break;
      }
      for (let i = parts.length - 1; i >= 0; i--) {
        const line = parts[i];
        if (line.length > 0) lines.push(line);
        if (lines.length >= minLines) break;
      }
    }

    // Beginning of file reached: the leftover partial piece is the first line.
    if (pendingTail.length > 0 && lines.length < minLines) {
      lines.push(pendingTail);
    }

    lines.reverse();
    return lines;
  } finally {
    await handle.close();
  }
}
