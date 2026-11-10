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
  /**
   * Who owns this session: the license fingerprint that loaded it, or `local`
   * on an ungated local run. Every read/write route resolves through it, so one
   * client can never see, edit or export another client's save.
   */
  readonly owner: string;
  /** Wall-clock of the last request that touched this session (LRU / TTL). */
  touchedAt = Date.now();
  /** Bytes exactly as pulled from the device (possibly XOR-wrapped). */
  container: Uint8Array;
  /** Decoded plain JSON the engine reads and patches. */
  plain: Uint8Array;
  /**
   * The decoded bytes exactly as they were loaded. `revert()` restores this, so
   * "start over" is a real undo rather than a new session the UI must adopt.
   */
  readonly original: Uint8Array;
  readonly codec: CodecResult;
  readonly loadedAt = new Date().toISOString();
  lastApply: ApplyResult | null = null;

  constructor(name: string, container: Uint8Array, owner = "local") {
    this.id = randomUUID();
    this.name = name;
    this.owner = owner;
    this.container = container;
    this.codec = decodeSave(container);
    this.plain = this.codec.bytes;
    this.original = this.codec.bytes.slice();
    // Fail fast on a container we cannot parse.
    openSave(this.plain);
  }

  /** Discard every applied edit and return to the bytes as loaded. */
  revert(): void {
    this.plain = this.original.slice();
    this.lastApply = null;
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

/**
 * Session store.
 *
 * Deliberately small and finite. Each loaded save holds ~25 MB (container +
 * decoded JSON + a member span per field), so an unbounded map is a one-request
 * memory leak: 13 loads measured 333 MB RSS on the shipped 4.3 MB save. On a
 * 512 MB plan that is an OOM, and on a shared deployment the unbounded map also
 * meant every user could list and export every other user's save.
 *
 * Three rules, all enforced here:
 *   1. a session belongs to the caller that loaded it (license fingerprint);
 *   2. per-owner and global counts are capped, oldest-touched evicted first;
 *   3. idle sessions expire, so a forgotten tab cannot pin a save forever.
 */
const SESSION_TTL_MS = Number(process.env.HC_SESSION_TTL_MS ?? 45 * 60 * 1000);
/*
 * Measured cost on the shipped 4.3 MB save: ~60 MB RSS per live session
 * (container + decoded JSON + one span record per field), on a ~92 MB baseline.
 * The defaults keep a 512 MB instance comfortable — 92 + 4 x 60 ≈ 330 MB — while
 * still allowing the one-edited-save + one-device-pull pattern the UI uses.
 * Raise HC_MAX_SESSIONS on a bigger plan; the numbers above are why.
 */
const MAX_SESSIONS = Math.max(1, Number(process.env.HC_MAX_SESSIONS ?? 4));
const MAX_SESSIONS_PER_OWNER = Math.max(1, Number(process.env.HC_MAX_SESSIONS_PER_OWNER ?? 3));

interface Stored {
  session: SaveSession;
}

const sessions = new Map<string, Stored>();

/** Drop sessions idle past the TTL. Cheap: only runs on registry access. */
function sweep(now = Date.now()): void {
  if (SESSION_TTL_MS <= 0) return;
  for (const [id, rec] of sessions) {
    if (now - rec.session.touchedAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

function evictFor(owner: string): void {
  const owned = [...sessions.values()]
    .filter((r) => r.session.owner === owner)
    .sort((a, b) => a.session.touchedAt - b.session.touchedAt);
  while (owned.length >= MAX_SESSIONS_PER_OWNER) {
    const oldest = owned.shift();
    if (oldest) sessions.delete(oldest.session.id);
  }
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort(
      (a, b) => a.session.touchedAt - b.session.touchedAt,
    )[0];
    if (!oldest) break;
    sessions.delete(oldest.session.id);
  }
}

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
 *
 * The pointer is global but is always validated against the caller's `owner`,
 * so one client's edit target can never resolve for another.
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
  owner = "local",
  opts: { active?: boolean } = {},
): SaveSession {
  sweep(Date.now());
  evictFor(owner);
  const s = new SaveSession(name, container, owner);
  sessions.set(s.id, { session: s });
  // A session becomes the edit target only when something the operator will
  // actually push is loaded into it. Donor sessions pass `active: false`.
  if (opts.active !== false) setActiveSession(s.id);
  return s;
}

export function getSession(id: string, owner = "local"): SaveSession {
  sweep();
  const rec = sessions.get(id);
  // A session belonging to someone else is reported as absent, not forbidden:
  // an id must never confirm that another client's save exists.
  if (!rec || rec.session.owner !== owner) throw new SessionError(`no session ${id}`, 404);
  rec.session.touchedAt = Date.now();
  return rec.session;
}

export function listSessions(owner = "local"): SessionMeta[] {
  sweep();
  return [...sessions.values()]
    .filter((r) => r.session.owner === owner)
    .map((r) => r.session.meta());
}

export function dropSession(id: string, owner = "local"): boolean {
  const rec = sessions.get(id);
  if (!rec || rec.session.owner !== owner) return false;
  if (activeId === id) activeId = null;
  return sessions.delete(id);
}

/** How many sessions the registry currently holds (health / diagnostics). */
export function sessionCount(): number {
  sweep();
  return sessions.size;
}

/**
 * The session the app is editing, or undefined when nothing is loaded.
 *
 * The explicit edit pointer wins when it belongs to `owner`; otherwise fall
 * back to that owner's most recently touched session.
 */
export function currentSession(owner = "local"): SaveSession | undefined {
  sweep();
  if (activeId) {
    const rec = sessions.get(activeId);
    if (rec && rec.session.owner === owner) return rec.session;
  }
  return [...sessions.values()]
    .filter((r) => r.session.owner === owner)
    .sort((a, b) => a.session.touchedAt - b.session.touchedAt)
    .pop()?.session;
}

/** Resolve a session by explicit id, or fall back to the edit pointer /
 * caller's newest. */
export function resolveSession(id?: string, owner = "local"): SaveSession {
  if (id) return getSession(id, owner);
  const s = currentSession(owner);
  if (!s) throw new SessionError("no save is loaded yet", 409);
  s.touchedAt = Date.now();
  return s;
}
