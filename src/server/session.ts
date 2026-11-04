/**
 * Server-side save session.
 *
 * Mirrors the reference tool's pipeline shape: a session holds the container
 * bytes exactly as pulled from the device, plus the decoded plain-JSON view
 * the engine operates on. Applying edits produces a new plain buffer and a
 * full audit trail; the container is only re-encoded on the way out.
 */

import { randomUUID } from "node:crypto";
import {
  CATALOG,
  PREFIX_SECTIONS,
  decodeSave,
  describeCodec,
  discoverPrefix,
  encodeSave,
  openSave,
  readIntegrity,
  runApply,
  storageMap,
  summarize,
  type ApplyOptions,
  type ApplyResult,
  type CodecResult,
  type EditOp,
  type IntegrityReport,
} from "../engine/index.ts";

export interface SessionMeta {
  id: string;
  name: string;
  containerBytes: number;
  plainBytes: number;
  containerKind: string;
  wasEncrypted: boolean;
  /** Which XOR key decoded the container, when encrypted. */
  codecKey?: string;
  codecWarning?: string;
  loadedAt: string;
  fieldCount: number;
}

export interface OverviewPayload {
  meta: SessionMeta;
  catalog: typeof CATALOG;
  prefixSections: typeof PREFIX_SECTIONS;
  overview: ReturnType<typeof summarize>;
  integrity: IntegrityReport;
  storage: Array<{ key: string; leaves: number }>;
}

export class SessionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "SessionError";
    this.status = status;
  }
}

export class SaveSession {
  readonly id: string;
  name: string;
  /** Bytes exactly as pulled from the device (possibly XOR-wrapped). */
  container: Uint8Array;
  /** Decoded plain JSON the engine reads and patches. */
  plain: Uint8Array;
  readonly codec: CodecResult;
  readonly loadedAt = new Date().toISOString();
  lastApply: ApplyResult | null = null;

  constructor(name: string, container: Uint8Array) {
    this.id = randomUUID();
    this.name = name;
    this.container = container;
    this.codec = decodeSave(container);
    this.plain = this.codec.bytes;
    // Fail fast on a container we cannot parse.
    openSave(this.plain);
  }

  meta(): SessionMeta {
    const save = openSave(this.plain);
    return {
      id: this.id,
      name: this.name,
      containerBytes: this.container.length,
      plainBytes: this.plain.length,
      containerKind: describeCodec(this.codec, this.container),
      wasEncrypted: this.codec.wasEncrypted,
      codecKey: this.codec.keyId ?? undefined,
      codecWarning: this.codec.warning,
      loadedAt: this.loadedAt,
      fieldCount: save.paths().length,
    };
  }

  overview(): OverviewPayload {
    const save = openSave(this.plain);
    return {
      meta: this.meta(),
      catalog: CATALOG,
      prefixSections: PREFIX_SECTIONS,
      overview: summarize(save),
      integrity: readIntegrity(save),
      storage: storageMap(save),
    };
  }

  /** Current values for the curated catalogue fields (missing ones are null). */
  values(): Record<string, unknown> {
    const save = openSave(this.plain);
    /*
     * Some saves store the statistics dictionary as JSON *text* —
     * `"v": "{\"FirstTryWins\":12,…}"` — instead of a bare object (the write
     * path already handles both; see `coalesceStringDictionary`). In the string
     * form, `save.has()` on an individual stat leaf is FALSE because its parent
     * is a string, so every Game Statistics card read as "not in save" even
     * after a successful edit. Decode the string once here so reads and writes
     * agree on both shapes.
     */
    const dictPath = "SpecialEvents.UserProfileFeature.v.UserProfileStatistics.v";
    let stringStats: Record<string, unknown> | null = null;
    if (save.has(dictPath)) {
      const dict = save.field(dictPath);
      if (dict.span.type === "string") {
        try {
          const parsed: unknown = JSON.parse(String(dict.value));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            stringStats = parsed as Record<string, unknown>;
          }
        } catch {
          // Malformed dictionary: leaves read as absent, same as before.
        }
      }
    }

    const out: Record<string, unknown> = {};
    for (const g of CATALOG) {
      for (const f of g.fields) {
        if (save.has(f.path)) {
          out[f.path] = save.field(f.path).value;
        } else if (stringStats && f.path.startsWith(`${dictPath}.`)) {
          const key = f.path.slice(dictPath.length + 1);
          out[f.path] = Object.prototype.hasOwnProperty.call(stringStats, key)
            ? stringStats[key]
            : null;
        } else {
          out[f.path] = null;
        }
      }
    }
    return out;
  }

  /** Browse a prefix-discovered section, optionally searching key paths server-side. */
  discover(prefix: string, limit = 2000, q = ""): ReturnType<typeof discoverPrefix> {
    const save = openSave(this.plain);
    return discoverPrefix(save, prefix, q).slice(0, limit);
  }

  apply(ops: readonly EditOp[], opts: ApplyOptions = {}): ApplyResult {
    const res = runApply(this.plain, ops, opts, this.codec);
    if (res.ok) {
      this.plain = res.bytes;
      this.lastApply = res;
    }
    return res;
  }

  /** Plain-JSON bytes, re-wrapped with the same key and trailer as the source. */
  exportContainer(): Uint8Array {
    return encodeSave(this.plain, this.codec);
  }
}

// --------------------------------------------------------------- registry --

const sessions = new Map<string, SaveSession>();

/**
 * The ONE session the desktop app is editing.
 *
 * There is deliberately an explicit pointer rather than "newest wins". Clone,
 * season-pass and pull each stage an intermediate donor session
 * (`content-source`, `season-pass-source`) plus a fresh `device:<serial>`
 * session; under a newest-wins rule those silently stole the UI — the tabs
 * read one save while Push exported another, which is exactly the "edited but
 * nothing changed in game" failure. `resolveSession()` honours this pointer
 * first, so a donor created mid-operation can never become the edit target.
 */
let activeId: string | null = null;

export function setActiveSession(id: string): void {
  if (sessions.has(id)) activeId = id;
}

export function getActiveSessionId(): string | null {
  return activeId;
}

export function createSession(
  name: string,
  container: Uint8Array,
  opts: { active?: boolean } = {},
): SaveSession {
  const s = new SaveSession(name, container);
  sessions.set(s.id, s);
  // A session becomes the edit target only when something the operator will
  // actually push is loaded into it. Donor sessions pass `active: false`.
  if (opts.active !== false) setActiveSession(s.id);
  return s;
}

export function getSession(id: string): SaveSession {
  const s = sessions.get(id);
  if (!s) throw new SessionError(`no session ${id}`, 404);
  return s;
}

export function listSessions(): SessionMeta[] {
  return [...sessions.values()].map((s) => s.meta());
}

export function dropSession(id: string): boolean {
  if (activeId === id) activeId = null;
  return sessions.delete(id);
}

/** The session the app is editing, or undefined when nothing is loaded. */
export function currentSession(): SaveSession | undefined {
  if (activeId) {
    const s = sessions.get(activeId);
    if (s) return s;
  }
  const all = [...sessions.values()];
  return all[all.length - 1];
}

/** Resolve a session by explicit id, or fall back to the active session. */
export function resolveSession(id?: string): SaveSession {
  if (id) return getSession(id);
  const s = currentSession();
  if (!s) throw new SessionError("no save is loaded yet", 409);
  return s;
}
