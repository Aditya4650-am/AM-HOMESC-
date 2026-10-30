/**
 * License keys — the tool's real login.
 *
 * Model (same shape as the IGG tool):
 *   - `HS_MASTER` is the root secret. It keys the HMAC that fingerprints a key
 *     (so the raw key is never stored) and the AES-256-GCM used to seal the
 *     short-lived activation token the browser then presents.
 *   - `HS_OWNER` is the owner passcode. Presenting it mints an owner token and
 *     unlocks the Owner Hub (issue / list / revoke).
 *   - `DATABASE_URL` persists issued keys. Without it keys live in
 *     `data/.hs-licenses.json`, which is fine locally and fatal on a PaaS
 *     (ephemeral disk): a restart would wipe every key.
 *
 * Enforcement is opt-in: with `HS_MASTER` unset the gate is open, so `npm start`
 * on a workstation still behaves like a local editor. Set `HS_MASTER` and the
 * whole `/api/*` surface except `/api/health` and `/api/license/*` requires a
 * valid token.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STORE_FILE = join(ROOT, "data", ".hs-licenses.json");

/** Crockford base32 — no I, L, O, U, so a key cannot be mistyped into another. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type Plan = "trial" | "week" | "month" | "year" | "lifetime" | "owner";

export interface LicenseRow {
  /** HMAC-SHA256 of the normalized key. The key itself is never persisted. */
  fp: string;
  plan: Plan;
  createdAt: number;
  /** 0 = never expires (lifetime / owner). */
  expiresAt: number;
  maxDevices: number;
  devices: string[];
  active: boolean;
  note: string;
}

export interface LicenseSnap {
  plan: Plan;
  expiresAt: number;
  remainingMs: number;
  status: "active" | "expired" | "revoked";
  owner: boolean;
  devices: number;
  maxDevices: number;
}

const PLAN_DAYS: Record<Exclude<Plan, "owner">, number> = {
  trial: 1,
  week: 7,
  month: 30,
  year: 365,
  lifetime: 0,
};

export const masterKey = (): string => (process.env.HS_MASTER ?? "").trim();
export const ownerPasscode = (): string => (process.env.HS_OWNER ?? "").trim();
/** True when this deployment enforces keys at all. */
export const licenseRequired = (): boolean => masterKey().length > 0;

const databaseUrl = (): string => (process.env.DATABASE_URL ?? "").trim();

// ------------------------------------------------------------------ crypto --

function hmacKey(): Buffer {
  return createHash("sha256").update(`${masterKey()}:fingerprint`).digest();
}

function aesKey(): Buffer {
  return createHash("sha256").update(`${masterKey()}:token`).digest();
}

/** Normalize user input: uppercase, drop separators, fix 0/O and 1/I/L reads. */
export function normalizeKey(input: string): string {
  const raw = String(input ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const body = raw.startsWith("HS") ? raw.slice(2) : raw;
  return body.replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** HMAC fingerprint of a normalized key body. */
export function fingerprint(normalized: string): string {
  return createHmac("sha256", hmacKey()).update(normalized).digest("hex");
}

/** `HS-XXXXX-XXXXX-XXXXX-XXXXX` (20 Crockford symbols ≈ 100 bits). */
export function mintKey(): string {
  const bytes = randomBytes(20);
  let body = "";
  for (let i = 0; i < 20; i++) body += ALPHABET[bytes[i]! % 32];
  return `HS-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}-${body.slice(15, 20)}`;
}

export interface TokenPayload {
  fp: string;
  dev: string;
  exp: number;
  plan: Plan;
}

/** Seal a token: base64url(iv | tag | ciphertext) under AES-256-GCM. */
export function sealToken(payload: TokenPayload): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64url");
}

/** Open a token. Returns null for anything tampered with, foreign or expired. */
export function openToken(token: string): TokenPayload | null {
  try {
    const buf = Buffer.from(token, "base64url");
    if (buf.length < 29) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", aesKey(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plain) as TokenPayload;
    if (typeof parsed?.fp !== "string" || typeof parsed?.exp !== "number") return null;
    if (parsed.exp !== 0 && parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- store --

type PgLike = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end: () => Promise<void>;
};

let pool: PgLike | null = null;
let fileCache: Map<string, LicenseRow> | null = null;

async function getPool(): Promise<PgLike | null> {
  if (!databaseUrl()) return null;
  if (pool) return pool;
  // `pg` is a pure-JS driver; imported lazily so a local run without a DB
  // never pays for loading it.
  try {
    const mod = (await import("pg")) as unknown as { default?: { Pool: new (o: unknown) => PgLike }; Pool?: new (o: unknown) => PgLike };
    const PoolCtor = mod.default?.Pool ?? mod.Pool;
    if (!PoolCtor) throw new Error("pg driver unavailable — run `npm install`");
    const p = new PoolCtor({ connectionString: databaseUrl(), ssl: { rejectUnauthorized: false } });
    await p.query(`
      create table if not exists hs_licenses (
        fp           text primary key,
        plan         text not null,
        created_at   bigint not null,
        expires_at   bigint not null,
        max_devices  integer not null,
        devices      jsonb  not null default '[]'::jsonb,
        active       boolean not null default true,
        note         text not null default ''
      )`);
    pool = p;
    return pool;
  } catch (err) {
    // A broken DATABASE_URL must not take the whole tool down: fall back to
    // the file store and surface the real error in the server log.
    console.error("[license] Postgres unavailable, falling back to file store:", err instanceof Error ? err.message : String(err));
    pool = null;
    return null;
  }
}

function loadFile(): Map<string, LicenseRow> {
  if (fileCache) return fileCache;
  fileCache = new Map();
  try {
    const rows = JSON.parse(readFileSync(STORE_FILE, "utf8")) as LicenseRow[];
    for (const r of rows) fileCache.set(r.fp, r);
  } catch {
    /* first run */
  }
  return fileCache;
}

function saveFile(map: Map<string, LicenseRow>): void {
  mkdirSync(dirname(STORE_FILE), { recursive: true });
  writeFileSync(STORE_FILE, JSON.stringify([...map.values()], null, 2), "utf8");
}

export interface Store {
  get: (fp: string) => Promise<LicenseRow | null>;
  put: (row: LicenseRow) => Promise<void>;
  all: () => Promise<LicenseRow[]>;
}

export const store: Store = {
  async get(fp) {
    const db = await getPool();
    if (db) {
      const { rows } = await db.query("select * from hs_licenses where fp = $1", [fp]);
      return rows[0] ? rowFromDb(rows[0]) : null;
    }
    return loadFile().get(fp) ?? null;
  },
  async put(row) {
    const db = await getPool();
    if (db) {
      await db.query(
        `insert into hs_licenses (fp, plan, created_at, expires_at, max_devices, devices, active, note)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
         on conflict (fp) do update set plan = excluded.plan, expires_at = excluded.expires_at,
           max_devices = excluded.max_devices, devices = excluded.devices,
           active = excluded.active, note = excluded.note`,
        [row.fp, row.plan, row.createdAt, row.expiresAt, row.maxDevices, JSON.stringify(row.devices), row.active, row.note],
      );
      return;
    }
    const map = loadFile();
    map.set(row.fp, row);
    saveFile(map);
  },
  async all() {
    const db = await getPool();
    if (db) {
      const { rows } = await db.query("select * from hs_licenses order by created_at desc limit 500");
      return rows.map(rowFromDb);
    }
    return [...loadFile().values()];
  },
};

function rowFromDb(r: Record<string, unknown>): LicenseRow {
  const devices = r.devices;
  return {
    fp: String(r.fp),
    plan: String(r.plan) as Plan,
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    maxDevices: Number(r.max_devices),
    devices: Array.isArray(devices) ? devices.map(String) : typeof devices === "string" ? (JSON.parse(devices) as string[]) : [],
    active: Boolean(r.active),
    note: String(r.note ?? ""),
  };
}

export const storageKind = (): "postgres" | "file" => (databaseUrl() ? "postgres" : "file");

// -------------------------------------------------------------- operations --

export class LicenseError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = "LicenseError";
    this.status = status;
  }
}

export function snapshot(row: LicenseRow): LicenseSnap {
  const now = Date.now();
  const expired = row.expiresAt !== 0 && row.expiresAt < now;
  return {
    plan: row.plan,
    expiresAt: row.expiresAt,
    remainingMs: row.expiresAt === 0 ? 0 : Math.max(0, row.expiresAt - now),
    status: !row.active ? "revoked" : expired ? "expired" : "active",
    owner: row.plan === "owner",
    devices: row.devices.length,
    maxDevices: row.maxDevices,
  };
}

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Turn a presented key into a sealed token, binding it to `deviceId`.
 * The owner passcode is checked first so an owner never needs a stored row.
 */
export async function activate(rawKey: string, deviceId: string): Promise<{ token: string; snap: LicenseSnap }> {
  if (!licenseRequired()) throw new LicenseError("license enforcement is not configured (HS_MASTER is unset)", 503);
  const dev = String(deviceId ?? "").trim();
  if (dev.length < 8) throw new LicenseError("a device id is required", 400);

  const presented = String(rawKey ?? "").trim();
  const owner = ownerPasscode();
  if (owner && presented === owner) {
    const payload: TokenPayload = { fp: fingerprint("OWNER"), dev, exp: Date.now() + TOKEN_TTL_MS, plan: "owner" };
    return {
      token: sealToken(payload),
      snap: { plan: "owner", expiresAt: 0, remainingMs: 0, status: "active", owner: true, devices: 1, maxDevices: 0 },
    };
  }

  const normalized = normalizeKey(presented);
  if (normalized.length < 10) throw new LicenseError("That does not look like a key (HS-XXXXX-XXXXX-XXXXX-XXXXX)");

  const row = await store.get(fingerprint(normalized));
  if (!row) throw new LicenseError("Invalid key");
  const snap = snapshot(row);
  if (snap.status === "revoked") throw new LicenseError("This key has been revoked");
  if (snap.status === "expired") throw new LicenseError("This key has expired");

  if (!row.devices.includes(dev)) {
    if (row.devices.length >= row.maxDevices) {
      throw new LicenseError(
        `Device limit reached (${row.devices.length}/${row.maxDevices}). Ask the owner to reset this key.`,
      );
    }
    row.devices.push(dev);
    await store.put(row);
  }

  const payload: TokenPayload = { fp: row.fp, dev, exp: Date.now() + TOKEN_TTL_MS, plan: row.plan };
  return { token: sealToken(payload), snap: snapshot(row) };
}

/** Resolve the caller from `x-hs-token`. Throws when the gate is on and invalid. */
export function requireLicense(req: { headers: Record<string, string | string[] | undefined> }): TokenPayload | null {
  if (!licenseRequired()) return null;
  const header = req.headers["x-hs-token"];
  const token = Array.isArray(header) ? header[0] : header;
  if (!token) throw new LicenseError("activation required");
  const payload = openToken(token);
  if (!payload) throw new LicenseError("session expired — activate again");
  return payload;
}

// -------------------------------------------------------------------- owner --

export interface IssueInput {
  plan?: Plan;
  days?: number;
  devices?: number;
  count?: number;
  note?: string;
}

export async function issue(input: IssueInput): Promise<{ key: string; snap: LicenseSnap }[]> {
  const plan = (input.plan ?? "month") as Plan;
  if (plan === "owner") throw new LicenseError("`owner` is not an issuable plan", 400);
  const days = plan === "lifetime" ? 0 : Number(input.days ?? PLAN_DAYS[plan as Exclude<Plan, "owner">]);
  if (!Number.isFinite(days) || days < 0) throw new LicenseError("`days` must be a non-negative number", 400);
  const maxDevices = Math.max(1, Math.min(10, Number(input.devices ?? 1)));
  const count = Math.max(1, Math.min(50, Number(input.count ?? 1)));
  const now = Date.now();
  const out: { key: string; snap: LicenseSnap }[] = [];
  for (let i = 0; i < count; i++) {
    const key = mintKey();
    const row: LicenseRow = {
      fp: fingerprint(normalizeKey(key)),
      plan,
      createdAt: now,
      expiresAt: days === 0 ? 0 : now + days * 86_400_000,
      maxDevices,
      devices: [],
      active: true,
      note: String(input.note ?? "").slice(0, 200),
    };
    await store.put(row);
    out.push({ key, snap: snapshot(row) });
  }
  return out;
}

/** Revoke (or restore) a key. Accepts the raw key or its fingerprint. */
export async function setActive(keyOrFp: string, active: boolean): Promise<boolean> {
  const raw = String(keyOrFp ?? "").trim();
  if (!raw) throw new LicenseError("`key` is required", 400);
  const fp = /^[0-9a-f]{64}$/i.test(raw) ? raw.toLowerCase() : fingerprint(normalizeKey(raw));
  const row = await store.get(fp);
  if (!row) return false;
  row.active = active;
  await store.put(row);
  return true;
}

/** Free the device slots on a key (a client changed PC / reinstalled). */
export async function resetDevices(keyOrFp: string): Promise<boolean> {
  const raw = String(keyOrFp ?? "").trim();
  const fp = /^[0-9a-f]{64}$/i.test(raw) ? raw.toLowerCase() : fingerprint(normalizeKey(raw));
  const row = await store.get(fp);
  if (!row) return false;
  row.devices = [];
  await store.put(row);
  return true;
}

/** Stable, non-secret id for a 4MB-container session — used by the audit log. */
export function newRecordId(): string {
  return randomUUID();
}
