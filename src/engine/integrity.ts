/**
 * `Properties.CeReas_R*` integrity strings.
 *
 * These are derived, human-readable checksum strings the client writes next to
 * the real state. Observed contents on a real level-655 save:
 *
 *   R1: "R1: C=2144822766,MTC=1000000,P=0,MP=5"
 *   R4: "R4: V:2147482778,MV:22500"
 *   R8: "R8:  B=1774 B=0 B=0 B=1601 B=1699,MB:1700 P=0,MP:5"
 *   R9: "R9:  B=1140 B=0 B=957 B=249,MB:998 P=0,MP:5"
 *
 * What we can PROVE:
 *   - R1 `C=` is exactly `Properties.coins`.
 *   - R4 `V:` is exactly `(earnedStars mod 2^32) - spentStars`.
 *     Verified: (-2147482755 + 2^32) - 1763 = 2147482778. ✓
 *
 * What we CANNOT prove:
 *   - R8/R9 `B=` values only *approximately* mirror the booster counts
 *     (R8 lists 1774 where BombAndLineBoost is 1776; R9 lists 1140 where
 *     HammerBonus is 1141; two slots are 0 in each). They are stale snapshots,
 *     not live derivations. Rewriting them from live counts could therefore
 *     be wrong, so this module never touches R8/R9 automatically — it only
 *     reports the drift.
 */

import type { SaveGame } from "./savegame.ts";

export const R_PATHS = {
  r1: "Properties.CeReas_R1",
  r4: "Properties.CeReas_R4",
  r8: "Properties.CeReas_R8",
  r9: "Properties.CeReas_R9",
} as const;

export interface IntegritySlice {
  path: string;
  present: boolean;
  raw: string;
  /** Parsed `KEY` -> `VALUE` pairs, tolerant of both `=` and `:` separators. */
  parts: Record<string, string>;
}

export interface IntegrityReport {
  r1: IntegritySlice;
  r4: IntegritySlice;
  r8: IntegritySlice;
  r9: IntegritySlice;
  /** `(earnedStars mod 2^32) - spentStars`, i.e. what R4's `V:` should be. */
  expectedR4Value: number;
  /** Current coins, i.e. what R1's `C=` should be. */
  expectedR1Coins: number;
  /** Booster names whose live count disagrees with an R8/R9 `B=` slot. */
  boosterDrift: Array<{ slot: string; mirrored: number; live: number; booster: string }>;
}

/** Known booster field names, in the order they plausibly appear in R8/R9. */
export const BOOSTER_PATHS: ReadonlyArray<{ path: string; label: string }> = [
  { path: "PlayerItems.BombAndLineBoost", label: "Bomb & Line" },
  { path: "PlayerItems.LightningBoost", label: "Lightning" },
  { path: "PlayerItems.MultiplyFishBoost", label: "Fish x2" },
  { path: "PlayerItems.HammerBonus", label: "Hammer" },
  { path: "PlayerItems.HorizontalLineBoosterBonus", label: "Horizontal Line" },
  { path: "PlayerItems.VerticalLineBoosterBonus", label: "Vertical Line" },
  { path: "PlayerItems.ReshuffleBoosterBonus", label: "Reshuffle" },
  { path: "PlayerItems.SwapBoosterBonus", label: "Swap" },
];

const U32 = 0x1_0000_0000;

/** Coerce to the unsigned 32-bit view the client uses. */
export function toU32(n: number): number {
  return ((n % U32) + U32) % U32;
}

/** What R4's `V:` must equal for the current `earnedStars` / `spentStars`. */
export function expectedR4Value(save: SaveGame): number {
  const earned = save.has("Properties.earnedStars") ? save.number("Properties.earnedStars") : 0;
  const spent = save.has("Properties.spentStars") ? save.number("Properties.spentStars") : 0;
  return toU32(earned) - spent;
}

function parseParts(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Strip the leading "R<n>:" marker, then split on commas and whitespace.
  const body = text.replace(/^\s*R\d+\s*:\s*/, "");
  for (const tok of body.split(/[,\s]+/)) {
    if (!tok) continue;
    const m = /^([A-Za-z]+)([:=])(.+)$/.exec(tok);
    if (m) out[m[1]!] = m[3]!;
  }
  return out;
}

function sliceOf(save: SaveGame, path: string): IntegritySlice {
  if (!save.has(path)) return { path, present: false, raw: "", parts: {} };
  const raw = save.string(path);
  return { path, present: true, raw, parts: parseParts(raw) };
}

function allBSlots(text: string): number[] {
  const out: number[] = [];
  const re = /(?:^|[\s,])B=(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(Number(m[1]));
  return out;
}

/** Read + cross-check the integrity strings against live state. */
export function readIntegrity(save: SaveGame): IntegrityReport {
  const r1 = sliceOf(save, R_PATHS.r1);
  const r4 = sliceOf(save, R_PATHS.r4);
  const r8 = sliceOf(save, R_PATHS.r8);
  const r9 = sliceOf(save, R_PATHS.r9);

  const boosterDrift: IntegrityReport["boosterDrift"] = [];
  const mirrored = [...allBSlots(r8.raw), ...allBSlots(r9.raw)];
  const live = BOOSTER_PATHS.map((b) => ({
    ...b,
    value: save.has(b.path) ? save.number(b.path) : 0,
  }));
  for (const b of live) {
    // Find a mirrored slot that is "close" (within 5) but not equal — that is
    // the signature of a stale snapshot rather than a different mapping.
    const near = mirrored.find((v) => v !== b.value && Math.abs(v - b.value) <= 5);
    if (near !== undefined) {
      boosterDrift.push({
        slot: "R8/R9",
        mirrored: near,
        live: b.value,
        booster: b.label,
      });
    }
  }

  return {
    r1,
    r4,
    r8,
    r9,
    expectedR4Value: expectedR4Value(save),
    expectedR1Coins: save.has("Properties.coins") ? save.number("Properties.coins") : 0,
    boosterDrift,
  };
}

export interface IntegrityRefreshResult {
  applied: Array<{ path: string; before: string; after: string; reason: string }>;
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Queue edits that bring the PROVEN-derived integrity strings back in sync.
 * Only R1 `C=` and R4 `V:` are touched. R8/R9 are deliberately left alone.
 *
 * `save` must already have the user's coins/stars edits queued so we read the
 * post-edit numbers; callers should call this AFTER `save.set(...)`.
 */
export function refreshIntegrity(save: SaveGame): IntegrityRefreshResult {
  const applied: IntegrityRefreshResult["applied"] = [];
  const skipped: IntegrityRefreshResult["skipped"] = [];

  // --- R1: C=<coins> ------------------------------------------------------
  if (!save.has(R_PATHS.r1)) {
    skipped.push({ path: R_PATHS.r1, reason: "not present in this save" });
  } else {
    const before = save.string(R_PATHS.r1);
    const coins = save.has("Properties.coins") ? save.number("Properties.coins") : null;
    if (coins === null) {
      skipped.push({ path: R_PATHS.r1, reason: "Properties.coins missing" });
    } else {
      // \bC= will not match the C inside "MTC=" (no word boundary there).
      const re = /\bC=\d+/;
      if (!re.test(before)) {
        skipped.push({ path: R_PATHS.r1, reason: "no C= component found" });
      } else {
        const after = before.replace(re, `C=${coins}`);
        if (after !== before) {
          save.set(R_PATHS.r1, after);
          applied.push({ path: R_PATHS.r1, before, after, reason: "C= follows Properties.coins" });
        }
      }
    }
  }

  // --- R4: V:<u32(earnedStars) - spentStars> ------------------------------
  if (!save.has(R_PATHS.r4)) {
    skipped.push({ path: R_PATHS.r4, reason: "not present in this save" });
  } else {
    const before = save.string(R_PATHS.r4);
    const v = expectedR4Value(save);
    // \bV= won't match the V inside "MV:".
    const re = /\bV:\d+/;
    if (!re.test(before)) {
      skipped.push({ path: R_PATHS.r4, reason: "no V: component found" });
    } else {
      const after = before.replace(re, `V:${v}`);
      if (after !== before) {
        save.set(R_PATHS.r4, after);
        applied.push({
          path: R_PATHS.r4,
          before,
          after,
          reason: "V: = (earnedStars mod 2^32) - spentStars",
        });
      }
    }
  }

  skipped.push({
    path: `${R_PATHS.r8}, ${R_PATHS.r9}`,
    reason:
      "booster mirrors are stale snapshots, not live derivations — " +
      "left untouched to avoid corrupting them",
  });

  return { applied, skipped };
}
