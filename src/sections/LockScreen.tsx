import { useEffect, useState } from "react";
import { api, ApiError, type LicenseSnap } from "../lib/api.ts";
import { clearToken, getDeviceId, getToken, setToken } from "../lib/auth-store.ts";
import { useToast } from "../components/ui.tsx";
import { Icon, MiniSpinner } from "../components/icons.tsx";
import { OwnerConsole } from "../components/OwnerConsole.tsx";

/**
 * The gate — a faithful recreation of the IGG VIP Studio login scene.
 *
 * Left: brand lockup, tagline and the three things the tool actually does.
 * Right: the auth card — device id, licence field, unlock, owner console.
 *
 * A stored activation token is re-validated against the server on load, so a
 * client who reloads lands straight in the studio while a revoked key does not.
 */

const LOCAL_SNAP: LicenseSnap = {
  plan: "local",
  expiresAt: 0,
  remainingMs: 0,
  status: "active",
  owner: true,
  devices: 1,
  maxDevices: 0,
};

export function LockScreen({ onUnlocked }: { onUnlocked: (snap: LicenseSnap) => void }) {
  const toast = useToast();
  const [phase, setPhase] = useState<"boot" | "gate">("boot");
  const [storage, setStorage] = useState<"postgres" | "file">("file");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [deviceId, setDeviceId] = useState("");

  useEffect(() => {
    setDeviceId(getDeviceId());
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const status = await api.licenseStatus();
        if (!alive) return;
        setStorage(status.storage);
        if (!status.required) {
          onUnlocked(LOCAL_SNAP);
          return;
        }
        if (getToken()) {
          try {
            const verified = await api.licenseVerify();
            if (!alive) return;
            onUnlocked(verified.license);
            return;
          } catch {
            // Expired, revoked or signed under another master key.
            clearToken();
          }
        }
        if (alive) setPhase("gate");
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase("gate");
      }
    })();
    return () => {
      alive = false;
    };
  }, [onUnlocked]);

  async function activate(): Promise<void> {
    if (busy) return;
    if (!key.trim()) {
      setError("Paste your license key first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.licenseActivate(key.trim(), deviceId || getDeviceId());
      setToken(res.token, res.license.plan);
      onUnlocked(res.license);
      try {
        toast.ok("Unlocked", `${res.license.plan} plan${res.license.owner ? " · owner" : ""}`);
      } catch {
        /* toast is cosmetic */
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyDevice(): Promise<void> {
    try {
      await navigator.clipboard.writeText(deviceId);
      toast.ok("Copied", "Device id copied to the clipboard.");
    } catch {
      toast.warn("Copy blocked", "Select the device id and copy it by hand.");
    }
  }

  if (phase === "boot") {
    return (
      <div className="login-scene" style={{ display: "grid", placeItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", color: "#94a3b8", fontSize: "0.85rem" }}>
          <MiniSpinner />
          Checking your session…
        </div>
      </div>
    );
  }

  return (
    <div className="login-scene">
      <div className="login-grid">
        {/* ------------------------------------------------------------ hero -- */}
        <section className="login-visual" aria-label="About this studio">
          <div className="login-brand-lockup gate-in">
            <span className="login-brand-mark">
              <img src="assets/ui/app-icon.png" alt="" />
            </span>
            <div>
              <div className="login-brand-wordmark" style={{ fontSize: "1.5rem", lineHeight: 1.15 }}>
                Homescapes VIP Studio
              </div>
              <p className="login-eyebrow">Game Data Center · licence gate</p>
            </div>
          </div>

          <p className="login-tagline gate-in">
            The complete Homescapes save editor. Connect to the client's game over ADB, stage real save values,
            and push them back in one pass — every field verified against the save format before anything is
            written.
          </p>

          <ul className="login-feature-list gate-in">
            <li>
              <span className="login-feature-mark">
                <Icon name="monitor" />
              </span>
              <span>
                <b>Connect to the live game.</b> Pull the client's own save from an emulator or phone, edit it,
                and push it back with an automatic backup.
              </span>
            </li>
            <li>
              <span className="login-feature-mark">
                <Icon name="database" />
              </span>
              <span>
                <b>Real fields only.</b> Coins, level, lives, statistics, cards, events, cosmetics and home
                content — read from the save, never invented.
              </span>
            </li>
            <li>
              <span className="login-feature-mark">
                <Icon name="shield" />
              </span>
              <span>
                <b>Sealed activation.</b> Keys are fingerprinted with HMAC-SHA256 and the session is an
                AES-256-GCM token that expires in 12 hours.
              </span>
            </li>
          </ul>
        </section>

        {/* ------------------------------------------------------------ card -- */}
        <section className="login-card gate-in" aria-labelledby="login-heading">
          <header className="login-card-heading">
            <span className="login-card-mark">
              <img src="assets/ui/app-icon.png" alt="" />
            </span>
            <div style={{ minWidth: 0 }}>
              <p className="kicker">Homescapes VIP Studio</p>
              <h1 id="login-heading" className="login-card-title">
                Unlock your studio
              </h1>
              <p className="login-card-desc">
                Enter the licence key your operator issued. This device is identified below.
              </p>
            </div>
          </header>

          <div className="login-divider" />

          <div className="device-id-card">
            <span className="device-id-icon">
              <Icon name="device" />
            </span>
            <div className="device-id-body">
              <div className="device-id-caption">Device id</div>
              <code className={deviceId ? "device-id-value" : "device-id-value device-id-value--pending"}>
                {deviceId || "reading…"}
              </code>
            </div>
            <button
              type="button"
              className="copy-button"
              onClick={() => void copyDevice()}
              disabled={!deviceId}
              title="Copy the device id"
            >
              <Icon name="copy" />
              Copy
            </button>
          </div>

          <div style={{ marginTop: "0.95rem" }}>
            <label className="login-label" htmlFor="license-key">
              <Icon name="key" />
              <span className="kicker">License key</span>
            </label>
            <div className="field-shell">
              <Icon name="key" className="field-leading-icon" />
              <input
                id="license-key"
                className="field"
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void activate();
                }}
                placeholder="HS-XXXXX-XXXXX-XXXXX-XXXXX"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="characters"
                type={showKey ? "text" : "password"}
              />
              <button
                type="button"
                className="field-toggle"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? "Hide license key" : "Show license key"}
                title={showKey ? "Hide key" : "Show key"}
              >
                <Icon name={showKey ? "eye-off" : "eye"} />
              </button>
            </div>
            <p className="login-hint">
              Keys are case-insensitive and the separators are optional. The <b>owner passcode</b> also works
              here — it opens the full studio plus the owner console.
            </p>

            {error ? (
              <div className="login-error" role="alert">
                <Icon name="alert" />
                <span>{error}</span>
              </div>
            ) : null}

            <button type="button" className="login-unlock" onClick={() => void activate()} disabled={busy}>
              {busy ? <MiniSpinner /> : <Icon name="unlock" />}
              {busy ? "Unlocking…" : "Unlock studio"}
            </button>

            <button type="button" className="login-unlock login-unlock--ghost" onClick={() => setOwnerOpen(true)}>
              <Icon name="server" />
              Owner console · issue client keys
            </button>

            {storage === "file" ? (
              <p className="login-storage-warn">
                <Icon name="alert" />
                <span>
                  No database is configured on this server — keys live in a local file and would be lost on a
                  restart. Set <b>DATABASE_URL</b> for production.
                </span>
              </p>
            ) : null}
          </div>
        </section>
      </div>

      <footer className="login-footer">
        <span className="login-footer-rule" aria-hidden />
        <span className="login-footer-credit">
          Built by <span className="login-brand-wordmark">AM TECH</span>
        </span>
        <span className="login-footer-rule" aria-hidden />
      </footer>

      {ownerOpen ? (
        <div
          className="login-owner-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOwnerOpen(false);
          }}
        >
          <OwnerConsole onClose={() => setOwnerOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}
