/**
 * The opt-in progression copy behind the clone panel's
 * "also copy level, stars and coins" tick.
 *
 * Run with:
 *   node --experimental-strip-types --test src/server/*.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { openSave } from "../engine/savegame.ts";
import { runApply } from "../engine/operations.ts";
import { refreshIntegrity } from "../engine/integrity.ts";
import {
  COIN_CEILING,
  LEVEL_JUMP_WARN,
  PROGRESSION_LEAVES,
  progressionCopy,
} from "./cloneProgress.ts";
import { assertContentRoots, PROGRESS_ROOTS } from "./cloneGuard.ts";

const save = (obj: unknown) => openSave(new TextEncoder().encode(JSON.stringify(obj)));

test("copies exactly the five named leaves, and nothing else", () => {
  const donor = save({
    Properties: { level: 655, LID_Lvl: 656, coins: 7432, earnedStars: 34, spentStars: 3 },
    Repairs: { area: 1 },
    Currency: { Coins: 999 },
  });
  const target = save({ Properties: { LID_Lvl: 34, coins: 100 } });

  const { ops, copied, notes } = progressionCopy(donor, target);

  assert.deepEqual(
    ops.map((o) => o.path).sort(),
    [
      "Properties.LID_Lvl",
      "Properties.coins",
      "Properties.earnedStars",
      "Properties.level",
      "Properties.spentStars",
    ].sort(),
  );
  // A whole progression ROOT is never among them — the ban guard stays intact:
  // `assertContentRoots` refuses "Properties" outright, and nothing here
  // produces a root path, only the five named leaves.
  for (const op of ops) {
    assert.ok(op.path.includes("."), `${op.path} must be a leaf, not a root`);
    assert.ok(!PROGRESS_ROOTS.includes(op.path), `${op.path} must not be a whole root`);
  }
  assert.throws(() => assertContentRoots(["Properties"]), /progression/);
  assert.equal(copied.length, 5);
  // No clamps here — but the 34 → 655 jump IS called out, twice (level and
  // match-3 level), which is the point of the notes.
  assert.equal(notes.filter((n) => n.includes("clamped")).length, 0);
  assert.equal(notes.filter((n) => n.includes("jump")).length, 2);
  // Values reported before → after.
  const byPath = new Map(copied.map((c) => [c.path, c]));
  assert.deepEqual(byPath.get("Properties.level"), {
    path: "Properties.level",
    from: null,
    to: 655,
  });
  assert.deepEqual(byPath.get("Properties.LID_Lvl"), {
    path: "Properties.LID_Lvl",
    from: 34,
    to: 656,
  });
  assert.deepEqual(byPath.get("Properties.coins"), { path: "Properties.coins", from: 100, to: 7432 });
});

test("a leaf the target already holds is not written at all", () => {
  const donor = save({ Properties: { level: 10, coins: 500 } });
  const target = save({ Properties: { level: 10, coins: 500 } });
  const { ops, copied } = progressionCopy(donor, target);
  assert.equal(ops.length, 0);
  assert.equal(copied.length, 0);
});

test("a leaf the donor lacks is skipped, not invented", () => {
  const donor = save({ Properties: { coins: 5 } });
  const target = save({ Properties: { level: 3 } });
  const { ops, copied } = progressionCopy(donor, target);
  assert.deepEqual(ops.map((o) => o.path), ["Properties.coins"]);
  assert.equal(copied.length, 1);
});

test("donor coins at the 32-bit edge are clamped and the clamp is reported", () => {
  const donor = save({ Properties: { coins: 2_144_822_766 } });
  const target = save({ Properties: { coins: 10 } });
  const { ops, copied, notes } = progressionCopy(donor, target);

  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.value, COIN_CEILING - 1);
  assert.ok((ops[0]!.value as number) < 2_000_000_000, "coins stay under the signed-32 edge");
  assert.equal(copied[0]!.to, COIN_CEILING - 1);
  assert.equal(copied[0]!.from, 10);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /clamped/);
});

test("a level jump over the warn threshold is called out", () => {
  const donor = save({ Properties: { level: 655 } });
  const target = save({ Properties: { level: 1 } });
  const { ops, notes } = progressionCopy(donor, target);
  assert.equal(ops.length, 1);
  assert.ok(notes.length >= 1, "a jump this size must be surfaced");
  assert.ok(
    notes.some((n) => n.includes("jump") && n.includes(String(655))),
    `expected a jump note, got: ${notes.join(" | ")}`,
  );

  // A modest jump stays silent.
  const small = progressionCopy(save({ Properties: { level: 50 } }), save({ Properties: { level: 40 } }));
  assert.equal(small.notes.length, 0);
  assert.ok(LEVEL_JUMP_WARN > 0);
});

test("the copy lands under refreshIntegrity without breaking the mirrors", () => {
  const donor = save({
    Properties: { level: 40, LID_Lvl: 41, coins: 5000, earnedStars: 40, spentStars: 5 },
  });
  const target = save({ Properties: { LID_Lvl: 2, coins: 7, name: "chbv" } });
  const { ops } = progressionCopy(donor, target);

  const res = runApply(
    new TextEncoder().encode(JSON.stringify({ Properties: { LID_Lvl: 2, coins: 7, name: "chbv" } })),
    ops,
    { refreshIntegrity: true },
  );
  assert.equal(res.ok, true, res.errors.join("; "));
  assert.ok(res.integrity, "the secret mirrors must be re-derived with the write");

  const out = openSave(res.bytes);
  assert.equal(out.number("Properties.level"), 40);
  assert.equal(out.number("Properties.LID_Lvl"), 41);
  assert.equal(out.number("Properties.coins"), 5000);
  assert.equal(out.number("Properties.earnedStars"), 40);
  assert.equal(out.number("Properties.spentStars"), 5);
  assert.equal(out.field("Properties.name").value, "chbv", "untouched state stays untouched");

  // And the mirrors still cross-check against the new state.
  refreshIntegrity(openSave(res.bytes));
});

test("the leaf list can never reach a progression root", () => {
  // Every copied path is a LEAF under a progression root — never the root
  // itself, which is what `assertContentRoots` refuses.
  for (const p of PROGRESSION_LEAVES) {
    assert.ok(p.includes("."), `${p} must be a leaf`);
    assert.ok(PROGRESS_ROOTS.includes(p.split(".")[0]!), `${p} must live under a progression root`);
  }
  // The guard itself still refuses a progression root outright.
  assert.throws(() => assertContentRoots(["Properties"]), /progression/);
  assert.throws(() => assertContentRoots(["Currency"]), /progression/);
  // ...while the content roots the clone actually sends stay allowed.
  assert.doesNotThrow(() => assertContentRoots(["Repairs", "RoomDesign", "Characters"]));
});
