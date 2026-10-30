import { useEffect, useState } from "react";
import { api, ApiError, type LicenseSnap, type OwnerRow } from "../lib/api.ts";
import { getDeviceId, setToken } from "../lib/auth-store.ts";
import { Button, Panel, Spinner, useToast } from "../components/ui.tsx";

/**
 * Professional login dashboard — styled after the IGG VIP Studio login scene:
 * device-id card + license input + unlock, on a dark surface. No auto-login:
 * every launch stops here until a valid key is presented (matches the IGG
 * regression contract).
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
  const [note, setNote] = useState("");
  const [ownerBusy, setOwnerBusy] = useState(false);

  const deviceId = getDeviceId();

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
    return () => { alive = false; };
  }, [onUnlocked]);

  async function activate(): Promise<void> {
    if (busy) return;
    if (!key.trim()) { setError("Paste your license key first."); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await api.licenseActivate(key.trim(), deviceId);
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
    if (!pass.trim()) { setError("Enter the owner passcode first."); return; }
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
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#070A13", color: "#94A3B8" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Spinner size={18} /> Checking access…
        </div>
      </div>
    );
  }

  if (!required) return null;

  const S = {
    bg: "#070A13", surface: "#0D1220", card: "#12192A", input: "#0F1524",
    fg: "#F8FAFC", muted: "#94A3B8", primary: "#7C3AED", primary2: "#A78BFA",
    border: "rgba(148,163,184,0.12)", ok: "#22C55E", err: "#EF4444", warn: "#F59E0B",
  };

  return (
    <div style={{ minHeight: "100vh", background: S.bg, color: S.fg, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: "Inter, system-ui, sans-serif" }}>
      <div style={{ width: "100%", maxWidth: 460 }}>
        {/* brand */}
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg,#7C3AED,#A78BFA)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 16 }}>H</div>
            <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: 0.2 }}>Homescapes Tool</div>
          </div>
          <div style={{ fontSize: 12, color: S.muted }}>Enter your license key to continue.</div>
        </div>

        {/* device id card */}
        <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 14, padding: 16, marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: S.muted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.6 }}>Device ID</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <code style={{ flex: 1, fontFamily: "JetBrains Mono, monospace", fontSize: 13, color: S.primary2, wordBreak: "break-all" }}>{deviceId}</code>
            <button
              onClick={() => { navigator.clipboard?.writeText(deviceId); toast.ok("Copied", deviceId); }}
              style={{ background: S.surface, border: `1px solid ${S.border}`, color: S.fg, borderRadius: 8, padding: "6px 10px", fontSize: 12, cursor: "pointer" }}
            >Copy</button>
          </div>
          {storage === "file" ? (
            <div style={{ marginTop: 10, fontSize: 11, color: S.warn }}>
              Warning: no database configured — keys will be lost on restart. Set DATABASE_URL.
            </div>
          ) : null}
        </div>

        {/* activation */}
        <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 14, padding: 16 }}>
          <label style={{ display: "block", fontSize: 13, fontWeight: 500, marginBottom: 6 }}>License key</label>
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void activate()}
            placeholder="HS-XXXXX-XXXXX-XXXXX-XXXXX  (or your owner passcode)"
            spellCheck={false}
            autoComplete="off"
            type="password"
            style={{ width: "100%", background: S.input, border: `1px solid ${S.border}`, borderRadius: 10, padding: "10px 12px", fontFamily: "JetBrains Mono, monospace", fontSize: 13, letterSpacing: 1, color: S.fg, outline: "none", boxSizing: "border-box" }}
          />
            <div style={{ marginTop: 6, fontSize: 11, color: S.muted }}>
              Tip: paste your <b>owner passcode</b> (HS_OWNER value) here to log in as owner.
            </div>
          <button
            onClick={() => void activate()}
            disabled={busy}
            style={{ marginTop: 12, width: "100%", background: S.primary, color: "#fff", border: "none", borderRadius: 10, padding: "11px 16px", fontSize: 14, fontWeight: 600, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </div>

        {/* owner */}
        <div style={{ textAlign: "center", marginTop: 14 }}>
          <button
            onClick={() => setOwnerOpen((v) => !v)}
            style={{ background: "none", border: "none", color: S.muted, fontSize: 11, textDecoration: "underline", cursor: "pointer" }}
          >
            {ownerOpen ? "Hide owner panel" : "Owner access"}
          </button>
        </div>

        {ownerOpen ? (
          <div style={{ marginTop: 14, background: S.card, border: `1px solid ${S.border}`, borderRadius: 14, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Owner Hub</div>
            <input
              type="password" value={pass} onChange={(e) => setPass(e.target.value)}
              placeholder="Owner passcode" autoComplete="off"
              style={{ width: "100%", background: S.input, border: `1px solid ${S.border}`, borderRadius: 8, padding: "8px 10px", fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: S.fg, marginBottom: 10, boxSizing: "border-box" }}
            />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
              <select value={plan} onChange={(e) => setPlan(e.target.value as typeof plan)}
                style={{ background: S.input, border: `1px solid ${S.border}`, borderRadius: 8, padding: "6px 8px", fontSize: 11, color: S.fg }}>
                <option value="trial">trial (1d)</option>
                <option value="week">week</option>
                <option value="month">month</option>
                <option value="year">year</option>
                <option value="lifetime">lifetime</option>
              </select>
              <input type="number" min={1} max={50} value={count} onChange={(e) => setCount(Number(e.target.value))}
                style={{ background: S.input, border: `1px solid ${S.border}`, borderRadius: 8, padding: "6px 8px", fontSize: 11, color: S.fg }} placeholder="count" />
              <input type="number" min={1} max={10} value={devices} onChange={(e) => setDevices(Number(e.target.value))}
                style={{ background: S.input, border: `1px solid ${S.border}`, borderRadius: 8, padding: "6px 8px", fontSize: 11, color: S.fg }} placeholder="devices" />
              <input type="number" min={1} max={3650} value={30} readOnly
                style={{ background: S.input, border: `1px solid ${S.border}`, borderRadius: 8, padding: "6px 8px", fontSize: 11, color: S.muted }} />
            </div>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (client name / order)"
              style={{ width: "100%", background: S.input, border: `1px solid ${S.border}`, borderRadius: 8, padding: "8px 10px", fontSize: 12, color: S.fg, marginBottom: 10, boxSizing: "border-box" }} />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => void ownerRun("issue", { plan, count, devices, note })}
                disabled={ownerBusy}
                style={{ flex: 1, background: S.primary, color: "#fff", border: "none", borderRadius: 8, padding: "9px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: ownerBusy ? 0.6 : 1 }}
              >
                {ownerBusy ? "Working…" : "Issue keys"}
              </button>
              <button
                onClick={() => void ownerRun("list")}
                style={{ flex: 1, background: S.surface, color: S.fg, border: `1px solid ${S.border}`, borderRadius: 8, padding: "9px 12px", fontSize: 12, cursor: "pointer" }}
              >
                List keys
              </button>
            </div>

            {issued.length > 0 ? (
              <div style={{ marginTop: 12, background: S.input, border: `1px solid ${S.border}`, borderRadius: 8, padding: 10 }}>
                <div style={{ fontSize: 10, color: S.muted, marginBottom: 6 }}>Issued — copy now (server stores only a fingerprint)</div>
                {issued.map((k) => (
                  <div key={k.key} style={{ display: "flex", justifyContent: "space-between", fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: S.primary2, marginBottom: 4 }}>
                    <span>{k.key}</span><span style={{ color: S.muted }}>{k.snap.plan}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {rows.length > 0 ? (
              <div style={{ marginTop: 12, maxHeight: 200, overflow: "auto", background: S.input, border: `1px solid ${S.border}`, borderRadius: 8, padding: 10 }}>
                {rows.map((r) => (
                  <div key={r.fp} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, marginBottom: 6, gap: 8 }}>
                    <span style={{ fontFamily: "JetBrains Mono, monospace", color: S.muted }}>{r.fp.slice(0, 14)}…</span>
                    <span style={{ color: S.fg }}>{r.plan} · {r.snap.status} · {r.devices.length}/{r.maxDevices}d</span>
                    <button
                      onClick={() => void ownerRun(r.active ? "revoke" : "restore", { key: r.fp })}
                      style={{ background: "none", border: "none", color: r.active ? S.err : S.ok, fontSize: 11, cursor: "pointer", textDecoration: "underline" }}
                    >
                      {r.active ? "revoke" : "restore"}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
