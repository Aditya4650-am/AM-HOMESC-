import { useEffect, useMemo, useState } from "react";
import { api, type DiscoveredField } from "../lib/api.ts";
import { useStudio } from "../lib/studio.tsx";
import { BTN, eventPic, GI } from "../lib/icons.ts";
import {
  Bar,
  ChipToggle,
  EmptyState,
  FeatureRow,
  GameIcon,
  KpiTile,
  Panel,
  PanelHead,
  PresetPill,
  SearchBox,
  Spinner,
  StateBadge,
  StatCard,
  useToast,
} from "../components/ui.tsx";

/**
 * Live events — an event index, per-event key editing and the season pass.
 *
 * `SpecialEvents.` is one of the largest prefixes in a mature save (tens of
 * thousands of leaves), so every fetch runs through the SERVER-side key
 * search and renders at most the 2,000-row page. With an empty search the
 * index (distinct first key segments) is shown instead of raw leaves.
 *
 * Safety: tag-name leaves (`.t`), nulls, JSON-looking strings and anything
 * else that is not a plain number / boolean / short string render read-only —
 * only leaf kinds the engine can write back byte-safely are staged.
 */
const EVENT_PREFIX = "SpecialEvents.";
const SEASON_PREFIX = "SeasonPassInfoCache.";

const ROW_CAP = 300;
const PAGE_CAP = 2000;

/** Kinds the engine reports as a plain JSON number — safe to stage as one. */
const NUMERIC_KINDS = new Set(["number", "int", "float", "tagged-i64", "tagged-f"]);

type LeafMode = "number" | "bool" | "text" | "ro";

function classify(f: DiscoveredField): LeafMode {
  if (f.path.endsWith(".t")) return "ro"; // tag-name leaf ("ds", "i64", …)
  if (f.kind === "boolean") return "bool";
  if (NUMERIC_KINDS.has(f.kind)) return typeof f.value === "number" ? "number" : "ro";
  if (f.kind.startsWith("tagged")) return "ro"; // wrappers we cannot rewrite safely
  if (f.kind === "string" && typeof f.value === "string") {
    const v = f.value;
    // Serialized JSON (objects/arrays/multiline blobs) must never be staged.
    if (v.startsWith("{") || v.startsWith("[") || v.includes("\r\n") || v.length > 48) return "ro";
    return "text";
  }
  return "ro"; // null, object, array, unknown kinds
}

function displayValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "—";
  if (typeof v === "string") return v === "" ? '""' : v;
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? "" : "s"}]`;
  if (typeof v === "object") return `{${Object.keys(v as object).length} keys}`;
  return String(v);
}

/** First key segment — the event id (`SpecialEvents.<Event>.…`). */
function firstSeg(key: string): string {
  const dot = key.indexOf(".");
  return dot === -1 ? key : key.slice(0, dot);
}

/** Key minus its first segment — the leaf path inside the event. */
function leafLabel(key: string): string {
  const dot = key.indexOf(".");
  const rest = dot === -1 ? key : key.slice(dot + 1);
  return rest || key;
}

/** `ZenMatchEvent` → `Zen Match Event`. */
function prettify(raw: string): string {
  const spaced = raw
    .replace(/[_-]+/g, " ")
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

function eventEmoji(name: string): string {
  if (/match/i.test(name)) return "🧩";
  if (/farm|garden/i.test(name)) return "🌻";
  if (/expedition/i.test(name)) return "🧭";
  if (/chest/i.test(name)) return "🎁";
  return "🐝";
}

function modeEmoji(mode: LeafMode, path: string): string {
  if (mode === "number") return "🔢";
  if (mode === "bool") return "🔘";
  if (mode === "text") return "🔤";
  if (path.endsWith(".t")) return "🏷️";
  return "🔒";
}

/* ------------------------------------------------------------------ main -- */

export function EventsSection() {
  const { overview, values, pending, setPending, clearPending, pushLog } = useStudio();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [fields, setFields] = useState<DiscoveredField[]>([]);
  const [season, setSeason] = useState<DiscoveredField[]>([]);
  const [loading, setLoading] = useState(true);
  const [seasonLoading, setSeasonLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  // Season pass — small, bounded prefix; refetched whenever `overview`
  // changes identity (i.e. after every apply).
  useEffect(() => {
    if (!overview) {
      setSeason([]);
      setSeasonLoading(false);
      return;
    }
    let cancelled = false;
    setSeasonLoading(true);
    api
      .discover(SEASON_PREFIX, undefined, 100)
      .then((f) => {
        if (!cancelled) setSeason(f);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          toast.err(
            "Could not read season pass",
            err instanceof Error ? err.message : String(err),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setSeasonLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [overview, toast]);

  // Live events — always fetched WITH the debounced server search so the
  // enormous prefix never pulls more than one page of raw leaves.
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
        .discover(EVENT_PREFIX, undefined, PAGE_CAP, query.trim())
        .then((f) => {
          if (!cancelled) setFields(f);
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            toast.err(
              "Could not read live events",
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
   * Server-side search reaches keys beyond the first page; the same needle is
   * re-applied locally so the index and detail rows stay correct even while
   * the debounced refetch is in flight.
   */
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return fields;
    return fields.filter((f) => f.path.toLowerCase().includes(q));
  }, [fields, query]);

  const index = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of visible) {
      const seg = firstSeg(f.key);
      if (!seg) continue;
      counts.set(seg, (counts.get(seg) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [visible]);

  const selectedRows = useMemo(
    () => (selected ? visible.filter((f) => firstSeg(f.key) === selected) : []),
    [visible, selected],
  );

  const stagedByEvent = useMemo(() => {
    const m = new Map<string, number>();
    for (const k of pending.keys()) {
      if (!k.startsWith(EVENT_PREFIX)) continue;
      const seg = firstSeg(k.slice(EVENT_PREFIX.length));
      if (!seg) continue;
      m.set(seg, (m.get(seg) ?? 0) + 1);
    }
    return m;
  }, [pending]);

  const stagedCount = useMemo(() => {
    let n = 0;
    for (const k of pending.keys()) {
      if (k.startsWith(EVENT_PREFIX) || k.startsWith(SEASON_PREFIX)) n++;
    }
    return n;
  }, [pending]);

  /* ------------------------------------------------------- season pass -- */

  const findSeason = (name: string): DiscoveredField | null =>
    season.find((f) => f.key === name || f.key.endsWith(`.${name}`)) ?? null;

  const stagedNumOf = (path: string): number | undefined => {
    const p = pending.get(path);
    return typeof p === "number" ? p : undefined;
  };

  const seasonFmt = (name: string): string => {
    const f = findSeason(name);
    if (!f) return "—";
    const eff = pending.get(f.path) ?? f.value;
    if (typeof eff === "number") return eff.toLocaleString("en-US");
    if (typeof eff === "boolean") return eff ? "yes" : "no";
    if (Array.isArray(eff)) return `${eff.length}`;
    if (eff && typeof eff === "object") return `${Object.keys(eff).length}`;
    if (eff === null || eff === undefined) return "—";
    const s = String(eff);
    return s.length > 14 ? `${s.length} chars` : s;
  };

  const golden = useMemo(
    () =>
      season.find(
        (f) =>
          (f.key === "goldenPassPurchased" || f.key.endsWith(".goldenPassPurchased")) &&
          f.kind === "boolean",
      ) ?? null,
    [season],
  );
  const goldenPending = golden ? pending.get(golden.path) : undefined;
  const goldenChecked =
    typeof goldenPending === "boolean" ? goldenPending : golden?.value === true;

  /* ------------------------------------------------------------ staging -- */

  /** STAGE: equal to live ⇒ drop the pending override, otherwise set it. */
  const stage = (path: string, live: unknown, next: number | boolean | string) => {
    const current = values[path] ?? live;
    if (current === next) clearPending(path);
    else setPending(path, next);
  };

  const seasonStat = (name: string, emoji: string, icon: string, label: string, tone: number) => {
    const f = findSeason(name);
    if (!f || typeof f.value !== "number") return null;
    return (
      <StatCard
        tone={tone}
        emoji={emoji}
        icon={icon}
        label={label}
        live={f.value}
        staged={stagedNumOf(f.path)}
        min={0}
        presets={[
          { label: "10", value: 10 },
          { label: "31", value: 31, title: "A full pass — 31 tiers" },
          { label: "50", value: 50 },
          { label: "100", value: 100 },
        ]}
        onCommit={(n) => stage(f.path, f.value, n)}
      />
    );
  };

  const clearStagedEdits = () => {
    let n = 0;
    for (const k of [...pending.keys()]) {
      if (k.startsWith(EVENT_PREFIX) || k.startsWith(SEASON_PREFIX)) {
        clearPending(k);
        n++;
      }
    }
    pushLog("info", "↩️ Clear staged event edits", `${n} field${n === 1 ? "" : "s"} cleared`);
  };

  const hasQuery = query.trim().length > 0;
  const shownRows = selectedRows.slice(0, ROW_CAP);

  /* -------------------------------------------------------------- render -- */

  return (
    <div className="flex flex-col gap-4">
      <Bar hint="Tap an event, then stage its keys.">
        <button
          className="preset-pill"
          onClick={clearStagedEdits}
          title="Drop staged edits under SpecialEvents.* and SeasonPassInfoCache.*"
        >
          ↩️ Clear staged
        </button>
        {hasQuery ? (
          <button className="preset-pill" onClick={() => setQuery("")} title="Back to the full index">
            ✕ Clear search
          </button>
        ) : null}
        <SearchBox value={query} onChange={setQuery} placeholder="Search event keys…" />
      </Bar>

      <div className="stagger-in grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          emoji="🐝"
          label="Events indexed"
          value={index.length}
          title="Distinct SpecialEvents.* first segments on the current page"
        />
        <KpiTile
          emoji="🔑"
          label="Keys shown"
          value={visible.length}
          title={`Matching keys on this page — the server cap is ${PAGE_CAP.toLocaleString("en-US")}`}
        />
        <KpiTile
          emoji="🎟️"
          label="Season pass"
          value={season.length > 0 ? "active" : seasonLoading ? "…" : "—"}
        />
        <KpiTile
          emoji="🧾"
          label="Staged"
          value={stagedCount}
          title="Event + season-pass edits waiting for Save & Push"
        />
      </div>

      {/* ---------------------------------------------------- season pass -- */}
      {season.length > 0 ? (
        <section className="panel">
          <PanelHead
            tone="gold"
            icon="🎟️"
            right={<StateBadge tone="gold">{season.length} keys</StateBadge>}
          >
            Season Pass
          </PanelHead>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiTile
              emoji="🟡"
              icon={GI.seasonPoints}
              label="Free tiers unlocked"
              value={seasonFmt("unlockedFree")}
            />
            <KpiTile
              emoji="🥇"
              icon={GI.goldenTicket}
              label="Gold tiers unlocked"
              value={seasonFmt("unlockedGold")}
            />
            <KpiTile
              emoji="📦"
              icon={BTN.seasonChest}
              label="Free rewards collected"
              value={seasonFmt("collectedFree")}
            />
            <KpiTile
              emoji="📦"
              icon={BTN.seasonChest}
              label="Gold rewards collected"
              value={seasonFmt("collectedGold")}
            />
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {seasonStat("unlockedFree", "🟡", GI.seasonPoints, "Unlocked (free track)", 1)}
            {seasonStat("unlockedGold", "🥇", GI.goldenTicket, "Unlocked (gold track)", 4)}
          </div>

          {golden ? (
            <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
              <ChipToggle
                emoji="👑"
                label="Golden pass purchased"
                checked={goldenChecked}
                onChange={() => stage(golden.path, golden.value, !goldenChecked)}
                title={
                  goldenChecked
                    ? "Golden pass is on — click to stage false"
                    : "Stage goldenPassPurchased = true"
                }
              />
            </div>
          ) : null}
        </section>
      ) : null}

      {/* --------------------------------------------------- event index -- */}
      {loading ? (
        <div className="flex items-center gap-2 rounded-xl border border-line bg-panel px-4 py-6 text-sm text-ink-3">
          <Spinner size={15} />
          Reading SpecialEvents…
        </div>
      ) : index.length === 0 ? (
        <EmptyState
          title={hasQuery ? "No event keys match" : "This save has no live events"}
        />
      ) : (
        <div className="stagger-in grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {index.map((e) => {
            const isSelected = selected === e.name;
            const stagedN = stagedByEvent.get(e.name) ?? 0;
            const pic = eventPic(e.name);
            return (
              <div
                key={e.name}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                className="panel cursor-pointer"
                style={
                  isSelected
                    ? {
                        borderColor: "rgba(217,161,60,0.8)",
                        boxShadow: "0 14px 34px rgba(217,161,60,0.3)",
                      }
                    : undefined
                }
                onClick={() => setSelected(e.name)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    setSelected(e.name);
                  }
                }}
              >
                <PanelHead
                  tone="cyan"
                  icon={
                    pic ? (
                      <GameIcon src={pic} emoji={eventEmoji(e.name)} size={26} className="rounded-lg" />
                    ) : (
                      eventEmoji(e.name)
                    )
                  }
                  right={<StateBadge tone="cyan">{e.count} fields</StateBadge>}
                >
                  {prettify(e.name)}
                </PanelHead>
                <div className="flex flex-wrap items-center gap-1.5">
                  {isSelected ? (
                    <StateBadge tone="gold">selected</StateBadge>
                  ) : (
                    <StateBadge>tap to open</StateBadge>
                  )}
                  {stagedN > 0 ? (
                    <StateBadge tone="gold">staged {stagedN}</StateBadge>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* --------------------------------------------------- event detail -- */}
      {selected ? (
        <Panel
          title={`${eventEmoji(selected)} ${prettify(selected)}`}
          actions={
            <div className="flex items-center gap-2">
              <StateBadge tone={loading ? "neutral" : "cyan"}>
                {loading ? "loading…" : `${selectedRows.length} keys`}
              </StateBadge>
              <SearchBox value={query} onChange={setQuery} placeholder="Search keys…" />
            </div>
          }
        >
          {selectedRows.length === 0 ? (
            <EmptyState
              title="No event keys match"
              detail="Clear the search, or pick another event card above."
            />
          ) : (
            <div className="stagger-in grid gap-2.5 lg:grid-cols-2">
              {shownRows.map((f) => (
                <LeafRow key={f.path} field={f} eventName={selected} />
              ))}
            </div>
          )}
        </Panel>
      ) : (
        <EmptyState
          title="Pick an event"
          detail="Select an event card above to inspect and stage its keys."
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ row -- */

function LeafRow({ field, eventName }: { field: DiscoveredField; eventName: string }) {
  const { pending, setPending, clearPending, values } = useStudio();
  const mode = classify(field);
  const staged = pending.get(field.path);
  const isStaged = staged !== undefined && staged !== field.value;
  const label = leafLabel(field.key);

  const stage = (next: number | boolean | string) => {
    const current = values[field.path] ?? field.value;
    if (current === next) clearPending(field.path);
    else setPending(field.path, next);
  };

  let controls: React.ReactNode;
  if (mode === "bool") {
    const eff = typeof staged === "boolean" ? staged : field.value === true;
    controls = (
      <>
        <PresetPill active={eff === true} onClick={() => stage(true)} title="Stage true">
          ON
        </PresetPill>
        <PresetPill active={eff === false} onClick={() => stage(false)} title="Stage false">
          OFF
        </PresetPill>
        {isStaged ? <StateBadge tone="gold">staged</StateBadge> : null}
      </>
    );
  } else if (mode === "number") {
    controls = (
      <NumberCtl
        live={typeof field.value === "number" ? field.value : null}
        staged={typeof staged === "number" ? staged : undefined}
        onStage={stage}
      />
    );
  } else if (mode === "text") {
    controls = (
      <TextCtl
        live={typeof field.value === "string" ? field.value : ""}
        staged={typeof staged === "string" ? staged : undefined}
        onStage={stage}
      />
    );
  } else {
    controls = (
      <>
        <span
          className="max-w-[9rem] truncate font-mono text-[11px] text-ink-3"
          title={displayValue(field.value)}
        >
          {displayValue(field.value)}
        </span>
      </>
    );
  }

  return (
    <FeatureRow emoji={modeEmoji(mode, field.path)} name={label} controls={controls} />
  );
}

/** Commit-on-blur quantity box + tiny presets for small values. */
function NumberCtl({
  live,
  staged,
  onStage,
}: {
  live: number | null;
  staged: number | undefined;
  onStage: (n: number) => void;
}) {
  const eff = staged ?? live ?? 0;
  const isStaged = staged !== undefined && live !== null && staged !== live;
  const [draft, setDraft] = useState(String(eff));
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setDraft(String(eff)), [eff]);

  const commit = () => {
    const raw = draft.trim();
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n)) {
      setErr("not a number");
      return;
    }
    setErr(null);
    if (n !== eff) onStage(n);
  };

  return (
    <>
      <input
        className="field field-qty"
        inputMode="numeric"
        value={draft}
        aria-label="Value"
        onChange={(e) => {
          setDraft(e.target.value);
          setErr(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      {Math.abs(eff) <= 100 ? (
        <>
          <PresetPill active={eff === 0} onClick={() => onStage(0)}>
            0
          </PresetPill>
          <PresetPill active={eff === 1} onClick={() => onStage(1)}>
            1
          </PresetPill>
          <PresetPill active={eff === 10} onClick={() => onStage(10)}>
            10
          </PresetPill>
        </>
      ) : null}
      {err ? (
        <StateBadge tone="warn">{err}</StateBadge>
      ) : isStaged ? (
        <StateBadge tone="gold">staged</StateBadge>
      ) : null}
    </>
  );
}

/** Commit-on-blur text box for short, plain (non-JSON) strings. */
function TextCtl({
  live,
  staged,
  onStage,
}: {
  live: string;
  staged: string | undefined;
  onStage: (s: string) => void;
}) {
  const eff = staged ?? live;
  const isStaged = staged !== undefined && staged !== live;
  const [draft, setDraft] = useState(eff);

  useEffect(() => setDraft(eff), [eff]);

  const commit = () => {
    if (draft !== eff) onStage(draft);
  };

  return (
    <>
      <input
        className="field w-28"
        value={draft}
        aria-label="Value"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      {isStaged ? <StateBadge tone="gold">staged</StateBadge> : null}
    </>
  );
}
