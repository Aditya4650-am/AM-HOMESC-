import test from "node:test";
import assert from "node:assert/strict";
import { editSeasonTicket, discoverSeasonTickets, planSeasonTicket } from "./season-ticket.ts";
import { openSave } from "./savegame.ts";
import { toBytes } from "./patcher.ts";
import { wrapSave, decodeSave } from "./codec.ts";

function modifier(season: string, expiry = 100, local = true, source = `${season}GoldenTicket`) {
  return { t: "ds", v: { groupId: season, source, isActive: false,
    AvatarModifier: { t: "ds", v: { isLocalPlayer: local, expirationTime: expiry } } } };
}
function fixture(season = "SSPSpooky48") {
  return { GameModifiers: {
    [season]: modifier(season),
    [`${season}GoldenTicketRemoteGroup`]: modifier(`${season}GoldenTicketRemoteGroup`, 999, false, `${season}GoldenTicket`),
  }, Currency: { "Other.amount": 12 }, PlayerItems: { OldTicket: 1 },
  Purchases: { incomplete: [{ transactionId: "error" }] }, SeasonPassInfoCache: { seasonPassEventId: "old" } };
}
const bytes = (v: unknown) => toBytes(JSON.stringify(v, null, "\t").replaceAll("\n", "\r\n"));

test("points creates flat dotted keys for another season and preserves unrelated data", () => {
  const input = fixture("SSPFuture99");
  const out = editSeasonTicket(bytes(input), { action: "points" });
  const actual = JSON.parse(new TextDecoder().decode(out.bytes));
  assert.deepEqual(actual, { ...input, Currency: { ...input.Currency,
    "SSPFuture99Points.amount": 10000, "SSPFuture99Points.prevAmount": 9999 } });
  assert.equal(out.ops.length, 2);
});
test("goldenTicket reads exact source, adds only one item, no time/cache/modifier edits", () => {
  const input = fixture(); input.GameModifiers.SSPSpooky48!.v.source = "SpecialProductGoldenTicket";
  const out = editSeasonTicket(bytes(input), { action: "goldenTicket" });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(out.bytes)), {
    ...input, PlayerItems: { ...input.PlayerItems, SpecialProductGoldenTicket: 1 },
  });
  assert.equal(out.ops.length, 1);
  assert.equal(discoverSeasonTickets(openSave(bytes(input))).length, 1);
});
test("both supports missing containers and repeat application is a byte-identical no-op", () => {
  const input = { GameModifiers: { SSPNew: modifier("SSPNew") } };
  const out = editSeasonTicket(bytes(input), { action: "both", points: 0 });
  const actual = JSON.parse(new TextDecoder().decode(out.bytes));
  assert.deepEqual(actual.Currency, { "SSPNewPoints.amount": 0, "SSPNewPoints.prevAmount": 0 });
  assert.deepEqual(actual.PlayerItems, { SSPNewGoldenTicket: 1 });
  const again = editSeasonTicket(out.encoded, { action: "both", points: 0 });
  assert.deepEqual(again.ops, []); assert.deepEqual(again.encoded, out.encoded);
});
test("multiple seasons prefer live event over later expiry; ties require selection", () => {
  const input = { GameModifiers: { A: modifier("A", 100), B: modifier("B", 200) } };
  const plan = (v: unknown, season?: string) => planSeasonTicket(openSave(bytes(v)), { action: "both", season });
  assert.equal(plan(input).season, "B");
  assert.equal(plan({ ...input, SpecialEvents: { A: { t: "ds", v: { statesGraph: { t: "ds", v: { ptr: { t: "ds", v: { currentState: "InProgress" } } } } } } } }).season, "A");
  input.GameModifiers.A.v.AvatarModifier.v.expirationTime = 200;
  assert.throws(() => plan(input), /Ambiguous/);
  assert.equal(plan(input, "A").season, "A");
  assert.throws(() => plan(input, "missing"), /No matching/);
});
test("invalid points and malformed/nested targets fail before writing", () => {
  for (const n of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => editSeasonTicket(bytes(fixture()), { action: "points", points: n }), /safe integer/);
  }
  const input = fixture();
  assert.throws(() => editSeasonTicket(bytes({ ...input, PlayerItems: null }), { action: "goldenTicket" }), /object/);
  assert.throws(() => editSeasonTicket(bytes({ ...input, Currency: { SSPSpooky48Points: { amount: 1 } } }), { action: "points" }), /nested/);
  assert.throws(() => editSeasonTicket(bytes({}), { action: "both" }), /No matching/);
});
test("supported encrypted container round trips through existing codec", () => {
  const encrypted = wrapSave(bytes(fixture()), "community");
  const out = editSeasonTicket(encrypted, { action: "both" });
  assert.equal(decodeSave(out.encoded).wasEncrypted, true);
  assert.equal(JSON.parse(new TextDecoder().decode(decodeSave(out.encoded).bytes)).PlayerItems.SSPSpooky48GoldenTicket, 1);
});
