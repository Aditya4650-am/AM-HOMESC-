import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api.ts";
import { getDeviceId, setToken } from "../lib/auth-store.ts";
import { Button, Panel, Spinner, useToast } from "../components/ui.tsx";
import { OwnerPanel } from "./OwnerPanel.tsx";

/**
 * The login. Two ways in, exactly like the IGG tool:
 *   - a customer pastes a license key (`HS-XXXXX-XXXXX-XXXXX-XXXXX`);
 *   - the owner opens the Owner Hub to issue / list / revoke keys.
 *
 * A successful activation stores a sealed token, not the key: the key itself is
 * presented once, at activation, and never sits in localStorage.
 */
export function LockScreen({ onUnlocked }: { onUnlocked: (snap: import("../lib/api.ts").LicenseSnap) => void }) {
  const toast = useToast();
  const [checking, setChecking] = useState(true);
  const [required, setRequired] = useState(true);
  const [storage, setStorage] = useState<"postgres" | "file">("file");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ownerOpen, setOwnerOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .licenseStatus()
      .then((s) => {
        if (!alive) return;
        setRequired(s.required);
        setStorage(s.storage);
        if (!s.required) onUnlocked({ plan: "local", expiresAt: 0, remainingMs: 0, status: "active", owner: true, devices: 1, maxDevices: 0 });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => alive && setChecking(false));
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
      const res = await api.licenseActivate(key.trim(), getDeviceId());
      setToken(res.token, res.license.plan);
      toast.ok("Activated", `${res.license.plan} plan${res.license.owner ? " · owner" : ""}`);
      onUnlocked(res.license);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-app">
        <div className="flex items-center gap-3 text-ink-3">
          <Spinner size={18} /> Checking access…
        </div>
      </div>
    );
  }

  if (!required) {
    // Local run with HS_MASTER unset: no gate. Hand straight back to the shell.
    return null;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-app px-4 py-10">
      <div className="w-full max-w-md space-y-4">
        <div className="text-center">
          <h1 className="text-lg font-semibold tracking-wide text-ink">AM TECH · Homescapes Tool</h1>
          <p className="mt-1 text-xs text-ink-3">Enter your license key to continue.</p>
        </div>

        <Panel title="Activation" description="Keys are bound to this device.">
          <div className="space-y-3">
            <label className="block">
              <span className="text-[13px] font-medium text-ink">License key</span>
              <input
                value={key}
                onChange={(e) => setKey(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && void activate()}
                placeholder="HS-XXXXX-XXXXX-XXXXX-XXXXX"
                spellCheck={false}
                autoComplete="off"
                className="mt-1.5 w-full rounded-lg border border-line-2 bg-app px-3 py-2 font-mono text-sm tracking-wider text-ink outline-none transition focus:border-gold"
              />
            </label>

            {error ? <p className="rounded-lg border border-err/40 bg-err/10 px-3 py-2 text-xs text-err">{error}</p> : null}

            <Button variant="gold" loading={busy} onClick={() => void activate()} className="w-full">
              Activate
            </Button>

            <p className="text-[11px] leading-relaxed text-ink-3">
              Device ID <span className="font-mono text-ink-2">{getDeviceId()}</span>
              {storage === "file" ? (
                <>
                  <br />
                  <span className="text-warn">Warning:</span> this server has no database — keys will be lost on
                  restart. Set <span className="font-mono">DATABASE_URL</span>.
                </>
              ) : null}
            </p>
          </div>
        </Panel>

        <div className="text-center">
          <button
            type="button"
            onClick={() => setOwnerOpen((v) => !v)}
            className="text-[11px] text-ink-3 underline-offset-2 hover:text-gold-2 hover:underline"
          >
            {ownerOpen ? "Hide owner panel" : "Owner access"}
          </button>
        </div>

        <div className="text-center">
          <button
            type="button"
            onClick={() => setOwnerOpen((v) => !v)}
            className="text-[11px] text-ink-3 underline-offset-2 hover:text-gold-2 hover:underline"
          >
            {ownerOpen ? "Hide owner panel" : "Owner access"}
          </button>
        </div>

        {ownerOpen ? <OwnerPanel /> : null}
      </div>
    </div>
  );
}
