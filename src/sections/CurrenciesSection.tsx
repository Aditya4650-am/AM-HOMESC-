import { useEffect, useMemo, useState } from "react";
import { api, type DiscoveredField } from "../lib/api.ts";
import { useStudio } from "../lib/studio.tsx";
import { BTN, GI } from "../lib/icons.ts";
import {
  Bar,
  EmptyState,
  KpiTile,
  SearchBox,
  Spinner,
  StatCard,
  useToast,
} from "../components/ui.tsx";

/**
 * Live-event tokens — `Currency.<Name>.amount` + `.prevAmount` leaf pairs.
 *
 * Every card stages straight into the shared pending map; the save is only
 * written when the user applies (Save & Push).
 */
const PREFIX = "Currency.";

/** Kinds the engine reports as a plain JSON number — safe to stage as one. */
const NUMERIC_KINDS = new Set(["number", "int", "float", "tagged-i64", "tagged-f"]);

const AMOUNT_PRESETS: Array<{ label: string; value: number }> = [
  { label: "1K", value: 1_000 },
  { label: "10K", value: 10_000 },
  { label: "50K", value: 50_000 },
  { label: "100K", value: 100_000 },
];

interface CurrencyRow {
  /** Raw key segment, e.g. `LongCompetitionPoints`. */
  name: string;
  label: string;
  emoji: string;
  amountPath: string;
  amountKind: string;
  amount: number | null;
  prevPath: string | null;
  prevKind: string | null;
  prevValue: number | null;
}

/** `Merge2_Farm_Photoalbum.Energy` → `Merge 2 Farm Photoalbum Energy`. */
function prettify(raw: string): string {
  const spaced = raw
    .replace(/[._-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  return spaced
    .split(" ")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function emojiFor(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("ticket")) return "🎟️";
  if (n.includes("score") || n.includes("points")) return "🏁";
  if (n.includes("energy")) return "⚡";
  if (n.includes("exp")) return "📈";
  return "🪙";
}

/** Real token art by name — the emoji above stays as the automatic fallback. */
function iconFor(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("gem")) return BTN.gems;
  if (n.includes("ticket")) return GI.tickets;
  if (n.includes("season")) return GI.seasonPoints;
  if (n.includes("point") || n.includes("score")) return GI.points;
  if (n.includes("energy")) return BTN.energy;
  return GI.coins;
}

export function CurrenciesSection() {
  const { overview, values, pending, setPending, clearPending, pushLog } = useStudio();
  const toast = useToast();
  const [fields, setFields] = useState<DiscoveredField[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  // Server-side key search, debounced: `overview` changes identity after each
  // apply, which is exactly when a refetch is wanted.
  useEffect(() => {
    if (!overview) {
      setFields([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      api
        .discover(PREFIX, undefined, 2000, query.trim())
        .then((f) => {
          if (!cancelled) setFields(f);
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            toast.err(
              "Could not read currencies",
              err instanceof Error ? err.message : String(err),
            );
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [overview, query, toast]);

  /* ------------------------------------------------------------- shaping -- */

  /**
   * The server search reaches keys beyond the first page; re-applying it to
   * the returned rows locally keeps the UI correct even before (or without)
   * the debounced refetch landing.
   */
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return fields;
    return fields.filter((f) => f.path.toLowerCase().includes(q));
  }, [fields, query]);

  const rows = useMemo<CurrencyRow[]>(() => {
    const byName = new Map<string, { amount?: DiscoveredField; prev?: DiscoveredField }>();
    for (const f of visible) {
      if (f.path.endsWith(".t")) continue; // tag-name leaves are never editable
      // Split on the LAST dot so `CNMerge2Photoalbum.Energy.amount` groups as
      // one token (`CNMerge2Photoalbum.Energy` + `amount` / `prevAmount`).
      const dot = f.key.lastIndexOf(".");
      if (dot < 0) continue;
      const name = f.key.slice(0, dot);
      const leaf = f.key.slice(dot + 1);
      if (leaf !== "amount" && leaf !== "prevAmount") continue;
      let g = byName.get(name);
      if (!g) {
        g = {};
        byName.set(name, g);
      }
      if (leaf === "amount") g.amount = f;
      else g.prev = f;
    }

    const out: CurrencyRow[] = [];
    for (const [name, g] of byName) {
      const a = g.amount;
      if (!a) continue;
      const p = g.prev ?? null;
      out.push({
        name,
        label: prettify(name),
        emoji: emojiFor(name),
        amountPath: a.path,
        amountKind: a.kind,
        amount: typeof a.value === "number" ? a.value : null,
        prevPath: p ? p.path : null,
        prevKind: p ? p.kind : null,
        prevValue: p && typeof p.value === "number" ? p.value : null,
      });
    }
    out.sort((x, y) => x.label.localeCompare(y.label));
    return out;
  }, [visible]);

  const ticketRows = useMemo(
    () => rows.filter((r) => r.name.toLowerCase().includes("ticket")),
    [rows],
  );

  /* ------------------------------------------------------------ staging -- */

  /** STAGE: equal to live ⇒ drop the pending override, otherwise set it. */
  const stageNum = (path: string, kind: string, live: number | null, next: number) => {
    if (!NUMERIC_KINDS.has(kind)) return;
    const current = values[path] ?? live;
    if (current === next) clearPending(path);
    else setPending(path, next);
  };

  const effNum = (path: string, live: number | null): number | null => {
    const p = pending.get(path);
    return typeof p === "number" ? p : live;
  };

  const stagedNum = (path: string): number | undefined => {
    const p = pending.get(path);
    return typeof p === "number" ? p : undefined;
  };

  const bulkFill = (targets: CurrencyRow[], value: number, label: string) => {
    let n = 0;
    for (const r of targets) {
      stageNum(r.amountPath, r.amountKind, r.amount, value);
      if (r.amount !== value) n++;
    }
    pushLog("info", label, `${n} field${n === 1 ? "" : "s"} staged`);
  };

  const syncPrev = (r: CurrencyRow) => {
    if (!r.prevPath || !r.prevKind || !NUMERIC_KINDS.has(r.prevKind)) return;
    const next = effNum(r.amountPath, r.amount);
    if (next === null) return;
    stageNum(r.prevPath, r.prevKind, r.prevValue, next);
    pushLog("info", `↺ Synced ${r.label} previous amount`, "1 field staged");
  };

  const clearStaged = () => {
    let n = 0;
    for (const r of rows) {
      for (const p of [r.amountPath, r.prevPath]) {
        if (p && pending.has(p)) {
          clearPending(p);
          n++;
        }
      }
    }
    pushLog("info", "↩️ Clear staged currencies", `${n} field${n === 1 ? "" : "s"} cleared`);
  };

  /* --------------------------------------------------------------- stats -- */

  const total = rows.reduce((sum, r) => sum + (effNum(r.amountPath, r.amount) ?? 0), 0);
  const stagedCount = rows.reduce(
    (n, r) =>
      n + (pending.has(r.amountPath) ? 1 : 0) + (r.prevPath && pending.has(r.prevPath) ? 1 : 0),
    0,
  );

  /* -------------------------------------------------------------- render -- */

  return (
    <div className="flex flex-col gap-4">
      <Bar hint="Tap a preset, then Save & Push.">
        <button
          className="preset-pill"
          onClick={() => bulkFill(ticketRows, 99_999, "🎟️ All tickets ×99,999")}
          title={`Stage 99,999 on every ticket token (${ticketRows.length} found)`}
        >
          🎟️ All tickets ×99,999
        </button>
        <button
          className="preset-pill"
          onClick={() => bulkFill(rows, 0, "🧹 Zero all currencies")}
          title="Stage 0 on every event token amount"
        >
          🧹 Zero all
        </button>
        <button
          className="preset-pill"
          onClick={clearStaged}
          title="Drop staged currency edits only — other sections keep theirs"
        >
          ↩️ Clear staged
        </button>
        <SearchBox value={query} onChange={setQuery} placeholder="Search currencies…" />
      </Bar>

      <div className="stagger-in grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          emoji="🪙"
          label="Currencies"
          value={rows.length}
          title="Distinct event tokens discovered under Currency."
        />
        <KpiTile
          emoji="💎"
          label="Total tokens"
          value={total.toLocaleString("en-US")}
          title="Sum of every live + staged amount"
        />
        <KpiTile emoji="🎟️" label="Ticket types" value={ticketRows.length} />
        <KpiTile
          emoji="🧾"
          label="Staged"
          value={stagedCount}
          title="Amount / previous-amount edits waiting for Save & Push"
        />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-xl border border-line bg-panel px-4 py-6 text-sm text-ink-3">
          <Spinner size={15} />
          Reading event currencies…
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={query.trim() ? "No currency keys match" : "This save has no event currencies"}
        />
      ) : (
        <>
          <div className="stagger-in grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((r, i) => (
              <div key={r.name} className="flex flex-col gap-1.5">
                <StatCard
                  tone={(i % 7) + 1}
                  emoji={r.emoji}
                  icon={iconFor(r.name)}
                  label={r.label}
                  live={r.amount}
                  staged={stagedNum(r.amountPath)}
                  presets={AMOUNT_PRESETS}
                  min={0}
                  onCommit={(n) => stageNum(r.amountPath, r.amountKind, r.amount, n)}
                />
                {r.prevPath ? (
                  <div className="flex justify-end">
                    <button
                      className="preset-pill"
                      title={`Copy the current ${r.label} amount into prevAmount`}
                      onClick={() => syncPrev(r)}
                    >
                      ↺ sync prev
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
