/**
 * Season Pass — copy the donor's maxed season state onto an account.
 *
 * ## Why this exists (measured 2026-10-20, twice, on a live device)
 *
 * Attempt 1 wrote only `Currency.<season>Points` plus the `SeasonPassInfoCache`
 * lines. Pushed, the game deleted the injected currency and rolled the whole
 * account back (level 40 -> gone, coins 123,456 -> 1,010). Recovered from a
 * snapshot.
 *
 * Attempt 2 wrote a hand-built CONSISTENT set — the 31-stage ladder, the
 * `completed` flags, `currProgress`, `currentOpenedStageIndex`, the log
 * counters and the points currency. Result, read back from the game's own
 * re-saved file:
 *
 *   * the account was NOT rolled back (level 39, 123,656 coins, 42 stars, no
 *     "suspicious activity" window) — so the first rollback was caused by the
 *     INCONSISTENCY (a points balance against zero completed stages), not by
 *     the currency write on its own;
 *   * every local field survived untouched (30/31 stages, `currProgress=30`);
 *   * but `Currency.<season>Points` was nulled again, and the pass rendered at
 *     tile 1 of 31 with the next tile locked at `0/1`.
 *
 * Attempt 3 (same day) copied the donor's ENTIRE `SpecialEvents.<season>`
 * subtree as a JSON-level diff — and still wrote the currency the nested way.
 * Read back from the game's own re-saved file: the account was intact and the
 * donor shape had survived (`currProgress=30` kept, the ladder
 * `savedPointsToComplete` 0…845 kept, an unclaimed-rewards window credited a
 * +200-coin pass reward in the UI), but every `stages[].completed` was
 * rewritten back to `false` and the currency placeholder was empty again. The
 * game recomputes completion from the points currency — which was never
 * readable in the nested form either attempt serialized. See "The points
 * currency" below for the measured byte-level reason.
 *
 * ## What the rendering actually keys off
 *
 * The pass window's progress bar is `vault.currentPoints / vault.pointsToComplete`
 * — measured, not assumed: `pointsToComplete` is 1 and the UI reads `0/1`. The
 * free row's tile count, though, did NOT follow `stages[].completed` (30 of 31
 * were written and kept, yet one tile was unlocked), and it did not follow
 * `SeasonPassInfoCache` (the donor and the device hold byte-identical caches —
 * `unlockedFree=31`, `unlockedGold=31`, `goldenPassPurchased=true`,
 * `collectedFree=1`, `collectedGold=6` — and only one of the two is maxed).
 * The one quantity that differed between a maxed account and this one, and that
 * attempt 2 never wrote, was the season's points CURRENCY.
 *
 * So the state that matters is the donor's, in full, not a subset of it.
 *
 * ## What this module does
 *
 * It copies the donor's whole `SpecialEvents.<season>.v` subtree onto the
 * account as a JSON-level diff: every differing leaf is set, every member the
 * donor has and the account lacks is created, and every array row the donor
 * has and the account lacks is appended. That reproduces the donor's exact
 * maxed shape rather than approximating it.
 *
 * Two things are deliberately NOT copied, because they assert a purchase:
 *
 *   * the purchase components — `BuyGoldenTicketWindow`,
 *     `CancellationPurchaseInfoWindow`, `GoldenTicketOffer`,
 *     `GoldenTicketPurchaseInfoWindow`, `LuaPurchaseDelegate`,
 *     `SuccessPurchaseInfoWindow`;
 *   * any field named `goldenPassBought`.
 *
 * `LogEventComponent.goldenPassBought` reads `true` on the donor and `false`
 * on the account. It is an assertion of a receipt this account never made: the
 * golden ticket is a real-money purchase the client runs through
 * `ValidatePurchase` / `PurchaseValidationStage` / `ConsumePurchase`, and
 * answers a refusal with `OnSeasonPassGoldenTicketBoughtFailed`, while
 * reporting `payer_type` and `inapps_count/sum` upward. Writing it would be
 * purchase spoofing, which is out of scope for this tool by standing rule.
 *
 * `SeasonPassInfoCache` is left exactly as found. It is byte-identical on the
 * donor and on the account, and only one of the two is maxed, so it is
 * demonstrably not the driver; touching it would add risk for no gain.
 *
 * ## The points currency — measured raw form (this is why attempts 2 and 3
 *    could not stick)
 *
 * The game stores a currency as two FLAT dotted-literal keys inside the
 * top-level `Currency` object, with bare numbers and no tags. Raw bytes:
 *
 *     donor:   "SSPProcedure46Points.amount": 10000,
 *              "SSPProcedure46Points.prevAmount": 9999,
 *     device:  "SSPProcedure46Points":            <- the game's own empty-null
 *                                                   placeholder (valueless)
 *
 * Attempts 2 and 3 instead REPLACED that null placeholder with a nested
 * object (`set("Currency.SSPProcedure46Points", {amount, prevAmount})`). A
 * shape the game never writes: within one save cycle the client re-parsed its
 * `Currency` dictionary, failed to recognise the nested form, and rewrote the
 * placeholder — on both pushed tests, on both saves read back from the game.
 *
 * The write is now the flat key pair, byte-for-byte the game's own
 * convention (identical to how this account stores `ExpeditionTickets.amount`
 * / `.prevAmount`). The valueless placeholder is left exactly where the game
 * put it — first in its key block — and the pair is appended after it, the
 * order the game's own sorted writer would produce.
 *
 * `Currency.<season>Points` is written at the LADDER'S OWN CEILING (845 for
 * `SSPProcedure46`) — the balance the account would legitimately hold after
 * completing the top stage. The donor sits at 10,000, but that value is an
 * IGG artefact: on the donor EVERY season currency reads ~10,000, which is
 * tool-generated rather than earned. The earned ceiling is the honest number.
 *
 * Everything below is a pure plan builder: no bytes are written and nothing is
 * pushed until the operator presses the button.
 */

import type { EditOp } from "./operations.ts";
import type { SaveGame } from "./savegame.ts";

export const SEASON_CACHE = "SeasonPassInfoCache";
export const SEASON_ID_PATH = `${SEASON_CACHE}.seasonPassEventId`;
export const GOLDEN_PATH = `${SEASON_CACHE}.goldenPassPurchased`;
export const UNLOCKED_FREE_PATH = `${SEASON_CACHE}.unlockedFree`;
export const UNLOCKED_GOLD_PATH = `${SEASON_CACHE}.unlockedGold`;

export const EVENT_LOGIC = "EventLogic";
export const MAIN_WINDOW = "MainWindow";
export const LOG_EVENT = "LogEventComponent";

/** Components that carry a purchase — never copied from the donor. */
export const PURCHASE_COMPONENTS: readonly string[] = [
  "BuyGoldenTicketWindow",
  "CancellationPurchaseInfoWindow",
  "GoldenTicketOffer",
  "GoldenTicketPurchaseInfoWindow",
  "LuaPurchaseDelegate",
  "SuccessPurchaseInfoWindow",
];

/** Fields that assert a receipt, wherever they appear in the copied subtree. */
export const PURCHASE_FIELDS: readonly string[] = ["goldenPassBought"];

export const GOLD_ROW_REASON =
  "the gold row requires the golden ticket, a real-money purchase the client " +
  "runs through ValidatePurchase/ConsumePurchase and reports upward via " +
  "payer_type and inapps_count/sum; LogEventComponent.goldenPassBought is an " +
  "assertion of a receipt this account never made, so writing it is purchase " +
  "spoofing, which this tool does not do.";

/** `Currency.<season>Points` for a season id such as `SSPProcedure46`. */
export function seasonPointsPath(season: string): string {
  return `Currency.${season}Points`;
}

export interface SeasonPassHighlight {
  path: string;
  before: unknown;
  after: unknown;
}

export interface SeasonPassPlan {
  ops: EditOp[];
  /** The live season procedure id, e.g. `SSPProcedure46`. */
  season: string;
  /** `Currency.<season>Points` — the field the stage ladder resolves against. */
  pointsPath: string;
  /** Points written: the ladder's own ceiling, not a round number. */
  points: number;
  /** Stages marked complete on the free row, e.g. 30 of 31. */
  completedStages: number;
  /** Index of the component named `EventLogic`, resolved per season. */
  eventLogicIndex: number;
  /** Whether `SpecialEvents.<season>` exists on the account at all. */
  eventPresent: boolean;
  /** The gold row is always refused; see `GOLD_ROW_REASON`. */
  goldRow: { unlocked: false; reason: string };
  /** Headline fields, for the UI's before/after readout. */
  highlights: SeasonPassHighlight[];
  /** How the donor's shape was applied. */
  stats: { sets: number; creates: number; appends: number; skipped: number };
  notes: string[];
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isObj(v: unknown): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sameJson(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => sameJson(x, b[i]!));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in b && sameJson(a[k]!, b[k]!));
  }
  return false;
}

function parseJson(text: string): Json | undefined {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

/** The donor's component names, keyed by index. */
function componentNames(donor: SaveGame, season: string): Map<number, string> {
  const m = new Map<number, string>();
  const re = new RegExp(
    `^SpecialEvents\\.${season}\\.v\\.components\\[(\\d+)\\]\\.v\\.first$`,
  );
  for (const p of donor.paths()) {
    const mt = re.exec(p);
    if (mt) m.set(Number(mt[1]), String(donor.field(p).value));
  }
  return m;
}

function componentIndex(save: SaveGame, season: string, name: string): number | undefined {
  const re = new RegExp(`^SpecialEvents\\.${season}\\.v\\.components\\[(\\d+)\\]\\.v\\.first$`);
  for (const p of save.paths()) {
    const mt = re.exec(p);
    if (mt && String(save.field(p).value) === name) return Number(mt[1]);
  }
  return undefined;
}

interface WalkCtx {
  ops: EditOp[];
  stats: { sets: number; creates: number; appends: number; skipped: number };
  /** Full path prefixes that must not be touched. */
  protectedPrefixes: string[];
  protectedFields: Set<string>;
  /** Paths whose device/donor node types disagree — cannot be copied. */
  mismatches: string[];
}

function walk(
  donorNode: Json,
  deviceNode: Json | undefined,
  path: string,
  ctx: WalkCtx,
): void {
  if (!isObj(donorNode)) return;
  const deviceObj = isObj(deviceNode) ? deviceNode : undefined;

  for (const key of Object.keys(donorNode)) {
    const childPath = path ? `${path}.${key}` : key;
    if (ctx.protectedPrefixes.some((pre) => childPath === pre || childPath.startsWith(`${pre}.`))) {
      ctx.stats.skipped++;
      continue;
    }
    if (ctx.protectedFields.has(key)) {
      ctx.stats.skipped++;
      continue;
    }

    const d = donorNode[key]!;
    const v = deviceObj?.[key];

    if (v === undefined) {
      // A member the donor has and the account lacks: insert it whole.
      ctx.ops.push({ path: childPath, value: d as EditOp["value"], create: true });
      ctx.stats.creates++;
      continue;
    }

    if (Array.isArray(d)) {
      if (!Array.isArray(v)) {
        ctx.mismatches.push(childPath);
        ctx.stats.skipped++;
        continue;
      }
      const n = Math.min(d.length, v.length);
      for (let i = 0; i < n; i++) {
        walk(d[i]!, v[i], `${childPath}[${i}]`, ctx);
      }
      for (let i = n; i < d.length; i++) {
        ctx.ops.push({ path: childPath, value: d[i] as EditOp["value"], append: true });
        ctx.stats.appends++;
      }
      continue;
    }

    if (isObj(d)) {
      if (!isObj(v)) {
        ctx.mismatches.push(childPath);
        ctx.stats.skipped++;
        continue;
      }
      walk(d, v, childPath, ctx);
      continue;
    }

    if (!sameJson(d, v)) {
      ctx.ops.push({ path: childPath, value: d as EditOp["value"] });
      ctx.stats.sets++;
    }
  }
}

/**
 * The season's points currency, in the game's own raw form.
 *
 * Measured 2026-10-20 on both the donor save and the game's own re-saved
 * device file: a currency is two FLAT dotted-literal members of the
 * top-level `Currency` object — `"SSPProcedure46Points.amount"` — with bare
 * numbers, never a nested object. The nested-object write (set() on the null
 * placeholder) was the exact failure of attempts 2 and 3: the game stripped
 * both pushes back to its empty placeholder within one save cycle.
 *
 * The valueless `"SSPProcedure46Points":` placeholder the game wrote is left
 * untouched; `create()` resolves the longest existing OBJECT prefix (the
 * `Currency` container — the placeholder is a null leaf, not an object) and
 * appends the literal dotted keys at the closing brace, i.e. after the
 * placeholder, matching the game's sorted-key order.
 */
function currencyOps(save: SaveGame, path: string, amount: number): EditOp[] {
  const prev = amount > 0 ? amount - 1 : 0;
  const ops: EditOp[] = [];
  if (save.has(path) && save.field(path).kind === "null") {
    /*
     * Playrix serializes an "unset" currency as a literal EMPTY token
     * (`"SSPProcedure46Points":` with no value between colon and brace —
     * the game reads it, but it is not valid JSON, so any later patch run
     * refuses the file). Normalizing it to the standard `null` literal is
     * byte-compatible for the game: donor and sibling saves already hold
     * `null` literals (e.g. `{"t":"ds","v":null}`). The key stays exactly
     * where the game wrote it, so splice order is preserved.
     */
    ops.push({ path, value: null });
  }
  if (save.has(`${path}.amount`)) {
    ops.push({ path: `${path}.amount`, value: amount });
  } else {
    ops.push({ path: `${path}.amount`, value: amount, create: true });
  }
  if (save.has(`${path}.prevAmount`)) {
    ops.push({ path: `${path}.prevAmount`, value: prev });
  } else {
    ops.push({ path: `${path}.prevAmount`, value: prev, create: true });
  }
  return ops;
}

/**
 * Plan the season-pass write: the donor's whole maxed season shape, minus
 * anything that asserts a purchase, plus the season's points currency.
 *
 * Throws when the account has no live season pass — a real refusal worth
 * showing, not something to quietly no-op.
 */
export function planSeasonPass(save: SaveGame, donor: SaveGame): SeasonPassPlan {
  const notes: string[] = [];

  const cached = save.has(SEASON_ID_PATH) ? String(save.field(SEASON_ID_PATH).value) : "";
  const donorSeason = donor.has(SEASON_ID_PATH) ? String(donor.field(SEASON_ID_PATH).value) : "";
  let season: string | undefined = cached || undefined;
  if (!season && donorSeason && save.has(`SpecialEvents.${donorSeason}.v`)) {
    season = donorSeason;
    notes.push(`this account names no live season but does hold ${donorSeason}, so that one was used.`);
  }
  if (!season) {
    throw new Error(
      `this save names no live season (${SEASON_ID_PATH} is absent) and holds no season ` +
        `event to adopt — there is no pass to unlock`,
    );
  }

  const eventRoot = `SpecialEvents.${season}.v`;
  const eventPresent = save.has(eventRoot);
  if (!eventPresent) {
    throw new Error(`${eventRoot} is not present on this account, so there is no pass to write`);
  }
  if (!donor.has(eventRoot)) {
    throw new Error(`the donor holds no ${eventRoot} to copy from`);
  }

  const donorEvent = parseJson(donor.rawText(eventRoot));
  const deviceEvent = parseJson(save.rawText(eventRoot));
  if (!isObj(donorEvent) || !isObj(deviceEvent)) {
    throw new Error(`the ${season} event could not be read as JSON on one of the two saves`);
  }

  /*
   * The stage ladder is the measured source of the points ceiling. It is a
   * progress record rather than config — it fills in as stages complete — so
   * the donor's copy is the only measured source of the earned value.
   */
  const donorIdx = componentIndex(donor, season, EVENT_LOGIC);
  if (donorIdx === undefined) {
    throw new Error(`the donor holds no ${EVENT_LOGIC} component for ${season}`);
  }
  const donorStages =
    `${eventRoot}.components[${donorIdx}].v.second.v.ptr.v.stages.v.ptr.v.stages`;
  const ladder: number[] = [];
  for (let i = 0; ; i++) {
    if (!donor.has(`${donorStages}[${i}].v.ptr.v.savedPointsToComplete`)) break;
    ladder.push(Number(donor.field(`${donorStages}[${i}].v.ptr.v.savedPointsToComplete`).value));
  }
  if (ladder.length === 0) {
    throw new Error(`the donor's ${donorStages} holds no stage ladder`);
  }
  const points = Math.max(...ladder);
  const completedStages = Math.max(ladder.length - 1, 0);

  const saveIdx = componentIndex(save, season, EVENT_LOGIC);
  if (saveIdx === undefined) {
    throw new Error(`this account's ${eventRoot} has no ${EVENT_LOGIC} component`);
  }

  /* Purchase-shaped components are never copied. */
  const names = componentNames(donor, season);
  const protectedPrefixes: string[] = [];
  for (const [idx, name] of names) {
    if (PURCHASE_COMPONENTS.includes(name)) {
      protectedPrefixes.push(`${eventRoot}.components[${idx}]`);
    }
  }

  const ctx: WalkCtx = {
    ops: [],
    stats: { sets: 0, creates: 0, appends: 0, skipped: 0 },
    protectedPrefixes,
    protectedFields: new Set(PURCHASE_FIELDS),
    mismatches: [],
  };
  walk(donorEvent, deviceEvent, eventRoot, ctx);

  if (ctx.mismatches.length) {
    notes.push(
      `${ctx.mismatches.length} field(s) had a different shape on the two saves and were ` +
        `left alone rather than forced: ${ctx.mismatches.slice(0, 3).join(", ")}`,
    );
  }

  /* The season's points currency, at the ladder's earned ceiling. */
  const pointsPath = seasonPointsPath(season);
  const ops = ctx.ops;
  for (const op of currencyOps(save, pointsPath, points)) ops.push(op);

  const highlights: SeasonPassHighlight[] = [];
  const hl = (p: string): void => {
    const before = save.has(p) ? save.field(p).value : undefined;
    const op = ops.find((o) => o.path === p || o.path === `${p}.amount`);
    if (op) highlights.push({ path: p, before, after: op.value });
  };
  hl(`${eventRoot}.components[${saveIdx}].v.second.v.ptr.v.currProgress`);
  hl(`${eventRoot}.components[${saveIdx}].v.second.v.ptr.v.maxStagesProgress`);
  hl(`${eventRoot}.components[${saveIdx}].v.second.v.ptr.v.previousProgress`);
  hl(pointsPath);

  const protectedNote = PURCHASE_COMPONENTS.length;
  notes.push(
    `${protectedNote} purchase-shaped components and the field ` +
      `\`goldenPassBought\` were left as found — the gold row is not asserted.`,
  );
  notes.push(
    `the donor's points value was NOT copied: it reads 10,000 on the donor, but ` +
      `every season currency on that save reads ~10,000, so it is a tool artefact. ` +
      `The ladder's own ceiling (${points}) was written instead.`,
  );

  return {
    ops,
    season,
    pointsPath,
    points,
    completedStages,
    eventLogicIndex: saveIdx,
    eventPresent,
    goldRow: { unlocked: false, reason: GOLD_ROW_REASON },
    highlights,
    stats: ctx.stats,
    notes,
  };
}
