import { useEffect, useState } from "react";
import { api, type OwnerRow, type LicenseSnap } from "../lib/api.ts";
import { getPlan } from "../lib/auth-store.ts";
import { Button, Panel, Spinner, useToast } from "../components/ui.tsx";

/**
 * Owner Hub — the key generation panel, reachable from the dashboard.
 *
 * Mirrors the IGG tool's owner panel: issue keys (plan + duration + devices +
 * note + optional device binding), list every issued key, restore time, revoke,
 * and reset a key's device slots. Every action is gated server-side by
 * HS_OWNER, so a non-owner simply gets "Wrong owner passcode".
 */
export function OwnerSection() {
  const toast = useToast();
  const [pass, setPass] = useState("");
  const [plan, setPlan] = useState<"trial" | "week" | "month" | "year" | "lifetime">("month");
  const [count, setCount] = useState(1);
  const [devices, setDevices] = useState(1);
  const [note, setNote] = useState("");
  const [bindDevice, setBindDevice] = useState("");
  const [group, setGroup] = useState(false);
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ key: string; snap: LicenseSnap }[]>([]);
  const [rows, setRows] = useState<OwnerRow[]>([]);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [restoreKey, setRestoreKey] = useState("");
  const [restoreDays, setRestoreDays] = useState(30);

  const isOwner = getPlan() === "owner";

  async function refresh() {
    if (!pass.trim()) return;
    try {
      const res = await api.licenseOwner({ passcode: pass.trim(), action: "list" });
      setRows(res.rows ?? []);
    } catch (err) {
      toast.err("List failed", err instanceof Error ? err.message : String(err));
    }
  }

  async function issue() {
    if (!pass.trim()) { toast.err("Owner passcode required", "Enter HS_OWNER first."); return; }
    setBusy(true);
    try {
      const res = await api.licenseOwner({
        passcode: pass.trim(),
        action: "issue",
        plan,
        days: plan === "lifetime" ? 0 : days,
        devices: group ? Math.max(2, devices) : 1,
        count,
        note,
        bindDevice: bindDevice.trim() || undefined,
      } as never);
      setIssued((prev) => [...(res.issued ?? []), ...prev]);
      toast.ok("Keys issued", `${res.issued?.length ?? 0} new key(s)`);
      await refresh();
    } catch (err) {
      toast.err("Issue failed", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: string) {
    if (!pass.trim()) return;
    try {
      await api.licenseOwner({ passcode: pass.trim(), action: "revoke", key } as never);
      toast.ok("Revoked", key);
      await refresh();
    } catch (err) {
      toast.err("Revoke failed", err instanceof Error ? err.message : String(err));
    }
  }

  async function restore() {
    if (!pass.trim() || !restoreKey.trim()) return;
    try {
      await api.licenseOwner({ passcode: pass.trim(), action: "restore", key: restoreKey.trim(), days: restoreDays } as never);
      toast.ok("Restored", restoreKey.trim());
      setRestoreKey("");
      await refresh();
    } catch (err) {
      toast.err("Restore failed", err instanceof Error ? err.message : String(err));
    }
  }

  async function resetDevices(key: string) {
    if (!pass.trim()) return;
    try {
      await api.licenseOwner({ passcode: pass.trim(), action: "reset-devices", key } as never);
      toast.ok("Devices reset", key);
      await refresh();
    } catch (err) {
      toast.err("Reset failed", err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-4">
      <Panel
        title="Owner Hub"
        description="Issue, restore, revoke and reset client keys. Requires the HS_OWNER passcode."
      >
        <div className="space-y-3">
          <label className="block">
            <span className="text-[13px] font-medium text-ink">Owner passcode</span>
            <input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder="HS_OWNER"
              autoComplete="off"
              className="mt-1.5 w-full rounded-lg border border-line-2 bg-app px-3 py-2 font-mono text-sm text-ink outline-none focus:border-gold"
            />
          </label>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="block text-[11px] text-ink-3">
              Plan
              <select
                value={plan}
                onChange={(e) => setPlan(e.target.value as typeof plan)}
                className="mt-1 w-full rounded-lg border border-line-2 bg-app px-2 py-1.5 text-xs text-ink"
              >
                <option value="trial">trial (1d)</option>
                <option value="week">week (7d)</option>
                <option value="month">month (30d)</option>
                <option value="year">year (365d)</option>
                <option value="lifetime">lifetime</option>
              </select>
            </label>
            <label className="block text-[11px] text-ink-3">
              Count
              <input
                type="number" min={1} max={50} value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-line-2 bg-app px-2 py-1.5 text-xs text-ink"
              />
            </label>
            <label className="block text-[11px] text-ink-3">
              Devices
              <input
                type="number" min={1} max={10} value={devices}
                onChange={(e) => setDevices(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-line-2 bg-app px-2 py-1.5 text-xs text-ink"
              />
            </label>
            <label className="block text-[11px] text-ink-3">
              Days (custom)
              <input
                type="number" min={1} max={3650} value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-line-2 bg-app px-2 py-1.5 text-xs text-ink"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block text-[11px] text-ink-3">
              Note
              <input
                value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="client name / order"
                className="mt-1 w-full rounded-lg border border-line-2 bg-app px-2 py-1.5 text-xs text-ink"
              />
            </label>
            <label className="block text-[11px] text-ink-3">
              Bind to device (optional)
              <input
                value={bindDevice} onChange={(e) => setBindDevice(e.target.value.toUpperCase())}
                placeholder="HSD-…"
                className="mt-1 w-full rounded-lg border border-line-2 bg-app px-2 py-1.5 font-mono text-xs text-ink"
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-[11px] text-ink-3">
            <input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} />
            Group key (multiple devices)
          </label>

          <div className="flex gap-2">
            <Button variant="gold" loading={busy} onClick={() => void issue()} className="flex-1">
              Issue keys
            </Button>
            <Button variant="subtle" onClick={() => void refresh()} className="flex-1">
              List keys
            </Button>
          </div>

          {issued.length > 0 ? (
            <div className="space-y-1 rounded-lg border border-line-2 bg-app p-3">
              <div className="text-[11px] font-medium text-ink-2">Issued (copy now — server stores only a fingerprint)</div>
              {issued.map((k) => (
                <div key={k.key} className="flex items-center justify-between gap-2">
                  <code className="font-mono text-[11px] text-gold-2">{k.key}</code>
                  <span className="text-[10px] text-ink-3">{k.snap.plan}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </Panel>

      {rows.length > 0 ? (
        <Panel title={`Issued keys (${rows.length})`} description="Revoke / restore / reset device slots.">
          <div className="space-y-2">
            {rows.map((r) => (
              <div
                key={r.fp}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line-2 bg-app p-2 text-[11px]"
              >
                <div className="min-w-0">
                  <div className="font-mono text-ink-2">{r.fp.slice(0, 16)}…</div>
                  <div className="text-ink-3">
                    {r.plan} · {r.snap.status} · {r.devices.length}/{r.maxDevices}d
                    {r.note ? ` · ${r.note}` : ""}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" onClick={() => void resetDevices(r.fp)} className="px-2 py-1 text-[11px]">
                    Reset devices
                  </Button>
                  <Button
                    variant={r.active ? "danger" : "subtle"}
                    onClick={() => {
                      if (pendingDelete === r.fp) {
                        void (r.active ? revoke(r.fp) : (async () => {
                          try {
                            await api.licenseOwner({ passcode: pass.trim(), action: "restore", key: r.fp, days: 30 } as never);
                            toast.ok("Restored", r.fp);
                            await refresh();
                          } catch (e) { toast.err("Restore failed", e instanceof Error ? e.message : String(e)); }
                        })());
                        setPendingDelete(null);
                      } else {
                        setPendingDelete(r.fp);
                        setTimeout(() => setPendingDelete((p) => (p === r.fp ? null : p)), 6000);
                      }
                    }}
                    className="px-2 py-1 text-[11px]"
                  >
                    {pendingDelete === r.fp
                      ? "Confirm?"
                      : r.active
                      ? "Revoke"
                      : "Restore"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      <Panel title="Restore time to a key" description="Add days to an existing key.">
        <div className="flex flex-wrap items-end gap-2">
          <label className="block text-[11px] text-ink-3">
            Key or fingerprint
            <input
              value={restoreKey} onChange={(e) => setRestoreKey(e.target.value)}
              className="mt-1 w-64 rounded-lg border border-line-2 bg-app px-2 py-1.5 font-mono text-xs text-ink"
            />
          </label>
          <label className="block text-[11px] text-ink-3">
            Days
            <input
              type="number" min={1} max={3650} value={restoreDays}
              onChange={(e) => setRestoreDays(Number(e.target.value))}
              className="mt-1 w-20 rounded-lg border border-line-2 bg-app px-2 py-1.5 text-xs text-ink"
            />
          </label>
          <Button variant="ghost" onClick={() => void restore()} className="px-3 py-1.5 text-[11px]">
            Restore
          </Button>
        </div>
      </Panel>
    </div>
  );
}
