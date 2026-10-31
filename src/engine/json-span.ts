/**
 * Bytes-level, position-tracking JSON scanner for Homescapes `SaveGame.db`.
 *
 * Design rules (hard requirements, do not relax):
 *  1. NEVER re-serialize. Re-serializing a 4.5 MB Playrix save loses >100 KB
 *     and corrupts the file. We only ever splice raw bytes.
 *  2. Work on the raw `Uint8Array`. Character offsets are useless for editing;
 *     everything below is a byte offset.
 *  3. Record the exact span of every member's key (incl. quotes) and value so
 *     the patcher can target one field without disturbing a byte elsewhere.
 *
 * The save is plain JSON: CRLF line endings, tab indentation, UTF-8, no BOM,
 * no trailing NUL, no scientific notation.
 *
 * NOTE: no `enum` anywhere — this module must run under Node's type-stripping
 * (`node --experimental-strip-types`), which cannot emit enum declarations.
 */

export type ValueType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "true"
  | "false"
  | "null";

export interface MemberSpan {
  /** Dotted path. Array indices use `[n]`. Keys containing dots stay literal. */
  path: string;
  /** Start byte of the key including its opening quote; `null` inside arrays. */
  keyStart: number | null;
  /** End byte of the key (exclusive), just past the closing quote. */
  keyEnd: number | null;
  /** First byte of the value. */
  valStart: number;
  /** One past the last byte of the value. */
  valEnd: number;
  type: ValueType;
  /** Parent container path; `""` for root members. */
  parent: string;
}

export interface SpanIndex {
  members: Map<string, MemberSpan>;
  /** Every path in file order. */
  order: string[];
  /** Direct child paths per container. */
  children: Map<string, string[]>;
  /** Byte offset just past the root value. */
  rootEnd: number;
  rootType: ValueType;
}

export class ScanError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} (byte ${offset})`);
    this.name = "ScanError";
    this.offset = offset;
  }
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COLON = 0x3a;
const COMMA = 0x2c;
const MINUS = 0x2d;
const PLUS = 0x2b;
const DOT = 0x2e;
const LOWER_E = 0x65;
const UPPER_E = 0x45;

function isWs(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

/** Index of the first non-whitespace byte at or after `from`. */
export function firstValueByte(b: Uint8Array, from: number): number {
  const n = b.length;
  let i = from;
  while (i < n && isWs(b[i]!)) i++;
  if (i >= n) throw new ScanError("unexpected end of document", n);
  return i;
}

/** `i` points at the opening quote; returns the index just past the closing quote. */
function scanString(b: Uint8Array, i: number): number {
  const n = b.length;
  if (b[i] !== QUOTE) throw new ScanError("expected string", i);
  i++;
  while (i < n) {
    const c = b[i]!;
    if (c === BACKSLASH) {
      i += 2; // escape sequence is always backslash + one char
      continue;
    }
    if (c === QUOTE) return i + 1;
    i++;
  }
  throw new ScanError("unterminated string", n);
}

/** `i` points at the first byte of a JSON number. */
function scanNumber(b: Uint8Array, i: number): number {
  const n = b.length;
  let j = i;
  while (j < n) {
    const c = b[j]!;
    if (
      (c >= 0x30 && c <= 0x39) ||
      c === MINUS ||
      c === PLUS ||
      c === DOT ||
      c === LOWER_E ||
      c === UPPER_E
    ) {
      j++;
    } else break;
  }
  if (j === i) throw new ScanError("malformed number", i);
  return j;
}

function matchKeyword(b: Uint8Array, i: number, kw: string): boolean {
  if (i + kw.length > b.length) return false;
  for (let k = 0; k < kw.length; k++) if (b[i + k] !== kw.charCodeAt(k)) return false;
  return true;
}

function joinPath(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

/**
 * Scan a whole document once, recording every member's byte span.
 * Nesting in Playrix saves is shallow (<32), so plain recursion is safe.
 */
export function scanSpans(raw: Uint8Array): SpanIndex {
  const members = new Map<string, MemberSpan>();
  const order: string[] = [];
  const children = new Map<string, string[]>();

  const record = (m: MemberSpan): void => {
    members.set(m.path, m);
    order.push(m.path);
    let sib = children.get(m.parent);
    if (!sib) children.set(m.parent, (sib = []));
    sib.push(m.path);
  };

  /** Returns [endExclusive, valueType]. */
  function scanValue(start: number, path: string, parent: string): [number, ValueType] {
    const i = firstValueByte(raw, start);
    const c = raw[i]!;

    if (c === OPEN_BRACE) {
      let j = firstValueByte(raw, i + 1);
      if (raw[j] === CLOSE_BRACE) return [j + 1, "object"];
      for (;;) {
        j = firstValueByte(raw, j);
        // `j` may land on the closing brace when the last member was an EMPTY
        // value (`"key":,`), whose end is the delimiter itself — not past it.
        if (raw[j] === CLOSE_BRACE) return [j + 1, "object"];
        if (raw[j] !== QUOTE) throw new ScanError("expected object key", j);
        const keyStart = j;
        const keyEnd = scanString(raw, j);
        const key = new TextDecoder().decode(raw.subarray(keyStart + 1, keyEnd - 1));
        const cpath = joinPath(path, key);
        j = firstValueByte(raw, keyEnd);
        if (raw[j] !== COLON) throw new ScanError("expected ':'", j);
        const vstart = firstValueByte(raw, j + 1);
        // Playrix writes an EMPTY value — `"key":,` or `"key":}` — for a
        // datastore it holds but has no value for. Its own parser reads that as
        // null; a strict JSON parser refuses it, which used to make the whole
        // save unreadable (measured: 39 such keys in a live 9.2.101 re-save).
        // Record a zero-width null so the rest of the document stays readable.
        const empty = raw[vstart] === COMMA || raw[vstart] === CLOSE_BRACE;
        const vend: [number, ValueType] = empty ? [vstart, "null"] : scanValue(vstart, cpath, path);
        record({
          path: cpath,
          keyStart,
          keyEnd,
          valStart: vstart,
          valEnd: vend[0],
          type: vend[1],
          parent: path,
        });
        j = firstValueByte(raw, vend[0]);
        if (raw[j] === COMMA) {
          j++;
          continue;
        }
        if (raw[j] === CLOSE_BRACE) return [j + 1, "object"];
        throw new ScanError("expected ',' or '}'", j);
      }
    }

    if (c === OPEN_BRACKET) {
      let j = firstValueByte(raw, i + 1);
      if (raw[j] === CLOSE_BRACKET) return [j + 1, "array"];
      let idx = 0;
      for (;;) {
        const cpath = `${path}[${idx}]`;
        const vstart = firstValueByte(raw, j);
        const vend = scanValue(vstart, cpath, path);
        record({
          path: cpath,
          keyStart: null,
          keyEnd: null,
          valStart: vstart,
          valEnd: vend[0],
          type: vend[1],
          parent: path,
        });
        j = firstValueByte(raw, vend[0]);
        if (raw[j] === COMMA) {
          j++;
          idx++;
          continue;
        }
        if (raw[j] === CLOSE_BRACKET) return [j + 1, "array"];
        throw new ScanError("expected ',' or ']'", j);
      }
    }

    if (c === QUOTE) return [scanString(raw, i), "string"];
    if (c === MINUS || (c >= 0x30 && c <= 0x39)) return [scanNumber(raw, i), "number"];
    if (matchKeyword(raw, i, "true")) return [i + 4, "true"];
    if (matchKeyword(raw, i, "false")) return [i + 5, "false"];
    if (matchKeyword(raw, i, "null")) return [i + 4, "null"];
    throw new ScanError(`unexpected byte 0x${c.toString(16)}`, i);
  }

  const [rootEnd, rootType] = scanValue(0, "", "");
  return { members, order, children, rootEnd, rootType };
}

/** Raw text of a member's value (no decoding). */
export function valueText(raw: Uint8Array, m: MemberSpan): string {
  return new TextDecoder().decode(raw.subarray(m.valStart, m.valEnd));
}

/** Raw text of a member's key (without the quotes). */
export function keyText(raw: Uint8Array, m: MemberSpan): string {
  if (m.keyStart === null || m.keyEnd === null) return "";
  return new TextDecoder().decode(raw.subarray(m.keyStart + 1, m.keyEnd - 1));
}

/**
 * Decode a JSON string literal's contents (strips quotes, resolves escapes).
 * Used for tagged Playrix values such as `{"t":"i64","v":"5"}`.
 */
export function decodeJsonString(raw: Uint8Array, m: MemberSpan): string {
  const text = valueText(raw, m);
  if (m.type !== "string") return text;
  try {
    return JSON.parse(text) as string;
  } catch {
    return text.slice(1, -1);
  }
}
