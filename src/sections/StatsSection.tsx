import { useState } from "react";
import { useStudio } from "../lib/studio.tsx";
import { AmEmpty } from "../components/ui.tsx";
import { AmActions } from "./AmActions.tsx";

/**
 * Stats — the eight booster stacks, each carrying the game's own artwork so a
 * row is recognised at a glance the way it is recognised in the client.
 * (The raw star counters used to sit here too. They moved out because the
 * Dashboard's Stars card already derives the balance the profile actually
 * displays — this pair was a second, competing way to be wrong.)
 *
 * Every booster is a `PlayerItems.*` leaf. The game materialises that object
 * lazily, so a save only carries the boosters the player actually holds: an
 * empty row is genuinely absent, and typing one creates the leaf exactly the
 * way the game writes it. Edits are staged locally until Save validates them.
 *
 * THE ICONS ARE MEASURED, NOT GUESSED. Each path was written to a distinct
 * value (40..47) on a live account and the slot that lit up with that number
 * was matched back to the art the client actually draws. The result is worth
 * recording because two rows defy the obvious reading of their label:
 *
 *   BombAndLineBoost            40 -> bomb-and-rocket  (level-select bar)
 *   LightningBoost              41 -> the rainbow ball (level-select bar)
 *   MultiplyFishBoost           42 -> paper planes     (level-select bar)
 *   HammerBonus                 43 -> hammer           (in-level bar)
 *   HorizontalLineBoosterBonus  44 -> BROOM            (in-level bar)
 *   VerticalLineBoosterBonus    45 -> KETTLEBELL       (in-level bar)
 *   SwapBoosterBonus            47 -> glove            (in-level bar)
 *   ReshuffleBoosterBonus       46 -> draws no slot in this level, so its row
 *                                     carries the remaining in-level art
 *
 * So "Horizontal Line" is drawn as a broom and "Vertical Line" as a kettlebell
 * — the paths are the ground truth and the labels are just what this tool
 * calls them. The `game-*` PNGs are cropped from the client's own frames; the
 * `pack-*` WebPs come from the supplied icon pack, which lines up with the
 * client one for one (its boosters/ folder is exactly the in-level bar).
 */

const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

interface StatField {
  path: string;
  label: string;
  /** Real Homescapes art — cropped from the client's own booster bar, or from
   *  the supplied icon pack. */
  icon?: string;
  hint?: string;
  warning?: string;
  min?: number;
  max?: number;
}

interface StatGroup {
  title: string;
  fields: StatField[];
}

const GROUPS: StatGroup[] = [
  {
    title: "Boosters",
    fields: [
      {
        path: "PlayerItems.BombAndLineBoost",
        label: "Bomb & Line",
        icon: "assets/boosters/game-bombline.png",
        min: 0,
        max: 99999,
      },
      {
        path: "PlayerItems.LightningBoost",
        label: "Lightning",
        icon: "assets/boosters/game-ball.png",
        min: 0,
        max: 99999,
      },
      {
        path: "PlayerItems.MultiplyFishBoost",
        label: "Fish x2",
        icon: "assets/boosters/game-plane.png",
        min: 0,
        max: 99999,
      },
      {
        path: "PlayerItems.HammerBonus",
        label: "Hammer",
        icon: "assets/boosters/pack-hammer.webp",
        min: 0,
        max: 99999,
      },
      {
        path: "PlayerItems.HorizontalLineBoosterBonus",
        label: "Horizontal Line",
        icon: "assets/boosters/pack-broom.webp",
        min: 0,
        max: 99999,
      },
      {
        path: "PlayerItems.VerticalLineBoosterBonus",
        label: "Vertical Line",
        icon: "assets/boosters/pack-kettlebell.webp",
        min: 0,
        max: 99999,
      },
      {
        path: "PlayerItems.ReshuffleBoosterBonus",
        label: "Reshuffle",
        icon: "assets/boosters/pack-fan.webp",
        min: 0,
        max: 99999,
      },
      {
        path: "PlayerItems.SwapBoosterBonus",
        label: "Swap",
        icon: "assets/boosters/pack-glove.webp",
        min: 0,
        max: 99999,
      },
    ],
  },
];

export function StatsSection() {
  const { overview } = useStudio();

  if (!overview) {
    return (
      <section className="am-panel">
        <Head title="Stats" />
        <AmEmpty
          title="No save loaded"
          detail="Press Connect in the title bar to read your client's live game."
        />
      </section>
    );
  }

  return (
    <section className="am-panel">
      <Head title="Stats" />

      {GROUPS.map((g) => (
        <div key={g.title}>
          <div className="am-label">{g.title}</div>
          <div className="am-fieldgrid">
            {g.fields.map((f) => (
              <FieldRow key={f.path} field={f} />
            ))}
          </div>
        </div>
      ))}

      <div className="am-panel-div" />
      <AmActions />
    </section>
  );
}

function Head({ title }: { title: string }) {
  return (
    <div className="am-panel-head">
      <img src="assets/ui/panel-bars.png" alt="" />
      <h2 className="am-panel-title">{title}</h2>
    </div>
  );
}

function FieldRow({ field }: { field: StatField }) {
  const { overview, values, pending, setPending } = useStudio();
  const staged = pending.get(field.path);
  const live = values[field.path];
  const current = staged !== undefined ? staged : live;
  const [draft, setDraft] = useState<string | null>(null);

  const shown =
    draft ?? (current === undefined || current === null ? "" : String(current));

  const onInput = (raw: string) => {
    setDraft(raw);
    const n = Number(raw.replace(/[,_\s]/g, ""));
    if (raw.trim() === "" || !Number.isFinite(n)) return;
    const lo = field.min ?? I32_MIN;
    const hi = field.max ?? I32_MAX;
    setPending(field.path, Math.min(hi, Math.max(lo, Math.trunc(n))));
  };

  const tip =
    `${field.path}` +
    `${field.hint ? ` — ${field.hint}` : ""}` +
    `${field.warning ? ` · ${field.warning}` : ""}`;

  return (
    <div className="am-field">
      <div
        className={field.icon ? "am-field-meta am-field-meta--icon" : "am-field-meta"}
      >
        {field.icon ? <img className="am-field-tile" src={field.icon} alt="" /> : null}
        <div className={field.icon ? "am-field-col" : undefined}>
          <div className="am-field-label" title={tip}>
            {field.label}
          </div>
          <div className="am-field-value">
            <input
              className="am-field-input"
              inputMode="numeric"
              spellCheck={false}
              value={shown}
              disabled={!overview}
              title={tip}
              aria-label={field.label}
              onChange={(e) => onInput(e.target.value)}
              onBlur={() => setDraft(null)}
            />
            {staged !== undefined ? <span className="am-staged">Staged</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
