/**
 * Typed client for the local studio API.
 *
 * Every response carries `ok`; failures also carry a human-readable `error`
 * that the UI surfaces verbatim, because "what the tool refused to do and
 * why" is the most useful thing it can say.
 */

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

export type Control = "int" | "text" | "bool";

export interface CatalogField {
  path: string;
  label: string;
  hint?: string;
  control: Control;
  min?: number;
  max?: number;
  warning?: string;
}

export interface CatalogGroup {
  id: string;
  label: string;
  description: string;
  fields: CatalogField[];
}

export interface PrefixSection {
  id: string;
  label: string;
  description: string;
  prefix: string;
  hideZero?: boolean;
}

export interface IntegritySlice {
  path: string;
  present: boolean;
  raw: string;
  parts: Record<string, string>;
}

export interface IntegrityReport {
  r1: IntegritySlice;
  r4: IntegritySlice;
  r8: IntegritySlice;
  r9: IntegritySlice;
  expectedR4Value: number;
  expectedR1Coins: number;
  boosterDrift: Array<{ slot: string; mirrored: number; live: number; booster: string }>;
}

export interface Overview {
  totalFields: number;
  tagged: { ds: number; i64: number; f: number };
  counts: Record<string, number>;
  bytes: number;
}

export interface OverviewPayload {
  meta: SessionMeta;
  catalog: CatalogGroup[];
  prefixSections: PrefixSection[];
  overview: Overview;
  integrity: IntegrityReport;
  storage: Array<{ key: string; leaves: number }>;
}

/** Any JSON-representable value (matches the engine's `JsonValue`). */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface EditOp {
  path: string;
  /** Scalars edit a leaf in place; an object/array materializes a null leaf. */
  value: JsonValue;
  /** Insert a NEW member into an existing object instead of editing a leaf. */
  create?: boolean;
}

export interface EditSummary {
  label: string;
  path?: string;
  start: number;
  before: string;
  after: string;
}

export interface IntegrityRefreshResult {
  applied: Array<{ path: string; before: string; after: string; reason: string }>;
  skipped: Array<{ path: string; reason: string }>;
}

export interface ApplyResponse {
  ok: boolean;
  summary: EditSummary[];
  integrity: IntegrityRefreshResult | null;
  warnings: string[];
  errors: string[];
  inputBytes: number;
  outputBytes: number;
  overview?: OverviewPayload;
}

/** One content root as the clone reported it. */
export interface CloneContentRoot {
  root: string;
  fields: number;
  mode: "leaves" | "whole-root" | "absent-in-both";
  skipped: number;
}

/** Result of a content clone (home, décor, characters — no progress). */
export interface CloneContentResponse {
  ok: boolean;
  source: string;
  serial: string;
  roots: CloneContentRoot[];
  fields: number;
  summary: EditSummary[];
  warnings: string[];
  warningsTotal: number;
  errors: string[];
  errorsTotal: number;
  overview?: OverviewPayload;
}

/** Where the clone feature reads from — always the built-in IGG account. */
export interface CloneSourceResponse {
  ok: boolean;
  path: string;
  exists: boolean;
  bytes: number;
}

export interface CosmeticItem {
  id: string;
  label: string;
  /** Real client art, served straight through from the engine catalog. */
  icon?: string;
  /** CSS colour for the basic frames whose identity is their colour. */
  swatch?: string;
  /** Monogram for the dashed placeholder tile used when no art exists. */
  mono?: string;
}

export interface CosmeticGroupInfo {
  kind: string;
  label: string;
  description: string;
  ownershipList?: string;
  flagPrefix?: string;
  equipPath: string;
  items: CosmeticItem[];
}

export interface CosmeticGroupState {
  owned: string[];
  equipped: string | null;
}

export type CosmeticsState = Record<string, CosmeticGroupState>;

export interface CosmeticsRequest {
  sessionId?: string;
  grant?: Record<string, string[]>;
  equip?: Record<string, string>;
}

export interface DiscoveredField {
  path: string;
  key: string;
  kind: string;
  value: unknown;
}

export interface DeviceInfo {
  id: string;
  label: string;
}

export interface AdbInfo {
  found: boolean;
  path: string;
  devices: DeviceInfo[];
  message: string;
}

export interface FieldDetail {
  path: string;
  kind: string;
  value: unknown;
  raw: string;
  tag?: string;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(`server returned ${res.status} with a non-JSON body`, res.status);
  }
  if (!res.ok || body?.ok === false) {
    throw new ApiError(body?.error ?? `request failed (${res.status})`, res.status);
  }
  return body as T;
}

function post<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export const api = {
  health: () => request<{ ok: boolean; app: string; version: string }>("/api/health"),

  overview: (sessionId?: string) =>
    request<{ ok: boolean; overview: OverviewPayload }>(
      `/api/overview${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    ).then((r) => r.overview),

  values: (sessionId?: string) =>
    request<{ ok: boolean; values: Record<string, unknown> }>(
      `/api/values${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    ).then((r) => r.values),

  discover: (prefix: string, sessionId?: string, limit = 2000, q = "") =>
    request<{ ok: boolean; fields: DiscoveredField[] }>(
      `/api/discover?prefix=${encodeURIComponent(prefix)}&limit=${limit}` +
        (q ? `&q=${encodeURIComponent(q)}` : "") +
        (sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""),
    ).then((r) => r.fields),

  field: (path: string, sessionId?: string) =>
    request<{ ok: boolean; field: FieldDetail }>(
      `/api/field?path=${encodeURIComponent(path)}` +
        (sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""),
    ).then((r) => r.field),

  reset: (sessionId?: string) =>
    post<{ ok: boolean; overview: OverviewPayload }>("/api/session/reset", { sessionId }).then(
      (r) => r.overview,
    ),

  apply: (ops: EditOp[], refreshIntegrity: boolean, sessionId?: string) =>
    post<ApplyResponse>("/api/apply", { ops, refreshIntegrity, sessionId }),

  /**
   * The clone feature: transplant the built-in IGG account's *content* roots
   * (home, décor, furniture, characters, avatars) onto the connected device
   * while leaving every progression root — level, balances, statistics,
   * quests, secret values — on the account untouched.
   *
   * `path` is deliberately not sent by the UI: the source is the tool's own
   * `data/IGG-account.db` and the server resolves it itself.
   */
  cloneContent: (payload: { serial: string; path?: string; roots?: string[] }) =>
    post<CloneContentResponse>("/api/clone-content", payload),

  /** Reports the built-in clone source (path + whether the file is present). */
  cloneSource: () => request<CloneSourceResponse>("/api/clone/source"),

  cosmeticsCatalog: () =>
    request<{ ok: boolean; groups: CosmeticGroupInfo[] }>("/api/cosmetics/catalog").then(
      (r) => r.groups,
    ),

  cosmeticsState: (sessionId?: string) =>
    request<{ ok: boolean; state: CosmeticsState }>(
      `/api/cosmetics/state${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    ).then((r) => r.state),

  cosmeticsApply: (payload: CosmeticsRequest) =>
    post<ApplyResponse>("/api/cosmetics", payload),

  /**
   * Grant copies of cards into the album. `plan` echoes which rows were
   * bumped, which were appended, and which were already at the stock cap, so
   * the log can state exactly what the write did before anything is pushed.
   */
  cardsGrant: (payload: { cards: number[]; copies?: number; sessionId?: string }) =>
    post<
      ApplyResponse & {
        plan: {
          bumps: { num: number; from: number; to: number }[];
          added: number[];
          capped: number[];
          stockCap: number;
          cardCount: number;
          setCount: number;
        };
      }
    >("/api/cards/grant", payload),

  devices: () =>
    request<{ ok: boolean; info: AdbInfo }>("/api/devices").then((r) => r.info),

  pull: (serial: string) =>
    post<{ ok: boolean; file: string; package: string; overview: OverviewPayload }>(
      "/api/device/pull",
      { serial },
    ),

  push: (serial: string, restart = true, sessionId?: string) =>
    post<{ ok: boolean; file?: string; toolBackup?: string; relaunched?: boolean; error?: string }>(
      "/api/device/push",
      { serial, restart, sessionId },
    ),

  stop: (serial: string) => post<{ ok: boolean }>("/api/device/stop", { serial }),

  start: (serial: string) => post<{ ok: boolean }>("/api/device/start", { serial }),

  restoreBackup: (serial: string) =>
    post<{ ok: boolean; restoredFrom?: string; error?: string }>("/api/device/restore", { serial }),
};

export { ApiError, toBase64, fromBase64 };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
