import test from "node:test";
import assert from "node:assert/strict";
import { MAX_GP } from "./MAX_GP.ts";
import { toBytes } from "./patcher.ts";

test("MAX_GP automatically updates both features for an arbitrary season, preserves other state", () => {
  const original = {
    GameModifiers: { FutureSeason: { t: "ds", v: {
      groupId: "FutureSeason", source: "FutureSeasonGoldenTicket", isActive: false,
      AvatarModifier: { t: "ds", v: { isLocalPlayer: true, expirationTime: 123 } },
    } } },
    Currency: { "OldPoints.amount": 77 },
    PlayerItems: { Existing: 2 },
    Purchases: { incomplete: [{ transactionId: "error" }] },
    SeasonPassInfoCache: { seasonPassEventId: "Old" },
  };
  const result = MAX_GP(toBytes(JSON.stringify(original)));
  assert.equal(result.season, "FutureSeason");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(result.bytes)), {
    ...original,
    Currency: { ...original.Currency, "FutureSeasonPoints.amount": 10000, "FutureSeasonPoints.prevAmount": 9999 },
    PlayerItems: { ...original.PlayerItems, FutureSeasonGoldenTicket: 1 },
  });
  const again = MAX_GP(result.encoded);
  assert.deepEqual(again.ops, []);
  assert.deepEqual(again.encoded, result.encoded);
});

test("MAX_GP refuses a save without a local season", () => {
  assert.throws(() => MAX_GP(toBytes('{"GameModifiers":{}}')), /No matching/);
});
