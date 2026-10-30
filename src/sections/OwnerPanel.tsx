import { useState } from "react";
import { api, ApiError, type LicenseSnap, type OwnerRow } from "../lib/api.ts";
import { Button, Panel, Spinner, useToast } from "../components/ui.tsx";

export type OwnerAction = "issue" | "list" | "revoke" | "restore" | "reset-devices";

/**
 * Owner Hub — key management for clients.
 *
 * Behind `HS_OWNER` on the server. The owner pastes the passcode and issues,
 * lists, revokes, restores or device-resets keys. Issued keys are shown once.
 */
export function OwnerPanel() {
  const toast = useToast();
  const [open, setOpen] = useState(true);
  const [pass, setPass] = useState("");
  const [plan, setPlan] = useState<"trial" | "week" | "month" | "year" | "lifetime">("month");
  const [count, setCount] = useState(1);
  const [devices, setDevices] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ key: string; snap: LicenseSnap }[]>([]);
  const [rows, setRows] = useState<OwnerRow[]>([]);

  async function run(action: OwnerAction, extra: Record<string, unknown> = {}) {
    if (!pass.trim()) {
      setError("Enter the owner passcode first.");
      return;
    }
    setBusy(true);
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
        await run("list");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Panel title="Owner Hub" description="Owner tools are available below.">
        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={() => setOpen(true)}>
            Open owner panel
          </Button>
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="Owner Hub"
      description="Issue, list, revoke and reset client license keys. Secret: HS_OWNER."
      actions={
        <Button variant="ghost" className="" onClick={() => setOpen(false)}>
          Hide
        </Button>
      }
    >
      <div className="space-y-3">
        <input
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          type="password"
          placeholder="Owner passcode"
          autoComplete="off"
          className="w-full rounded-lg border border-line-2 bg-app px-3 py-2 font-mono text-sm text-ink outline-none focus:border-gold"
        />
        {error ? <p className="rounded-lg border border-err/40 bg-err/10 px-3 py-2 text-xs text-err">{error}</p> : null}
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
          <Button variant="gold" loading={busy} onClick={() => void run("issue", { plan, count, devices })} className="flex-1">
            Issue keys
          </Button>
          <Button variant="ghost" loading={busy} onClick={() => void run("list")} className="flex-1">
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
                  onClick={() => void run(r.active ? "revoke" : "restore", { key: r.fp })}
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
  );
}
