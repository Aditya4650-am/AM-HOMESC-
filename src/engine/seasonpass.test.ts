/**
 * Season Pass planner — unit cases that run without a fixture file.
 *
 * Two properties are pinned here, both learned the hard way:
 *
 *   1. `Currency.<season>Points` is usually ABSENT on an account that has never
 *      played the season, and `create()` names a member by the remainder of the
 *      longest prefix that is already an object. Creating the leaves one at a
 *      time would splice literal keys named `"SSPProcedure46Points.amount"` into
 *      `Currency` and corrupt the balance block. Hence ONE whole-subtree op.
 *
 *   2. The stage track is a consistent SET. The 2026-10-20 push that wrote only
 *      the points currency got deleted by the game and rolled the account back,
 *      because `EventLogic.stages[].completed` and `currProgress` were left
 *      contradicting it. The planner must write the ladder, the completions,
 *      `currProgress` and the window/log scalars together — and must NOT touch
 *      the gold row's fields.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { openSave, type SaveGame } from "./savegame.ts";
import { runApply } from "./operations.ts";
import { seasonPointsPath, planSeasonPass } from "./seasonpass.ts";

function saveOf(obj: unknown): SaveGame {
  return openSave(new TextEncoder().encode(JSON.stringify(obj)));
}

/** The donor's measured point ladder, 31 stages, last threshold 845. */
const LADDER = [
  0, 1, 3, 5, 10, 15, 20, 30, 40, 50, 65, 80, 95, 110, 125, 150, 175, 200, 225,
  250, 290, 330, 370, 410, 450, 505, 560, 615, 685, 755, 845,
];

interface Comp { v: { first: string; second: { v: { ptr: { v: Record<string, unknown> } } } } }

const comp = (first: string, fields: Record<string, unknown>): Comp => ({
  v: { first, second: { v: { ptr: { v: fields } } } },
});

/** A stage record exactly as the save holds it. */
const stage = (completed: boolean, pts: number) => ({
  v: { type: "seasonPassStage", ptr: { v: { completed, savedPointsToComplete: pts } } },
});

/** Build `SpecialEvents.<season>` with EventLogic/MainWindow/LogEventComponent. */
function event(
  season: string,
  opts: { progress: number; maxLadder: number[]; golden: boolean },
): Record<string, unknown> {
  const stages = opts.maxLadder.map((pts, i) => stage(i > 0 && i <= opts.progress, pts));
  return {
    [season]: {
      v: {
        components: [
          comp("EventLogic", {
            currProgress: opts.progress,
            isProgressUpdated: opts.progress > 0,
            stages: { v: { ptr: { v: { stages } } } },
          }),
          comp("MainWindow", { currentOpenedStageIndex: opts.progress, openTimesCount: 0 }),
          comp("LogEventComponent", {
            stagesCompletedCount: opts.progress,
            active: opts.progress > 0,
            goldenPassBought: opts.golden,
          }),
        ],
      },
    },
  };
}

/** A maxed donor: full ladder, all but stage 0 complete, golden ticket owned. */
function maxedDonor(season = "SSPProcedure46", points = 10000): SaveGame {
  return saveOf({
    SeasonPassInfoCache: {
      seasonPassEventId: season,
      goldenPassPurchased: true,
      unlockedFree: 31,
      unlockedGold: 31,
    },
    Currency: {
      [`${season}Points`]: { amount: points, prevAmount: points - 1 },
      ExpeditionTickets: { amount: 100, prevAmount: 99 },
    },
    SpecialEvents: event(season, { progress: 30, maxLadder: LADDER, golden: true }),
  });
}

/** An account on the same season, holding no season currency, no progress. */
function freshAccount(season = "SSPProcedure46"): SaveGame {
  return saveOf({
    SeasonPassInfoCache: {
      seasonPassEventId: season,
      goldenPassPurchased: false,
      unlockedFree: 0,
      unlockedGold: 0,
    },
    Currency: { ExpeditionTickets: { amount: 100, prevAmount: 99 } },
    SpecialEvents: event(season, { progress: 0, maxLadder: LADDER, golden: false }),
  });
}

const stagePath = (season: string, i: number) =>
  `SpecialEvents.${season}.v.components[0].v.second.v.ptr.v.stages.v.ptr.v.stages[${i}]`;

test("seasonpass: the points currency is written the way the game writes it", () => {
  const dev = freshAccount();
  const plan = planSeasonPass(dev, maxedDonor());
  assert.equal(plan.season, "SSPProcedure46");
  assert.equal(plan.pointsPath, seasonPointsPath("SSPProcedure46"));

  /*
   * The measured raw form (2026-10-20, donor + the game's own re-saved device
   * file) is TWO FLAT DOTTED-LITERAL members of `Currency` with bare numbers —
   * `"SSPProcedure46Points.amount": 845`. A nested object
   * (`"SSPProcedure46Points": {"amount": ...}`) is a shape the game never
   * writes, and both live pushes that used it were stripped back to the empty
   * placeholder within one save cycle. So the planner must never emit a nested
   * object op, and must never emit a bare-number `.amount` at top level.
   */
  const nested = plan.ops.find((o) => o.path === "Currency.SSPProcedure46Points");
  assert.equal(nested, undefined, "the currency must never be replaced by a nested object");

  const amount = plan.ops.find((o) => o.path === "Currency.SSPProcedure46Points.amount");
  const prev = plan.ops.find((o) => o.path === "Currency.SSPProcedure46Points.prevAmount");
  assert.ok(amount, "expected the flat `…Points.amount` member");
  assert.ok(prev, "expected the flat `…Points.prevAmount` member");
  assert.equal(amount!.create, true);
  // The amount is the ladder's own ceiling, not a round number.
  assert.equal(amount!.value, 845);
  assert.equal(prev!.value, 844);

  const res = runApply(
    new TextEncoder().encode(JSON.stringify({
      SeasonPassInfoCache: {
        seasonPassEventId: "SSPProcedure46",
        goldenPassPurchased: false,
        unlockedFree: 0,
        unlockedGold: 0,
      },
      Currency: { ExpeditionTickets: { amount: 100, prevAmount: 99 } },
      SpecialEvents: event("SSPProcedure46", { progress: 0, maxLadder: LADDER, golden: false }),
    })),
    plan.ops,
  );
  assert.ok(res.ok, res.errors.join("; "));

  const after = openSave(res.bytes);
  assert.equal(after.field("Currency.SSPProcedure46Points.amount").value, 845);
  assert.equal(after.field("Currency.SSPProcedure46Points.prevAmount").value, 844);
  // Flat literal members: no container of that name exists in the save.
  assert.equal(after.index.members.get("Currency.SSPProcedure46Points"), undefined);
  // Both are direct children of Currency, not a nested dictionary.
  assert.deepEqual(
    [...after.children("Currency")].filter((p) => p.includes("Points")).sort(),
    ["Currency.SSPProcedure46Points.amount", "Currency.SSPProcedure46Points.prevAmount"],
  );
  // And the bytes carry the game's own spelling of the key.
  const text = new TextDecoder().decode(res.bytes);
  assert.ok(text.includes('"SSPProcedure46Points.amount":845'), "raw flat key present");

  // Siblings survive untouched.
  assert.equal(after.field("Currency.ExpeditionTickets.amount").value, 100);
});

test("seasonpass: the whole stage set is written consistently", () => {
  const plan = planSeasonPass(freshAccount(), maxedDonor());
  const byPath = new Map(plan.ops.map((o) => [o.path, o.value]));

  /*
   * The walk now emits only leaves that actually DIFFER, so a value the account
   * already holds correctly is not rewritten. What matters is the end state:
   * applying the plan must reproduce the donor's whole stage set.
   */
  assert.equal(byPath.get(`${stagePath("SSPProcedure46", 0)}.v.ptr.v.completed`), undefined,
    "stage 0 already matches the donor, so it is not rewritten");

  const base = "SpecialEvents.SSPProcedure46.v.components[0].v.second.v.ptr.v";
  assert.equal(byPath.get(`${base}.currProgress`), 30);
  assert.equal(byPath.get(`${base}.isProgressUpdated`), true);
  assert.equal(
    byPath.get("SpecialEvents.SSPProcedure46.v.components[1].v.second.v.ptr.v.currentOpenedStageIndex"),
    30,
  );
  const log = "SpecialEvents.SSPProcedure46.v.components[2].v.second.v.ptr.v";
  assert.equal(byPath.get(`${log}.stagesCompletedCount`), 30);
  assert.equal(byPath.get(`${log}.active`), true);
  assert.equal(plan.completedStages, 30);

  // End state: every stage after the entry stage is complete, on the ladder.
  const dev = freshAccount();
  const res = runApply(dev.raw, plan.ops);
  assert.ok(res.ok, res.errors.join("; "));
  const after = openSave(res.bytes);
  for (let i = 0; i < LADDER.length; i++) {
    const p = `${stagePath("SSPProcedure46", i)}.v.ptr.v`;
    assert.equal(after.field(`${p}.savedPointsToComplete`).value, LADDER[i], `stage ${i} ladder`);
    assert.equal(after.field(`${p}.completed`).value, i > 0, `stage ${i} completion`);
  }
  assert.equal(after.field(`${base}.currProgress`).value, 30);
  assert.equal(
    after.field("SpecialEvents.SSPProcedure46.v.components[1].v.second.v.ptr.v.currentOpenedStageIndex").value,
    30,
  );
  assert.equal(after.field(`${log}.stagesCompletedCount`).value, 30);
});

test("seasonpass: the gold row is REFUSED, never asserted", () => {
  const plan = planSeasonPass(freshAccount(), maxedDonor());
  const paths = new Set(plan.ops.map((o) => o.path));

  // The two gold-row fields are left exactly as found.
  assert.equal(paths.has("SeasonPassInfoCache.unlockedGold"), false);
  assert.equal(paths.has("SeasonPassInfoCache.goldenPassPurchased"), false);
  assert.equal(
    paths.has("SpecialEvents.SSPProcedure46.v.components[2].v.second.v.ptr.v.goldenPassBought"),
    false,
    "goldenPassBought is an assertion of a receipt — purchase spoofing",
  );

  assert.equal(plan.goldRow.unlocked, false);
  assert.match(plan.goldRow.reason, /ValidatePurchase|purchase/i);
  // The current planner leaves the cache unchanged (see module contract).
  assert.equal(paths.has("SeasonPassInfoCache.unlockedFree"), false);
});

test("seasonpass: an existing currency is edited in place, not replaced", () => {
  const dev = saveOf({
    SeasonPassInfoCache: { seasonPassEventId: "SSPProcedure46", unlockedFree: 2, unlockedGold: 1 },
    Currency: { SSPProcedure46Points: { amount: 3, prevAmount: 2 } },
    SpecialEvents: event("SSPProcedure46", { progress: 0, maxLadder: LADDER, golden: false }),
  });
  const plan = planSeasonPass(dev, maxedDonor());
  assert.equal(
    plan.ops.some((o) => o.path === "Currency.SSPProcedure46Points" && o.create),
    false,
    "must not replace an object the account already owns",
  );
  const byPath = new Map(plan.ops.map((o) => [o.path, o.value]));
  assert.equal(byPath.get("Currency.SSPProcedure46Points.amount"), 845);
  assert.equal(byPath.get("Currency.SSPProcedure46Points.prevAmount"), 844);
});

test("seasonpass: a season the donor never played is refused, not invented", () => {
  // The account is on SSPProcedure49; the donor only ever maxed SSPProcedure46.
  // There is no measured ladder for the new season, so the only honest answer
  // is a refusal — inventing thresholds would be a value the game would revert.
  const dev = saveOf({
    SeasonPassInfoCache: { seasonPassEventId: "SSPProcedure49" },
    Currency: {},
    SpecialEvents: event("SSPProcedure49", { progress: 0, maxLadder: LADDER, golden: false }),
  });
  assert.throws(
    () => planSeasonPass(dev, maxedDonor("SSPProcedure46")),
    /donor holds no SpecialEvents\.SSPProcedure49\.v to copy from/,
  );
});

test("seasonpass: a save with no live season is refused, not quietly no-oped", () => {
  const dev = saveOf({ Currency: {}, SeasonPassInfoCache: {} });
  assert.throws(() => planSeasonPass(dev, maxedDonor()), /no live season/);
});

test("seasonpass: no cache but a live event adopts the season, and says so", () => {
  const dev = saveOf({
    Currency: {},
    SpecialEvents: event("SSPProcedure46", { progress: 0, maxLadder: LADDER, golden: false }),
  });
  const plan = planSeasonPass(dev, maxedDonor("SSPProcedure46"));
  assert.equal(plan.season, "SSPProcedure46");
  assert.ok(plan.notes.some((n) => n.includes("no live season")));
});

test("seasonpass: a missing event is surfaced, because the window needs it", () => {
  const dev = saveOf({
    SeasonPassInfoCache: { seasonPassEventId: "SSPProcedure46" },
    Currency: {},
  });
  assert.throws(
    () => planSeasonPass(dev, maxedDonor()),
    /SpecialEvents\.SSPProcedure46\.v is not present on this account/,
  );
});

test("seasonpass: the account's own component index is used when it differs", () => {
  // Account has EventLogic at index 3, donor has it at 0.
  const dev = saveOf({
    SeasonPassInfoCache: { seasonPassEventId: "SSPProcedure46" },
    Currency: { SSPProcedure46Points: { amount: 0, prevAmount: 0 } },
    SpecialEvents: {
      SSPProcedure46: {
        v: {
          components: [
            comp("Cheats", {}),
            comp("Dispatcher", {}),
            comp("MainWindow", { currentOpenedStageIndex: 0, openTimesCount: 0 }),
            comp("EventLogic", {
              currProgress: 0,
              isProgressUpdated: false,
              stages: { v: { ptr: { v: { stages: LADDER.map((p) => stage(false, p)) } } } },
            }),
            comp("LogEventComponent", { stagesCompletedCount: 0, active: false, goldenPassBought: false }),
          ],
        },
      },
    },
  });
  const plan = planSeasonPass(dev, maxedDonor());
  assert.equal(plan.eventLogicIndex, 3);
  assert.ok(
    plan.ops.some((o) => o.path.startsWith("SpecialEvents.SSPProcedure46.v.components[3]")),
    "ops must target the account's index, not the donor's",
  );
  assert.ok(plan.notes.some((n) => n.includes("component 3")));
});

test("seasonpass: a re-ordered component list is matched by NAME, never by position", () => {
  /*
   * The corruption this pins (measured on a synthetic re-ordered save before the
   * fix): the plan was built by diffing `components[]` positionally, so an
   * account holding [Cheats, Dispatcher, EventLogic] was diffed against a donor
   * holding [EventLogic, MainWindow, LogEventComponent]. Writes landed on the
   * wrong components AND `components[0].v.first` was rewritten to
   * "EventLogic" — i.e. the account's own components were renamed.
   *
   * A component's name is its identity, so the correct behaviour is: match by
   * name, write only inside the account's own component, never touch `v.first`,
   * and leave components the donor does not have exactly as found.
   */
  const devObj = {
    SeasonPassInfoCache: { seasonPassEventId: "SSPProcedure46" },
    Currency: { SSPProcedure46Points: { amount: 0, prevAmount: 0 } },
    SpecialEvents: {
      SSPProcedure46: {
        v: {
          components: [
            comp("Cheats", { speed: 3 }),
            comp("Dispatcher", { queue: 7 }),
            comp("MainWindow", { currentOpenedStageIndex: 0, openTimesCount: 0 }),
            comp("EventLogic", {
              currProgress: 0,
              isProgressUpdated: false,
              stages: { v: { ptr: { v: { stages: LADDER.map((p) => stage(false, p)) } } } },
            }),
            comp("LogEventComponent", { stagesCompletedCount: 0, active: false, goldenPassBought: false }),
          ],
        },
      },
    },
  };
  const dev = saveOf(devObj);
  const plan = planSeasonPass(dev, maxedDonor());

  // 1. No op may rename a component.
  for (const op of plan.ops) {
    assert.ok(
      !/\.components\[\d+\]\.v\.first$/.test(op.path),
      `component identity must never be written: ${op.path}`,
    );
  }

  // 2. Nothing may be written inside a component the donor does not have.
  for (const op of plan.ops) {
    assert.ok(
      !op.path.startsWith("SpecialEvents.SSPProcedure46.v.components[0].") &&
        !op.path.startsWith("SpecialEvents.SSPProcedure46.v.components[1]."),
      `must not write into a component only the account owns: ${op.path}`,
    );
  }

  // 3. Applying must move the donor's state into the account's OWN indices.
  const res = runApply(new TextEncoder().encode(JSON.stringify(devObj)), plan.ops);
  assert.ok(res.ok, res.errors.join("; "));
  const after = openSave(res.bytes);

  const name = (i: number) =>
    String(after.field(`SpecialEvents.SSPProcedure46.v.components[${i}].v.first`).value);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map(name),
    ["Cheats", "Dispatcher", "MainWindow", "EventLogic", "LogEventComponent"],
    "component names are untouched",
  );
  assert.equal(after.field("SpecialEvents.SSPProcedure46.v.components[0].v.second.v.ptr.v.speed").value, 3);
  assert.equal(after.field("SpecialEvents.SSPProcedure46.v.components[1].v.second.v.ptr.v.queue").value, 7);

  const logic = "SpecialEvents.SSPProcedure46.v.components[3].v.second.v.ptr.v";
  assert.equal(after.field(`${logic}.currProgress`).value, 30);
  assert.equal(after.field(`${logic}.isProgressUpdated`).value, true);
  assert.equal(after.field(`${logic}.stages.v.ptr.v.stages[30].v.ptr.v.completed`).value, true);
  assert.equal(
    after.field("SpecialEvents.SSPProcedure46.v.components[2].v.second.v.ptr.v.currentOpenedStageIndex").value,
    30,
  );
  assert.equal(
    after.field("SpecialEvents.SSPProcedure46.v.components[4].v.second.v.ptr.v.stagesCompletedCount").value,
    30,
  );
  // The gold-row receipt is still refused, on a re-ordered save too.
  assert.equal(
    after.field("SpecialEvents.SSPProcedure46.v.components[4].v.second.v.ptr.v.goldenPassBought").value,
    false,
  );
});
