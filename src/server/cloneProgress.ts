/**
 * The opt-in progression copy behind the clone panel's
 * "also copy level, stars and coins" tick.
 *
 * A content clone — the default, and the build measured clean in game —
 * carries the donor's house and nothing else. This module is the ONLY way a
 * clone touches progress, it is never called unless the operator asked for it
 * in so many words, and it copies exactly five named leaves:
 *
 *   Properties.level        the profile Level (the field the game reads)
 *   Properties.LID_Lvl      the match-3 level kept in the local save
 *   Properties.coins        soft currency
 *   Properties.earnedStars  lifetime star balance numerator
 *   Properties.spentStars   stars already spent
 *
 * Why these and nothing else (see `cloneGuard.ts` for the APK research):
 * the client re-derives the secret `Properties.CeReas_R1` (coins) and
 * `Properties.CeReas_R4` (star balance) strings from live state and fires
 * `SecretValueValidationFailedEvent` when they disagree, and the server runs
 * `AntiCheat.Server.ScoreValidation` against the account's OWN history. The
 * caller applies the returned ops in the same batch as the content clone with
 * `refreshIntegrity: true`, which is what re-derives those mirrors — so the
 * write is consistent, bounded and mirror-true.
 *
 * Bounded here, in one place:
 *   - coins are clamped below 2e9, the signed-32-bit edge the client's own
 *     arithmetic sits on;
 *   - a level jump more than +200 over the account's own value is called out,
 *     because that gap is exactly what the server-side score compares;
 *   - a value the target already holds is not written at all.
 *
 * What this cannot do is promise "never flagged": only Playrix sees the
 * server-side score, and it scores progress against the account's own history.
 * Everything measurable from the save is kept true here; the rest is stated
 * honestly to the operator.
 */
import type { EditOp } from "../engine/operations.ts";
import type { SaveGame } from "../engine/savegame.ts";

/** The five donor leaves a progression copy may write — never a whole root. */
export const PROGRESSION_LEAVES: readonly string[] = [
  "Properties.level",
  "Properties.LID_Lvl",
  "Properties.coins",
  "Properties.earnedStars",
  "Properties.spentStars",
];

/** Coins at or above this are clamped: the signed 32-bit edge. */
export const COIN_CEILING = 2_000_000_000;

/** A level jump larger than this over the account's own value is called out. */
export const LEVEL_JUMP_WARN = 200;

export interface ProgressionCopy {
  /** Ops to append to the clone's batch (applied with `refreshIntegrity`). */
  ops: EditOp[];
  /** What each op writes, before → after, for the operator-facing report. */
  copied: Array<{ path: string; from: number | null; to: number }>;
  /** Clamps and jump warnings — surfaced, never silent. */
  notes: string[];
}

const safeNumber = (save: SaveGame, path: string): number | null => {
  try {
    return save.has(path) ? save.number(path) : null;
  } catch {
    return null;
  }
};

/**
 * Read the donor's five progression leaves and turn them into bounded ops for
 * `target`. A leaf the donor lacks is skipped; a leaf whose value the target
 * already holds produces no op (a no-op clone stays a no-op).
 */
export function progressionCopy(donor: SaveGame, target: SaveGame): ProgressionCopy {
  const ops: EditOp[] = [];
  const copied: ProgressionCopy["copied"] = [];
  const notes: string[] = [];

  for (const path of PROGRESSION_LEAVES) {
    const dv = safeNumber(donor, path);
    if (dv === null) continue; // donor simply has no such field

    let to = dv;
    if (path === "Properties.coins" && to >= COIN_CEILING) {
      to = COIN_CEILING - 1;
      notes.push(
        `donor coins ${dv.toLocaleString("en-US")} clamped to ${to.toLocaleString("en-US")} ` +
          `(the signed 32-bit edge the client arithmetic sits on)`,
      );
    }

    const from = safeNumber(target, path);
    if (path === "Properties.level" || path === "Properties.LID_Lvl") {
      const base = from ?? 1;
      if (to > base + LEVEL_JUMP_WARN) {
        notes.push(
          `level ${base} → ${to} is a jump of ${to - base}; Playrix scores progress against ` +
            `this account's own history (AntiCheat.Server.ScoreValidation), so a jump this ` +
            `size can raise the suspicious-activity window`,
        );
      }
    }

    if (from === to) continue; // nothing to write
    ops.push({ path, value: to });
    copied.push({ path, from, to });
  }

  return { ops, copied, notes };
}
