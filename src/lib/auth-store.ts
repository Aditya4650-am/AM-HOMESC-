/**
 * Client-side activation state — deliberately dependency-free so both the API
 * layer and the UI can read it without an import cycle.
 *
 * The activation token is an AES-GCM sealed blob minted by the server; it is
 * not the license key. The key itself is presented once, at activation, and is
 * never written to storage.
 */

const TOKEN_KEY = "hs.license.token";
const DEVICE_KEY = "hs.device.id";
const PLAN_KEY = "hs.license.plan";

/** `HSD-XXXX-XXXX-XXXX-XXXX-XXXX` — the file-backed id the EXE mints. */
const HSD_RE = /^HSD(?:-[A-Z0-9]{4}){5}$/;
/** Ids minted by older browser builds: `HSD-` + 20 hex digits. Still valid, so
 *  a key bound to one does not read as "locked to another device" after this
 *  change ships. */
const HSD_LEGACY_RE = /^HSD-[0-9A-F]{20}$/;

/** Uppercased, whitespace-free form used for every comparison. */
export function normalizeDeviceId(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

export function isDeviceId(raw: string): boolean {
  const v = normalizeDeviceId(raw);
  return HSD_RE.test(v) || HSD_LEGACY_RE.test(v);
}

/** True when the page runs inside the desktop EXE (pywebview's alias). */
function inExe(): boolean {
  try {
    const w = window as unknown as { hcNative?: { deviceId?: unknown }; chrome?: { webview?: unknown } };
    return Boolean(w.hcNative) || Boolean(w.chrome?.webview);
  } catch {
    return false;
  }
}

/** The EXE's machine id carried on the window URL — read before React mounts. */
function urlDeviceId(): string | null {
  try {
    const v = new URLSearchParams(window.location.search).get("did");
    return v && isDeviceId(v) ? normalizeDeviceId(v) : null;
  } catch {
    return null;
  }
}

function readStoredId(): string | null {
  try {
    const v = localStorage.getItem(DEVICE_KEY);
    return v && isDeviceId(v) ? normalizeDeviceId(v) : null;
  } catch {
    return null; // private mode / blocked storage
  }
}

function persistId(id: string): void {
  try {
    localStorage.setItem(DEVICE_KEY, id);
  } catch {
    /* ignore */
  }
}

function mintDeviceId(): string {
  const alph = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => alph[b % alph.length] ?? "A");
  const g = (i: number) => chars.slice(i, i + 4).join("");
  return `HSD-${g(0)}-${g(4)}-${g(8)}-${g(12)}-${g(16)}`;
}

/**
 * Device id for THIS machine, resolved in order of authority:
 *
 *   1. `?did=` on the URL — the EXE's file-backed id, present synchronously
 *      before React mounts. No bridge, no polling, no storage, no race.
 *   2. localStorage — a plain browser's own id, stable across reloads.
 *   3. A fresh random id — a browser's very first visit only.
 *
 * Inside the EXE minting is forbidden outright. pywebview starts WebView2 with
 * private_mode=True (its default) and the EXE serves the UI from a loopback
 * port that changes every launch, so localStorage is empty on every start: an
 * allowed mint won every launch, the id changed each restart, and the key —
 * bound to one id — stopped matching the machine. An EXE therefore returns an
 * empty id here rather than ever showing a number that is not this machine's;
 * `resolveDeviceId()` waits for the bridge to fill it in.
 */
export function getDeviceId(): string {
  const fromUrl = urlDeviceId();
  if (fromUrl) {
    persistId(fromUrl);
    return fromUrl;
  }
  const stored = readStoredId();
  if (stored) return stored;
  if (inExe()) return "";
  const fresh = mintDeviceId();
  persistId(fresh);
  return fresh;
}

/**
 * `getDeviceId()` plus the bridge wait an EXE needs when the URL carried no
 * id (an older build). Polls `hcNative.deviceId()` — the EXE reads it from
 * `%APPDATA%\\Homescapes-Save-Studio\\device.id`, so it is the same value on
 * every launch of the same PC. Returns "" rather than a fabricated id if the
 * bridge never answers; the caller shows "reading…" instead of a wrong number.
 */
export async function resolveDeviceId(budgetMs = 8_000): Promise<string> {
  const sync = getDeviceId();
  if (sync) return sync;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const w = window as unknown as { hcNative?: { deviceId?: () => unknown } };
      const fn = w.hcNative?.deviceId;
      if (typeof fn === "function") {
        const v = normalizeDeviceId(String((await fn()) ?? ""));
        if (isDeviceId(v)) {
          persistId(v);
          return v;
        }
        // The bridge is up but has no deviceId() — an old build will never
        // have one, so waiting longer cannot help.
        return "";
      }
    } catch {
      /* bridge not ready yet — keep polling */
    }
    if (Date.now() >= deadline) return "";
    await new Promise((r) => setTimeout(r, 100));
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string, plan: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(PLAN_KEY, plan);
  } catch {
    /* ignore */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(PLAN_KEY);
  } catch {
    /* ignore */
  }
}

export function getPlan(): string | null {
  try {
    return localStorage.getItem(PLAN_KEY);
  } catch {
    return null;
  }
}
