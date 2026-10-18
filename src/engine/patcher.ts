/**
 * Surgical byte patcher.
 *
 * Edits are collected as `(start, end, replacement)` triples expressed against
 * the ORIGINAL buffer, then spliced in ONE forward pass into a freshly sized
 * output buffer.
 *
 * Why not mutate in place: if an edit changes the length, every later stored
 * offset becomes stale and silently corrupts the file. (Reproduced against a
 * real 4.5 MB Homescapes save: a lowest-offset-first in-place splice produced
 * a buffer that failed `JSON.parse`.) Walking forward and tracking a read
 * cursor plus a write cursor makes length changes a non-event.
 *
 * Nothing outside the edited spans is touched, so line endings, indentation,
 * key order, number formatting and embedded escaped payloads survive verbatim.
 */

export interface RawEdit {
  /** First byte of the replaced region, in the ORIGINAL buffer. */
  start: number;
  /** One past the last byte of the replaced region, in the ORIGINAL buffer. */
  end: number;
  bytes: Uint8Array;
  /** Human-readable description for the audit log / UI diff. */
  label: string;
  /** JSON path this edit targets, when known. */
  path?: string;
}

export interface EditSummary {
  label: string;
  path?: string;
  start: number;
  before: string;
  after: string;
}

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

const utf8enc = new TextEncoder();
const utf8dec = new TextDecoder();

export function toBytes(s: string): Uint8Array {
  return utf8enc.encode(s);
}

export function fromBytes(b: Uint8Array): string {
  return utf8dec.decode(b);
}

/** Validate that edits are in-bounds and mutually non-overlapping. */
export function validateEdits(raw: Uint8Array, edits: readonly RawEdit[]): RawEdit[] {
  for (const e of edits) {
    if (!Number.isInteger(e.start) || !Number.isInteger(e.end)) {
      throw new PatchError(`edit "${e.label}" has non-integer bounds`);
    }
    if (e.start < 0 || e.end > raw.length || e.start > e.end) {
      throw new PatchError(
        `edit "${e.label}" span [${e.start},${e.end}) is outside the buffer (len ${raw.length})`,
      );
    }
  }
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.start < prev.end) {
      throw new PatchError(
        `overlapping edits "${prev.label}" [${prev.start},${prev.end}) and ` +
          `"${cur.label}" [${cur.start},${cur.end})`,
      );
    }
  }
  return sorted;
}

/** Apply edits to `raw`, returning a new buffer plus a human-readable diff. */
export function applyEdits(
  raw: Uint8Array,
  edits: readonly RawEdit[],
): { out: Uint8Array; summary: EditSummary[] } {
  const sorted = validateEdits(raw, edits);

  let total = raw.length;
  for (const e of sorted) total += e.bytes.length - (e.end - e.start);
  if (total < 0) throw new PatchError("patch would produce a negative-length buffer");

  const out = new Uint8Array(total);
  let read = 0; // cursor in `raw`
  let write = 0; // cursor in `out`
  for (const e of sorted) {
    if (e.start > read) {
      out.set(raw.subarray(read, e.start), write);
      write += e.start - read;
    }
    out.set(e.bytes, write);
    write += e.bytes.length;
    read = e.end;
  }
  if (read < raw.length) {
    out.set(raw.subarray(read), write);
    write += raw.length - read;
  }
  if (write !== total) {
    throw new PatchError(`internal error: wrote ${write} bytes, expected ${total}`);
  }

  assertUntouched(raw, out, sorted);

  const summary = sorted.map((e) => ({
    label: e.label,
    path: e.path,
    start: e.start,
    before: fromBytes(raw.subarray(e.start, e.end)),
    after: fromBytes(e.bytes),
  }));
  return { out, summary };
}

/**
 * Prove that every byte outside the edited spans is identical to the source.
 * This is the safety property the whole editor rests on.
 */
export function assertUntouched(
  raw: Uint8Array,
  out: Uint8Array,
  edits: readonly RawEdit[],
): void {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);

  let i = 0; // cursor in `raw`
  let o = 0; // cursor in `out`
  for (const e of sorted) {
    for (; i < e.start; i++, o++) {
      if (raw[i] !== out[o]) {
        throw new PatchError(`untouched byte changed at source ${i} / output ${o}`);
      }
    }
    i = e.end;
    // Skip the replacement region in `out`. Its length is the REPLACEMENT's,
    // which may differ from the source span — that is the whole point of the
    // patcher, and counting `e.end - e.start` here would desynchronise the
    // cursors and make every length-changing edit look like corruption.
    o += e.bytes.length;
  }
  for (; i < raw.length; i++, o++) {
    if (raw[i] !== out[o]) {
      throw new PatchError(`untouched byte changed at source ${i} / output ${o}`);
    }
  }
  if (o !== out.length) {
    throw new PatchError(`output length mismatch: expected ${o}, got ${out.length}`);
  }
}

/**
 * Encode a JSON number literal the way Playrix writes them: plain decimal,
 * no `+`, no leading zeros, no exponent, `-0` normalized to `0`.
 * Rejects non-finite values, which JSON cannot represent.
 */
export function encodeJsonNumber(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PatchError(`cannot encode non-finite number ${String(value)}`);
  }
  if (Object.is(value, -0)) return "0";
  if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
    return String(value);
  }
  const s = String(value);
  if (/[eE]/.test(s)) {
    throw new PatchError(
      `value ${value} serializes with an exponent, which this save format does not use`,
    );
  }
  return s;
}

/** Encode a JSON string literal, escaping only what JSON requires. */
export function encodeJsonString(value: string): string {
  return JSON.stringify(value);
}

/** Any value a JSON document can hold. Used for constructed subtrees. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Encode an arbitrary JSON value as compact text — the compact style the
 * 9.2.101 engine writes (the fresh save has zero whitespace).
 *
 * Unlike `JSON.stringify`, this REFUSES anything JSON cannot represent
 * faithfully instead of silently coercing it: `undefined` members, non-finite
 * numbers, bigint/function/symbol, non-plain objects (Date, class instances),
 * and cycles. A save tool must never invent or drop content on encode.
 */
export function encodeJsonValue(value: JsonValue): string {
  const out: string[] = [];
  const seen = new Set<object>();
  const walk = (v: unknown, path: string): void => {
    if (v === null) {
      out.push("null");
      return;
    }
    switch (typeof v) {
      case "boolean":
        out.push(v ? "true" : "false");
        return;
      case "number":
        out.push(encodeJsonNumber(v)); // already rejects non-finite
        return;
      case "string":
        out.push(encodeJsonString(v));
        return;
      case "object": {
        if (seen.has(v)) throw new PatchError(`${path}: cyclic value`);
        seen.add(v);
        if (Array.isArray(v)) {
          out.push("[");
          for (let i = 0; i < v.length; i++) {
            if (i > 0) out.push(",");
            walk(v[i], `${path}[${i}]`);
          }
          out.push("]");
        } else {
          const proto = Object.getPrototypeOf(v);
          if (proto !== Object.prototype && proto !== null) {
            throw new PatchError(
              `${path}: only plain objects are allowed (got ${proto?.constructor?.name ?? "unknown"})`,
            );
          }
          out.push("{");
          let first = true;
          for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
            if (item === undefined) {
              throw new PatchError(`${path}.${k}: undefined is not representable in JSON`);
            }
            if (!first) out.push(",");
            first = false;
            out.push(encodeJsonString(k), ":");
            walk(item, `${path}.${k}`);
          }
          out.push("}");
        }
        seen.delete(v);
        return;
      }
      case "undefined":
        throw new PatchError(`${path}: undefined is not representable in JSON`);
      default:
        throw new PatchError(`${path}: unsupported value type ${typeof v}`);
    }
  };
  walk(value, "$");
  return out.join("");
}
