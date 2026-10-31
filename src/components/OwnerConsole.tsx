import { useCallback, useEffect, useRef, useState } from "react";
import { api, type LicenseSnap, type OwnerRequest, type OwnerRow } from "../lib/api.ts";
import { getPlan } from "../lib/auth-store.ts";
import { useToast } from "./ui.tsx";
import { Icon, MiniSpinner } from "./icons.tsx";

/**
 * Owner console — client key generation, exactly the igg "Control" flow.
 *
 * Used in two places:
 *  - the login scene, as a modal reachable before any key is presented (the
 *    HS_OWNER passcode is itself the credential);
 *  - the in-studio Owner tab, where an owner activation token authorises the
 *    same actions without retyping the passcode.
 *
 * Everything is server-side: the browser never mints a key, it only renders
 * what `/api/license/owner` returns. The server stores a fingerprint, never the
 * key, so an issued key is shown once and copied by the operator.
 */

type Plan = "trial" | "week" | "month" | "year" | "lifetime" | "custom";

const PLAN_LABEL: Record<Plan, string> = {
  trial: "Trial · 1 day",
  week: "Week · 7 days",
  month: "Month · 30 days",
  year: "Year · 365 days",
  lifetime: "Lifetime",
  custom: "Custom duration",
};

const DAY = 86_400_000;

function remain(expiresAt: number): string {
  if (expiresAt === 0) return "lifetime";
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "expired";
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / 3_600_000);
  if (d > 0) return `${d}d ${h}h left`;
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m left` : `${Math.max(1, m)}m left`;
}

function stamp(ts: number): string {
  try {
    return new Date(ts).toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(ts);
  }
}

const SHORT_PLAN: Record<string, string> = {
  trial: "trial",
  week: "week",
  month: "month",
  year: "year",
  lifetime: "lifetime",
  custom: "custom",
  owner: "owner",
};

export function OwnerConsole({
  embedded = false,
  initialPasscode = "",
  onClose,
}: {
  embedded?: boolean;
  initialPasscode?: string;
  onClose?: () => void;
}) {
  const toast = useToast();
  const ownerToken = getPlan() === "owner";

  const [tab, setTab] = useState<"keys" | "guide">("keys");
  const [pass, setPass] = useState(initialPasscode);
  const [authorized, setAuthorized] = useState(ownerToken);
  const [rows, setRows] = useState<OwnerRow[]>([]);
  const [issued, setIssued] = useState<{ key: string; snap: LicenseSnap; plan: Plan }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [plan, setPlan] = useState<Plan>("month");
  const [count, setCount] = useState(1);
  const [days, setDays] = useState(30);
  const [hours, setHours] = useState(0);
  const [group, setGroup] = useState(false);
  const [maxDev, setMaxDev] = useState(3);
  const [bindDevice, setBindDevice] = useState("");
  const [note, setNote] = useState("");

  const [restoreTarget, setRestoreTarget] = useState("");
  const [restoreDays, setRestoreDays] = useState(30);
  const [confirm, setConfirm] = useState<string | null>(null);
  const confirmTimer = useRef<number | null>(null);

  const armConfirm = (id: string) => {
    setConfirm(id);
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => setConfirm(null), 6000);
  };

  useEffect(
    () => () => {
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    },
    [],
  );

  const run = useCallback(
    async (action: OwnerRequest["action"], extra: Partial<OwnerRequest> = {}) => {
      const payload: OwnerRequest = {
        action,
        ...(pass.trim() ? { passcode: pass.trim() } : {}),
        ...extra,
      };
      const res = await api.licenseOwner(payload);
      if (action === "list") {
        setRows(res.rows ?? []);
        setAuthorized(true);
      }
      return res;
    },
    [pass],
  );

  const refresh = useCallback(async () => {
    try {
      setError(null);
      await run("list");
    } catch (err) {
      setAuthorized(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [run]);

  // An owner token already authorises the console: load the list immediately.
  useEffect(() => {
    if (ownerToken) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.ok("Copied", what);
    } catch {
      toast.warn("Copy blocked", "Your browser refused clipboard access — select the text and copy it by hand.");
    }
  };

  const issue = async () => {
    if (busy) return;
    if (!authorized && !pass.trim()) {
      setError("Enter the owner passcode first.");
      return;
    }
    if (plan === "custom" && Number(days) + Number(hours) <= 0) {
      setError("A custom key needs at least one day or one hour.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await run("issue", {
        plan,
        count: Math.max(1, Math.min(50, Number(count) || 1)),
        ...(plan === "custom" ? { days: Number(days) || 0, hours: Number(hours) || 0 } : {}),
        devices: group ? Math.max(2, Math.min(10, Number(maxDev) || 3)) : 1,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(!group && bindDevice.trim() ? { bindDevice: bindDevice.trim().toUpperCase() } : {}),
      });
      const fresh = (res.issued ?? []).map((k) => ({ ...k, plan }));
      setIssued((prev) => [...fresh, ...prev].slice(0, 50));
      toast.ok(
        fresh.length === 1 ? "Key issued" : `${fresh.length} keys issued`,
        "Copy it now — the server stores only a fingerprint.",
      );
      setNote("");
      await run("list");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: "revoke" | "restore" | "reset-devices" | "delete", fp: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await run(action, { key: fp });
      toast.ok(
        action === "revoke"
          ? "Key revoked"
          : action === "restore"
            ? "Key restored"
            : action === "delete"
              ? "Key deleted"
              : "Device slots freed",
        fp.slice(0, 16) + "…",
      );
      setConfirm(null);
      await run("list");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const restoreTime = async () => {
    if (!restoreTarget.trim()) {
      setError("Paste the key, or its fingerprint, to restore.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await run("restore", { key: restoreTarget.trim(), days: restoreDays });
      toast.ok("Time restored", `+${restoreDays} day(s)`);
      setRestoreTarget("");
      await run("list");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const activeRows = rows.filter((r) => r.snap.status === "active");
  const deviceCount = rows.reduce((n, r) => n + r.devices.length, 0);

  /* ------------------------------------------------------------------ view -- */

  const gate = !authorized ? (
    <div className="owner-gate">
      <h3>Owner access</h3>
      <p>
        Enter the <b>HS_OWNER</b> passcode configured on this server. It is the only credential that can
        mint keys, and it never leaves the server after the check.
      </p>
      <label className="owner-field">
        <span className="kicker">Owner passcode</span>
        <input
          className="owner-input owner-input--mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void refresh();
          }}
          placeholder="HS_OWNER"
        />
      </label>
      <button type="button" className="owner-btn" disabled={busy} onClick={() => void refresh()}>
        {busy ? <MiniSpinner /> : <Icon name="unlock" />}
        Open console
      </button>
    </div>
  ) : null;

  return (
    <div
      className={embedded ? "" : "login-owner-card"}
      role={embedded ? undefined : "dialog"}
      aria-modal={embedded ? undefined : true}
      aria-label="Owner console"
    >
      <header className="owner-head">
        <span className="owner-head-icon">
          <Icon name="server" />
        </span>
        <div style={{ minWidth: 0, flex: "1 1 auto" }}>
          <h2>Owner console</h2>
          <p>Issue, bind, restore and revoke client keys. Every check runs on the server.</p>
        </div>
        {onClose ? (
          <button type="button" className="owner-close" onClick={onClose} aria-label="Close owner console">
            <Icon name="x" />
          </button>
        ) : null}
      </header>

      <nav className="owner-tabs" aria-label="Owner console sections">
        <button
          type="button"
          className={`owner-tab${tab === "keys" ? " owner-tab--active" : ""}`}
          aria-current={tab === "keys" ? "page" : undefined}
          onClick={() => setTab("keys")}
        >
          <Icon name="key" />
          Keys
        </button>
        <button
          type="button"
          className={`owner-tab${tab === "guide" ? " owner-tab--active" : ""}`}
          aria-current={tab === "guide" ? "page" : undefined}
          onClick={() => setTab("guide")}
        >
          <Icon name="layers" />
          How it works
        </button>
      </nav>

      <div className="owner-body">
        {error ? (
          <div className="login-error" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </div>
        ) : null}

        {tab === "keys" ? (
          !authorized ? (
            gate
          ) : (
            <>
              <div className="owner-stats">
                <div className="owner-stat">
                  <div className="owner-stat-label">Keys</div>
                  <div className="owner-stat-value">{rows.length}</div>
                </div>
                <div className="owner-stat">
                  <div className="owner-stat-label">Active</div>
                  <div className="owner-stat-value">{activeRows.length}</div>
                </div>
                <div className="owner-stat">
                  <div className="owner-stat-label">Devices bound</div>
                  <div className="owner-stat-value">{deviceCount}</div>
                </div>
              </div>

              {!ownerToken ? (
                <label className="owner-field">
                  <span className="kicker">Owner passcode (kept for this session)</span>
                  <input
                    className="owner-input owner-input--mono"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={pass}
                    onChange={(e) => setPass(e.target.value)}
                    placeholder="HS_OWNER"
                  />
                </label>
              ) : null}

              <section>
                <h3 className="owner-section-title">
                  <span>Issue a key</span>
                  <span className="owner-count">genuine HS-XXXXX-XXXXX-XXXXX-XXXXX</span>
                </h3>
                <div className="owner-grid-2">
                  <label className="owner-field">
                    <span className="kicker">Plan</span>
                    <select className="owner-input" value={plan} onChange={(e) => setPlan(e.target.value as Plan)}>
                      {(Object.keys(PLAN_LABEL) as Plan[]).map((p) => (
                        <option key={p} value={p}>
                          {PLAN_LABEL[p]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="owner-field">
                    <span className="kicker">How many keys</span>
                    <input
                      className="owner-input"
                      inputMode="numeric"
                      min={1}
                      max={50}
                      value={count}
                      onChange={(e) => setCount(Number(e.target.value.replace(/[^\d]/g, "")) || 1)}
                    />
                  </label>
                </div>

                {plan === "custom" ? (
                  <div className="owner-grid-3" style={{ marginTop: "0.55rem" }}>
                    <label className="owner-field">
                      <span className="kicker">Days</span>
                      <input
                        className="owner-input"
                        inputMode="numeric"
                        min={0}
                        value={days}
                        onChange={(e) => setDays(Number(e.target.value.replace(/[^\d]/g, "")) || 0)}
                      />
                    </label>
                    <label className="owner-field">
                      <span className="kicker">Hours</span>
                      <input
                        className="owner-input"
                        inputMode="numeric"
                        min={0}
                        value={hours}
                        onChange={(e) => setHours(Number(e.target.value.replace(/[^\d]/g, "")) || 0)}
                      />
                    </label>
                    <label className="owner-field">
                      <span className="kicker">Preview</span>
                      <input
                        className="owner-input"
                        readOnly
                        value={`${Number(days) || 0}d ${Number(hours) || 0}h`}
                      />
                    </label>
                  </div>
                ) : null}

                <div className="owner-grid-2" style={{ marginTop: "0.55rem" }}>
                  <label className="owner-field">
                    <span className="kicker">Note / client</span>
                    <input
                      className="owner-input"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="name, order id…"
                    />
                  </label>
                  <label className="owner-field">
                    <span className="kicker">Bind to device id (optional)</span>
                    <input
                      className={`owner-input owner-input--mono${group ? "" : ""}`}
                      value={bindDevice}
                      onChange={(e) => setBindDevice(e.target.value.toUpperCase())}
                      placeholder="HSD-…"
                      disabled={group}
                      title={group ? "Group keys are bound to devices on first activation" : "Pre-bind a single-device key"}
                    />
                  </label>
                </div>

                <div className="owner-grid-2" style={{ marginTop: "0.35rem", alignItems: "center" }}>
                  <label className="owner-check">
                    <input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} />
                    Group key · multiple devices
                  </label>
                  {group ? (
                    <label className="owner-field">
                      <span className="kicker">Max devices</span>
                      <input
                        className="owner-input"
                        inputMode="numeric"
                        min={2}
                        max={10}
                        value={maxDev}
                        onChange={(e) => setMaxDev(Number(e.target.value.replace(/[^\d]/g, "")) || 2)}
                      />
                    </label>
                  ) : (
                    <div className="owner-note">
                      Single-device keys bind to the first machine that activates them, or to the device id
                      above.
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.8rem" }}>
                  <button type="button" className="owner-btn" disabled={busy} onClick={() => void issue()}>
                    {busy ? <MiniSpinner /> : <Icon name="sparkles" />}
                    Issue {count > 1 ? `${count} keys` : "key"}
                  </button>
                  <button
                    type="button"
                    className="owner-btn owner-btn--ghost"
                    disabled={busy}
                    onClick={() => void refresh()}
                  >
                    <Icon name="refresh" />
                    Refresh list
                  </button>
                </div>
              </section>

              {issued.length > 0 ? (
                <section>
                  <h3 className="owner-section-title">
                    <span>Just issued — copy now</span>
                    <span className="owner-count">only a fingerprint is stored</span>
                  </h3>
                  <div className="owner-list">
                    {issued.map((k) => (
                      <div className="owner-issued" key={k.key}>
                        <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                          <code>{k.key}</code>
                          <span className="owner-issued-meta">
                            {SHORT_PLAN[k.plan] ?? k.plan} ·{" "}
                            {k.snap.expiresAt === 0 ? "lifetime" : `${remain(k.snap.expiresAt)}`}
                          </span>
                        </div>
                        <button type="button" className="owner-copy" onClick={() => void copy(k.key, "License key")}>
                          <Icon name="copy" />
                          Copy
                        </button>
                        <button
                          type="button"
                          className="owner-copy"
                          onClick={() => setIssued((prev) => prev.filter((x) => x.key !== k.key))}
                          aria-label="Hide issued key"
                        >
                          <Icon name="check" />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              <section>
                <h3 className="owner-section-title">
                  <span>Issued keys</span>
                  <span className="owner-count">{rows.length} total</span>
                </h3>
                {rows.length === 0 ? (
                  <div className="owner-empty">
                    No keys yet. Issue the first one above — it works immediately, no restart.
                  </div>
                ) : (
                  <div className="owner-list">
                    {rows.map((r) => {
                      const revoked = r.snap.status === "revoked";
                      const expired = r.snap.status === "expired";
                      const id = r.fp;
                      return (
                        <article className="owner-row" key={id}>
                          <div className="owner-row-top">
                            <span className="owner-fp" title={r.fp}>
                              {r.fp.slice(0, 18)}…
                            </span>
                            <span className="owner-pill owner-pill--plan">{SHORT_PLAN[r.plan] ?? r.plan}</span>
                            {r.maxDevices > 1 ? (
                              <span className="owner-pill owner-pill--group">
                                group · {r.devices.length}/{r.maxDevices}
                              </span>
                            ) : (
                              <span className="owner-pill">single</span>
                            )}
                            <span
                              className={`owner-pill ${
                                revoked || expired ? "owner-pill--off" : "owner-pill--ok"
                              }`}
                            >
                              {r.snap.status}
                            </span>
                            <span className="owner-row-remain">
                              {revoked ? "revoked" : expired ? "expired" : remain(r.expiresAt)}
                            </span>
                          </div>
                          <div className="owner-row-sub">
                            <span>created {stamp(r.createdAt)}</span>
                            {r.note ? <span>{r.note}</span> : null}
                          </div>
                          {r.devices.length > 0 ? (
                            <div className="owner-row-sub">
                              <span style={{ fontFamily: "var(--font-mono)" }}>{r.devices.join(" · ")}</span>
                            </div>
                          ) : null}
                          <div className="owner-row-actions">
                            <button
                              type="button"
                              className="owner-btn owner-btn--ghost owner-btn--sm"
                              onClick={() => void copy(r.fp, "Key fingerprint")}
                              title="Copy the full fingerprint"
                            >
                              <Icon name="copy" />
                              Fingerprint
                            </button>
                            <button
                              type="button"
                              className="owner-btn owner-btn--ghost owner-btn--sm"
                              disabled={busy}
                              onClick={() => void act("reset-devices", id)}
                            >
                              <Icon name="refresh" />
                              Reset devices
                            </button>
                            {revoked || expired ? (
                              <button
                                type="button"
                                className="owner-btn owner-btn--ok owner-btn--sm"
                                disabled={busy}
                                onClick={() => void act("restore", id)}
                              >
                                <Icon name="unlock" />
                                Restore
                              </button>
                            ) : (
                              <button
                                type="button"
                                className={`owner-btn ${confirm === `${id}:revoke` ? "owner-btn--danger" : "owner-btn--ghost"} owner-btn--sm`}
                                disabled={busy}
                                onClick={() => {
                                  if (confirm === `${id}:revoke`) void act("revoke", id);
                                  else armConfirm(`${id}:revoke`);
                                }}
                              >
                                <Icon name="lock" />
                                {confirm === `${id}:revoke` ? "Confirm revoke" : "Revoke"}
                              </button>
                            )}
                            <button
                              type="button"
                              className={`owner-btn ${confirm === `${id}:delete` ? "owner-btn--danger" : "owner-btn--ghost"} owner-btn--sm`}
                              disabled={busy}
                              onClick={() => {
                                if (confirm === `${id}:delete`) void act("delete", id);
                                else armConfirm(`${id}:delete`);
                              }}
                            >
                              <Icon name="trash" />
                              {confirm === `${id}:delete` ? "Confirm delete" : "Delete"}
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>

              <section>
                <h3 className="owner-section-title">
                  <span>Restore time</span>
                  <span className="owner-count">add days to a key</span>
                </h3>
                <div className="owner-grid-2">
                  <label className="owner-field">
                    <span className="kicker">Key or fingerprint</span>
                    <input
                      className="owner-input owner-input--mono"
                      value={restoreTarget}
                      onChange={(e) => setRestoreTarget(e.target.value)}
                      placeholder="HS-… or 64-hex fingerprint"
                    />
                  </label>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: "0.5rem" }}>
                    <label className="owner-field" style={{ flex: "0 0 7rem" }}>
                      <span className="kicker">Days</span>
                      <input
                        className="owner-input"
                        inputMode="numeric"
                        min={1}
                        max={3650}
                        value={restoreDays}
                        onChange={(e) => setRestoreDays(Number(e.target.value.replace(/[^\d]/g, "")) || 1)}
                      />
                    </label>
                    <button type="button" className="owner-btn" disabled={busy} onClick={() => void restoreTime()}>
                      <Icon name="refresh" />
                      Apply
                    </button>
                  </div>
                </div>
              </section>
            </>
          )
        ) : (
          <div className="owner-guide">
            <div className="owner-guide-card">
              <span className="owner-guide-n">01</span>
              <div>
                <h4>Issue</h4>
                <p>
                  Pick a plan (or a custom day/hour window), a device allowance, an optional client note and an
                  optional device id. The server mints a Crockford key and stores only its HMAC fingerprint.
                </p>
              </div>
            </div>
            <div className="owner-guide-card">
              <span className="owner-guide-n">02</span>
              <div>
                <h4>Send the key</h4>
                <p>
                  Copy the key the moment it is shown — it can never be recovered from the server. The client
                  pastes it into the studio gate; the tool seals a 12-hour activation token.
                </p>
              </div>
            </div>
            <div className="owner-guide-card">
              <span className="owner-guide-n">03</span>
              <div>
                <h4>Bind</h4>
                <p>
                  A single-device key binds to the first machine that activates it. Group keys allow a set number
                  of machines. Reset devices when a client reinstalls or changes PC.
                </p>
              </div>
            </div>
            <div className="owner-guide-card">
              <span className="owner-guide-n">04</span>
              <div>
                <h4>Restore time</h4>
                <p>
                  Add days to an existing key after a renewal. Restoring a revoked key reactivates it; deleting a
                  key erases it permanently.
                </p>
              </div>
            </div>
            <div className="owner-guide-card">
              <span className="owner-guide-n">05</span>
              <div>
                <h4>What the server never does</h4>
                <p>
                  It never stores a raw key, never contacts the game, and never spoofs a purchase. Keys gate this
                  studio only.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
