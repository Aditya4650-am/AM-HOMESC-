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

/** Stable per-browser device id. Render-safe: lives in localStorage only. */
export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing && existing.length >= 8) return existing;
    const bytes = new Uint8Array(10);
    crypto.getRandomValues(bytes);
    const id = `HSD-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    // Private mode / blocked storage: fall back to a per-load id. The user will
    // be asked to activate again on reload, which is honest.
    return `HSD-TEMP${Date.now().toString(36).toUpperCase()}`;
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
