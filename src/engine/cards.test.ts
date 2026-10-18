/**
 * Cards — catalog, album reads, and grant planning.
 *
 * These run against a synthetic save in Playrix's own shape, so they need no
 * fixture and always execute. The integration cases that read a real 4.5 MB
 * container live in `engine.test.ts`.
 *
 *   node --experimental-strip-types --test src/engine/*.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ALBUM_PATH,
  BATCH_MAX,
  CARDS_PER_SET,
  CARD_COUNT,
  SET_COUNT,
  SETS_PATH,
  STOCK_CAP,
  cardIdOf,
  parseSetId,
  planGrants,
  readAlbum,
  setOfCard,
} from "./cards.ts";
import { runApply } from "./operations.ts";
import { openSave, SaveError } from "./savegame.ts";

/**
 * A save with the album present: two held cards (one copy each), the 15 set
 * rows the event always writes, and a gift budget. Mirrors the live
 * `CardsCollection7` shape byte-for-byte in structure.
 */
function synthSave(card01Stock = 1): Uint8Array {
  const ownedCards = [
    {
      t: "ds",
      v: { cardId: "card_01", generatedCount: card01Stock, inStockCount: card01Stock, isNew: false },
    },
    { t: "ds", v: { cardId: "card_12", generatedCount: 2, inStockCount: 2, isNew: false } },
  ];
  const ownedSets = Array.from({ length: SET_COUNT }, (_, i) => ({
    t: "ds",
    v: {
      setId: `set_${String(i + 1).padStart(2, "0")}`,
      // set_01 holds card_01, set_02 holds card_12 — a stale progress bar on
      // purpose, so the re-derivation has something real to correct.
      lastSeenProgress: i === 0 ? 1 : i === 1 ? 1 : 0,
      isRewarded: false,
    },
  }));
  const doc = {
    Properties: { coins: 100, level: 40 },
    SpecialEvents: {
      CardsCollection: {
        t: "ds",
        v: {
          Core: {
            t: "ds",
            v: {
              OwnedCards: ownedCards,
              OwnedSets: ownedSets,
              GiftData: { t: "ds", v: { GiftsSentToday: 0, LastGiftDate: { t: "i64", v: "0" } } },
            },
          },
        },
      },
    },
  };
  return new TextEncoder().encode(JSON.stringify(doc, null, 2));
}

test("cards: catalog constants match the live event", () => {
  assert.equal(CARD_COUNT, 150, "150 cards in the album window");
  assert.equal(CARDS_PER_SET, 10, "the 10-per-set rule shared with the IGG tool");
  assert.equal(SET_COUNT, 15, "150 / 10 = 15 sets");
  assert.equal(SET_COUNT * CARDS_PER_SET, CARD_COUNT, "sets tile the catalog exactly");
  assert.equal(STOCK_CAP, 4, "the event converts a 5th copy into trade tokens");
});

test("cards: card -> set mapping at every boundary", () => {
  assert.equal(setOfCard(1), 1);
  assert.equal(setOfCard(10), 1, "the last card of a set stays in it");
  assert.equal(setOfCard(11), 2, "the first card of the next set moves over");
  assert.equal(setOfCard(50), 5);
  assert.equal(setOfCard(150), 15, "the catalog's last card is in the last set");

  assert.equal(cardIdOf(1), "card_01", "ids are zero-padded like the save's own");
  assert.equal(cardIdOf(7), "card_07");
  assert.equal(cardIdOf(150), "card_150");

  assert.equal(parseSetId("set_01"), 1);
  assert.equal(parseSetId("set_15"), 15);
  assert.equal(parseSetId("card_15"), null, "a card id is not a set id");
  assert.equal(parseSetId("set_1"), null, "ids carry two digits");
});

test("cards: readAlbum reports the rows the save actually holds", () => {
  const save = openSave(synthSave());
  const a = readAlbum(save);

  assert.equal(a.present, true);
  assert.equal(a.uniqueOwned, 2);
  assert.equal(a.totalCopies, 3, "one copy of card_01 + two of card_12");
  assert.equal(a.setRows.length, SET_COUNT, "all 15 set rows are indexed");

  const c1 = a.byNum.get(1);
  assert.ok(c1);
  assert.equal(c1.cardId, "card_01");
  assert.equal(c1.set, 1);
  assert.equal(c1.index, 0, "the row index is what a stock edit targets");
  assert.equal(c1.inStockCount, 1);

  const c12 = a.byNum.get(12);
  assert.ok(c12);
  assert.equal(c12.set, 2);
  assert.equal(c12.inStockCount, 2);

  assert.equal(a.ownedPerSet.get(1), 1);
  assert.equal(a.ownedPerSet.get(2), 1);
  assert.equal(a.ownedPerSet.get(3), 0);
  assert.equal(a.byNum.has(150), false, "unowned cards never appear in the album");
});

test("cards: an album-less save reports present=false rather than throwing", () => {
  const save = openSave(new TextEncoder().encode(JSON.stringify({ Properties: { coins: 1 } })));
  const a = readAlbum(save);
  assert.equal(a.present, false);
  assert.equal(a.uniqueOwned, 0);
  assert.equal(a.setRows.length, 0);
});

test("cards: a grant bumps owned rows in place and appends the new one", () => {
  const save = openSave(synthSave());
  const plan = planGrants(save, [1, 12, 150], 3);

  assert.deepEqual(plan.added, [150], "only card_150 is not in the album");
  assert.equal(plan.bumps.length, 2, "the two held cards are bumped");
  assert.deepEqual(
    plan.bumps.map((b) => [b.num, b.from, b.to]),
    [
      [1, 1, 4],
      [12, 2, 4],
    ],
    "each bump lands exactly on the 4-copy cap",
  );
  assert.equal(plan.capped.length, 0, "nothing was already full");

  const append = plan.ops.filter((o) => o.append);
  assert.equal(append.length, 1, "one appended row");
  assert.equal(append[0]?.path, ALBUM_PATH);
  assert.deepEqual(
    append[0]?.value,
    { t: "ds", v: { cardId: "card_150", generatedCount: 3, inStockCount: 3, isNew: false } },
    "the appended row has the game's own shape",
  );

  assert.ok(
    plan.ops.some(
      (o) => o.path === `${SETS_PATH}[14].v.lastSeenProgress` && o.value === 1,
    ),
    "set_15 progress is re-derived 0 -> 1 by the new card",
  );
});

test("cards: copies are clamped to the event's own cap", () => {
  const save = openSave(synthSave());

  const over = planGrants(save, [1], 99);
  assert.deepEqual(
    over.bumps.map((b) => b.to),
    [STOCK_CAP],
    "99 copies becomes 4, because a 5th is converted to trade tokens",
  );

  // `set()` queues a splice that only lands on commit(), so a capped card has
  // to be built into the fixture itself rather than edited in place here.
  const full = openSave(synthSave(STOCK_CAP));
  const plan = planGrants(full, [1, 2], 2);
  assert.deepEqual(plan.bumps, [], "a capped card gains nothing");
  assert.deepEqual(plan.capped, [1], "and is reported as capped");
  assert.deepEqual(plan.added, [2], "the unowned card is still granted");
});

test("cards: junk and out-of-range card numbers are ignored, not written", () => {
  const save = openSave(synthSave());
  const plan = planGrants(save, [0, -5, 151, 999, 1], 1);
  assert.deepEqual(plan.added, []);
  assert.deepEqual(
    plan.bumps.map((b) => b.num),
    [1],
    "only the one in-range card survives",
  );
});

test("cards: runApply lands the grant as valid Playrix JSON", () => {
  const plain = synthSave();
  const plan = planGrants(openSave(plain), [1, 12, 150, 10], 2);
  const r = runApply(plain, plan.ops, { refreshIntegrity: false });

  assert.equal(r.ok, true, `apply should succeed: ${r.errors.join(" | ")}`);
  assert.deepEqual(r.errors, []);
  assert.ok(r.summary.length > 0);

  // `commit()` already proved every byte outside the splices is untouched;
  // here we prove the RESULT is a save the game can read.
  const doc = JSON.parse(new TextDecoder().decode(r.bytes)) as {
    SpecialEvents: { CardsCollection: { v: { Core: { v: Record<string, unknown> } } } };
  };
  const core = doc.SpecialEvents.CardsCollection.v.Core.v;
  const rows = core.OwnedCards as Array<{ v: { cardId: string; inStockCount: number } }>;
  assert.equal(rows.length, 4, "two held + card_150 + card_10 appended");

  const byId = new Map(rows.map((x) => [x.v.cardId, x.v]));
  assert.equal(byId.get("card_01")?.inStockCount, 3, "1 copy + 2 granted");
  assert.equal(byId.get("card_12")?.inStockCount, 4, "2 copies + 2 granted, on the cap");
  assert.equal(byId.get("card_10")?.inStockCount, 2, "a brand-new row carries the grant");
  assert.equal(byId.get("card_150")?.inStockCount, 2);
  assert.equal(byId.get("card_150")?.cardId, "card_150");

  const sets = core.OwnedSets as Array<{ v: { setId: string; lastSeenProgress: number } }>;
  const prog = new Map(sets.map((s) => [s.v.setId, s.v.lastSeenProgress]));
  assert.equal(prog.get("set_01"), 2, "card_01 + card_10 both land in set_01");
  assert.equal(prog.get("set_02"), 1, "set_02 unchanged by the round-trip");
  assert.equal(prog.get("set_15"), 1, "card_150 re-derives its set");

  // The untouched top-level root survived the splices.
  const top = doc as unknown as { Properties: { coins: number; level: number } };
  assert.equal(top.Properties.coins, 100);
  assert.equal(top.Properties.level, 40);

  // Re-read through the engine, not just JSON: the byte spans still resolve.
  const again = readAlbum(openSave(r.bytes));
  assert.equal(again.uniqueOwned, 4);
  assert.equal(again.totalCopies, 11, "3 + 2 + 2 + 2 + 2");
});

test("cards: an array row is appended, never spliced in as a literal key", () => {
  const plain = synthSave();
  const path = `${ALBUM_PATH}[9].v.inStockCount`;

  // Without the append flag the batch must refuse — `create()` would have
  // written a literal `"OwnedCards[9].v.inStockCount"` member into the parent
  // object and corrupted the file.
  const refused = runApply(plain, [{ path, value: 4 }], { refreshIntegrity: false });
  assert.equal(refused.ok, false);
  assert.match(refused.errors.join(" "), /append/);
  assert.equal(refused.outputBytes, refused.inputBytes, "nothing was written");

  const save = openSave(plain);
  assert.throws(() => save.create(path, 4), SaveError, "create() refuses it too");
  assert.throws(() => save.append(path, 4), SaveError, "append() targets arrays, not leaves");

  // And appending to something that is not an array at all is refused.
  assert.throws(() => save.append("Properties", { a: 1 }), SaveError);
  assert.throws(() => save.append("Properties.nope", { a: 1 }), SaveError);
});

test("cards: many appends into one array stay overlap-free", () => {
  const plain = synthSave();
  const save = openSave(plain);
  for (let n = 20; n <= 35; n++) {
    save.append(ALBUM_PATH, {
      t: "ds",
      v: { cardId: cardIdOf(n), generatedCount: 1, inStockCount: 1, isNew: false },
    });
  }
  const out = save.commit();
  assert.ok(out.summary.length > 0);

  const doc = JSON.parse(new TextDecoder().decode(out.bytes)) as {
    SpecialEvents: { CardsCollection: { v: { Core: { v: { OwnedCards: unknown[] } } } } };
  };
  const rows = doc.SpecialEvents.CardsCollection.v.Core.v.OwnedCards;
  assert.equal(rows.length, 18, "2 held + 16 appended");

  const again = readAlbum(openSave(out.bytes));
  assert.equal(again.uniqueOwned, 18);
  assert.equal(again.byNum.get(35)?.inStockCount, 1);
  // 20 -> set_02, 21..30 -> set_03 (a full set), 31..35 -> set_04.
  assert.equal(again.ownedPerSet.get(2), 2, "card_12 held before + card_20 appended");
  assert.equal(again.ownedPerSet.get(3), 10, "set_03 is completed by the run");
  assert.equal(again.ownedPerSet.get(4), 5);
});

test("cards: a whole 100-card wave lands in one pass", () => {
  // The batch cap: one request carries at most BATCH_MAX cards, and a
  // selection bigger than that is split client-side into waves of it. So the
  // engine has to handle a full wave — 100 cards, the album's first ten sets
  // exactly — in a single plan without losing a row or a progress bar.
  assert.equal(BATCH_MAX, 100, "100 cards a wave");
  assert.equal(BATCH_MAX % CARDS_PER_SET, 0, "a wave covers whole sets");

  const plain = synthSave();
  const wave = Array.from({ length: BATCH_MAX }, (_, i) => i + 1); // cards 1..100
  const plan = planGrants(openSave(plain), wave, 1);

  // card_01 is held at 1 copy and card_12 at 2, so 98 are appended and the 2
  // held cards are topped up one copy each.
  assert.equal(plan.added.length, 98);
  assert.equal(plan.bumps.length, 2);
  assert.deepEqual(
    plan.bumps.map((b) => [b.num, b.from, b.to]),
    [
      [1, 1, 2],
      [12, 2, 3],
    ],
  );
  assert.deepEqual(plan.capped, [], "nothing starts full at 1 copy");

  const r = runApply(plain, plan.ops, { refreshIntegrity: false });
  assert.equal(r.ok, true, `a full wave must apply: ${r.errors.join(" | ")}`);
  assert.deepEqual(r.errors, []);

  const doc = JSON.parse(new TextDecoder().decode(r.bytes)) as {
    Properties: { coins: number };
    SpecialEvents: { CardsCollection: { v: { Core: { v: Record<string, unknown> } } } };
  };
  const core = doc.SpecialEvents.CardsCollection.v.Core.v;
  const rows = core.OwnedCards as Array<{ v: { cardId: string; inStockCount: number } }>;
  assert.equal(rows.length, BATCH_MAX, "2 held + 98 appended");

  // Cards 1..100 are exactly sets 01..10, so every one of those ten set rows
  // must re-derive to a full 10/10 — the album window's own progress bars.
  const sets = core.OwnedSets as Array<{ v: { setId: string; lastSeenProgress: number } }>;
  const prog = new Map(sets.map((s) => [s.v.setId, s.v.lastSeenProgress]));
  for (let s = 1; s <= 10; s++) {
    assert.equal(
      prog.get(`set_${String(s).padStart(2, "0")}`),
      CARDS_PER_SET,
      `set ${s} is completed by the wave`,
    );
  }
  for (let s = 11; s <= SET_COUNT; s++) {
    assert.equal(prog.get(`set_${String(s).padStart(2, "0")}`), 0, `set ${s} stays empty`);
  }

  // And the result is still a save the engine can read back.
  const again = readAlbum(openSave(r.bytes));
  assert.equal(again.uniqueOwned, BATCH_MAX);
  assert.equal(again.totalCopies, 103, "2 + 3 topped up + 98 new, one copy each");
  assert.equal(again.byNum.get(12)?.inStockCount, 3, "a topped-up card carries the grant");
  assert.equal(again.byNum.get(100)?.inStockCount, 1, "an appended card starts at one copy");
  assert.equal(again.byNum.get(1)?.set, 1, "the 10-per-set rule survives 98 appends");
  assert.equal(again.byNum.get(100)?.set, 10);
});
