import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type DiscoveredField } from "../lib/api.ts";
import { useStudio } from "../lib/studio.tsx";
import { BTN, GI } from "../lib/icons.ts";
import {
  Bar,
  ChipToggle,
  EmptyState,
  FeatureRow,
  GameIcon,
  KpiTile,
  Panel,
  PanelHead,
  SearchBox,
  Spinner,
  StateBadge,
  StatCard,
  useToast,
} from "../components/ui.tsx";

/**
 * Items — everything the profile holds under `PlayerItems.`.
 *
 * Booster counts live (and are edited) in the Boosters tab, so they surface
 * here as a read-only summary that still reflects staged values. BonusStars
 * is featured with presets; reward-grant flags get a chip grid with bulk
 * re-arm; epoch timers and leftovers render as safe-edit feature rows.
 */
export function ItemsSection() {
  const { overview, pending, setPending, clearPending, pushLog } = useStudio();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [fields, setFields] = useState<DiscoveredField[]>([]);
  const [loading, setLoading] = useState(true);

  // Server-side key search, debounced; `overview` identity changes after each
  // apply, which auto-refetches this section.
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
        .discover("PlayerItems.", undefined, 2000, query.trim())
        .then((f) => {
          if (!cancelled) setFields(f);
        })
        .catch((err: unknown) => {
          if (!cancelled)
            toast.err("Could not read items", err instanceof Error ? err.message : String(err));
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

  const { boosters, bonusStars, rewards, timers, others } = useMemo(
    () => categorize(fields),
    [fields],
  );

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

  const setRewards = (value: boolean) => {
    let n = 0;
    for (const f of rewards) {
      if (f.value === value) {
        clearPending(f.path);
        continue;
      }
      setPending(f.path, value);
      n++;
    }
    pushLog("info", value ? "Mark all rewards given" : "Re-arm all rewards", `${n} field${n === 1 ? "" : "s"} staged`);
  };

  if (!overview) {
    return (
      <EmptyState
        title="No save loaded"
        detail="Load a save file or pull one from a device to browse its inventory."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Bar hint="Every consumable the profile holds">
        <button className="preset-pill" onClick={clearStaged}>
          ↩️ Clear staged
        </button>
        <SearchBox value={query} onChange={setQuery} placeholder="Search item keys…" />
      </Bar>

      {/* KPI strip */}
      <div className="stagger-in grid grid-cols-2 gap-3 sm:grid-cols-3">
        <KpiTile emoji="🔢" label="Item keys" value={fields.length.toLocaleString("en-US")} title="leaves discovered under PlayerItems." />
        <KpiTile emoji="🎁" icon={GI.chest} label="Reward flags" value={rewards.length.toLocaleString("en-US")} title="GivingDecor* / GivingChest* booleans" />
        <KpiTile emoji="⏱️" label="Timers" value={timers.length.toLocaleString("en-US")} title="epoch start/end timestamps" />
      </div>

      {loading && fields.length === 0 ? (
        <div className="flex items-center gap-2 py-10 text-ink-3">
          <Spinner size={15} />
          <span className="text-sm">Reading inventory…</span>
        </div>
      ) : fields.length === 0 ? (
        <EmptyState
          title={query ? "Nothing matches" : "No PlayerItems. fields in this save"}
        />
      ) : (
        <>
          {/* BonusStars — featured */}
          <div className="stagger-in grid gap-3 lg:grid-cols-3">
            {bonusStars ? (
              <StatCard
                tone={1}
                emoji="🌟"
                icon={GI.stars}
                label="Bonus Stars"
                live={typeof bonusStars.value === "number" ? bonusStars.value : null}
                staged={pending.get(bonusStars.path) as number | undefined}
                min={0}
                presets={[
                  { label: "10", value: 10 },
                  { label: "50", value: 50 },
                  { label: "100", value: 100 },
                  { label: "500", value: 500 },
                  { label: "1000", value: 1000 },
                ]}
                onCommit={(n) => setPending(bonusStars.path, n)}
              />
            ) : (
              <div className="stat-card" data-tone="1">
                <div className="stat-title">
                  <span className="stat-emoji" aria-hidden>
                    <GameIcon src={GI.stars} emoji="🌟" size={18} />
                  </span>
                  <span className="truncate">Bonus Stars</span>
                </div>
                <div className="text-[11px] leading-snug text-ink-3">
                  This save does not store a BonusStars key yet.
                </div>
              </div>
            )}
            <div className="panel lg:col-span-2">
              <PanelHead tone="gold" icon="🎒" right={<StateBadge tone="cyan">{fields.length} keys</StateBadge>}>
                Inventory overview
              </PanelHead>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <KpiTile emoji="💣" label="Boosters" value={boosters.length} title="counts owned — edited in the Boosters tab" />
                <KpiTile emoji="🎁" icon={GI.chest} label="Rewards" value={rewards.length} title="already-granted markers" />
                <KpiTile emoji="⏱️" label="Timers" value={timers.length} title="epoch timestamps" />
                <KpiTile emoji="📦" icon={GI.mysteryChest} label="Other" value={others.length} title="remaining item keys" />
              </div>
            </div>
          </div>

          {/* Boosters — read-only summary (edited in the Boosters tab) */}
          {boosters.length > 0 ? (
            <Panel title="Booster counts" description="Edit these in the Boosters tab.">
              <div className="grid gap-2 sm:grid-cols-2">
                {boosters.map((f) => {
                  const staged = pending.get(f.path);
                  const shown = staged !== undefined ? staged : f.value;
                  const isStaged = staged !== undefined && staged !== f.value;
                  return (
                    <FeatureRow
                      key={f.path}
                      emoji={BOOSTER_EMOJI[f.key] ?? "🎁"}
                      icon={BOOSTER_ICON[f.key]}
                      name={prettify(f.key)}
                      controls={
                        <>
                          <span className="font-mono text-sm font-semibold text-ink">
                            ×{String(shown ?? 0)}
                          </span>
                          {isStaged ? <StateBadge tone="gold">staged</StateBadge> : null}
                        </>
                      }
                    />
                  );
                })}
              </div>
            </Panel>
          ) : null}

          {/* Reward flags — chip grid with bulk re-arm */}
          {rewards.length > 0 ? (
            <div className="panel">
              <PanelHead
                tone="amber"
                icon={<GameIcon src={GI.chest} emoji="🎁" size={16} />}
                right={
                  <button className="preset-pill inline-flex items-center gap-1.5" onClick={() => setRewards(true)}>
                    <GameIcon src={BTN.reward} emoji="🎁" size={15} />
                    Mark all given
                  </button>
                }
              >
                Reward flags ({rewards.length})
              </PanelHead>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <button className="preset-pill inline-flex items-center gap-1.5" onClick={() => setRewards(false)}>
                  <GameIcon src={BTN.reward} emoji="🔄" size={15} />
                  Re-arm all rewards
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {rewards.map((f, i) => (
                  <RewardChip key={f.path} field={f} index={i} />
                ))}
              </div>
            </div>
          ) : null}

          {/* Timers / protect windows */}
          {timers.length > 0 ? (
            <Panel title="Timers & protect windows">
              <div className="grid gap-2">
                {timers.slice(0, 300).map((f) => (
                  <SafeRow key={f.path} field={f} />
                ))}
              </div>
              {timers.length > 300 ? (
                <div className="mt-2 text-center text-[11px] text-ink-3">
                  +{(timers.length - 300).toLocaleString("en-US")} more — refine search to see them
                </div>
              ) : null}
            </Panel>
          ) : null}

          {/* Anything else */}
          {others.length > 0 ? (
            <Panel title="Other items">
              <div className="grid gap-2">
                {others.slice(0, 300).map((f) => (
                  <SafeRow key={f.path} field={f} />
                ))}
              </div>
              {others.length > 300 ? (
                <div className="mt-2 text-center text-[11px] text-ink-3">
                  +{(others.length - 300).toLocaleString("en-US")} more — refine search to see them
                </div>
              ) : null}
            </Panel>
          ) : null}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- categorize -- */

const BOOSTER_KEYS = new Set([
  "BombAndLineBoost",
  "LightningBoost",
  "MultiplyFishBoost",
  "HammerBonus",
  "HorizontalLineBoosterBonus",
  "VerticalLineBoosterBonus",
  "ReshuffleBoosterBonus",
  "SwapBoosterBonus",
]);

const BOOSTER_EMOJI: Record<string, string> = {
  BombAndLineBoost: "💣",
  LightningBoost: "⚡",
  MultiplyFishBoost: "🐟",
  HammerBonus: "🔨",
  HorizontalLineBoosterBonus: "↔️",
  VerticalLineBoosterBonus: "↕️",
  ReshuffleBoosterBonus: "🔀",
  SwapBoosterBonus: "🔁",
};

/** Real booster art — Lightning and Fish have no asset, so they keep emoji. */
const BOOSTER_ICON: Record<string, string> = {
  BombAndLineBoost: GI.rocketBomb,
  HammerBonus: GI.hammer,
  HorizontalLineBoosterBonus: GI.broom,
  VerticalLineBoosterBonus: GI.sledge,
  ReshuffleBoosterBonus: GI.fan,
  SwapBoosterBonus: GI.glove,
};

function categorize(fields: DiscoveredField[]) {
  const boosters: DiscoveredField[] = [];
  const rewards: DiscoveredField[] = [];
  const timers: DiscoveredField[] = [];
  const others: DiscoveredField[] = [];
  let bonusStars: DiscoveredField | null = null;

  for (const f of fields) {
    if (f.key === "BonusStars") {
      bonusStars = f;
      continue;
    }
    if (BOOSTER_KEYS.has(f.key)) {
      boosters.push(f);
      continue;
    }
    if (f.kind === "boolean" && (f.key.startsWith("GivingDecor") || f.key.startsWith("GivingChest"))) {
      rewards.push(f);
      continue;
    }
    if (
      f.kind === "number" &&
      (f.key.endsWith("AmountStartTime") ||
        f.key.endsWith("ProtectEndTime") ||
        f.key.endsWith("ProtectRemainTime"))
    ) {
      timers.push(f);
      continue;
    }
    others.push(f);
  }
  // Keep booster display order aligned with the canonical list.
  boosters.sort(
    (a, b) =>
      [...BOOSTER_KEYS].indexOf(a.key) - [...BOOSTER_KEYS].indexOf(b.key),
  );
  return { boosters, bonusStars, rewards, timers, others };
}

/* ----------------------------------------------------------------- chips -- */

/** Cycle of original reward-box art for the generic reward flags. */
const REWARD_BOXES: readonly string[] = [BTN.boxBlue, BTN.boxGreen, BTN.boxOrange, BTN.boxYellow];

/** Reward flag → original chest/box art (the emoji stays as the fallback). */
function rewardPic(key: string, index: number): { src: string; emoji: string } {
  const k = key.toLowerCase();
  if (k.includes("mystery")) return { src: BTN.purpleChest, emoji: "🎁" };
  if (k.includes("surprise")) return { src: BTN.surprise, emoji: "🎁" };
  if (k.includes("season")) return { src: BTN.seasonChest, emoji: "🎁" };
  if (k.includes("chest")) return { src: BTN.keyChest, emoji: "🧰" };
  return { src: REWARD_BOXES[index % REWARD_BOXES.length] ?? BTN.reward, emoji: "🎀" };
}

function RewardChip({ field, index }: { field: DiscoveredField; index: number }) {
  const { pending, setPending, clearPending } = useStudio();
  const staged = pending.get(field.path);
  const live = field.value === true;
  const checked = typeof staged === "boolean" ? staged : live;
  const isStaged = staged !== undefined && staged !== live;
  const pic = rewardPic(field.key, index);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <GameIcon src={pic.src} emoji={pic.emoji} size={18} className="shrink-0 rounded" />
        <ChipToggle
          emoji={field.key.startsWith("GivingChest") ? "🧰" : "🎀"}
          label={prettify(field.key.replace(/^Giving(Decor|Chest)/, "")) || "Default"}
          checked={checked}
          title={`${field.path} — ${checked ? "already granted" : "re-armable"}`}
          onChange={() => {
            const next = !checked;
            if (next === live) clearPending(field.path);
            else setPending(field.path, next);
          }}
        />
      </div>
      {isStaged ? (
        <span className="self-center">
          <StateBadge tone="gold">staged</StateBadge>
        </span>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- safe rows -- */

/**
 * Generic feature row with the mandatory edit-safety rules: numbers and
 * booleans stage as their own type, tag names / JSON blobs / nulls are
 * read-only, short plain strings get a text box.
 */
function SafeRow({ field }: { field: DiscoveredField }) {
  const { pending, setPending, clearPending } = useStudio();
  const staged = pending.get(field.path);
  const shown = staged !== undefined ? staged : field.value;
  const isStaged = staged !== undefined && staged !== field.value;

  const numeric = field.kind === "number" || field.kind === "tagged-i64" || field.kind === "tagged-f";
  const boolish = field.kind === "boolean";
  const readonly =
    field.kind === "null" ||
    field.path.endsWith(".t") ||
    (typeof field.value === "string" &&
      (field.value.trimStart().startsWith("{") ||
        field.value.trimStart().startsWith("[") ||
        field.value.includes("\r\n")));

  const stage = (v: number | string | boolean) => {
    if (v === field.value) clearPending(field.path);
    else setPending(field.path, v);
  };

  let controls: ReactNode;
  if (readonly) {
    controls = null;
  } else if (numeric) {
    controls = (
      <>
        <input
          key={`${field.path}-${String(field.value)}`}
          className="field field-qty"
          inputMode="numeric"
          defaultValue={String(shown ?? 0)}
          title={isStaged ? `${String(field.value)} → ${String(shown)} (staged)` : `now ${String(shown)}`}
          onBlur={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) stage(n);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        {isStaged ? <StateBadge tone="gold">staged</StateBadge> : null}
      </>
    );
  } else if (boolish) {
    controls = (
      <>
        <button
          className="preset-pill"
          onClick={() => stage(!(shown === true))}
          title={shown === true ? "currently true" : "currently false"}
        >
          {shown === true ? "✅ true" : "⚪ false"}
        </button>
        {isStaged ? <StateBadge tone="gold">staged</StateBadge> : null}
      </>
    );
  } else if (field.kind === "string") {
    const live = typeof field.value === "string" ? field.value : "";
    controls = (
      <>
        <input
          key={`${field.path}-${live}`}
          className="field w-40"
          defaultValue={typeof shown === "string" ? shown : ""}
          spellCheck={false}
          title={isStaged ? `${live} → ${String(shown)} (staged)` : `now ${live || "(empty)"}`}
          onBlur={(e) => stage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        {isStaged ? <StateBadge tone="gold">staged</StateBadge> : null}
      </>
    );
  } else {
    controls = null;
  }

  return <FeatureRow emoji={field.kind === "boolean" ? "🔘" : numeric ? "🔢" : "🔤"} name={prettify(field.key || "(root)")} controls={controls} />;
}

/* ---------------------------------------------------------------- helpers -- */

function prettify(key: string): string {
  return key
    .replace(/\[\d+\]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
