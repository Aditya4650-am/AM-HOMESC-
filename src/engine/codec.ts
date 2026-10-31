/**
 * Homescapes `SaveGame.db` container codec.
 *
 * Shapes that exist in the wild:
 *
 *   1. Plain JSON — the community sample and older exports. Fast path.
 *   2. Repeating-key XOR (period 731, key starts at file offset 0 — there is
 *      NO header; the apparent `#\x10f205` header on 9.2.101 files is simply
 *      ciphertext whose first bytes happen to spell those characters).
 *      Two keys are known:
 *        - "f205"      — RECOVERED from live 9.2.101 device files and PROVEN
 *                        against three independent generations (db/bak/buf):
 *                        valid JSON, HUD-matching values, byte-exact round-trip.
 *                        See `f205-key.ts` for the full provenance.
 *        - "community" — from `decode_savegame.py`; round-trips the older
 *                        4.5 MB level-655 sample only. Key was rotated for
 *                        9.2.101 (11/731 bytes match), kept as legacy fallback.
 *
 * Plaintext is JSON optionally followed by trailing NUL bytes (the live files
 * carry exactly one). Those are stripped into `trailer` so the engine sees
 * pure JSON, and re-appended by `encodeSave`, keeping container round-trips
 * byte-exact.
 *
 * Detection is strict: a candidate plaintext must begin with `{`, follow JSON
 * object grammar immediately after it (`"` or `}`), and terminate with `}`/`]`
 * (ignoring trailing NUL/whitespace). Real wrong-key decodes break this on
 * byte 1, so the codec refuses rather than handing back garbage.
 */

import { xorKey } from "./xor-key.ts";
import { f205Key } from "./f205-key.ts";
import { RECOVERY_LOGF } from "./recovery-logf.ts";

export type CodecKeyId = "f205" | "community" | "recovered";

export interface CodecResult {
  /** Plain JSON bytes (trailing NULs removed). Safe for `openSave`. */
  bytes: Uint8Array;
  /** Trailing NUL bytes stripped from the container; re-appended on encode. */
  trailer: Uint8Array;
  /** Whether an XOR wrapper had to be removed. */
  wasEncrypted: boolean;
  /** Which key decoded the container, if any. */
  keyId: CodecKeyId | null;
  /** Exact XOR key bytes used when encrypted (carried for re-encoding). */
  key?: Uint8Array;
  /** How confidently we identified the container. */
  confidence: "certain" | "heuristic";
  /** Present when the container could not be decoded. */
  warning?: string;
}

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);
const EMPTY = new Uint8Array(0);

function firstNonWs(b: Uint8Array): number {
  for (let i = 0; i < b.length; i++) if (!WS.has(b[i]!)) return i;
  return -1;
}

/**
 * Strict save-JSON shape check used to validate a candidate decode:
 * opens with `{`, the next significant byte obeys JSON object grammar, and
 * the last significant byte closes the value. Trailing NUL/whitespace is
 * tolerated (the live container's NUL terminator).
 */
function looksLikeSaveJson(b: Uint8Array): boolean {
  let i = firstNonWs(b);
  if (i < 0 || b[i] !== 0x7b) return false;
  i++;
  while (i < b.length && WS.has(b[i]!)) i++;
  if (i >= b.length) return false;
  if (b[i] !== 0x22 /* '"' */ && b[i] !== 0x7d /* '}' */) return false;
  let j = b.length - 1;
  while (j > 0 && (b[j] === 0x00 || WS.has(b[j]!))) j--;
  return b[j] === 0x7d /* '}' */ || b[j] === 0x5d /* ']' */;
}

function xorWith(raw: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(raw.length);
  const klen = key.length;
  for (let i = 0; i < raw.length; i++) out[i] = raw[i]! ^ key[i % klen]!;
  return out;
}

/** Split trailing NUL bytes off a decoded body. */
function stripNulTrailer(b: Uint8Array): { body: Uint8Array; trailer: Uint8Array } {
  let end = b.length;
  while (end > 0 && b[end - 1] === 0x00) end--;
  if (end === b.length) return { body: b, trailer: EMPTY };
  return { body: b.subarray(0, end), trailer: b.subarray(end) };
}

function appendTrailer(b: Uint8Array, trailer: Uint8Array): Uint8Array {
  if (trailer.length === 0) return b;
  // Idempotent: never double-append if the caller's bytes already carry it.
  if (b.length >= trailer.length) {
    let already = true;
    for (let i = 0; i < trailer.length; i++) {
      if (b[b.length - trailer.length + i] !== trailer[i]) { already = false; break; }
    }
    if (already) return b;
  }
  const out = new Uint8Array(b.length + trailer.length);
  out.set(b, 0);
  out.set(trailer, b.length);
  return out;
}

function keyFor(keyId: CodecKeyId): Uint8Array {
  if (keyId === "recovered") {
    throw new Error(
      "recovered keys are not static — pass the CodecResult from decodeSave to encodeSave " +
        "so the key recovered from the container is reused",
    );
  }
  return keyId === "community" ? xorKey() : f205Key();
}

/**
 * Known keys, tried in order of authority: the device-proven 9.2.101 key
 * first, the legacy community key second.
 */
const KEY_TRIES: ReadonlyArray<readonly [CodecKeyId, () => Uint8Array]> = [
  ["f205", f205Key],
  ["community", xorKey],
];

// ------------------------------------------------------ key recovery ------
// The XOR key is per-INSTALL, not per-account: it is regenerated by native
// code on every `pm clear`, so a hardcoded key can always go stale. Because
// the key is a repeating 731-byte pattern XORed over JSON whose byte
// frequencies are highly non-uniform, every key position can be recovered
// statistically: for position j, each candidate byte k is scored by how well
// the observed ciphertext bytes at i ≡ j (mod 731) decrypt to the plaintext
// byte distribution (SUM count[c] * logfreq[c ^ k]). Proven decisive (min
// gap ≥ 1.1 nats/byte, 0 weak positions) on five real 9.2.101 device saves
// in ~150–200 ms for 320 KB–4.5 MB containers.

const RECOVERY_PERIOD = 731;
/** Recovery only has votes for positions i >= 256 (the JSON head is known). */
const RECOVERY_OFF = 256;
/** Below this size there are too few votes per key position to trust. */
const RECOVERY_MIN_LEN = 4096;
/**
 * Score floor for candidate plaintext bytes >= 128: save JSON is ASCII, so a
 * candidate key that maps ciphertext to high-bit bytes is effectively
 * probability zero (e^-25 ≈ 1.4e-11 per byte). Real install keys are
 * printable ASCII, so the true key never lands here.
 */
const RECOVERY_LOGF_FLOOR = -25;

interface KeyRecovery {
  key: Uint8Array;
  /** Smallest decisive margin over the runner-up, nats per byte at a position. */
  minGap: number;
  /** Positions whose margin was suspiciously weak (< 0.5 nats/byte). */
  weak: number;
}

/**
 * Recover the repeating XOR key from ciphertext alone by plaintext byte
 * frequency voting. Deterministic: the same container always yields the
 * same key. Returns null when the buffer is too small to carry enough
 * votes per key position.
 */
function recoverXorKey(raw: Uint8Array): KeyRecovery | null {
  if (raw.length < RECOVERY_OFF + RECOVERY_PERIOD) return null;
  const key = new Uint8Array(RECOVERY_PERIOD);
  const counts = new Float64Array(256);
  let minGap = Infinity;
  let weak = 0;
  for (let j = 0; j < RECOVERY_PERIOD; j++) {
    counts.fill(0);
    let n = 0;
    // Smallest i >= RECOVERY_OFF with i % PERIOD == j.
    let i = j >= RECOVERY_OFF ? j : j + RECOVERY_PERIOD;
    for (; i < raw.length; i += RECOVERY_PERIOD) {
      counts[raw[i]!]!++;
      n++;
    }
    if (n === 0) {
      key[j] = 0;
      continue;
    }
    let best = 0;
    let bestS = -Infinity;
    let secondS = -Infinity;
    for (let k = 0; k < 128; k++) {
      let s = 0;
      for (let c = 0; c < 256; c++) {
        const cnt = counts[c]!;
        if (cnt === 0) continue;
        const idx = c ^ k;
        s += cnt * (idx < 128 ? RECOVERY_LOGF[idx]! : RECOVERY_LOGF_FLOOR);
      }
      if (s > bestS) {
        secondS = bestS;
        bestS = s;
        best = k;
      } else if (s > secondS) {
        secondS = s;
      }
    }
    key[j] = best;
    const gap = (bestS - secondS) / n;
    if (gap < minGap) minGap = gap;
    if (gap < 0.5) weak++;
  }
  return { key, minGap, weak };
}

/**
 * A candidate plaintext must not only look like save JSON (strict head/tail
 * grammar) but parse fully as UTF-8 JSON: a wrong key that happened to pass
 * the shape check would still fail JSON.parse with overwhelming probability
 * at 100 KB+, and a false acceptance would hand the user a container the
 * game cannot read.
 */
function parsesAsUtf8Json(b: Uint8Array): boolean {
  try {
    JSON.parse(withEmptyValuesAsNull(new TextDecoder("utf-8", { fatal: true }).decode(b)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Playrix emits an EMPTY value (`"key":,` / `"key":}`) for a datastore it
 * holds without a value; its own parser reads that as null. `JSON.parse`
 * refuses it, so key recovery would reject a perfectly good candidate decode.
 * Rewrite only for VALIDATION — the bytes we keep are never touched.
 *
 * The delimiter that closes the (empty) value is consumed by the pattern and
 * re-emitted, so `"key":,` becomes `"key":null,`.
 */
export function withEmptyValuesAsNull(text: string): string {
  return text.replace(/:\s*([,}\]])/g, ":null$1");
}

/** How many Playrix empty-value members this text carries (for validation). */
export function countEmptyValues(text: string): number {
  return (text.match(/:\s*(?=[,}\]])/g) ?? []).length;
}

/** Decode a possibly-wrapped save into plain JSON bytes. */
export function decodeSave(raw: Uint8Array): CodecResult {
  // Plain JSON fast path — same strict shape check as for decoded candidates,
  // so double-wrapped or truncated buffers are refused instead of accepted
  // just because byte 0 happens to be '{'.
  if (looksLikeSaveJson(raw)) {
    const { body, trailer } = stripNulTrailer(raw);
    return { bytes: body, trailer, wasEncrypted: false, keyId: null, confidence: "certain" };
  }

  for (const [keyId, getKey] of KEY_TRIES) {
    const key = getKey();
    const decoded = xorWith(raw, key);
    if (!looksLikeSaveJson(decoded)) continue;
    const { body, trailer } = stripNulTrailer(decoded);
    return {
      bytes: body,
      trailer,
      wasEncrypted: true,
      keyId,
      key,
      confidence: "certain",
      ...(keyId === "community"
        ? {
            warning:
              "Decoded with the legacy community key, which is verified only against the " +
              "older 4.5 MB sample — not against this build's device files. Verify the " +
              "game loads the result before keeping edits.",
          }
        : {}),
    };
  }

  // Per-install key: statistical recovery (see recoverXorKey above). This is
  // the normal path for saves pulled from any device after a `pm clear`,
  // because the game regenerates its XOR key on every fresh install.
  const recovery = recoverXorKey(raw);
  if (recovery) {
    const decoded = xorWith(raw, recovery.key);
    if (looksLikeSaveJson(decoded)) {
      const { body, trailer } = stripNulTrailer(decoded);
      if (parsesAsUtf8Json(body)) {
        return {
          bytes: body,
          trailer,
          wasEncrypted: true,
          keyId: "recovered",
          key: recovery.key,
          confidence: "certain",
          ...(recovery.weak > 0
            ? {
                warning:
                  `Recovered the per-install XOR key statistically, but ${recovery.weak} of ` +
                  `${RECOVERY_PERIOD} key positions had a weak margin (<0.5 nats/byte). ` +
                  "Verify the game loads pushed edits before keeping them.",
              }
            : {}),
        };
      }
    }
  }

  return {
    bytes: raw,
    trailer: EMPTY,
    wasEncrypted: false,
    keyId: null,
    confidence: "heuristic",
    warning:
      "Container is neither plain JSON nor decodable with the known keys (device-proven " +
      "9.2.101 key, legacy community key) and statistical key recovery did not produce " +
      "valid save JSON. It may use a scheme this tool does not model.",
  };
}

/**
 * Re-apply the container wrapper. Accepts the `CodecResult` from decoding
 * (so the same key and trailer are used — this is the correct path), or a
 * boolean for backwards compatibility (true = wrap with the device key).
 */
export function encodeSave(
  bytes: Uint8Array,
  source: CodecResult | boolean = true,
): Uint8Array {
  if (typeof source === "boolean") {
    return source ? xorWith(bytes, f205Key()) : bytes;
  }
  const body = appendTrailer(bytes, source.trailer);
  if (!source.wasEncrypted || source.keyId === null) return body;
  // Prefer the exact key bytes carried on the result: for "recovered" this
  // is the only source, for known keys it avoids recomputation.
  return xorWith(body, source.key ?? keyFor(source.keyId));
}

/**
 * Explicitly wrap plain JSON bytes with a named key (testing/tooling helper).
 * `trailer` defaults to none; pass the NUL terminator to emulate a device file.
 */
export function wrapSave(
  bytes: Uint8Array,
  keyId: CodecKeyId,
  trailer: Uint8Array = EMPTY,
): Uint8Array {
  return xorWith(appendTrailer(bytes, trailer), keyFor(keyId));
}

/** Human-readable container label derived from an already-computed decode. */
export function describeCodec(c: CodecResult, raw?: Uint8Array): string {
  if (c.keyId === "f205") return "f205 XOR container (device-proven 9.2.101 key)";
  if (c.keyId === "community") return "XOR container (legacy community key)";
  if (c.keyId === "recovered") return "XOR container (per-install key recovered statistically)";
  const ref = raw ?? c.bytes;
  const i = firstNonWs(ref);
  if (i < 0) return "empty buffer";
  if (c.confidence === "certain" && ref[i] === 0x7b) return "plain JSON object";
  return `undecoded binary container (first byte 0x${ref[i]!.toString(16).padStart(2, "0")})`;
}

/**
 * Structural health check the UI runs before anything is pushed to a device.
 * Performs a full decode so the label reflects which key actually works.
 */
export function describeContainer(raw: Uint8Array): string {
  return describeCodec(decodeSave(raw), raw);
}
