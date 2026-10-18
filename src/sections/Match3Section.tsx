import { useEffect, useMemo, useState } from "react";
import { api, type DiscoveredField } from "../lib/api.ts";
import { useStudio } from "../lib/studio.tsx";
import { BTN, GI } from "../lib/icons.ts";
import {
  Bar,
  EmptyState,
  FeatureRow,
  KpiTile,
  Panel,
  PanelHead,
  PresetRow,
  SearchBox,
  Spinner,
  StateBadge,
  useToast,
} from "../components/ui.tsx";

/**
 * Match3 — core puzzle state: pre-level equipped booster slots, daily-wins
 * history and the JSON progress strings.
 *
 * The `currentBoosters[n]` slots and `counts[n]` daily-wins cells stage as
 * plain numbers; progress strings (`AdditionalMovesCount`, `ShownTutorials[n]`
 * …) are serialized JSON and stay read-only, surfaced as parsed counts.
 */
export function Match3Section() {
  const { overview, pending, setPending, clearPending, pushLog } = useStudio();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [fields, setFields] = useState<DiscoveredField[]>([]);
  const [loading, setLoading] = useState(true);

  // Debounced server-side key search across both prefixes; `overview`
  // identity changes after each apply → auto refetch.
  useEffect(() => {
    if (!overview) {
      setFields([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .discover("Match3.|Match3DailyWins.", undefined, 2000, query.trim())
        .then((f) => {
          if (!cancelled) setFields(f);
        })
        .catch((err: unknown) => {
          if (!cancelled)
            toast.err("Could not read match-3 state", err instanceof Error ? err.message : String(err));
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

  const { slots, dailyWins, anchor, progress, tutorials, perksLevel, colorSeed } =
    useMemo(() => classify(fields), [fields]);

  const effNum = (f: DiscoveredField): number => {
    const staged = pending.get(f.path);
    return typeof staged === "number" ? staged : typeof f.value === "number" ? f.value : 0;
  };
  const isStaged = (f: DiscoveredField): boolean =>
    pending.has(f.path) && pending.get(f.path) !== f.value;

  const equipped = slots.filter((f) => effNum(f) > 0).length;
  const winsTotal = dailyWins.reduce((acc, f) => {
    const v = effNum(f);
    return acc + (v > 0 ? v : 0);
  }, 0);

  const stageAllCounts = (value: number, label: string) => {
    let n = 0;
    for (const f of dailyWins) {
      if (f.value === value) {
        clearPending(f.path);
        continue;
      }
      setPending(f.path, value);
      n++;
    }
    pushLog("info", label, `${n} field${n === 1 ? "" : "s"} staged`);
  };

  const clearStaged = () => {
    let n = 0;
    for (const f of fields) {
      if (pending.has(f.path)) {
        clearPending(f.path);
        n++;
      }
    }
    pushLog("info", "Clear staged", `${n} staged edit${n === 1 ? "" : "s"} reverted`);
  };

  if (!overview) {
    return (
      <EmptyState
        title="No save loaded"
        detail="Load a save file or pull one from a device to browse its match-3 state."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Bar hint="Tap a value, then Save & Push.">
        <button
          className="preset-pill"
          onClick={() => stageAllCounts(1, "Set all daily wins to 1")}
          title="Stage every Match3DailyWins.counts[i] to 1"
        >
          🏁 Set all daily wins to 1
        </button>
        <button
          className="preset-pill"
          onClick={() => stageAllCounts(-1, "Reset daily wins")}
          title="-1 means 'no data' for that day"
        >
          ⚪ Reset daily wins
        </button>
        <button className="preset-pill" onClick={clearStaged}>
          ↩️ Clear staged
        </button>
        <SearchBox value={query} onChange={setQuery} placeholder="Search match-3 keys…" />
      </Bar>

      {/* KPI strip */}
      <div className="stagger-in grid grid-cols-2 gap-3 sm:grid-cols-3">
        <KpiTile
          emoji="🎯"
          label="Equipped slots"
          value={`${equipped}/${slots.length > 0 ? 8 : 0}`}
          title="pre-level booster slots with a positive count"
        />
        <KpiTile emoji="🏆" icon={GI.cups} label="Daily wins" value={winsTotal.toLocaleString("en-US")} title="sum of counts[i] where > 0" />
        <KpiTile emoji="📚" label="Tutorials seen" value={tutorials.length.toLocaleString("en-US")} title="Match3.ShownTutorials entries" />
      </div>

      {loading && fields.length === 0 ? (
        <div className="flex items-center gap-2 py-10 text-ink-3">
          <Spinner size={15} />
          <span className="text-sm">Reading match-3 state…</span>
        </div>
      ) : fields.length === 0 ? (
        <EmptyState
          title={query ? "Nothing matches" : "No Match3 fields in this save"}
        />
      ) : (
        <>
          {/* a) Pre-level boosters */}
          <Panel title="🎯 Pre-level boosters">
            {slots.length === 0 ? null : (
              <div className="grid gap-2">
                {slots.map((f, i) => (
                  <FeatureRow
                    key={f.path}
                    emoji="🎯"
                    icon={slotIcon(f)}
                    name={`Slot ${i + 1}`}
                    controls={
                      <>
                        <PresetRow
                          options={[
                            { label: "0", value: 0 },
                            { label: "1", value: 1 },
                            { label: "5", value: 5 },
                          ]}
                          active={isStaged(f) ? effNum(f) : null}
                          onPick={(v) => {
                            if (v === "max") return;
                            if (v === f.value) clearPending(f.path);
                            else setPending(f.path, v);
                          }}
                        />
                        <SlotInput field={f} />
                        {isStaged(f) ? <StateBadge tone="gold">staged</StateBadge> : null}
                      </>
                    }
                  />
                ))}
              </div>
            )}
          </Panel>

          {/* b) Daily wins */}
          {dailyWins.length > 0 ? (
            <div className="panel">
              <PanelHead
                tone="amber"
                icon="🏆"
                right={<StateBadge tone={isStagedAny(dailyWins, pending) ? "gold" : "cyan"}>{winsTotal} wins</StateBadge>}
              >
                Daily wins ({dailyWins.length} days)
              </PanelHead>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <button className="preset-pill" onClick={() => stageAllCounts(-1, "Reset daily wins")}>
                  -1 clear
                </button>
                <button className="preset-pill" onClick={() => stageAllCounts(0, "Set daily wins to 0")}>
                  0
                </button>
                <button className="preset-pill" onClick={() => stageAllCounts(1, "Set daily wins to 1")}>
                  1
                </button>
                <button className="preset-pill" onClick={() => stageAllCounts(5, "Set daily wins to 5")}>
                  5
                </button>
              </div>
              <div className="flex items-center gap-3">
                <div className="mini-bar flex-1">
                  <div
                    className="mini-bar__fill mini-bar__fill--gold"
                    style={{ width: `${Math.min(100, (winsTotal / Math.max(1, dailyWins.length)) * 20)}%` }}
                  />
                </div>
                <span className="shrink-0 text-xs font-semibold text-ink-2">
                  {winsTotal} wins · avg {(winsTotal / dailyWins.length).toFixed(1)}/day
                </span>
              </div>
              <div className="stagger-in mt-3 grid grid-cols-3 gap-1.5 sm:grid-cols-5 lg:grid-cols-7">
                {dailyWins.map((f, i) => (
                  <DayCell key={f.path} field={f} index={i} staged={isStaged(f)} value={effNum(f)} />
                ))}
              </div>
              {anchor ? <AnchorCard field={anchor} /> : null}
            </div>
          ) : anchor ? (
            <AnchorCard field={anchor} />
          ) : null}

          {/* c) Progress strings */}
          <Panel title="📜 Progress strings">
            <div className="grid gap-2">
              {progress.map((f) => (
                <ProgressRow key={f.path} field={f} />
              ))}
              {colorSeed ? (
                <FeatureRow
                  emoji="🎨"
                  name="Color seed"
                  controls={<NumBox field={colorSeed} />}
                />
              ) : null}
              {perksLevel ? (
                <FeatureRow
                  emoji="💎"
                  icon={GI.superRainbow}
                  name="Perks level info"
                  controls={<NumBox field={perksLevel} />}
                />
              ) : null}
            </div>
            {tutorials.length > 0 ? (
              <div className="mt-3 rounded-lg bg-panel-2 px-3 py-2">
                <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-ink-2">
                  <span aria-hidden>📚</span>
                  <span>{tutorials.length} tutorials seen</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {tutorials.slice(0, 20).map((t, i) => (
                    <span
                      key={`${t.path}`}
                      className="rounded border border-line-2 bg-panel px-1.5 py-0.5 font-mono text-[10px] text-ink-3"
                      title={t.path}
                    >
                      {i}: {String(t.value).slice(0, 24)}
                    </span>
                  ))}
                  {tutorials.length > 20 ? (
                    <span className="rounded border border-line-2 px-1.5 py-0.5 text-[10px] text-ink-3">
                      +{tutorials.length - 20} more
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </Panel>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- icons -- */

/**
 * Real pre-level booster art for a `currentBoosters[N]` slot: matched by the
 * booster id the slot carries (saves store the id string directly). Returns
 * `undefined` whenever no asset genuinely matches — the emoji stays.
 */
function slotIcon(f: DiscoveredField): string | undefined {
  if (!/^currentBoosters\[\d+\]$/.test(f.key)) return undefined;
  if (typeof f.value !== "string") return undefined;
  const id = f.value.toLowerCase();
  if (id.includes("rainbow")) return GI.rainbow;
  if (id.includes("hammer")) return GI.hammer;
  if (id.includes("glove") || id.includes("swap")) return GI.glove;
  if (id.includes("ball")) return GI.glove;
  if (id.includes("broom")) return GI.broom;
  if (id.includes("fan") || id.includes("shuffle")) return GI.fan;
  if (id.includes("bomb")) return GI.bomb;
  if (id.includes("rocket")) return GI.rocket;
  if (id.includes("plane")) return GI.plane;
  return undefined;
}

/* -------------------------------------------------------------- classify -- */

function classify(fields: DiscoveredField[]) {
  const slots: DiscoveredField[] = [];
  const dailyWins: DiscoveredField[] = [];
  const progress: DiscoveredField[] = [];
  const tutorials: DiscoveredField[] = [];
  let anchor: DiscoveredField | null = null;
  let perksLevel: DiscoveredField | null = null;
  let colorSeed: DiscoveredField | null = null;

  for (const f of fields) {
    if (/^currentBoosters\[\d+\]$/.test(f.key) && (f.kind === "number" || f.kind === "tagged-i64")) {
      slots.push(f);
      continue;
    }
    if (/^counts\[\d+\]$/.test(f.key) && (f.kind === "number" || f.kind === "tagged-i64")) {
      dailyWins.push(f);
      continue;
    }
    if (
      f.key === "anchor" &&
      (f.kind === "number" || f.kind === "tagged-i64" || f.kind === "tagged-f")
    ) {
      anchor = f;
      continue;
    }
    if (f.key.startsWith("ShownTutorials")) {
      tutorials.push(f);
      continue;
    }
    if (f.key === "ColorSeed" && (f.kind === "number" || f.kind === "tagged-i64" || f.kind === "tagged-f")) {
      colorSeed = f;
      continue;
    }
    if (
      f.key === "ds_perksLevelInfo" &&
      (f.kind === "number" || f.kind === "tagged-i64" || f.kind === "tagged-f")
    ) {
      perksLevel = f;
      continue;
    }
    if (
      f.key === "AdditionalMovesCount" ||
      f.key === "UnfinishedGoals" ||
      f.key === "FinishedGoals"
    ) {
      progress.push(f);
      continue;
    }
    // Anything else still belongs to the section — surface it read-only.
    progress.push(f);
  }

  const byIndex = (a: DiscoveredField, b: DiscoveredField) =>
    Number(a.key.match(/\d+/)?.[0] ?? 0) - Number(b.key.match(/\d+/)?.[0] ?? 0);
  slots.sort(byIndex);
  dailyWins.sort(byIndex);
  tutorials.sort(byIndex);
  return { slots, dailyWins, anchor, progress, tutorials, perksLevel, colorSeed };
}

function isStagedAny(
  fields: DiscoveredField[],
  pending: Map<string, number | string | boolean>,
): boolean {
  return fields.some((f) => pending.has(f.path) && pending.get(f.path) !== f.value);
}

/* ------------------------------------------------------------- widgets -- */

function SlotInput({ field }: { field: DiscoveredField }) {
  const { pending, setPending, clearPending } = useStudio();
  const staged = pending.get(field.path);
  const shown = typeof staged === "number" ? staged : typeof field.value === "number" ? field.value : 0;
  return (
    <input
      key={`${field.path}-${String(field.value)}`}
      className="field field-qty"
      inputMode="numeric"
      defaultValue={String(shown)}
      title={`now ${shown}`}
      onBlur={(e) => {
        const n = Number(e.target.value);
        if (!Number.isFinite(n)) return;
        if (n === field.value) clearPending(field.path);
        else setPending(field.path, n);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function DayCell({
  field,
  index,
  staged,
  value,
}: {
  field: DiscoveredField;
  index: number;
  staged: boolean;
  value: number;
}) {
  const { setPending, clearPending } = useStudio();
  const tone = (index % 7) + 1;
  return (
    <div className="stat-card" data-tone={String(tone)}>
      <div className="stat-title">
        <span className="truncate">D{index}</span>
        {staged ? (
          <span className="ml-auto">
            <StateBadge tone="gold">staged</StateBadge>
          </span>
        ) : null}
      </div>
      <input
        key={`${field.path}-${String(field.value)}`}
        className="stat-value"
        inputMode="numeric"
        defaultValue={String(value)}
        title={value < 0 ? "no data" : `${value} win${value === 1 ? "" : "s"}`}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          if (n === field.value) clearPending(field.path);
          else setPending(field.path, n);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      <div className="font-mono text-[10px] text-ink-3">{value < 0 ? "no data" : "wins"}</div>
    </div>
  );
}

function AnchorCard({ field }: { field: DiscoveredField }) {
  const { pending, setPending, clearPending } = useStudio();
  const staged = pending.get(field.path);
  const shown = typeof staged === "number" ? staged : typeof field.value === "number" ? field.value : 0;
  const isStaged = staged !== undefined && staged !== field.value;
  return (
    <div className="mt-3 stat-card" data-tone="4">
      <div className="stat-title">
        <span className="stat-emoji" aria-hidden>
          📅
        </span>
        <span className="truncate">Day anchor</span>
        {isStaged ? (
          <span className="ml-auto">
            <StateBadge tone="gold">staged</StateBadge>
          </span>
        ) : null}
      </div>
      <input
        key={`${field.path}-${String(field.value)}`}
        className="stat-value"
        inputMode="numeric"
        defaultValue={String(shown)}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          if (n === field.value) clearPending(field.path);
          else setPending(field.path, n);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}

function ProgressRow({ field }: { field: DiscoveredField }) {
  const parsed = parseLength(field.value);
  const label =
    field.key === "AdditionalMovesCount"
      ? `${parsed} extra moves recorded`
      : field.key === "UnfinishedGoals"
        ? `${parsed} unfinished goals`
        : field.key === "FinishedGoals"
          ? `${parsed} finished goals`
          : parsed > 0
            ? `${field.key.replace(/[_\[\]]+/g, " ")} — ${parsed} entries`
            : field.key.replace(/[_\[\]]+/g, " ");
  // Extra-moves bookkeeping gets the move-token art; equipped booster slots
  // (stored as id strings) get their own booster icon.
  const icon = field.key === "AdditionalMovesCount" ? BTN.moveToken : slotIcon(field);
  return <FeatureRow emoji="📄" icon={icon} name={label} />;
}

function NumBox({ field }: { field: DiscoveredField }) {
  const { pending, setPending, clearPending } = useStudio();
  const staged = pending.get(field.path);
  const shown = typeof staged === "number" ? staged : typeof field.value === "number" ? field.value : 0;
  const isStaged = staged !== undefined && staged !== field.value;
  return (
    <>
      <input
        key={`${field.path}-${String(field.value)}`}
        className="field field-qty"
        inputMode="numeric"
        defaultValue={String(shown)}
        title={`now ${shown}`}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          if (n === field.value) clearPending(field.path);
          else setPending(field.path, n);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      {isStaged ? <StateBadge tone="gold">staged</StateBadge> : null}
    </>
  );
}

function parseLength(value: unknown): number {
  if (typeof value !== "string") return 0;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}
