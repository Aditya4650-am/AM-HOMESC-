import { useEffect, useState } from "react";
import { api, ApiError, type LicenseSnap, type OwnerRow } from "../lib/api.ts";
import { getDeviceId, setToken } from "../lib/auth-store.ts";
import { Button, Panel, Spinner, useToast } from "../components/ui.tsx";

/**
 * The login. Two ways in, exactly like the IGG tool:
 *   - a customer pastes a license key (`HS-XXXXX-XXXXX-XXXXX-XXXXX`);
 *   - the owner pastes the owner passcode (`HS_OWNER`) and gets the Owner Hub,
 *     where keys are issued, listed, revoked and device-reset.
 *
 * A successful activation stores a sealed token, not the key: the key never
 * sits in localStorage and is never re-sent on subsequent requests.
 */
export function LockScreen({ onUnlocked }: { onUnlocked: (snap: LicenseSnap) => void }) {
  const toast = useToast();
  const [checking, setChecking] = useState(true);
  const [required, setRequired] = useState(true);
  const [storage, setStorage] = useState<"postgres" | "file">("file");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ownerOpen, setOwnerOpen] = useState(false);
  const [pass, setPass] = useState("");
  const [issued, setIssued] = useState<{ key: string; snap: LicenseSnap }[]>([]);
  const [rows, setRows] = useState<OwnerRow[]>([]);
  const [plan, setPlan] = useState<"trial" | "week" | "month" | "year" | "lifetime">("month");
  const [count, setCount] = useState(1);
  const [devices, setDevices] = useState(1);
  const [ownerBusy, setOwnerBusy] = useState(false);

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

  async function ownerRun(action: "issue" | "list" | "revoke" | "restore" | "reset-devices", extra: Record<string, unknown> = {}) {
    if (!pass.trim()) {
      setError("Enter the owner passcode first.");
      return;
    }
    setOwnerBusy(true);
    setError(null);
    try {
      const res = await api.licenseOwner({ passcode: pass.trim(), action, ...extra } as never);
      if (action === "issue") {
        setIssued((prev) => [...(res.issued ?? []), ...prev]);
        toast.ok("Keys issued", `${res.issued?.length ?? 0} new key(s)`);
      } else if (action === "list") {
        setRows(res.rows ?? []);
      } else {
        toast.ok("Done", action);
        await ownerRun("list");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setOwnerBusy(false);
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
    // Local run with HS_MASTER unset: no gate. Render the shell immediately.
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

        {ownerOpen ? (
          <Panel title="Owner Hub" description="Issue and manage keys. Owner passcode is HS_OWNER.">
            <div className="space-y-3">
              <input
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                type="password"
                placeholder="Owner passcode"
                autoComplete="off"
                className="w-full rounded-lg border border-line-2 bg-app px-3 py-2 font-mono text-sm text-ink outline-none focus:border-gold"
              />

              <div className="grid grid-cols-3 gap-2">
                <label className="block text-[11px] text-ink-3">
                  Plan
                  <select
                    value={plan}
                    onChange={(e) => setPlan(e.target.value as typeof plan)}
                    className="mt-1 w-full rounded-lg border border-line-2 bg-app px-2 py-1.5 text-xs text-ink"
                  >
                    <option value="trial">trial (1d)</option>
                    <option value="week">week</option>
                    <option value="month">month</option>
                    <option value="year">year</option>
                    <option value="lifetime">lifetime</option>
                  </select>
                </label>
                <label className="block text-[11px] text-ink-3">
                  Count
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={count}
                    onChange={(e) => setCount(Number(e.target.value))}
                    className="mt-1 w-full rounded-lg border border-line-2 bg-app px-2 py-1.5 text-xs text-ink"
                  />
                </label>
                <label className="block text-[11px] text-ink-3">
                  Devices
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={devices}
                    onChange={(e) => setDevices(Number(e.target.value))}
                    className="mt-1 w-full rounded-lg border border-line-2 bg-app px-2 py-1.5 text-xs text-ink"
                  />
                </label>
              </div>

              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  loading={ownerBusy}
                  onClick={() => void ownerRun("issue", { plan, count, devices })}
                  className="flex-1"
                >
                  Issue keys
                </Button>
                <Button variant="subtle" onClick={() => void ownerRun("list")} className="flex-1">
                  List keys
                </Button>
              </div>

              {issued.length > 0 ? (
                <div className="space-y-1 rounded-lg border border-line-2 bg-app p-2">
                  {issued.map((k) => (
                    <div key={k.key} className="flex items-center justify-between gap-2">
                      <code className="font-mono text-[11px] text-gold-2">{k.key}</code>
                      <span className="text-[10px] text-ink-3">{k.snap.plan}</span>
                    </div>
                  ))}
                  <p className="pt-1 text-[10px] text-ink-3">Copy these now — the server stores only a fingerprint.</p>
                </div>
              ) : null}

              {rows.length > 0 ? (
                <div className="max-h-48 space-y-1 overflow-auto rounded-lg border border-line-2 bg-app p-2">
                  {rows.map((r) => (
                    <div key={r.fp} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="font-mono text-ink-2">{r.fp}…</span>
                      <span className="text-ink-3">
                        {r.snap.plan} · {r.snap.status} · {r.devices.length}/{r.maxDevices}d
                      </span>
                      <button
                        type="button"
                        onClick={() => void ownerRun(r.active ? "revoke" : "restore", { key: r.fp })}
                        className="text-err hover:underline"
                      >
                        {r.active ? "revoke" : "restore"}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </Panel>
        ) : null}
      </div>
    </div>
  );
}
