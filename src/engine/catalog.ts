/**
 * Curated field catalogue for the "Core" editor scope.
 *
 * Only paths that have been PROVEN against a real save are hard-coded here.
 * Everything else (avatars, event currencies, rooms, quests) is discovered
 * from the save itself via prefix scans, so a new game version cannot silently
 * point the editor at the wrong bytes.
 */

import type { SaveGame } from "./savegame.ts";

export type Control = "int" | "text" | "bool";

export interface CatalogField {
  path: string;
  label: string;
  /** Short in-card explanation of what the player-visible effect is. */
  hint?: string;
  control: Control;
  min?: number;
  max?: number;
  /** Fields the game derives elsewhere get an extra warning in the UI. */
  warning?: string;
}

export interface CatalogGroup {
  id: string;
  label: string;
  description: string;
  fields: CatalogField[];
}

/** int32 bounds — the client stores these as signed 32-bit and wraps. */
const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

export const CATALOG: readonly CatalogGroup[] = [
  {
    id: "core",
    label: "Data Center",
    description: "Account-level counters: currency, progression and star balance.",
    fields: [
      {
        path: "Properties.coins",
        label: "Coins",
        hint: "Soft currency used to buy furniture and speed up orders.",
        control: "int",
        min: 0,
        max: I32_MAX,
        warning: "Mirrored into Properties.CeReas_R1 as `C=`.",
      },
      {
        path: "Properties.LID_Lvl",
        label: "Level",
        hint:
          "Match-3 (minigame) level stored in the local save. The profile " +
          "level the client displays and the leaderboard report is tracked " +
          "server-side by Playrix, so a save edit alone does not change it " +
          "(verified live: LID_Lvl=32 kept after the game re-saved while the " +
          "client and leaderboard still reported level 1).",
        control: "int",
        min: 1,
        max: 100000,
        warning:
          "Server-authoritative for display: expect the game to keep showing " +
          "its server-computed level after this write. Large jumps also make " +
          "later orders impossible to complete.",
      },
      {
        path: "Properties.earnedStars",
        label: "Earned stars (lifetime)",
        hint: "Total stars ever earned on orders.",
        control: "int",
        min: I32_MIN,
        max: I32_MAX,
        warning:
          "Stored as a signed 32-bit value that WRAPS (this save already holds " +
          "-2147482755). Mirrored into Properties.CeReas_R4 as `V:`.",
      },
      {
        path: "Properties.spentStars",
        label: "Spent stars",
        hint: "Stars already spent on room upgrades.",
        control: "int",
        min: 0,
        max: I32_MAX,
        warning: "Mirrored into Properties.CeReas_R4 as `V:`.",
      },
    ],
  },
  {
    id: "lives",
    label: "Lives",
    description: "Attempts remaining when you fail a level.",
    fields: [
      {
        path: "Properties.lives.current",
        label: "Current lives",
        hint: "Stored as a flat `lives.current` key, not a nested object.",
        control: "int",
        min: 0,
        max: 9999,
      },
    ],
  },
  {
    id: "boosters",
    label: "Boosters",
    description: "Pre-level power-ups carried in your inventory.",
    fields: [
      { path: "PlayerItems.BombAndLineBoost", label: "Bomb & Line", control: "int", min: 0, max: 99999 },
      { path: "PlayerItems.LightningBoost", label: "Lightning", control: "int", min: 0, max: 99999 },
      { path: "PlayerItems.MultiplyFishBoost", label: "Fish x2", control: "int", min: 0, max: 99999 },
      { path: "PlayerItems.HammerBonus", label: "Hammer", control: "int", min: 0, max: 99999 },
      { path: "PlayerItems.HorizontalLineBoosterBonus", label: "Horizontal Line", control: "int", min: 0, max: 99999 },
      { path: "PlayerItems.VerticalLineBoosterBonus", label: "Vertical Line", control: "int", min: 0, max: 99999 },
      { path: "PlayerItems.ReshuffleBoosterBonus", label: "Reshuffle", control: "int", min: 0, max: 99999 },
      { path: "PlayerItems.SwapBoosterBonus", label: "Swap", control: "int", min: 0, max: 99999 },
    ],
  },
  {
    id: "profile",
    label: "Profile data",
    description: "Profile dates proven present in the real save.",
    fields: [
      {
        path: "Properties.name",
        label: "Player name",
        hint: "The client's in-game name — identifies whose game is loaded.",
        control: "text",
      },
      {
        path: "Properties.avatarId",
        label: "Avatar id",
        hint: "Equipped avatar picture id (also staged by the Avatars tab).",
        control: "text",
      },
      {
        path: "Properties.firstPlayTime",
        label: "Start date",
        hint: "First-play timestamp in unix seconds — the date shown on the in-game profile card.",
        control: "int",
        min: 0,
        max: 4102444800,
        warning: "Path proven in a real save; the game's acceptance of an edited value is not yet verified.",
      },
    ],
  },
  {
    id: "statistics",
    label: "Profile statistics",
    description:
      "The in-game Profile panel's own numbers (Olympus Cup + General Stats), read from the game's UserProfileStatistics storage.",
    fields: [
      {
        path: "SpecialEvents.UserProfileFeature.v.UserProfileStatistics.v.ChampionsContestTotalCups",
        label: "Total Cups",
        hint: "Olympus Cup panel — Total Cups.",
        control: "int",
        min: 0,
        max: 2147483647,
      },
      {
        path: "SpecialEvents.UserProfileFeature.v.UserProfileStatistics.v.ChampionsContestMaxCups",
        label: "Highest Cups",
        hint: "Olympus Cup panel — Highest Cups.",
        control: "int",
        min: 0,
        max: 2147483647,
      },
      {
        path: "SpecialEvents.UserProfileFeature.v.UserProfileStatistics.v.ChampionsContestWins",
        label: "Olympus Cup Wins",
        hint: "Olympus Cup panel — event wins.",
        control: "int",
        min: 0,
        max: 2147483647,
      },
      {
        path: "SpecialEvents.UserProfileFeature.v.UserProfileStatistics.v.FirstTryWins",
        label: "First Try Wins",
        hint: "General Stats — levels won on the first attempt.",
        control: "int",
        min: 0,
        max: 2147483647,
      },
      {
        path: "SpecialEvents.UserProfileFeature.v.UserProfileStatistics.v.LivesSent",
        label: "Lives Sent",
        hint: "General Stats — lives gifted to friends.",
        control: "int",
        min: 0,
        max: 2147483647,
      },
      {
        path: "SpecialEvents.UserProfileFeature.v.UserProfileStatistics.v.LivesReceived",
        label: "Lives Received",
        hint: "General Stats — lives received from friends.",
        control: "int",
        min: 0,
        max: 2147483647,
      },
      {
        path: "SpecialEvents.UserProfileFeature.v.UserProfileStatistics.v.MaxWinStreak",
        label: "Max Streak",
        hint: "General Stats — best win streak.",
        control: "int",
        min: 0,
        max: 2147483647,
      },
      {
        path: "SpecialEvents.UserProfileFeature.v.UserProfileStatistics.v.CardsCollectionWins",
        label: "Collections completed",
        hint: "General Stats — completed card collections.",
        control: "int",
        min: 0,
        max: 2147483647,
      },
      {
        path: "SpecialEvents.UserProfileFeature.v.UserProfileStatistics.v.ExpeditionsCompleted",
        label: "Expeditions completed",
        hint: "Expedition events finished.",
        control: "int",
        min: 0,
        max: 2147483647,
      },
      {
        path: "SpecialEvents.UserProfileFeature.v.UserProfileStatistics.v.QuestsCompleted",
        label: "Quests completed",
        hint: "Side-quests finished.",
        control: "int",
        min: 0,
        max: 2147483647,
      },
    ],
  },
];

/**
 * Prefix-discovered sections. The UI renders these as browsable tables of
 * leaf fields, so no per-entry names are hard-coded.
 *
 * `prefix` accepts several alternatives separated by `|` — a feature whose
 * state lives under more than one root (e.g. collections) matches any of them.
 */
export interface PrefixSection {
  id: string;
  label: string;
  description: string;
  prefix: string;
  /** Hide fields whose value is 0/false to keep long lists readable. */
  hideZero?: boolean;
}

export const PREFIX_SECTIONS: readonly PrefixSection[] = [
  {
    id: "avatars",
    label: "Avatars",
    description: "Profile pictures and their unlock state.",
    prefix: "Avatars.",
    hideZero: true,
  },
  {
    id: "currencies",
    label: "Event currencies",
    description: "Limited-time tokens collected during live events (amount + previous amount).",
    prefix: "Currency.",
    hideZero: true,
  },
  {
    id: "rooms",
    label: "Rooms & design",
    description: "Per-room design state: availability, completed actions and selected decor.",
    prefix: "RoomDesign.",
  },
  {
    id: "quests",
    label: "Quests",
    description: "Side-quest and main-story task state.",
    prefix: "Quests.",
  },
  {
    id: "costumes",
    label: "Costumes",
    description: "Austin's wardrobe — owned and equipped outfit pieces.",
    prefix: "Garment.",
    hideZero: true,
  },
  {
    id: "collections",
    label: "Collections",
    description: "Characters, photo albums and trophies gathered across the story.",
    prefix: "Characters.|PhotoAlbums.|GameTrophy.",
    hideZero: true,
  },
  {
    id: "events",
    label: "Live events",
    description:
      "State of every special event on this save — progress, rewards and event logic.",
    prefix: "SpecialEvents.",
    hideZero: true,
  },
  {
    id: "match3",
    label: "Match-3",
    description: "Core puzzle state: booster inventory, extra moves and level-day wins.",
    prefix: "Match3.|Match3DailyWins.",
    hideZero: true,
  },
  {
    id: "items",
    label: "Player items",
    description:
      "Every consumable the profile holds: booster counts, bonus stars, chests and granted decor.",
    prefix: "PlayerItems.",
    hideZero: true,
  },
  {
    id: "explorer",
    label: "Field explorer",
    description: "Raw browse of the decoded save — every leaf, in file order.",
    prefix: "",
    hideZero: true,
  },
];

export interface DiscoveredField {
  path: string;
  key: string;
  kind: string;
  value: unknown;
}

/**
 * Collect the leaf fields under a prefix, in file order.
 *
 * `prefix` may hold several alternatives separated by `|`; a path matches the
 * section when it starts with any of them. With an empty prefix every leaf is
 * returned (the raw field explorer).
 *
 * `q` optionally filters by case-insensitive substring on the path BEFORE any
 * field decoding, so enormous sections (tens of thousands of event leaves)
 * stay fast and are searchable across the whole save instead of only the
 * first page.
 */
export function discoverPrefix(save: SaveGame, prefix: string, q = ""): DiscoveredField[] {
  const alts = prefix === "" ? [""] : prefix.split("|");
  const needle = q.trim().toLowerCase();
  const out: DiscoveredField[] = [];
  for (const path of save.paths()) {
    if (!alts.some((a) => path.startsWith(a))) continue;
    if (needle && !path.toLowerCase().includes(needle)) continue;
    const m = save.index.members.get(path)!;
    if (m.type === "object" || m.type === "array") continue; // leaves only
    const f = save.field(path);
    out.push({
      path,
      key: alts.map((a) => (path.startsWith(a) ? path.slice(a.length) : null)).find((k) => k !== null)!,
      kind: f.kind,
      value: f.value,
    });
  }
  return out;
}

export interface Overview {
  totalFields: number;
  tagged: { ds: number; i64: number; f: number };
  counts: Record<string, number>;
  bytes: number;
}

/** One-pass statistics the dashboard header shows. */
export function summarize(save: SaveGame): Overview {
  const tagged = { ds: 0, i64: 0, f: 0 };
  const counts: Record<string, number> = {};
  for (const path of save.paths()) {
    const m = save.index.members.get(path)!;
    if (m.type === "object") {
      const kids = save.index.children.get(path);
      if (kids && kids.includes(`${path}.t`) && kids.includes(`${path}.v`)) {
        const t = save.index.members.get(`${path}.t`);
        if (t) {
          const tag = save.rawText(`${path}.t`).slice(1, -1);
          if (tag === "ds") tagged.ds++;
          else if (tag === "i64") tagged.i64++;
          else if (tag === "f") tagged.f++;
        }
      }
      continue;
    }
    if (m.type === "array") continue;
    const dot = path.indexOf(".");
    const root = dot < 0 ? path : path.slice(0, dot);
    counts[root] = (counts[root] ?? 0) + 1;
  }
  return { totalFields: save.paths().length, tagged, counts, bytes: save.raw.length };
}

/** Top-level sections with their leaf-field counts, sorted by size. */
export function storageMap(save: SaveGame): Array<{ key: string; leaves: number }> {
  const s = summarize(save);
  return Object.entries(s.counts)
    .map(([key, leaves]) => ({ key, leaves }))
    .sort((a, b) => b.leaves - a.leaves);
}
