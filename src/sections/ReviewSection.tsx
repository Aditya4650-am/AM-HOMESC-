import { useState } from "react";
import { useStudio } from "../lib/studio.tsx";
import {
  Badge,
  Button,
  EmptyState,
  KpiTile,
  Panel,
  PanelHead,
  StateBadge,
  useToast,
} from "../components/ui.tsx";

/**
 * Review, apply and audit.
 *
 * This is the screen that has to earn the user's trust: it shows exactly which
 * fields are staged, what each will change from and to, and after applying it
 * reports the byte-level diff the server actually performed — including which
 * integrity strings were refreshed and which were deliberately left alone.
 */
export function ReviewSection() {
  const { overview, values, pending, clearPending, applyPending, applying, lastApply } = useStudio();
  const toast = useToast();
  const [refreshIntegrity, setRefreshIntegrity] = useState(true);

  const staged = [...pending.entries()].map(([path, value]) => ({
    path,
    before: values[path],
    after: value,
  }));

  const netBytes = lastApply ? lastApply.outputBytes - lastApply.inputBytes : 0;

  const download = () => {
    window.location.href = "/api/export";
  };

  if (!overview) return <EmptyState title="No save loaded" />;

  return (
    <div className="stagger-in flex flex-col gap-5">
      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <KpiTile
          emoji="✏️"
          label="Staged edits"
          value={staged.length.toLocaleString("en-US")}
          title="Nothing is written until you apply"
        />
        <KpiTile
          emoji="⚖️"
          label="Byte delta"
          value={
            lastApply
              ? `${netBytes >= 0 ? "+" : ""}${netBytes.toLocaleString("en-US")}`
              : "—"
          }
          title="Net byte change of the last apply"
        />
        <KpiTile
          emoji="🧾"
          label="Container bytes"
          value={overview.meta.plainBytes.toLocaleString("en-US")}
          title={`${overview.meta.containerKind}${overview.meta.wasEncrypted ? " · XOR-wrapped" : ""}`}
        />
      </div>

      <Panel
        title={
          <PanelHead
            tone="gold"
            icon="✏️"
            right={
              staged.length > 0 ? (
                <StateBadge tone="gold">{staged.length} staged</StateBadge>
              ) : (
                <StateBadge tone="neutral">empty</StateBadge>
              )
            }
          >
            Staged changes
          </PanelHead>
        }
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" disabled={staged.length === 0} onClick={() => clearPending()}>
              Discard all
            </Button>
            <Button
              variant="gold"
              disabled={staged.length === 0}
              loading={applying}
              onClick={() => void applyPending()}
            >
              Apply now
              {staged.length > 0 ? ` · ${staged.length} edit${staged.length === 1 ? "" : "s"}` : ""}
            </Button>
          </div>
        }
      >
        <label className="mb-4 flex items-center gap-2.5">
          <input
            type="checkbox"
            checked={refreshIntegrity}
            onChange={(e) => setRefreshIntegrity(e.target.checked)}
            className="accent-[#e8b04b]"
          />
          <span className="text-[13px] font-medium text-ink">Refresh derived integrity strings</span>
        </label>

        {staged.length === 0 ? (
          <EmptyState
            title="Nothing staged yet"
            detail="Edit a value in Data Center, Boosters, Lives, or any discovered field, and it will appear here for review."
            action={<span className="chip chip--gold">✏️ Start in Data Center, then review here</span>}
          />
        ) : (
          <div className="stagger-in grid gap-2.5 lg:grid-cols-2">
            {staged.map((s) => (
              <div key={s.path} className="panel">
                <div className="flex items-center gap-2">
                  <span className="feature-row__icon" aria-hidden>
                    ✏️
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-ink"
                    title={s.path}
                  >
                    {s.path}
                  </span>
                  <StateBadge tone="gold">staged</StateBadge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-panel-2 px-3 py-1.5 font-mono text-xs">
                  <span className="text-ink-3">{String(s.before ?? "—")}</span>
                  <span aria-hidden className="text-ink-3">
                    →
                  </span>
                  <span className="font-semibold text-warn">{String(s.after)}</span>
                  <button
                    onClick={() => clearPending(s.path)}
                    className="preset-pill ml-auto"
                    title="Drop this edit"
                  >
                    ✕ Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {lastApply ? (
        <Panel
          title={<PanelHead tone="navy" icon="🧾">Audit trail</PanelHead>}
          actions={<Badge tone={lastApply.ok ? "ok" : "err"}>{lastApply.ok ? "applied" : "refused"}</Badge>}
        >
          <div className="stagger-in grid gap-3 sm:grid-cols-3">
            <KpiTile emoji="📥" label="Input bytes" value={lastApply.inputBytes.toLocaleString("en-US")} />
            <KpiTile emoji="📤" label="Output bytes" value={lastApply.outputBytes.toLocaleString("en-US")} />
            <KpiTile
              emoji="⚖️"
              label="Net change"
              value={`${netBytes >= 0 ? "+" : ""}${netBytes.toLocaleString("en-US")}`}
            />
          </div>

          {lastApply.errors.length > 0 ? (
            <div className="mt-4 rounded-lg border border-err/40 bg-err/10 p-3 text-xs text-err">
              {lastApply.errors.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          ) : null}
          {lastApply.warnings.length > 0 ? (
            <div className="mt-4 rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
              {lastApply.warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          ) : null}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-ink-3">
                  <th className="py-2 pr-4 font-medium">Offset</th>
                  <th className="py-2 pr-4 font-medium">Field</th>
                  <th className="py-2 pr-4 font-medium">Before</th>
                  <th className="py-2 font-medium">After</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {lastApply.summary.map((s, i) => (
                  <tr key={i} className="border-t border-line/60">
                    <td className="py-2 pr-4 text-ink-3">{s.start.toLocaleString("en-US")}</td>
                    <td className="py-2 pr-4 text-ink-2">{s.path ?? s.label}</td>
                    <td className="py-2 pr-4 text-ink-3">{s.before}</td>
                    <td className="py-2 text-ok">{s.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      <Panel title={<PanelHead tone="gold" icon="⬇️">Export</PanelHead>}>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="gold" onClick={download}>
            Download SaveGame.db
          </Button>
        </div>
        <div className="mt-3">
          <Button
            variant="subtle"
            onClick={() => {
              void navigator.clipboard
                .writeText(window.location.origin + "/api/export")
                .then(() => toast.ok("Link copied"));
            }}
          >
            Copy export URL
          </Button>
        </div>
      </Panel>
    </div>
  );
}
