import type { CatalogField } from "../lib/api.ts";
import { useStudio } from "../lib/studio.tsx";
import { BTN, GI } from "../lib/icons.ts";
import {
  EmptyState,
  FeatureRow,
  GameIcon,
  KpiTile,
  Panel,
  PresetRow,
  StateBadge,
  StatCard,
} from "../components/ui.tsx";

/**
 * Curated catalogue groups rendered as premium feature panels:
 *
 *  - Data       → KPI tiles + tonal stat cards with one-click preset values
 *  - Boosters   → feature rows per power-up: presets (10/50/100/500) + qty box
 *                 + bulk "fill all" actions
 *  - Lives      → refill card with instant presets
 *
 * Every action stages into the shared pending map — the save is only written
 * when the user applies (Save & Push).
 */
export function CoreSection({ groupId }: { groupId: string }) {
  const { overview } = useStudio();

  const group = overview?.catalog.find((g) => g.id === groupId);
  if (!group) {
    return (
      <EmptyState
        title="Group not present"
        detail="This save does not expose the fields that belong in this section."
      />
    );
  }

  if (groupId === "boosters") return <BoosterPanel group={group} />;
  if (groupId === "lives") return <LivesPanel group={group} />;
  return <DataPanel group={group} />;
}

/* ------------------------------------------------------------------ data -- */

function DataPanel({ group }: { group: { fields: CatalogField[] } }) {
  const { values, pending, setPending } = useStudio();

  const num = (path: string): number | null => {
    const v = pending.get(path) ?? values[path];
    return typeof v === "number" ? v : null;
  };
  const live = (path: string): number | null => {
    const v = values[path];
    return typeof v === "number" ? v : null;
  };
  const field = (path: string) => group.fields.find((f) => f.path === path);

  const coinsF = field("Properties.coins");
  const levelF = field("Properties.LID_Lvl");
  const earnedF = field("Properties.earnedStars");
  const spentF = field("Properties.spentStars");

  const add = (path: string, delta: number) => {
    const cur = num(path) ?? 0;
    setPending(path, Math.max(0, cur + delta));
  };

  return (
    <div className="flex flex-col gap-4">
      {/* KPI strip */}
      <div className="stagger-in grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          emoji="🏆"
          icon={GI.level}
          label="Level"
          value={num("Properties.LID_Lvl")?.toLocaleString("en-US") ?? "—"}
        />
        <KpiTile
          emoji="🪙"
          icon={GI.coins}
          label="Coins"
          value={num("Properties.coins")?.toLocaleString("en-US") ?? "—"}
        />
        <KpiTile
          emoji="⭐"
          icon={GI.stars}
          label="Earned stars"
          value={num("Properties.earnedStars")?.toLocaleString("en-US") ?? "—"}
        />
        <KpiTile
          emoji="💫"
          icon={GI.stars}
          label="Spent stars"
          value={num("Properties.spentStars")?.toLocaleString("en-US") ?? "—"}
        />
      </div>

      {/* Tonal stat cards with one-click presets */}
      <div className="stagger-in grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {coinsF ? (
          <StatCard
            tone={1}
            emoji="🪙"
            icon={GI.coins}
            label={coinsF.label}
            live={live(coinsF.path)}
            staged={pending.get(coinsF.path) as number | undefined}
            min={coinsF.min}
            max={coinsF.max}
            presets={[
              { label: "10K", value: 10_000 },
              { label: "100K", value: 100_000 },
              { label: "1M", value: 1_000_000 },
              { label: "10M", value: 10_000_000 },
              { label: "MAX", value: 2_000_000_000, title: "2,000,000,000 — edge of i32" },
            ]}
            onCommit={(n) => setPending(coinsF.path, n)}
          />
        ) : null}
        {levelF ? (
          <StatCard
            tone={2}
            emoji="🏆"
            icon={GI.level}
            label={levelF.label}
            live={live(levelF.path)}
            staged={pending.get(levelF.path) as number | undefined}
            min={levelF.min}
            max={levelF.max}
            presets={[
              { label: "+10", value: (num(levelF.path) ?? 0) + 10 },
              { label: "+50", value: (num(levelF.path) ?? 0) + 50 },
              { label: "+100", value: (num(levelF.path) ?? 0) + 100 },
              { label: "+500", value: (num(levelF.path) ?? 0) + 500 },
            ]}
            onCommit={(n) => setPending(levelF.path, n)}
          />
        ) : null}
        {earnedF ? (
          <StatCard
            tone={3}
            emoji="⭐"
            icon={GI.stars}
            label={earnedF.label}
            live={live(earnedF.path)}
            staged={pending.get(earnedF.path) as number | undefined}
            min={earnedF.min}
            max={earnedF.max}
            presets={[
              { label: "+100", value: (num(earnedF.path) ?? 0) + 100 },
              { label: "+1K", value: (num(earnedF.path) ?? 0) + 1_000 },
              { label: "+10K", value: (num(earnedF.path) ?? 0) + 10_000 },
            ]}
            onCommit={(n) => setPending(earnedF.path, n)}
          />
        ) : null}
        {spentF ? (
          <StatCard
            tone={4}
            emoji="💫"
            icon={GI.stars}
            label={spentF.label}
            live={live(spentF.path)}
            staged={pending.get(spentF.path) as number | undefined}
            min={spentF.min}
            max={spentF.max}
            presets={[
              { label: "+10", value: (num(spentF.path) ?? 0) + 10 },
              { label: "+100", value: (num(spentF.path) ?? 0) + 100 },
              { label: "+1K", value: (num(spentF.path) ?? 0) + 1_000 },
            ]}
            onCommit={(n) => setPending(spentF.path, n)}
          />
        ) : null}
      </div>

      {/* Other curated fields in this group (text / unsupported controls) */}
      {group.fields.filter((f) => !["Properties.coins", "Properties.LID_Lvl", "Properties.earnedStars", "Properties.spentStars"].includes(f.path))
        .length > 0 ? (
        <Panel title="More fields" description="Additional fields in this save.">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {group.fields
              .filter(
                (f) =>
                  ![
                    "Properties.coins",
                    "Properties.LID_Lvl",
                    "Properties.earnedStars",
                    "Properties.spentStars",
                  ].includes(f.path),
              )
              .map((f) => (
                <GenericField key={f.path} field={f} />
              ))}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function GenericField({ field }: { field: CatalogField }) {
  const { values, pending, setPending } = useStudio();
  const live = values[field.path];
  const staged = pending.get(field.path);
  const isStaged = staged !== undefined && String(staged) !== String(live ?? "");

  return (
    <div className="stat-card" data-tone="5">
      <div className="stat-title">
        <span className="stat-emoji" aria-hidden>
          {field.control === "text" ? "🔤" : "🔢"}
        </span>
        <span className="truncate">{field.label}</span>
        {isStaged ? (
          <span className="ml-auto">
            <StateBadge tone="gold">staged</StateBadge>
          </span>
        ) : null}
      </div>
      <input
        className="stat-value"
        defaultValue={staged !== undefined ? String(staged) : live != null ? String(live) : ""}
        key={`${field.path}-${String(live)}`}
        onBlur={(e) => {
          const s = e.target.value;
          if (field.control === "int") {
            const n = Number(s);
            if (Number.isFinite(n) && n !== live) setPending(field.path, n);
          } else if (s !== live) {
            setPending(field.path, s);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      {field.hint ? <div className="text-[11px] leading-snug text-ink-3">{field.hint}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------- boosters -- */

const BOOSTER_EMOJI: Record<string, string> = {
  "PlayerItems.BombAndLineBoost": "💣",
  "PlayerItems.LightningBoost": "⚡",
  "PlayerItems.MultiplyFishBoost": "🐟",
  "PlayerItems.HammerBonus": "🔨",
  "PlayerItems.HorizontalLineBoosterBonus": "↔️",
  "PlayerItems.VerticalLineBoosterBonus": "↕️",
  "PlayerItems.ReshuffleBoosterBonus": "🔀",
  "PlayerItems.SwapBoosterBonus": "🔁",
};

const BOOSTER_ICON: Record<string, string> = {
  "PlayerItems.BombAndLineBoost": GI.rocketBomb,
  "PlayerItems.HammerBonus": GI.hammer,
  "PlayerItems.ReshuffleBoosterBonus": GI.fan,
  "PlayerItems.SwapBoosterBonus": GI.glove,
};

function BoosterPanel({ group }: { group: { fields: CatalogField[] } }) {
  const { values, pending, setPending } = useStudio();

  const shown = (path: string): number => {
    const v = pending.get(path) ?? values[path];
    return typeof v === "number" ? v : 0;
  };
  const live = (path: string): number | null =>
    typeof values[path] === "number" ? (values[path] as number) : null;

  const fillAll = (n: number) => {
    for (const f of group.fields) setPending(f.path, n);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-sm text-ink-2">Pre-level power-ups — tap a preset, then Save &amp; Push.</p>
        <button className="preset-pill inline-flex items-center gap-1.5" onClick={() => fillAll(100)}>
          <GameIcon src={BTN.perk} emoji="⚡" size={15} />
          Set all ×100
        </button>
        <button className="preset-pill inline-flex items-center gap-1.5" onClick={() => fillAll(500)}>
          <GameIcon src={BTN.perk} emoji="⚡" size={15} />
          Set all ×500
        </button>
        <button className="preset-pill" onClick={() => fillAll(0)}>
          Clear all
        </button>
      </div>

      <div className="stagger-in grid gap-2.5 lg:grid-cols-2">
        {group.fields.map((f) => (
          <FeatureRow
            key={f.path}
            emoji={BOOSTER_EMOJI[f.path] ?? "🎁"}
            icon={BOOSTER_ICON[f.path]}
            name={f.label}
            controls={
              <QtyControl
                value={shown(f.path)}
                live={live(f.path)}
                min={f.min}
                max={f.max}
                presets={[
                  { label: "10", value: 10 },
                  { label: "50", value: 50 },
                  { label: "100", value: 100 },
                  { label: "500", value: 500 },
                ]}
                onPick={(v) => setPending(f.path, v)}
                onCommit={(n) => setPending(f.path, n)}
              />
            }
          />
        ))}
      </div>
    </div>
  );
}

/** Preset pills + right-aligned quantity box inside a feature row. */
function QtyControl({
  value,
  live,
  min,
  max,
  presets,
  onPick,
  onCommit,
}: {
  value: number;
  live: number | null;
  min?: number;
  max?: number;
  presets: Array<{ label: string; value: number }>;
  onPick: (n: number) => void;
  onCommit: (n: number) => void;
}) {
  const isStaged = live !== null && value !== live;
  return (
    <>
      <PresetRow
        options={presets}
        active={isStaged ? value : live}
        onPick={(v) => {
          if (v !== "max") onPick(Number(v));
        }}
      />
      <input
        key={`${value}-${String(live)}`}
        className="field field-qty"
        inputMode="numeric"
        defaultValue={String(value)}
        title={isStaged ? `${live} → ${value} (staged)` : `now ${value}`}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          if (min !== undefined && n < min) return;
          if (max !== undefined && n > max) return;
          if (n !== value) onCommit(n);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      {isStaged ? <StateBadge tone="gold">staged</StateBadge> : null}
    </>
  );
}

/* ----------------------------------------------------------------- lives -- */

function LivesPanel({ group }: { group: { fields: CatalogField[] } }) {
  const { values, pending, setPending } = useStudio();
  const f = group.fields.find((x) => x.path === "Properties.lives.current") ?? group.fields[0];

  const live = f && typeof values[f.path] === "number" ? (values[f.path] as number) : null;
  const staged = f ? (pending.get(f.path) as number | undefined) : undefined;
  const shown = staged !== undefined ? staged : live;

  if (!f) return <EmptyState title="No life fields in this save" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="stagger-in grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          tone={6}
          emoji="💗"
          icon={GI.lives}
          label={f.label}
          live={live}
          staged={staged}
          min={f.min}
          max={f.max}
          presets={[
            { label: "×1", value: 1 },
            { label: "×3", value: 3 },
            { label: "×5", value: 5 },
            { label: "×10", value: 10 },
            { label: "MAX", value: f.max ?? 9999 },
          ]}
          onCommit={(n) => setPending(f.path, n)}
        />
        <div className="stat-card" data-tone="7">
          <div className="stat-title">
            <span className="stat-emoji" aria-hidden>
              ⚡
            </span>
            <span className="truncate">Instant refill</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              className="preset-pill inline-flex items-center gap-1.5"
              onClick={() => setPending(f.path, 5)}
              title="Set current lives to the standard full bar"
            >
              <GameIcon src={BTN.lives} emoji="💖" size={15} />
              Full (5)
            </button>
            <button
              className="preset-pill"
              onClick={() => setPending(f.path, (shown ?? 0) + 1)}
            >
              +1
            </button>
            <button
              className="preset-pill"
              onClick={() => setPending(f.path, Math.min((f.max ?? 9999), (shown ?? 0) + 5))}
            >
              +5
            </button>
            <button className="preset-pill" onClick={() => setPending(f.path, f.max ?? 9999)}>
              🚀 Max
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}