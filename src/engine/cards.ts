/**
 * Cards — the Homescapes card album under `SpecialEvents.CardsCollection.*`.
 *
 * This is the same job your IGG Township tool's Cards tab does for
 * `mGameInfo.xml`, done against the Homescapes save's own shape:
 *
 *   OwnedCards[]  {"t":"ds","v":{"cardId":"card_09","generatedCount":1,
 *                                "inStockCount":1,"isNew":false}}
 *   OwnedSets[]   {"t":"ds","v":{"setId":"set_01","lastSeenProgress":2,
 *                                "isRewarded":false}}
 *   GiftData      {"t":"ds","v":{"GiftsSentToday":0,...}}
 *
 * Catalog facts, measured on the live event (`CardsCollection7`):
 *   - 150 cards, `card_01` .. `card_150`.
 *   - 15 sets of exactly 10, `set_01` .. `set_15`, `card_NN` -> set
 *     `floor((N-1)/10)+1`. Same 10-per-set rule the IGG tool uses.
 *   - `inStockCount` is capped in-game at 4; beyond that the event converts
 *     the copy into trade tokens, so a grant that writes more than the cap
 *     would desync what the UI shows from what the game believes.
 *   - `OwnedSets[i].lastSeenProgress` is a *derived* count: it always equals
 *     the number of `OwnedCards` entries in that set (verified on the live
 *     save: set_01 -> 2, set_02 -> 1, set_05 -> 1, the rest -> 0). It has to
 *     be re-derived whenever the album changes or the collection window
 *     renders a stale progress bar.
 *
 * Everything here is a pure plan builder: no bytes are written and nothing
 * is pushed. `runApply` performs the splices; the operator presses Push.
 */

import type { EditOp } from "./operations.ts";
import type { SaveGame } from "./savegame.ts";

/** Cards per set — the 10-per-set rule shared with the IGG tool. */
export const CARDS_PER_SET = 10;
/** Total cards in the Homescapes catalog. */
export const CARD_COUNT = 150;
/** Sets the catalog is divided into (`CARD_COUNT / CARDS_PER_SET`). */
export const SET_COUNT = CARD_COUNT / CARDS_PER_SET;
/** The event converts a 5th copy into trade tokens — grant up to this only. */
export const STOCK_CAP = 4;

/**
 * Cards one grant request may carry. A bigger selection is sent as
 * sequential waves of this size — the way the main tool batches a long
 * send — so a single request's work stays bounded and a long run can report
 * progress (and pace itself with the delay field) between waves.
 */
export const BATCH_MAX = 100;

export const ALBUM_PATH = "SpecialEvents.CardsCollection.v.Core.v.OwnedCards";
export const SETS_PATH = "SpecialEvents.CardsCollection.v.Core.v.OwnedSets";
export const GIFT_PATH = "SpecialEvents.CardsCollection.v.Core.v.GiftData";

/** `7` -> `card_07`; zero-padded exactly like the save's own ids. */
export function cardIdOf(num: number): string {
  return `card_${String(num).padStart(2, "0")}`;
}

/** `7` -> `set_01` for card 7; `12` -> `set_02`. */
export function setOfCard(num: number): number {
  return Math.floor((num - 1) / CARDS_PER_SET) + 1;
}

/** `set_02` -> 2; `null` when the id is not a set. */
export function parseSetId(id: string): number | null {
  const m = /^set_(\d{2})$/.exec(id);
  return m && m[1] !== undefined ? Number(m[1]) : null;
}

export interface OwnedCard {
  /** Index into `OwnedCards`, so a stock edit can target the right row. */
  index: number;
  /** Card number 1..150. */
  num: number;
  cardId: string;
  /** Set number 1..15. */
  set: number;
  generatedCount: number;
  inStockCount: number;
}

export interface AlbumState {
  byNum: Map<number, OwnedCard>;
  /** Set number -> how many distinct cards of that set are owned. */
  ownedPerSet: Map<number, number>;
  /** `OwnedSets` index -> the set number it declares. */
  setRows: { index: number; set: number; lastSeenProgress: number }[];
  /** Distinct cards owned across the whole album. */
  uniqueOwned: number;
  /** Total copies held across the album. */
  totalCopies: number;
  /** True when `OwnedCards` is absent — no live event in this save. */
  present: boolean;
}

/** Read the album out of an open save. Never mutates. */
export function readAlbum(save: SaveGame): AlbumState {
  const st: AlbumState = {
    byNum: new Map(),
    ownedPerSet: new Map(),
    setRows: [],
    uniqueOwned: 0,
    totalCopies: 0,
    present: save.has(ALBUM_PATH),
  };
  // Every set starts at a real 0, so a consumer never has to distinguish
  // "empty set" from "set absent" — the album always reports all 15.
  for (let s = 1; s <= SET_COUNT; s++) st.ownedPerSet.set(s, 0);

  if (st.present) {
    const n = save.field(ALBUM_PATH).span.type === "array" ? countArrayRows(save, ALBUM_PATH) : 0;
    for (let i = 0; i < n; i++) {
      const idPath = `${ALBUM_PATH}[${i}].v.cardId`;
      if (!save.has(idPath)) continue;
      const cardId = String(save.field(idPath).value);
      const m = /(\d+)/.exec(cardId);
      if (!m || m[1] === undefined) continue;
      const num = Number(m[1]);
      if (!(num >= 1 && num <= CARD_COUNT)) continue;
      const genPath = `${ALBUM_PATH}[${i}].v.generatedCount`;
      const stockPath = `${ALBUM_PATH}[${i}].v.inStockCount`;
      const row: OwnedCard = {
        index: i,
        num,
        cardId,
        set: setOfCard(num),
        generatedCount: save.has(genPath) ? Number(save.field(genPath).value) || 0 : 0,
        inStockCount: save.has(stockPath) ? Number(save.field(stockPath).value) || 0 : 0,
      };
      st.byNum.set(num, row);
      st.ownedPerSet.set(row.set, (st.ownedPerSet.get(row.set) ?? 0) + 1);
      st.totalCopies += row.inStockCount;
    }
    st.uniqueOwned = st.byNum.size;
  }

  if (save.has(SETS_PATH)) {
    const n = countArrayRows(save, SETS_PATH);
    for (let i = 0; i < n; i++) {
      const idPath = `${SETS_PATH}[${i}].v.setId`;
      if (!save.has(idPath)) continue;
      const set = parseSetId(String(save.field(idPath).value));
      if (set === null) continue;
      const lp = `${SETS_PATH}[${i}].v.lastSeenProgress`;
      st.setRows.push({
        index: i,
        set,
        lastSeenProgress: save.has(lp) ? Number(save.field(lp).value) || 0 : 0,
      });
    }
  }
  return st;
}

/** Number of elements in an array the scanner indexed as `path[0..]`. */
function countArrayRows(save: SaveGame, path: string): number {
  let n = 0;
  while (save.has(`${path}[${n}]`)) n++;
  return n;
}

export interface GrantPlan {
  ops: EditOp[];
  /** Cards that will gain stock (already owned). */
  bumps: { num: number; from: number; to: number }[];
  /** Cards that will be added to the album (not owned yet). */
  added: number[];
  /** Selected cards that are already at the cap. */
  capped: number[];
}

/**
 * Build the ops that grant `copies` of each selected card.
 *
 * Two shapes, both real save edits:
 *   - owned  -> bump `inStockCount` (and keep `generatedCount` above it) in place.
 *   - new    -> append a whole `OwnedCards` row, then the derived
 *               `OwnedSets.lastSeenProgress` is re-derived for every touched set.
 *
 * `copies` is clamped to `STOCK_CAP` because that is what the event itself
 * does with an overflow copy: it converts it to trade tokens. Writing 99 into
 * `inStockCount` would produce a number the game cannot display.
 */
export function planGrants(
  save: SaveGame,
  cardNums: readonly number[],
  copies: number,
): GrantPlan {
  const plan: GrantPlan = { ops: [], bumps: [], added: [], capped: [] };
  const want = Math.max(1, Math.trunc(copies));

  // Resolve which rows exist before writing anything: later ops must not
  // depend on the index shifts an earlier append would cause.
  const existing = new Map<number, OwnedCard>();
  const st = readAlbum(save);
  for (const [num, row] of st.byNum) existing.set(num, row);

  const touchedSets = new Set<number>();

  for (const num of [...cardNums].sort((a, b) => a - b)) {
    if (!(num >= 1 && num <= CARD_COUNT)) continue;
    const row = existing.get(num);
    if (row) {
      const target = Math.min(STOCK_CAP, row.inStockCount + want);
      if (target <= row.inStockCount) {
        plan.capped.push(num);
        continue;
      }
      plan.ops.push({
        path: `${ALBUM_PATH}[${row.index}].v.inStockCount`,
        value: target,
      });
      if (row.generatedCount < target) {
        plan.ops.push({
          path: `${ALBUM_PATH}[${row.index}].v.generatedCount`,
          value: target,
        });
      }
      plan.bumps.push({ num, from: row.inStockCount, to: target });
      touchedSets.add(row.set);
      continue;
    }

    const clamped = Math.min(STOCK_CAP, want);
    plan.ops.push({
      path: ALBUM_PATH,
      // A brand-new row: `generatedCount` and `inStockCount` agree, exactly
      // like every card the event itself has granted (measured: both are 1).
      value: {
        t: "ds",
        v: { cardId: cardIdOf(num), generatedCount: clamped, inStockCount: clamped, isNew: false },
      },
      append: true,
    });
    plan.added.push(num);
    touchedSets.add(setOfCard(num));
  }

  // Re-derive lastSeenProgress for every touched set that has a row.
  const ownedAfter = new Map(st.ownedPerSet);
  for (const num of plan.added) {
    const s = setOfCard(num);
    ownedAfter.set(s, (ownedAfter.get(s) ?? 0) + 1);
  }
  for (const { index, set, lastSeenProgress } of st.setRows) {
    if (!touchedSets.has(set)) continue;
    const next = Math.min(CARDS_PER_SET, ownedAfter.get(set) ?? 0);
    if (next === lastSeenProgress) continue;
    plan.ops.push({ path: `${SETS_PATH}[${index}].v.lastSeenProgress`, value: next });
  }

  return plan;
}
