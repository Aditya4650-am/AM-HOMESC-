/**
 * High-level, edit-safe view of a Homescapes `SaveGame.db`.
 *
 * Responsibilities:
 *   - scan once, keep byte spans for every field
 *   - expose fields as friendly values (unwrapping Playrix tagged wrappers)
 *   - queue edits that only ever splice raw bytes
 *   - optionally refresh the derived `Properties.CeReas_R*` checksum strings
 *
 * Playrix stores many scalars as tagged wrappers instead of bare values:
 *   {"t": "i64", "v": "5"}   -> integer, but the value is a JSON *string*
 *   {"t": "f",    "v": 1.5}  -> float
 *   {"t": "ds",   "v": {...}}-> a small dictionary-like object
 * Reading and writing must go through the wrapper's inner `v`, never the
 * wrapper itself, and the wrapper must survive untouched.
 */

import { scanSpans, valueText, type MemberSpan, type SpanIndex } from "./json-span.ts";
import {
  applyEdits,
  encodeJsonNumber,
  encodeJsonString,
  encodeJsonValue,
  fromBytes,
  toBytes,
  type EditSummary,
  type JsonValue,
  type RawEdit,
} from "./patcher.ts";

export type FieldKind =
  | "int"
  | "float"
  | "number"
  | "string"
  | "boolean"
  | "null"
  | "object"
  | "array"
  | "tagged-i64"
  | "tagged-f"
  | "tagged-ds"
  | "tagged-other";

export interface SaveField {
  path: string;
  kind: FieldKind;
  /** Friendly decoded value: tagged `i64` unwrapped to a number, etc. */
  value: unknown;
  /** Raw JSON text exactly as it appears in the file. */
  raw: string;
  span: MemberSpan;
  /** Tag string when this field is a `{"t":...,"v":...}` wrapper. */
  tag?: string;
  /** Span of the wrapper's inner `v`, when tagged. */
  innerSpan?: MemberSpan;
}

export class SaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveError";
  }
}

interface TagInfo {
  tag: string;
  inner: MemberSpan;
}

const toInt = (s: string): number => {
  const n = Number(s);
  if (!Number.isFinite(n)) throw new SaveError(`not a number: ${s}`);
  return n;
};

const WS_BYTES = new Set([0x20, 0x09, 0x0a, 0x0d]); // space, tab, LF, CR

export class SaveGame {
  readonly raw: Uint8Array;
  readonly index: SpanIndex;
  /** True when the buffer was XOR-wrapped and must be re-wrapped on save. */
  readonly wasEncrypted: boolean;
  #edits: RawEdit[] = [];

  constructor(raw: Uint8Array, index: SpanIndex, wasEncrypted = false) {
    this.raw = raw;
    this.index = index;
    this.wasEncrypted = wasEncrypted;
  }

  // ---------------------------------------------------------------- read --

  has(path: string): boolean {
    return this.index.members.has(path);
  }

  /** Every recorded path, in file order. */
  paths(): readonly string[] {
    return this.index.order;
  }

  /** Direct children of a container path (empty string = root). */
  children(path: string): readonly string[] {
    return this.index.children.get(path) ?? [];
  }

  span(path: string): MemberSpan {
    const m = this.index.members.get(path);
    if (!m) throw new SaveError(`no such field: ${path}`);
    return m;
  }

  /** Raw JSON text of a field's value. */
  rawText(path: string): string {
    return valueText(this.raw, this.span(path));
  }

  /** Detect a `{"t":...,"v":...}` wrapper. */
  #tagOf(path: string, m: MemberSpan): TagInfo | undefined {
    if (m.type !== "object") return undefined;
    const kids = this.index.children.get(path);
    if (!kids || kids.length !== 2) return undefined;
    if (!kids.includes(`${path}.t`) || !kids.includes(`${path}.v`)) return undefined;
    const t = this.index.members.get(`${path}.t`);
    const v = this.index.members.get(`${path}.v`);
    if (!t || !v || t.type !== "string") return undefined;
    return { tag: valueText(this.raw, t).slice(1, -1), inner: v };
  }

  /** Field detail including friendly value and tag metadata. */
  field(path: string): SaveField {
    const m = this.span(path);
    const tag = this.#tagOf(path, m);
    if (tag) {
      const innerText = valueText(this.raw, tag.inner);
      let value: unknown = innerText;
      if (tag.inner.type === "null") {
        // Playrix's empty value (`"v":,`) — held, but valueless.
        value = null;
      } else if (tag.inner.type === "string") {
        value = tag.tag === "i64" || tag.tag === "f" ? Number(JSON.parse(innerText)) : JSON.parse(innerText);
      } else if (tag.inner.type === "number") {
        value = Number(innerText);
      } else if (tag.inner.type === "true" || tag.inner.type === "false") {
        value = tag.inner.type === "true";
      } else {
        try {
          value = JSON.parse(innerText);
        } catch {
          value = innerText;
        }
      }
      const kind: FieldKind =
        tag.tag === "i64" ? "tagged-i64" : tag.tag === "f" ? "tagged-f" : tag.tag === "ds" ? "tagged-ds" : "tagged-other";
      return { path, kind, value, raw: valueText(this.raw, m), span: m, tag: tag.tag, innerSpan: tag.inner };
    }
    return {
      path,
      kind: kindOf(m.type),
      value: decodeBare(m.type, valueText(this.raw, m)),
      raw: valueText(this.raw, m),
      span: m,
    };
  }

  /**
   * Newest queued replacement text for `path`, if any. Readers must consult
   * this first so that a `set()` is visible immediately ("read your own
   * writes") — `refreshIntegrity` derives R1/R4 from values the caller has
   * already queued but not yet committed.
   */
  #pendingText(path: string): string | undefined {
    for (let i = this.#edits.length - 1; i >= 0; i--) {
      const e = this.#edits[i]!;
      if (e.path === path) return fromBytes(e.bytes);
    }
    return undefined;
  }

  /** Convenience typed readers used by the curated editor cards. */
  number(path: string): number {
    const queued = this.#pendingText(path);
    if (queued !== undefined) {
      // Queued bytes are the encoded JSON literal (e.g. `4242` or `"4242"`
      // for tagged i64 inners), so accept a numeric string too.
      const parsed: unknown = JSON.parse(queued);
      const v = typeof parsed === "string" ? Number(parsed) : parsed;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new SaveError(`${path} is not numeric (got ${typeof parsed})`);
      }
      return v;
    }
    const f = this.field(path);
    const v = f.value;
    if (typeof v !== "number") throw new SaveError(`${path} is not numeric (got ${typeof v})`);
    return v;
  }

  string(path: string): string {
    const queued = this.#pendingText(path);
    if (queued !== undefined) {
      const parsed: unknown = JSON.parse(queued);
      if (typeof parsed !== "string") throw new SaveError(`${path} is not a string`);
      return parsed;
    }
    const f = this.field(path);
    const v = f.value;
    if (typeof v !== "string") throw new SaveError(`${path} is not a string`);
    return v;
  }

  // --------------------------------------------------------------- write --

  /**
   * Queue a value change. Nothing is written until `commit()`.
   * Refuses to replace containers wholesale — edit a leaf instead.
   *
   * Exception: a `null` leaf (the game's "unset" default — fresh accounts have
   * `Avatars`, `GameModifiers` and `PlayerItems` all null) may be replaced by
   * ANY JSON-valid value, including a constructed object. That is how unlock
   * structures are materialized on a save that has never written them: still a
   * single surgical value splice, with `commit()` proving the rest untouched.
   */
  set(path: string, value: JsonValue): this {
    const m = this.span(path);
    const tag = this.#tagOf(path, m);
    const label = this.#label(path, value);

    if (tag) {
      // Route through the wrapper's inner `v`, preserving the wrapper.
      const inner = tag.inner;
      let text: string;
      if (tag.tag === "i64") {
        if (typeof value !== "number" || !Number.isInteger(value)) {
          throw new SaveError(`${path} is a tagged i64 and requires an integer`);
        }
        text = encodeJsonString(String(value)); // i64 values are JSON strings
      } else if (tag.tag === "f") {
        if (typeof value !== "number") throw new SaveError(`${path} is a tagged float`);
        text = encodeJsonNumber(value);
      } else if (inner.type === "string") {
        if (typeof value !== "string") throw new SaveError(`${path} stores a string`);
        text = encodeJsonString(value);
      } else if (inner.type === "number") {
        if (typeof value !== "number") throw new SaveError(`${path} stores a number`);
        text = encodeJsonNumber(value);
      } else {
        throw new SaveError(
          `${path} is a tagged ${tag.tag} with a ${inner.type} value; edit one of its leaves instead`,
        );
      }
      this.#edits.push({
        start: inner.valStart,
        end: inner.valEnd,
        bytes: toBytes(text),
        label,
        path,
      });
      return this;
    }

    switch (m.type) {
      case "number": {
        if (typeof value !== "number") throw new SaveError(`${path} is numeric; pass a number`);
        this.#push(m, encodeJsonNumber(value), label, path);
        return this;
      }
      case "string": {
        if (typeof value !== "string") throw new SaveError(`${path} is a string; pass text`);
        this.#push(m, encodeJsonString(value), label, path);
        return this;
      }
      case "true":
      case "false": {
        if (typeof value !== "boolean") throw new SaveError(`${path} is a boolean`);
        this.#push(m, value ? "true" : "false", label, path);
        return this;
      }
      case "null": {
        // Null leaf -> any JSON-valid value. Typical use: materializing an
        // unlock structure (Avatars/GameModifiers/PlayerItems) the fresh
        // account has never written. Strictly validated — no silent coercion.
        let text: string;
        try {
          text = encodeJsonValue(value);
        } catch (err) {
          throw new SaveError(`${path}: ${(err as Error).message}`);
        }
        this.#push(m, text, label, path);
        return this;
      }
      default:
        throw new SaveError(
          `refusing to replace the whole ${m.type} at ${path}; edit one of its leaf fields instead`,
        );
    }
  }

  /**
   * Insert a NEW member into an existing object — the one operation `set()`
   * deliberately refuses, for fields the save has never written (a fresh
   * account has no `Properties.level` at all).
   *
   * Dotted-literal keys follow the save's own convention: the LONGEST prefix
   * that already resolves to an object becomes the parent and the remainder
   * stays a literal member name — so `Properties.lives.max` writes the literal
   * key `"lives.max"` inside `Properties`, exactly like the game's own
   * `"lives.current"`. A dotless path targets the root object.
   *
   * One splice at the parent's closing brace; `commit()` still proves every
   * other byte is untouched.
   */
  create(path: string, value: JsonValue): this {
    if (this.has(path)) throw new SaveError(`${path} already exists; use set() to edit it`);

    // ---- locate the parent object: longest existing prefix wins ----
    const dots: number[] = [];
    for (let i = path.indexOf("."); i > 0; i = path.indexOf(".", i + 1)) dots.push(i);
    let parent: string | null = null;
    for (let k = dots.length - 1; k >= 0; k--) {
      const prefix = path.slice(0, dots[k]!);
      if (this.index.members.get(prefix)?.type === "object") {
        parent = prefix;
        break;
      }
    }

    let name: string;
    let valStart: number;
    let valEnd: number;
    if (parent !== null) {
      name = path.slice(parent.length + 1);
      const p = this.span(parent);
      valStart = p.valStart;
      valEnd = p.valEnd;
    } else if (dots.length === 0) {
      // Root-level member: the document itself must be an object.
      let s = 0;
      while (s < this.raw.length && WS_BYTES.has(this.raw[s]!)) s++;
      let e = this.raw.length - 1;
      while (e > s && WS_BYTES.has(this.raw[e]!)) e--;
      if (this.raw[s] !== 0x7b || this.raw[e] !== 0x7d) {
        throw new SaveError(`cannot create ${path}: document root is not an object`);
      }
      name = path;
      valStart = s;
      valEnd = e + 1;
    } else {
      throw new SaveError(`no existing object parent for ${path}`);
    }

    // A member name carrying an array index names a ROW, not a plain key:
    // `OwnedCards[9].v.inStockCount` would otherwise be spliced into the
    // parent object as the literal member "OwnedCards[9].v.inStockCount" and
    // corrupt the save. Rows that do not exist yet can only be appended.
    if (name.includes("[")) {
      throw new SaveError(
        `${path} names an array row — a new row must be appended with append(), not created`,
      );
    }

    // ---- closing brace of the parent, and whether it is empty ----
    const close = valEnd - 1;
    if (this.raw[close] !== 0x7d) {
      throw new SaveError(`internal: parent of ${path} does not end with "}"`);
    }
    let i = valStart + 1;
    while (i < close && WS_BYTES.has(this.raw[i]!)) i++;
    const empty = i === close;

    let pair: string;
    try {
      pair = `${encodeJsonString(name)}:${encodeJsonValue(value)}`;
    } catch (err) {
      throw new SaveError(`${path}: ${(err as Error).message}`);
    }
    const text = (empty ? "" : ",") + pair + "}";
    const label = this.#label(path, value, true);

    // Sibling creates into the same parent share this closing-brace anchor.
    // Amending the pending insert (instead of pushing a second edit over the
    // same byte) keeps the edit list overlap-free — commit() rejects overlapping
    // ranges — while preserving creation order. Only create() ever claims the
    // [close, close + 1) range: leaf replacements end AT the closing brace,
    // never past it.
    for (let k = this.#edits.length - 1; k >= 0; k--) {
      const e = this.#edits[k]!;
      if (e.start !== close || e.end !== close + 1) continue;
      const prev = fromBytes(e.bytes);
      const head = prev.startsWith(",") ? "," : "";
      e.bytes = toBytes(head + pair + "," + prev.slice(head.length));
      // Keep the audit label bounded on bulk grants (176+ sibling creates).
      if (e.label.length < 240) e.label = `${e.label} & ${label}`;
      else {
        const m = /^(.*) \+(\d+)$/.exec(e.label);
        e.label = m ? `${m[1]} +${Number(m[2]) + 1}` : `${e.label} +1`;
      }
      return this;
    }
    this.#edits.push({ start: close, end: close + 1, bytes: toBytes(text), label, path });
    return this;
  }

  /**
   * Append one element to an EXISTING array — the counterpart to `create()`
   * for list-shaped state the save already wrote (the card album's
   * `OwnedCards`, gift boxes, avatar unlocks held as a list).
   *
   * Same splice discipline as `create()`: one edit at the closing bracket,
   * and appends into the same array amend that bracket's pending insert
   * instead of stacking a second edit over the same bytes — so granting 150
   * cards stays overlap-free and `commit()` still proves every other byte
   * is untouched. Re-serializing the array is never an option: it would
   * rewrite the whole container.
   */
  append(path: string, value: JsonValue): this {
    const m = this.span(path);
    if (m.type !== "array") throw new SaveError(`${path} is not an array`);
    const close = m.valEnd - 1;
    if (this.raw[close] !== 0x5d) {
      throw new SaveError(`internal: ${path} does not end with "]"`);
    }
    let i = m.valStart + 1;
    while (i < close && WS_BYTES.has(this.raw[i]!)) i++;
    const empty = i === close;

    let item: string;
    try {
      item = encodeJsonValue(value);
    } catch (err) {
      throw new SaveError(`${path}: ${(err as Error).message}`);
    }
    const text = (empty ? "" : ",") + item + "]";
    const label = this.#label(`${path}[+]`, value, true);

    // Amend the pending append for this array rather than overlapping it.
    for (let k = this.#edits.length - 1; k >= 0; k--) {
      const e = this.#edits[k]!;
      if (e.start !== close || e.end !== close + 1) continue;
      const prev = fromBytes(e.bytes);
      const head = prev.startsWith(",") ? "," : "";
      e.bytes = toBytes(head + item + "," + prev.slice(head.length));
      if (e.label.length < 240) e.label = `${e.label} & ${label}`;
      else {
        const m2 = /^(.*) \+(\d+)$/.exec(e.label);
        e.label = m2 ? `${m2[1]} +${Number(m2[2]) + 1}` : `${e.label} +1`;
      }
      return this;
    }
    this.#edits.push({ start: close, end: close + 1, bytes: toBytes(text), label, path });
    return this;
  }

  #label(path: string, value: JsonValue, created = false): string {
    const shown =
      typeof value === "object" && value !== null
        ? Array.isArray(value)
          ? `[${value.length} items]`
          : `{${Object.keys(value).length} keys}`
        : JSON.stringify(value);
    return `${created ? "+ " : ""}${path} = ${shown}`;
  }

  #push(m: MemberSpan, text: string, label: string, path: string): void {
    this.#edits.push({ start: m.valStart, end: m.valEnd, bytes: toBytes(text), label, path });
  }

  /** Queue a queued edit range replacement (used by integrity refresh). */
  pushRawEdit(start: number, end: number, text: string, label: string, path?: string): this {
    this.#edits.push({ start, end, bytes: toBytes(text), label, path });
    return this;
  }

  /** Pending edits, newest last. */
  pending(): readonly RawEdit[] {
    return this.#edits;
  }

  discard(): void {
    this.#edits = [];
  }

  /**
   * Apply every queued edit and return the new buffer.
   * Output is validated: JSON must still parse and untouched bytes must be
   * bit-identical to the source.
   */
  commit(): { bytes: Uint8Array; summary: EditSummary[] } {
    const edits = this.#edits;
    if (edits.length === 0) return { bytes: this.raw, summary: [] };

    const { out, summary } = applyEdits(this.raw, edits);
    assertStillJson(out);
    this.#edits = [];
    return { bytes: out, summary };
  }
}

function assertStillJson(buf: Uint8Array): void {
  const text = fromBytes(buf);
  try {
    JSON.parse(text);
  } catch (err) {
    throw new SaveError(`patch produced invalid JSON: ${(err as Error).message}`);
  }
}

function kindOf(t: MemberSpan["type"]): FieldKind {
  switch (t) {
    case "number":
      return "number";
    case "string":
      return "string";
    case "true":
    case "false":
      return "boolean";
    case "null":
      return "null";
    case "object":
      return "object";
    case "array":
      return "array";
    default:
      return "number";
  }
}

function decodeBare(t: MemberSpan["type"], text: string): unknown {
  switch (t) {
    case "number":
      return Number(text);
    case "string":
      try {
        return JSON.parse(text) as string;
      } catch {
        return text.slice(1, -1);
      }
    case "true":
      return true;
    case "false":
      return false;
    case "null":
      return null;
    default:
      return text;
  }
}

/** Open a save that has already been decoded to plain JSON bytes. */
export function openSave(raw: Uint8Array, wasEncrypted = false): SaveGame {
  const index = scanSpans(raw);
  if (index.rootType !== "object") {
    throw new SaveError(`expected a JSON object root, found ${index.rootType}`);
  }
  return new SaveGame(raw, index, wasEncrypted);
}
