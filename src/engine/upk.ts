/**
 * Official-APK asset inspection: Playrix BLK(zstd) containers and binary VSO
 * bundles inside Homescapes' `assets/packs/**` / `assets/base_mm/**`.
 *
 * The APK ships its feature configuration as BLK archives whose payload is a
 * zstd frame (`28 b5 2f fd`); the decompressed payload is a compact binary
 * table whose string pool holds every feature/condition/variable name, e.g.
 * `CardsCollectionFeature`, `Cond_CardsCollection_Enabled`,
 * `Cond_CardsCollections_LaunchesEnabled`. Extracting those tokens is how the
 * studio learns which feature gates exist without guessing.
 */

import { zstdDecompressSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export class UpkError extends Error {}

export interface BlkDecode {
  /** Bytes before the zstd frame (the BLK archive header). */
  header: Uint8Array;
  /** Decompressed payload (binary VSO bundle). */
  data: Uint8Array;
}

/** True when the bytes look like a Playrix BLK archive. */
export function isBlk(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x42 && bytes[1] === 0x4c && bytes[2] === 0x4b && // "BLK"
    bytes[3] === 0x1a && // archive version terminator
    indexOfZstdMagic(bytes) > 0
  );
}

function indexOfZstdMagic(bytes: Uint8Array): number {
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x28 && bytes[i + 1] === 0xb5 && bytes[i + 2] === 0x2f && bytes[i + 3] === 0xfd) {
      return i;
    }
  }
  return -1;
}

const DECOMP_MAX = 64 * 1024 * 1024;

/**
 * Decompress one BLK archive. Game VSO bundles are well below (and far from)
 * the 64 MB decode ceiling used here; a larger ceiling would need streaming.
 * Returns null when the file carries no zstd frame.
 */
export function decodeBlkZstd(bytes: Uint8Array): BlkDecode | null {
  const i = indexOfZstdMagic(bytes);
  if (i < 0) return null;
  let data: Buffer;
  try {
    data = zstdDecompressSync(Buffer.from(bytes.buffer, bytes.byteOffset + i, bytes.length - i), {
      // `maxSize` is validated at runtime even though the d.ts lies.
      ...({ maxSize: DECOMP_MAX } as object),
    });
  } catch (err) {
    throw new UpkError(`zstd decode failed: ${(err as Error).message}`);
  }
  return { header: bytes.subarray(0, i), data: new Uint8Array(data) };
}

/** Printable ASCII runs of length >= minLen — the VSO string/identifier pool. */
export function asciiTokens(bytes: Uint8Array, minLen = 4): string[] {
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i <= bytes.length; i++) {
    const b = i < bytes.length ? bytes[i] : undefined;
    const printable = b !== undefined && b >= 0x20 && b < 0x7f;
    if (printable) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= minLen) {
        out.push(Buffer.from(bytes.buffer, bytes.byteOffset + start, i - start).toString("latin1"));
      }
      start = -1;
    }
  }
  return out;
}

/** De-duplicate tokens preserving first-seen order. */
export function uniqueTokens(tokens: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

export interface VsoScanRow {
  path: string;
  decodedBytes: number;
  /** Every unique ASCII token in the bundle, first-seen order. */
  tokens: string[];
}

/**
 * Scan a directory for BLK/VSO bundles and decode each one. Non-decodable
 * files are skipped so a partially corrupt APK directory still yields the
 * readable bundles.
 */
export async function scanVsoDir(dir: string, limit = 800): Promise<VsoScanRow[]> {
  const rows: VsoScanRow[] = [];
  for (const name of (await readdir(dir)).sort()) {
    if (rows.length >= limit) break;
    if (!/\.vso$/i.test(name)) continue;
    const path = join(dir, name);
    try {
      const bytes = new Uint8Array(await readFile(path));
      const dec = decodeBlkZstd(bytes);
      if (!dec) continue;
      rows.push({
        path,
        decodedBytes: dec.data.length,
        tokens: uniqueTokens(asciiTokens(dec.data)),
      });
    } catch {
      // unreadable container — skip
    }
  }
  return rows;
}
