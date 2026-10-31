import { useEffect, useState } from "react";
import { useStudio } from "../lib/studio.tsx";
import { api } from "../lib/api.ts";
import { AmEmpty, useToast } from "../components/ui.tsx";
import { AmActions } from "./AmActions.tsx";

/**
 * Dashboard — the client's REAL profile numbers.
 *
 * This is the multi-client view: whatever save is loaded (a file, or a live
 * game pulled from a connected device instance) the cards read that client's
 * own data. The stat list mirrors the in-game Profile panel exactly:
 *
 *  - Core row:       Coins · Stars · Level · Current lives · Start date
 *  - Olympus Cup:    Total Cups · Highest Cups · Olympus Cup Wins
 *  - General Stats:  First Try Wins · Lives Sent · Lives Received ·
 *                    Max Streak · Titles Achieved · Collections completed
 *
 * All of them are proven save leaves under Properties.* and
 * SpecialEvents.UserProfileFeature.v.UserProfileStatistics.* (catalogue
 * groups `core`, `profile`, `statistics`). Removed per the real panel:
 * install date, time in game, last played, sessions, bonus stars, real
 * coins — the game's profile shows none of those.
 *
 * Real-client honesty: a fresh account (e.g. a just-created level-1 client)
 * does NOT contain every leaf yet — the game materialises this dictionary
 * lazily, so a stat a player has never earned simply has no key. Absent stats
 * therefore render EMPTY with "not in save" instead of pretending a value
 * exists, but they stay editable: staging one creates the leaf through
 * `save.create()`, i.e. exactly the way the game itself writes a newly earned
 * stat, and the value appears in-game after Push. "Titles Achieved" is a
 * computed display in the game (count of owned titles), so the card shows
 * that count read-only.
 *
 * Stars is the balance = u32(earnedStars) − spentStars (the save's R4 `V:`
 * mirror); typing a balance stages Properties.earnedStars. Every input is a
 * plain type-in field — no ± steppers. Save applies staged diffs honestly.
 */

const STAT_ROOT = "SpecialEvents.UserProfileFeature.v.UserProfileStatistics.v.";
const EARNED_PATH = "Properties.earnedStars";
const SPENT_PATH = "Properties.spentStars";

const I32_MIN = -2147483648;
const I32_MAX = 2147483647;
const U32_MAX = 4294967296;

type StatKind = "int" | "date" | "computed";

interface DashStat {
  key: string;
  label: string;
  /** Staged path — absent on the Stars balance and Titles Achieved cards. */
  path?: string;
  kind: StatKind;
  tile?: string;
  emoji?: string;
  min?: number;
  max?: number;
  hint?: string;
  warning?: string;
  variant?: "coin" | "star";
}

const STATS: readonly DashStat[] = [
  /* ---------------------------------------------------- client core row -- */
  {
    key: "coins",
    label: "Coins",
    path: "Properties.coins",
    kind: "int",
    tile: "assets/ui/coin-tile.png",
    min: 0,
    max: I32_MAX,
    hint: "Soft currency used to buy furniture and speed up orders.",
    warning: "Mirrored into Properties.CeReas_R1 as `C=` — Save refreshes it.",
    variant: "coin",
  },
  {
    key: "stars",
    label: "Stars",
    kind: "int",
    tile: "assets/ui/star-tile.png",
    min: 0,
    max: U32_MAX - 1,
    hint:
      "Balance = u32(earnedStars) − spentStars (the save's R4 `V:` mirror). " +
      "Typing a balance stages Properties.earnedStars; Save refreshes the mirror.",
    variant: "star",
  },
  {
    key: "level",
    label: "Level",
    path: "Properties.LID_Lvl",
    kind: "int",
    tile: "/gi/Gold_Medal.webp",
    min: 1,
    max: 100000,
    hint: "Player level — drives which rooms and orders unlock.",
    warning: "Level gates content server-side; far-above-progress levels can lock orders.",
  },
  {
    key: "lives",
    label: "Current lives",
    path: "Properties.lives.current",
    kind: "int",
    tile: "/gi/Unlimited_Lives.webp",
    min: 0,
    max: 9999,
    hint: "Stored as a flat `lives.current` key.",
  },
  {
    key: "start",
    label: "Start date",
    path: "Properties.firstPlayTime",
    kind: "date",
    emoji: "🗓️",
    min: 0,
    max: 4102444800,
    hint: "First-play timestamp (unix seconds), typed as dd/mm/yyyy — the date on the profile card.",
  },
  /* -------------------------------------------------------- Olympus Cup -- */
  {
    key: "cups-total",
    label: "Total Cups",
    path: `${STAT_ROOT}ChampionsContestTotalCups`,
    kind: "int",
    emoji: "🏆",
    min: 0,
    max: I32_MAX,
    hint: "Olympus Cup panel — Total Cups.",
  },
  {
    key: "cups-max",
    label: "Highest Cups",
    path: `${STAT_ROOT}ChampionsContestMaxCups`,
    kind: "int",
    emoji: "🏆",
    min: 0,
    max: I32_MAX,
    hint: "Olympus Cup panel — Highest Cups.",
  },
  {
    key: "cups-wins",
    label: "Olympus Cup Wins",
    path: `${STAT_ROOT}ChampionsContestWins`,
    kind: "int",
    emoji: "🥇",
    min: 0,
    max: I32_MAX,
    hint: "Olympus Cup panel — event wins.",
  },
  /* ------------------------------------------------------- General Stats -- */
  {
    key: "first-try",
    label: "First Try Wins",
    path: `${STAT_ROOT}FirstTryWins`,
    kind: "int",
    emoji: "🎯",
    min: 0,
    max: I32_MAX,
    hint: "Levels won on the first attempt.",
  },
  {
    key: "lives-sent",
    label: "Lives Sent",
    path: `${STAT_ROOT}LivesSent`,
    kind: "int",
    emoji: "❤️",
    min: 0,
    max: I32_MAX,
    hint: "Lives gifted to friends.",
  },
  {
    key: "lives-recv",
    label: "Lives Received",
    path: `${STAT_ROOT}LivesReceived`,
    kind: "int",
    emoji: "📨",
    min: 0,
    max: I32_MAX,
    hint: "Lives received from friends.",
  },
  {
    key: "max-streak",
    label: "Max Streak",
    path: `${STAT_ROOT}MaxWinStreak`,
    kind: "int",
    emoji: "🔥",
    min: 0,
    max: I32_MAX,
    hint: "Best win streak.",
  },
  {
    key: "titles",
    label: "Titles Achieved",
    kind: "computed",
    emoji: "🐦",
    hint: "Count of owned titles — the game computes this display, so it is shown read-only. Grant titles from the cosmetics lists.",
  },
  {
    key: "collections",
    label: "Collections completed",
    path: `${STAT_ROOT}CardsCollectionWins`,
    kind: "int",
    emoji: "🃏",
    min: 0,
    max: I32_MAX,
    hint: "Completed card collections.",
  },
];

const fmt = (n: number) =>
  Number.isInteger(n)
    ? n.toLocaleString("en-US")
    : n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Star balance exactly as integrity.ts computes R4's `V:`. */
function starBalance(earned: number, spent: number): number {
  const u = ((earned % U32_MAX) + U32_MAX) % U32_MAX;
  return u - spent;
}

/** `dd/mm/yyyy` (or raw unix seconds) → unix seconds; null when unparseable. */
function parseDate(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(t);
  if (m) {
    const ts = Math.floor(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])) / 1000);
    return Number.isFinite(ts) ? ts : null;
  }
  if (/^\d{9,12}$/.test(t)) return Number(t);
  return null;
}

/** unix seconds → `dd/mm/yyyy` (UTC, like the main tool's formatDat). */
function fmtDate(raw: number): string {
  if (!Number.isFinite(raw) || raw <= 1_000_000_000) return fmt(raw);
  const d = new Date(raw * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

export function DashboardSection() {
  const { overview } = useStudio();
  const [titlesOwned, setTitlesOwned] = useState<number | null>(null);

  useEffect(() => {
    if (!overview) {
      setTitlesOwned(null);
      return;
    }
    let cancelled = false;
    api
      .cosmeticsState()
      .then((s) => {
        if (!cancelled) setTitlesOwned(s.titles?.owned.length ?? 0);
      })
      .catch(() => {
        if (!cancelled) setTitlesOwned(null);
      });
    return () => {
      cancelled = true;
    };
  }, [overview]);

  if (!overview) {
    return (
      <section className="am-panel">
        <Head title="Game Statistics" />
        <AmEmpty
          title="No save loaded"
          detail="Press Connect in the title bar to read a client's live game over ADB, or press Open save to load a SaveGame.db from this computer. Everything on every tab is that account's real data."
        />
      </section>
    );
  }

  return (
    <section className="am-panel">
      <Head title="Game Statistics" />

      <div className="am-statgrid">
        {STATS.map((stat) => (
          <StatCard key={stat.key} stat={stat} computed={stat.kind === "computed" ? titlesOwned : undefined} />
        ))}
      </div>

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

function StatCard({ stat, computed }: { stat: DashStat; computed?: number | null }) {
  const { values, pending, setPending, clearPending } = useStudio();
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);

  const effNum = (path: string): number | undefined => {
    const p = pending.get(path);
    if (typeof p === "number") return p;
    const v = values[path];
    return typeof v === "number" ? v : undefined;
  };

  const isStars = stat.key === "stars";
  const isComputed = stat.kind === "computed";
  const path = stat.path;

  /* Effective raw value + staged flag (Stars derives from earned − spent). */
  let current: number | string | undefined;
  let staged = false;
  if (isStars) {
    const earned = effNum(EARNED_PATH) ?? 0;
    const spent = effNum(SPENT_PATH) ?? 0;
    current = starBalance(earned, spent);
    staged = pending.has(EARNED_PATH);
  } else if (isComputed) {
    current = computed ?? undefined;
  } else if (path !== undefined) {
    const p = pending.get(path);
    staged = p !== undefined;
    const v = p !== undefined ? p : values[path];
    current = typeof v === "number" || typeof v === "string" ? v : undefined;
  }

  /* A real client may not hold the leaf yet (fresh accounts render null). */
  const absent =
    !isStars &&
    !isComputed &&
    path !== undefined &&
    (values[path] === undefined || values[path] === null) &&
    !staged;

  const tip =
    (path ?? (isStars ? "Properties.earnedStars (balance)" : "owned titles")) +
    (stat.hint ? ` — ${stat.hint}` : "") +
    (stat.warning ? ` · ${stat.warning}` : "") +
    (absent
      ? " · not in this save yet — the value will be created on Save, the way the game writes a newly earned stat"
      : "");

  const idle = (): string => {
    if (current === undefined) return "";
    if (typeof current === "string") return current;
    if (stat.kind === "date") return fmtDate(current);
    return fmt(current);
  };

  const shown = draft ?? idle();

  /* ------------------------------------------------------------ staging -- */

  const stageNumber = (n: number) => {
    if (isStars) {
      const spent = effNum(SPENT_PATH) ?? 0;
      const t = Math.min(stat.max ?? U32_MAX, Math.max(stat.min ?? 0, Math.trunc(n)));
      const u = (((t + spent) % U32_MAX) + U32_MAX) % U32_MAX;
      const earnedNew = u >= 2147483648 ? u - U32_MAX : u;
      const liveEarned = values[EARNED_PATH];
      if (liveEarned === earnedNew) clearPending(EARNED_PATH);
      else setPending(EARNED_PATH, earnedNew);
      return;
    }
    if (path === undefined || isComputed) return;
    const lo = stat.min ?? I32_MIN;
    const hi = stat.max ?? I32_MAX;
    const next = Math.min(hi, Math.max(lo, Math.trunc(n)));
    const live = values[path];
    if (live === next) clearPending(path);
    else setPending(path, next);
  };

  const onInput = (raw: string) => {
    setDraft(raw);
    if (stat.kind !== "int") return; // date fields commit on blur
    const n = Number(raw.replace(/[,\s_]/g, ""));
    if (raw.trim() === "" || !Number.isFinite(n)) return;
    stageNumber(n);
  };

  const commit = () => {
    const raw = draft;
    setDraft(null);
    if (raw === null) return;
    const t = raw.trim();
    if (t === "") return;

    if (stat.kind === "date") {
      const n = parseDate(t);
      if (n === null) {
        toast.warn("Date not applied", `${stat.label}: use dd/mm/yyyy (or raw unix seconds).`);
        return;
      }
      if (path === undefined) return;
      const lo = stat.min ?? 0;
      const hi = stat.max ?? 4102444800;
      const next = Math.min(hi, Math.max(lo, n));
      const live = values[path];
      if (live === next) clearPending(path);
      else setPending(path, next);
      return;
    }
    // int fields already staged on input; invalid text simply reverts to idle.
  };

  /* -------------------------------------------------------------- render -- */

  /* An absent stat is NOT disabled: `runApply` creates the leaf inside the
     same object the game already writes, so an unearned stat can be filled in
     and will read back in-game after Push. Only the game's own computed
     displays stay read-only. */
  const disabled = isComputed;

  return (
    <div
      className={stat.variant ? `am-scard am-scard--${stat.variant}` : "am-scard"}
    >
      <div className="am-scard-head">
        {stat.tile !== undefined ? (
          <img className="am-scard-icon" src={stat.tile} alt="" />
        ) : (
          <span className="am-scard-emoji" aria-hidden>
            {stat.emoji}
          </span>
        )}
        <span className="am-scard-label" title={tip}>
          {stat.label}
        </span>
        {staged ? <span className="am-staged">Staged</span> : null}
      </div>
      <input
        className="am-scard-input"
        inputMode={stat.kind === "int" ? "numeric" : "text"}
        spellCheck={false}
        value={shown}
        disabled={disabled}
        readOnly={isComputed}
        placeholder={absent ? "not in save · type to set" : "—"}
        title={tip}
        aria-label={stat.label}
        onChange={(e) => onInput(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
    </div>
  );
}
