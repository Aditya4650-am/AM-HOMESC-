import { useMemo, useState } from "react";
import { AmActions } from "./AmActions.tsx";
import { AmCheck, AmEmpty, useToast } from "../components/ui.tsx";
import { useStudio } from "../lib/studio.tsx";

/**
 * Fresh Start — the "level 1 new account" tab.
 *
 * Mirrors the igg main tool's "novo" restore: put the *save* back to the
 * numbers a brand-new account carries (level 1, a few coins, full lives).
 * It is a real local file edit, staged like every other field and written
 * only when the operator presses Save / Push — and Push writes a `.hcsbak`
 * backup of the current save first, so a fresh start is reversible.
 *
 * Honest scope, stated in the panel:
 *  - The Playrix *account* identity (the save id the server binds to the
 *    device) is NOT changed here. This resets save progression, exactly the
 *    part a save editor owns. Creating a genuinely new server account is a
 *    device/identity operation, not a save edit.
 *  - The level key on 9.2.101 saves is `Properties.LID_Lvl` and it IS the HUD
 *    level (verified in game on this device: stored 1 renders "1"). Older
 *    community saves used `Properties.level`, which stored HUD level minus one.
 */
const LEVEL_PATH = "Properties.LID_Lvl";
const LEGACY_LEVEL_PATH = "Properties.level";
const COINS_PATH = "Properties.coins";
const STARS_PATH = "Properties.earnedStars";
const SPENT_STARS_PATH = "Properties.spentStars";
const LIVES_PATH = "Properties.lives.current";

/** The in-game Profile panel's counters, all under the statistics dictionary. */
const STAT_ROOT = "SpecialEvents.UserProfileFeature.v.UserProfileStatistics.v.";
const STAT_KEYS = [
  "ChampionsContestTotalCups",
  "ChampionsContestMaxCups",
  "ChampionsContestWins",
  "FirstTryWins",
  "LivesSent",
  "LivesReceived",
  "MaxWinStreak",
  "CardsCollectionWins",
  "ExpeditionsCompleted",
  "QuestsCompleted",
] as const;

interface FreshField {
  path: string;
  label: string;
  hint: string;
  value: number;
}

const DEFAULTS = {
  level: 1,
  coins: 1000,
  stars: 0,
  lives: 5,
};

function Head({ title }: { title: string }) {
  return (
    <div className="am-panel-head">
      <img src="assets/ui/panel-bars.png" alt="" />
      <h2 className="am-panel-title">{title}</h2>
    </div>
  );
}

function displayValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return v.toLocaleString("en-US");
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

export function FreshStartSection() {
  const { overview, values, pending, setPending, clearPending, pushLog } = useStudio();
  const toast = useToast();

  const [level, setLevel] = useState(String(DEFAULTS.level));
  const [coins, setCoins] = useState(String(DEFAULTS.coins));
  const [stars, setStars] = useState(String(DEFAULTS.stars));
  const [lives, setLives] = useState(String(DEFAULTS.lives));
  const [alsoSpent, setAlsoSpent] = useState(true);
  const [alsoStats, setAlsoStats] = useState(true);

  const staged = useMemo(
    () =>
      [
        LEVEL_PATH,
        LEGACY_LEVEL_PATH,
        COINS_PATH,
        STARS_PATH,
        SPENT_STARS_PATH,
        LIVES_PATH,
        ...STAT_KEYS.map((k) => `${STAT_ROOT}${k}`),
      ].filter((p) => pending.has(p)),
    [pending],
  );

  const stageFresh = () => {
    const lv = Math.max(0, Math.floor(Number(level) || 0));
    const cn = Math.max(0, Math.floor(Number(coins) || 0));
    const st = Math.max(0, Math.floor(Number(stars) || 0));
    const lf = Math.max(0, Math.floor(Number(lives) || 0));

    const ops: FreshField[] = [
      { path: LEVEL_PATH, label: "Level", hint: "HUD level", value: lv },
      { path: COINS_PATH, label: "Coins", hint: "fresh balance", value: cn },
      { path: STARS_PATH, label: "Earned stars", hint: "lifetime", value: st },
      { path: LIVES_PATH, label: "Lives", hint: "current", value: lf },
    ];
    // Older saves mirror the HUD level as `Properties.level = LID_Lvl - 1`.
    // Keep both copies in step when the save actually carries the legacy key.
    if (values[LEGACY_LEVEL_PATH] !== undefined) {
      ops.push({
        path: LEGACY_LEVEL_PATH,
        label: "Legacy level",
        hint: "LID_Lvl − 1",
        value: Math.max(0, lv - 1),
      });
    }
    if (alsoSpent) {
      ops.push({ path: SPENT_STARS_PATH, label: "Spent stars", hint: "reset", value: 0 });
    }
    if (alsoStats) {
      for (const key of STAT_KEYS) {
        ops.push({ path: `${STAT_ROOT}${key}`, label: key, hint: "profile counter", value: 0 });
      }
    }

    let n = 0;
    const created: string[] = [];
    for (const op of ops) {
      if (values[op.path] === undefined && !pending.has(op.path)) {
        // A fresh account has not written every counter yet. Save creates the
        // missing key (or the whole dictionary wrapper) exactly the way the
        // game itself writes a newly earned stat.
        created.push(op.label);
      }
      setPending(op.path, op.value);
      n++;
    }
    const note = created.length > 0 ? ` (${created.length} new key${created.length === 1 ? "" : "s"} will be created)` : "";
    pushLog(
      "info",
      "Fresh-start values staged",
      `${n} field${n === 1 ? "" : "s"} — shown level ${lv}${note} — press Save to write`,
    );
    toast.ok(
      "Fresh start staged",
      `Level ${lv}, ${cn.toLocaleString("en-US")} coins, ${lf} lives. Press Save, then Push.`,
    );
  };

  const clearStaged = () => {
    const n = staged.length;
    for (const p of staged) clearPending(p);
    pushLog("info", "Clear staged fresh-start edits", `${n} field${n === 1 ? "" : "s"} cleared`);
  };

  const live = (p: string): unknown => (pending.has(p) ? pending.get(p) : values[p]);

  if (!overview) {
    return (
      <section className="am-panel">
        <Head title="Fresh Start" />
        <AmEmpty
          title="No save loaded"
          detail="Press Connect in the title bar to read your client's live game."
        />
      </section>
    );
  }

  const rows: FreshField[] = [
    { path: LEVEL_PATH, label: "Level (HUD)", hint: "shown level", value: DEFAULTS.level },
    { path: COINS_PATH, label: "Coins", hint: "balance", value: DEFAULTS.coins },
    { path: STARS_PATH, label: "Earned stars", hint: "lifetime", value: DEFAULTS.stars },
    { path: SPENT_STARS_PATH, label: "Spent stars", hint: "reset when enabled", value: 0 },
    { path: LIVES_PATH, label: "Lives", hint: "current", value: DEFAULTS.lives },
  ];

  return (
    <section className="am-panel">
      <Head title="Fresh Start" />

      <div className="am-hint" style={{ margin: "8px 0 14px", lineHeight: 1.5 }}>
        Put this save back to the numbers a brand-new account carries. The file is written only
        when you press <b>Save</b>, and <b>Push</b> keeps a <code>.hcsbak</code> backup of the
        current save first — so a fresh start is reversible until you have played past it.
      </div>

      <div className="am-label">Target values</div>
      <div className="am-row" style={{ flexWrap: "wrap", gap: 8 }}>
        <span className="am-hint">Level</span>
        <input
          className="am-input"
          style={{ width: 72 }}
          inputMode="numeric"
          value={level}
          aria-label="Fresh display level"
          onChange={(e) => setLevel(e.target.value)}
        />
        <span className="am-hint">Coins</span>
        <input
          className="am-input"
          style={{ width: 110 }}
          inputMode="numeric"
          value={coins}
          aria-label="Fresh coins"
          onChange={(e) => setCoins(e.target.value)}
        />
        <span className="am-hint">Stars</span>
        <input
          className="am-input"
          style={{ width: 72 }}
          inputMode="numeric"
          value={stars}
          aria-label="Fresh earned stars"
          onChange={(e) => setStars(e.target.value)}
        />
        <span className="am-hint">Lives</span>
        <input
          className="am-input"
          style={{ width: 72 }}
          inputMode="numeric"
          value={lives}
          aria-label="Fresh lives"
          onChange={(e) => setLives(e.target.value)}
        />
      </div>
      <div className="am-hint" style={{ margin: "0 0 6px" }}>
        Level is the number you want the HUD to show. On 9.2.x saves the game stores exactly
        that number in <code>Properties.LID_Lvl</code> (stored 1 renders “1”); older saves kept
        a second <code>Properties.level</code> copy holding HUD level − 1, and this stages both
        when that key exists.
      </div>

      <div className="am-checkrow" style={{ padding: "9px 0" }}>
        <AmCheck
          on={alsoSpent}
          onChange={setAlsoSpent}
          label="Also reset spent stars to 0"
          title="Stage Properties.spentStars = 0"
        />
      </div>
      <div className="am-checkrow" style={{ padding: "0 0 9px" }}>
        <AmCheck
          on={alsoStats}
          onChange={setAlsoStats}
          label="Also reset the Profile statistics to 0"
          title="Stage every UserProfileStatistics counter (Cups, wins, lives sent/received, streaks, collections, quests) to 0"
        />
      </div>

      <div className="am-row" style={{ margin: "6px 0 14px" }}>
        <button
          type="button"
          className="am-ghost am-ghost--primary"
          onClick={stageFresh}
          title="Stage every fresh-start field; nothing is written until Save"
        >
          Stage fresh-start values
        </button>
        {staged.length > 0 ? (
          <button type="button" className="am-ghost" onClick={clearStaged}>
            Revert staged ({staged.length})
          </button>
        ) : null}
      </div>

      <div className="am-label">Current in this save</div>
      <div className="am-fieldgrid">
        {rows.map((r) => (
          <div className="am-field" key={r.path}>
            <div className="am-field-meta">
              <div className="am-field-label" title={r.path}>
                {r.label}
              </div>
              <div className="am-field-value">
                <span className="am-hint">{displayValue(live(r.path))}</span>
                {pending.has(r.path) ? <span className="am-staged">staged</span> : null}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="am-hint" style={{ margin: "14px 0 4px", lineHeight: 1.5 }}>
        <b>What this does not do:</b> it does not create a new Playrix account. The save id the
        game server binds to this device is unchanged — this is the save-side half of a fresh
        start (the same half the igg tool's "novo" restore owns), not a new identity.
      </div>

      <AmActions />
    </section>
  );
}
