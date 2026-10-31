/**
 * Engine tests. Run with:
 *   node --experimental-strip-types --test src/engine/*.test.ts
 *
 * The integration cases need a real save. They read it from `HS_FIXTURE`
 * (defaulting to the sample save in the user's Downloads folder) and SKIP —
 * not fail — when it is absent, so the pure-unit cases still run anywhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scanSpans, valueText } from "./json-span.ts";
import {
  applyEdits,
  encodeJsonNumber,
  encodeJsonString,
  PatchError,
  toBytes,
} from "./patcher.ts";
import { decodeSave, encodeSave, describeContainer, wrapSave, withEmptyValuesAsNull } from "./codec.ts";
import { openSave, SaveError, type SaveGame } from "./savegame.ts";
import {
  BOOSTER_PATHS,
  expectedR4Value,
  readIntegrity,
  refreshIntegrity,
  toU32,
} from "./integrity.ts";
import { COSMETICS, cosmeticOps, equipManyOps, equipOps, grantOps } from "./cosmetics.ts";
import { runApply } from "./operations.ts";

/*
 * Integration cases need a real save. Resolution order:
 *
 *   1. `HS_FIXTURE` (a full-size save pulled off a device — what these tests
 *      were originally written against);
 *   2. the save this repository actually ships (`data/IGG-account.db`), which is
 *      a real 4.3 MB container and therefore exercises the same scanner,
 *      patcher and integrity code paths;
 *   3. skip.
 *
 * Before this, the only fallback was one developer's Windows Downloads path, so
 * on CI (and on any machine but that one) fourteen integration cases silently
 * skipped — the engine's most important guarantees were never checked
 * automatically.
 */
const SHIPPED_FIXTURE = fileURLToPath(new URL("../../data/IGG-account.db", import.meta.url));
const FIXTURE =
  process.env.HS_FIXTURE ??
  (existsSync(SHIPPED_FIXTURE) ? SHIPPED_FIXTURE : "C:\\Users\\User\\Downloads\\Telegram Desktop\\SaveGame.db");

const haveFixture = existsSync(FIXTURE);

/**
 * Real 9.2.101 container pulled from the running emulator (db/bak/buf live in
 * G:\hs_build). These are the ONLY files that prove the f205 key: the legacy
 * sample never exercised it.
 */
/*
 * The XOR-wrapped 9.2.101 container is the only thing that proves the f205 key.
 * It is not shipped (it is a live player save and the repo already carries one),
 * so these cases stay opt-in via `HS_LIVE` — but the skip message now names the
 * variable, so a failure reads as "not configured", not "broken".
 */
const LIVE_FIXTURE = process.env.HS_LIVE ?? "";
const haveLiveFixture = LIVE_FIXTURE.length > 0 && existsSync(LIVE_FIXTURE);
const loadFixture = (): Uint8Array => new Uint8Array(readFileSync(FIXTURE));

// --------------------------------------------------------------- pure unit --

test("encodeJsonNumber never emits an exponent or a leading plus", () => {
  assert.equal(encodeJsonNumber(0), "0");
  assert.equal(encodeJsonNumber(-0), "0");
  assert.equal(encodeJsonNumber(655), "655");
  assert.equal(encodeJsonNumber(-2147482755), "-2147482755");
  assert.equal(encodeJsonNumber(2144822766), "2144822766");
  assert.equal(encodeJsonNumber(1.5), "1.5");
  assert.throws(() => encodeJsonNumber(Number.NaN), PatchError);
  assert.throws(() => encodeJsonNumber(Number.POSITIVE_INFINITY), PatchError);
});

test("encodeJsonString escapes only what JSON requires", () => {
  assert.equal(encodeJsonString("5"), '"5"');
  assert.equal(encodeJsonString('a"b'), '"a\\"b"');
  assert.equal(encodeJsonString("a\\b"), '"a\\\\b"');
});

test("applyEdits splices length-changing edits without shifting later ones", () => {
  const raw = toBytes('{"a": 12345, "b": 7}');
  const idx = scanSpans(raw);
  const a = idx.members.get("a")!;
  const b = idx.members.get("b")!;
  const { out } = applyEdits(raw, [
    { start: a.valStart, end: a.valEnd, bytes: toBytes("9"), label: "shrink a" },
    { start: b.valStart, end: b.valEnd, bytes: toBytes("700"), label: "grow b" },
  ]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(out)), { a: 9, b: 700 });
});

test("applyEdits rejects overlapping edits", () => {
  const raw = toBytes('{"a": 1}');
  assert.throws(
    () =>
      applyEdits(raw, [
        { start: 0, end: 5, bytes: toBytes("x"), label: "one" },
        { start: 3, end: 8, bytes: toBytes("y"), label: "two" },
      ]),
    (err: unknown) => err instanceof PatchError && /overlapping/.test((err as Error).message),
  );
});

test("applyEdits rejects out-of-bounds edits", () => {
  const raw = toBytes('{"a": 1}');
  assert.throws(
    () => applyEdits(raw, [{ start: 0, end: 99, bytes: toBytes("x"), label: "oob" }]),
    PatchError,
  );
});

test("scanSpans handles escapes, nested objects and arrays", () => {
  const raw = toBytes('{"k": "a\\"b", "o": {"n": [1, 2, {"q": null}]}}');
  const idx = scanSpans(raw);
  assert.equal(idx.rootType, "object");
  assert.equal(idx.members.size, 7);
  assert.equal(valueText(raw, idx.members.get("k")!), '"a\\"b"');
  assert.equal(idx.members.get("o.n[0]")!.type, "number");
  assert.equal(idx.members.get("o.n[2].q")!.type, "null");
  assert.equal(idx.rootEnd, raw.length);
});

test("codec treats plain JSON as the certain fast path", () => {
  const raw = toBytes('{"x": 1}');
  const dec = decodeSave(raw);
  assert.equal(dec.wasEncrypted, false);
  assert.equal(dec.confidence, "certain");
  assert.equal(describeContainer(raw), "plain JSON object");
});

test("codec refuses to invent plaintext from an unknown container", () => {
  const junk = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
  const dec = decodeSave(junk);
  assert.equal(dec.confidence, "heuristic");
  assert.ok(dec.warning, "expected a warning about the unknown container");
});

test("codec round-trips an XOR-wrapped buffer", () => {
  const plain = toBytes('{"x": 1}');
  const wrapped = encodeSave(plain, true);
  assert.notDeepEqual(wrapped, plain);
  const dec = decodeSave(wrapped);
  assert.equal(dec.wasEncrypted, true);
  assert.equal(dec.keyId, "f205", "boolean wrap now uses the device-proven key");
  assert.deepEqual(dec.bytes, plain);
});

test("codec statistically recovers a per-install key and round-trips byte-exact", () => {
  // Save-shaped JSON big enough that every key position gets ~160 byte votes
  // (real saves are 320 KB–4.5 MB; the frequency model needs mass, not data).
  const block = '"P":{"coins":1010,"stars":0,"name":"HSTester","avatarId":"14","level":123},';
  const plain = toBytes(`{"GameTrophy":{"Trophies":{}},${block.repeat(1600)}"tail":1}`);
  // Deterministic pseudo-random 731-byte key in printable ASCII (0x20–0x7E),
  // matching real per-install keys (all printable, none set bit 7).
  const key = new Uint8Array(731);
  let seed = 0x12345678;
  for (let i = 0; i < 731; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    key[i] = 0x20 + ((seed >>> 16) % 95);
  }
  const ct = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i++) ct[i] = plain[i]! ^ key[i % 731]!;

  const dec = decodeSave(ct);
  assert.equal(dec.keyId, "recovered", "unknown per-install key must be recovered statistically");
  assert.ok(dec.key, "recovered key bytes must ride on the result");
  assert.deepEqual(dec.bytes, plain, "recovered decode equals the plaintext");
  assert.deepEqual(encodeSave(dec.bytes, dec), ct, "byte-exact re-encode with the recovered key");
  assert.equal(
    describeContainer(ct),
    "XOR container (per-install key recovered statistically)",
    "describeContainer names the recovery path",
  );
});

test("codec falls back to the legacy community key with a warning", () => {
  const plain = toBytes('{"x": 1}');
  const wrapped = wrapSave(plain, "community");
  const dec = decodeSave(wrapped);
  assert.equal(dec.keyId, "community");
  assert.equal(dec.wasEncrypted, true);
  assert.ok(dec.warning, "legacy key must surface a warning");
  assert.deepEqual(dec.bytes, plain);
  assert.deepEqual(encodeSave(dec.bytes, dec), wrapped, "legacy wrap round-trips");
});

test("codec strips the device NUL terminator and restores it exactly once", () => {
  const plain = toBytes('{"x":1}');
  const device = wrapSave(plain, "f205", new Uint8Array([0x00]));
  const dec = decodeSave(device);
  assert.deepEqual(dec.bytes, plain, "engine sees pure JSON");
  assert.deepEqual(Array.from(dec.trailer), [0x00]);
  assert.deepEqual(encodeSave(dec.bytes, dec), device, "byte-exact round-trip");
  const withNul = new Uint8Array(plain.length + 1);
  withNul.set(plain);
  assert.deepEqual(
    encodeSave(withNul, dec),
    device,
    "must not double-append a trailer the caller already carries",
  );
});

test("wrong key is rejected, not silently accepted", () => {
  const plain = toBytes('{"x": 1}');
  const wrapped = wrapSave(plain, "f205");
  const doubleWrapped = wrapSave(wrapped, "community");

  // A correctly wrapped buffer resolves to the device key (f205 first).
  assert.equal(decodeSave(wrapped).keyId, "f205");

  // Wrapped twice, neither known key can produce valid JSON — even though the
  // buffer still starts with '{' (both keys share byte 0) — so the codec must
  // refuse with a heuristic result instead of accepting it as plain JSON.
  const dec = decodeSave(doubleWrapped);
  assert.equal(dec.keyId, null);
  assert.equal(dec.confidence, "heuristic");
  assert.ok(dec.warning, "expected a refusal warning");
});

test("toU32 wraps negatives the way the client does", () => {
  assert.equal(toU32(-2147482755), 2147484541);
  assert.equal(toU32(5), 5);
  assert.equal(toU32(0), 0);
});

// ------------------------------------------------------------ integration --
// Everything below needs the real 4.5 MB save.

test(
  "fixture: full scan matches the known shape",
  { skip: haveFixture ? false : `fixture not found at ${FIXTURE}` },
  () => {
    const raw = loadFixture();
    const idx = scanSpans(raw);
    assert.equal(idx.rootType, "object");
    /*
     * The scanner must consume the entire container and record every member.
     * The byte LENGTH is deliberately not asserted: the two real fixtures in use
     * (the shipped `data/IGG-account.db` and the full-size device pull) hold the
     * same 130,191 members but differ by ~180 KB of whitespace and a trailing
     * NUL. Only the trailing NUL/whitespace may sit outside the root.
     */
    assert.ok(idx.rootEnd <= raw.length, "root cannot extend past the buffer");
    for (let i = idx.rootEnd; i < raw.length; i++) {
      const b = raw[i]!;
      assert.ok(
        b === 0x00 || b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d,
        `only NUL/whitespace may follow the root — found 0x${b.toString(16)} at ${i}`,
      );
    }
    assert.equal(idx.members.size, 130191, "every member of the known save is indexed");
  },
);

test(
  "fixture: known fields resolve by path, not by text search",
  { skip: haveFixture ? false : `fixture not found at ${FIXTURE}` },
  () => {
    const raw = loadFixture();
    const save = openSave(raw);
    assert.equal(save.number("Properties.coins"), 2144822766);
    assert.equal(save.number("Properties.level"), 655);
    assert.equal(save.number("Properties.earnedStars"), -2147482755);
    assert.equal(save.number("Properties.spentStars"), 1763);
    assert.equal(save.number("Properties.lives.current"), 5);

    // The literal `"level": 655` occurs 3x (twice inside Incomes history).
    // Path lookup must land on exactly the Properties one.
    // NOTE: byte-pattern search needs Buffer — Uint8Array#indexOf coerces its
    // argument to a number (a Uint8Array becomes NaN → always -1).
    const needle = toBytes('"level": 655');
    const buf = Buffer.from(raw);
    let hits = 0;
    for (let i = buf.indexOf(needle); i >= 0; i = buf.indexOf(needle, i + 1)) hits++;
    assert.equal(hits, 3, "expected 3 literal occurrences of the level needle");
    const span = save.span("Properties.level");
    assert.equal(valueText(raw, span), "655");
    assert.equal(new TextDecoder().decode(raw.subarray(span.valStart - 9, span.valStart)), '"level": ');
  },
);

test(
  "fixture: no-op commit returns the buffer untouched",
  { skip: haveFixture ? false : `fixture not found at ${FIXTURE}` },
  () => {
    const raw = loadFixture();
    const save = openSave(raw);
    const { bytes, summary } = save.commit();
    assert.equal(summary.length, 0);
    assert.deepEqual(bytes, raw);
  },
);

test(
  "fixture: editing coins keeps every other byte identical and stays valid JSON",
  { skip: haveFixture ? false : `fixture not found at ${FIXTURE}` },
  () => {
    const raw = loadFixture();
    const save = openSave(raw);
    save.set("Properties.coins", 999999999);
    const { bytes, summary } = save.commit();
    assert.equal(summary.length, 1);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)).Properties.coins, 999999999);

    // Untouched regions must be byte-identical.
    const out = save.index; // spans from BEFORE the edit
    const coins = out.members.get("Properties.coins")!;
    const before = raw.subarray(0, coins.valStart);
    const after = raw.subarray(coins.valEnd);
    const outText = new TextDecoder().decode(bytes);
    assert.equal(outText.startsWith(new TextDecoder().decode(before)), true);
    assert.equal(outText.endsWith(new TextDecoder().decode(after)), true);
  },
);

test(
  "save: edits a save that carries a Playrix empty-value member, and the patch stays valid",
  { skip: haveFixture ? false : `fixture not found at ${FIXTURE}` },
  () => {
    // Playrix writes datastore members it holds without a value as an empty
    // member: `"Currency."SSPProcedure46Points":,`. Its own parser reads that
    // as null; JSON.parse does not — so commit() must tolerate the source save
    // carrying it rather than refusing every edit.
    const raw = toBytes(
      '{"Properties":{"coins":5},"Currency":{"ExpeditionTickets.amount":100,"SSPProcedure46Points":,"SSPSpooky48Points.amount":845}}',
    );
    const save = openSave(raw);
    save.set("Properties.coins", 999999999);
    const { bytes, summary } = save.commit();
    assert.equal(summary.length, 1);
    const doc = JSON.parse(withEmptyValuesAsNull(new TextDecoder().decode(bytes)));
    assert.equal(doc.Properties.coins, 999999999);
  },
);

test(
  "fixture: a tagged i64 field keeps its wrapper and stores a string value",
  { skip: haveFixture ? false : `fixture not found at ${FIXTURE}` },
  () => {
    const raw = loadFixture();
    const save = openSave(raw);
    // Find any tagged i64 field to prove wrapper preservation generically.
    let target: string | undefined;
    for (const p of save.paths()) {
      const m = save.index.members.get(p)!;
      if (m.type !== "object") continue;
      const kids = save.index.children.get(p);
      if (kids && kids.length === 2 && kids.includes(`${p}.t`) && kids.includes(`${p}.v`)) {
        if (save.field(p).kind === "tagged-i64") {
          target = p;
          break;
        }
      }
    }
    assert.ok(target, "expected at least one tagged i64 field in the save");
    const f = save.field(target!);
    assert.equal(f.tag, "i64");
    assert.equal(typeof f.value, "number");
    const wrapperBefore = f.raw;
    save.set(target!, 4242);
    const { bytes } = save.commit();
    const outText = new TextDecoder().decode(bytes);
    const innerStart = f.innerSpan!.valStart;
    const innerEnd = f.innerSpan!.valEnd;
    const srcText = new TextDecoder().decode(raw);

    // Everything before the inner value must be untouched...
    assert.equal(outText.slice(0, innerStart), srcText.slice(0, innerStart));
    // ...and everything after it must be untouched too.
    assert.equal(outText.slice(innerStart + '"4242"'.length), srcText.slice(innerEnd));
    // ...and the new inner value is a JSON string, as i64 tags require.
    assert.equal(outText.slice(innerStart, innerStart + '"4242"'.length), '"4242"');
    // The wrapper's tag survives.
    assert.ok(outText.includes('"t": "i64"'), "tag wrapper must survive the edit");
    assert.notEqual(wrapperBefore, undefined);
  },
);

test(
  "fixture: integrity strings cross-check against live state",
  { skip: haveFixture ? false : `fixture not found at ${FIXTURE}` },
  () => {
    const save = openSave(loadFixture());
    const rep = readIntegrity(save);
    assert.ok(rep.r1.present, "R1 should exist");
    assert.ok(rep.r4.present, "R4 should exist");
    assert.equal(rep.r1.parts.C, "2144822766");
    assert.equal(rep.expectedR1Coins, 2144822766);
    // Proven formula: (earnedStars mod 2^32) - spentStars
    assert.equal(rep.expectedR4Value, 2147482778);
    assert.equal(rep.r4.parts.V, "2147482778");
    assert.equal(expectedR4Value(save), 2147482778);
    // R8/R9 are stale mirrors; the drift detector should say so rather than
    // pretending they are exact.
    assert.ok(rep.boosterDrift.length > 0, "expected the booster drift detector to fire");
  },
);

test(
  "fixture: integrity refresh rewrites R1 and R4 but leaves R8/R9 alone",
  { skip: haveFixture ? false : `fixture not found at ${FIXTURE}` },
  () => {
    const save = openSave(loadFixture());
    const r8Before = save.string("Properties.CeReas_R8");
    const r9Before = save.string("Properties.CeReas_R9");

    save.set("Properties.coins", 123456789);
    save.set("Properties.earnedStars", 1000);
    const res = refreshIntegrity(save);
    assert.equal(res.applied.length, 2, `expected 2 integrity edits, got ${JSON.stringify(res.applied)}`);

    const { bytes } = save.commit();
    const doc = JSON.parse(new TextDecoder().decode(bytes));
    assert.equal(doc.Properties.CeReas_R1, "R1: C=123456789,MTC=1000000,P=0,MP=5");
    // Proven formula: V = (earnedStars mod 2^32) - spentStars. With the
    // post-edit values earnedStars=1000 and spentStars=1763 (unchanged):
    // toU32(1000) - 1763 = -763.
    assert.equal(doc.Properties.CeReas_R4, "R4: V:-763,MV:22500");
    assert.equal(doc.Properties.CeReas_R8, r8Before, "R8 must be untouched");
    assert.equal(doc.Properties.CeReas_R9, r9Before, "R9 must be untouched");
  },
);

test(
  "fixture: the booster catalog paths all exist",
  { skip: haveFixture ? false : `fixture not found at ${FIXTURE}` },
  () => {
    const save = openSave(loadFixture());
    for (const b of BOOSTER_PATHS) {
      assert.ok(save.has(b.path), `missing booster path ${b.path}`);
      assert.equal(typeof save.number(b.path), "number");
    }
  },
);

test("save: refuses to replace a container wholesale", () => {
  const save: SaveGame = openSave(toBytes('{"o": {"a": 1}, "n": 2}'));
  assert.throws(() => save.set("o", 5), SaveError);
  assert.throws(() => save.set("nope", 5), SaveError);
});

test("save: materializes a null leaf into a constructed object", () => {
  const raw = toBytes('{"meta":{"a":1},"mods":null,"tail":true}');
  const save = openSave(raw);
  save.set("mods", { frame: { id: "X", n: 3, on: true }, list: [1, "two", null] });
  const { bytes, summary } = save.commit();
  assert.equal(summary.length, 1);
  assert.match(summary[0]!.label, /\{2 keys\}/, "label must summarize, not dump");
  const doc = JSON.parse(new TextDecoder().decode(bytes));
  assert.deepEqual(doc.mods, { frame: { id: "X", n: 3, on: true }, list: [1, "two", null] });
  // Everything outside the spliced span is byte-identical.
  const src = new TextDecoder().decode(raw);
  const out = new TextDecoder().decode(bytes);
  assert.equal(out.startsWith('{"meta":{"a":1},"mods":'), true);
  assert.equal(out.endsWith(',"tail":true}'), true);
  assert.equal(src.indexOf(',"tail":true}') > 0, true);
});

test("save: scalar onto null works; existing containers still refused", () => {
  const save = openSave(toBytes('{"o": {"a": 1}, "n": null}'));
  assert.throws(() => save.set("o", { b: 2 }), SaveError, "existing object must stay refused");
  save.set("n", 42);
  const { bytes } = save.commit();
  assert.equal(JSON.parse(new TextDecoder().decode(bytes)).n, 42);
});

test("save: constructed subtrees reject values JSON cannot hold", () => {
  const mk = () => openSave(toBytes('{"n": null}'));
  assert.throws(() => mk().set("n", { x: undefined } as never), SaveError, "undefined");
  assert.throws(() => mk().set("n", { x: NaN }), SaveError, "NaN");
  assert.throws(() => mk().set("n", { x: Infinity }), SaveError, "Infinity");
  assert.throws(
    () => mk().set("n", { x: new Date() } as never),
    SaveError,
    "non-plain object",
  );
  assert.throws(() => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    mk().set("n", cyc as never);
  }, SaveError, "cycle");
});

test("save: create() inserts a new member into an existing object", () => {
  const raw = toBytes('{"Properties":{"coins":7},"tail":1}');
  const save = openSave(raw);
  save.create("Properties.level", 100);
  const { bytes, summary } = save.commit();
  const doc = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(doc.Properties.level, 100);
  assert.equal(doc.Properties.coins, 7, "sibling preserved");
  assert.equal(doc.tail, 1, "root sibling preserved");
  assert.equal(summary.length, 1);
  assert.equal(summary[0]!.label, "+ Properties.level = 100");
  assert.equal(summary[0]!.before, "}", "spans the parent's closing brace");
});

test("save: create() honors the dotted-literal key convention", () => {
  const save = openSave(toBytes('{"Properties":{"lives.current":5}}'));
  save.create("Properties.lives.max", 9);
  const { bytes } = save.commit();
  const doc = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(doc.Properties["lives.current"], 5);
  assert.equal(doc.Properties["lives.max"], 9, "literal key, exactly like the game");
  assert.equal(doc.Properties.lives, undefined, "must NOT invent a nested object");
});

test("save: create() refuses duplicates, orphans and null parents", () => {
  const save = openSave(toBytes('{"a":{"b":1},"n":null}'));
  assert.throws(() => save.create("a.b", 2), SaveError, "duplicate");
  assert.throws(() => save.create("zzz.b", 2), SaveError, "orphan parent");
  assert.throws(() => save.create("n.child", 2), SaveError, "null parent is not an object");
});

test("save: create() handles empty objects, root-level, and rejects bad values", () => {
  const e = openSave(toBytes('{"e":{}}'));
  e.create("e.k", true);
  assert.equal(JSON.parse(new TextDecoder().decode(e.commit().bytes)).e.k, true);

  const r = openSave(toBytes('{"z":1}'));
  r.create("top", [1, 2]);
  const doc = JSON.parse(new TextDecoder().decode(r.commit().bytes));
  assert.deepEqual(doc.top, [1, 2], "root-level create");
  assert.equal(doc.z, 1);

  assert.throws(
    () => openSave(toBytes('{"e":{}}')).create("e.k", NaN),
    SaveError,
    "non-finite rejected",
  );
});

// -------------------------------------------------- device container (live) --
// Proves the f205 key against files the shipping 9.2.101 client actually
// wrote, including byte-exact re-encoding — the property that matters before
// anything is pushed back to a device.

test(
  "live container: f205 key decodes to valid JSON and round-trips byte-exactly",
  { skip: haveLiveFixture ? false : `live container not found at ${LIVE_FIXTURE}` },
  () => {
    const raw = new Uint8Array(readFileSync(LIVE_FIXTURE));
    const dec = decodeSave(raw);

    assert.equal(dec.confidence, "certain");
    assert.equal(dec.keyId, "f205");
    assert.equal(dec.wasEncrypted, true);
    assert.equal(dec.warning, undefined, "device-proven key needs no warning");

    // The engine must see pure JSON; the NUL terminator stays with the codec.
    assert.deepEqual(Array.from(dec.trailer), [0x00]);
    const doc = JSON.parse(new TextDecoder().decode(dec.bytes));
    assert.ok(doc.Properties, "root must contain Properties");

    // Cross-check against the live HUD screenshot of this account.
    assert.equal(doc.Properties.coins, 1010);
    assert.equal(doc.Properties["lives.current"], 5);

    // Container round-trip must be byte-identical: any drift here would
    // corrupt the save when pushed back to the device.
    assert.deepEqual(encodeSave(dec.bytes, dec), raw);
  },
);

test(
  "live container: a surgical coin edit survives decode/encode unchanged elsewhere",
  { skip: haveLiveFixture ? false : `live container not found at ${LIVE_FIXTURE}` },
  () => {
    const raw = new Uint8Array(readFileSync(LIVE_FIXTURE));
    const dec = decodeSave(raw);
    const save = openSave(dec.bytes);

    save.set("Properties.coins", 777777);
    const { bytes: edited } = save.commit();
    const reEncoded = encodeSave(edited, dec);

    // "1010" (4 bytes) -> "777777" (6 bytes): exactly +2, nothing else.
    assert.equal(reEncoded.length, raw.length + 2);

    // Re-decode the edited container and confirm only coins moved.
    const dec2 = decodeSave(reEncoded);
    assert.equal(dec2.keyId, "f205");
    assert.deepEqual(Array.from(dec2.trailer), [0x00], "trailer must survive");

    const doc1 = JSON.parse(new TextDecoder().decode(dec.bytes));
    const doc2 = JSON.parse(new TextDecoder().decode(dec2.bytes));
    assert.equal(doc2.Properties.coins, 777777);
    assert.equal(doc2.Properties["lives.current"], 5, "lives must be untouched");

    // Structural proof: doc2 equals doc1 with only the coins value replaced.
    // (Key order and every other byte of the JSON stay as the game wrote them.)
    const expected = JSON.parse(JSON.stringify(doc1));
    expected.Properties.coins = 777777;
    assert.deepEqual(doc2, expected, "exactly one value may change per edit");
  },
);

test(
  "live siblings: bak and buf decode with the same key",
  { skip: haveLiveFixture ? false : `live container not found at ${LIVE_FIXTURE}` },
  () => {
    for (const sibling of ["G:\\hs_build\\live1.bak", "G:\\hs_build\\live1.buf"]) {
      if (!existsSync(sibling)) continue;
      const raw = new Uint8Array(readFileSync(sibling));
      const dec = decodeSave(raw);
      assert.equal(dec.keyId, "f205", `${sibling} must decode with the f205 key`);
      JSON.parse(new TextDecoder().decode(dec.bytes)); // throws on failure
      assert.deepEqual(encodeSave(dec.bytes, dec), raw, `${sibling} round-trip`);
    }
  },
);

test(
  "live container: materializing Avatars/PlayerItems/GameModifiers survives encode",
  { skip: haveLiveFixture ? false : `live container not found at ${LIVE_FIXTURE}` },
  () => {
    const raw = new Uint8Array(readFileSync(LIVE_FIXTURE));
    const dec = decodeSave(raw);
    const save = openSave(dec.bytes);
    assert.equal(save.field("Avatars").span.type, "null", "fresh account starts with null Avatars");

    save.set("Avatars", { unlocked1: true, isNew1: false, unlocked144: true, isNew144: false });
    save.set("PlayerItems", { BombAndLineBoost: 5, LightningBoost: 5 });
    save.set("GameModifiers", {
      SSPProcedure46: {
        t: "ds",
        v: {
          groupId: "SSPProcedure46",
          source: "SSPProcedure46GoldenTicket",
          isActive: true,
          AvatarModifier: {
            t: "ds",
            v: {
              borderEffectId: "SP_AvaGlare",
              frameSwl: "UI_SeasonPass_Frames",
              frameTex: "UI_SSP_avatar_border",
              isLocalPlayer: true,
              expirationTime: 1893456000,
            },
          },
        },
      },
    });
    const { bytes: edited } = save.commit();
    const reEncoded = encodeSave(edited, dec);

    const dec2 = decodeSave(reEncoded);
    assert.equal(dec2.keyId, "f205");
    assert.deepEqual(Array.from(dec2.trailer), [0x00]);

    const doc1 = JSON.parse(new TextDecoder().decode(dec.bytes));
    const doc2 = JSON.parse(new TextDecoder().decode(dec2.bytes));
    assert.deepEqual(doc2.Avatars, {
      unlocked1: true, isNew1: false, unlocked144: true, isNew144: false,
    });
    assert.equal(doc2.PlayerItems.BombAndLineBoost, 5);
    assert.equal(
      doc2.GameModifiers.SSPProcedure46.v.AvatarModifier.v.expirationTime,
      1893456000,
    );
    // Untouched siblings keep their original values.
    assert.equal(doc2.Properties.coins, doc1.Properties.coins);
    assert.deepEqual(doc2.Garment, doc1.Garment);

    // Structural proof: only the three materialized groups differ.
    const expected = JSON.parse(JSON.stringify(doc1));
    expected.Avatars = doc2.Avatars;
    expected.PlayerItems = doc2.PlayerItems;
    expected.GameModifiers = doc2.GameModifiers;
    assert.deepEqual(doc2, expected, "exactly the three constructed groups may change");
  },
);

// --------------------------------------------------------------- cosmetics --

/** Fresh-install shape: null ProfileData/Avatars, null RanksComponent. */
const FRESH = toBytes(
  JSON.stringify({
    Properties: { avatarId: "3", coins: 1010 },
    SpecialEvents: {
      UserProfileFeature: {
        t: "ds",
        v: {
          ProfileData: { t: "ds", v: null },
          FramesComponent: { t: "ds", v: { NewItems: "", ReceivedItems: "" } },
          AttributeComponent: { t: "ds", v: { NewItems: "", ReceivedItems: "" } },
          BadgesComponent: { t: "ds", v: { NewItems: "", ReceivedItems: "" } },
          RanksComponent: { t: "ds", v: null },
        },
      },
    },
    Avatars: null,
  }),
);

test("cosmetics: catalog sanity — researched counts, unique non-empty ids", () => {
  const byKind = Object.fromEntries(COSMETICS.map((g) => [g.kind, g.items.length]));
  // Frames are the union of two independent sources, each of which alone is
  // incomplete: the older client export (which had donut/train but no gold or
  // fire) and the reference save the game itself wrote (which had gold/fire
  // but no donut/train). Counts match the mined id set exactly.
  assert.deepEqual(byKind, {
    frames: 14,
    styles: 8,
    badges: 14,
    titles: 24,
    avatars: 176,
  });
  // Avatars are excluded: the client ships no avatar art at all, and none was
  // asked for. Every other family must be real art, a faithful colour swatch,
  // or an explicitly-marked placeholder — never silently blank.
  const artless = new Set(["avatars"]);
  for (const g of COSMETICS) {
    const ids = g.items.map((it) => it.id);
    assert.equal(new Set(ids).size, ids.length, `${g.kind}: duplicate ids`);
    for (const it of g.items) {
      assert.ok(it.id.length > 0, `${g.kind}: empty id`);
      assert.ok(it.label.length > 0, `${g.kind}.${it.id}: empty label`);
      if (artless.has(g.kind)) continue;
      assert.ok(
        it.icon !== undefined || it.swatch !== undefined || it.mono !== undefined,
        `${g.kind}.${it.id}: no icon, swatch or placeholder monogram`,
      );
    }
  }
});

test("cosmetics: grants merge into fresh lists and materialize null RanksComponent", () => {
  const save = openSave(FRESH);
  const ops = [
    ...grantOps(save, "frames", ["dragon_nest_frame_lava", "dragon_nest_frame_train"]),
    ...grantOps(save, "titles", ["expedition_52_gold", "expedition_52_grand"]),
  ];
  assert.equal(ops.length, 2);
  const r = runApply(FRESH, ops);
  assert.equal(r.ok, true, r.errors.join("; "));

  const s2 = openSave(r.bytes);
  assert.equal(
    s2.string("SpecialEvents.UserProfileFeature.v.FramesComponent.v.ReceivedItems"),
    "dragon_nest_frame_lava,dragon_nest_frame_train",
  );
  assert.equal(
    s2.string("SpecialEvents.UserProfileFeature.v.RanksComponent.v.ReceivedItems"),
    "expedition_52_gold,expedition_52_grand",
  );
  assert.equal(
    s2.string("SpecialEvents.UserProfileFeature.v.RanksComponent.v.NewItems"),
    "expedition_52_gold,expedition_52_grand",
    "ranks mirror ReceivedItems into NewItems — measured from a save the game wrote",
  );
  // Frames do NOT mirror: a real save keeps FramesComponent.NewItems empty
  // even with 12 frames owned.
  assert.equal(
    s2.string("SpecialEvents.UserProfileFeature.v.FramesComponent.v.NewItems"),
    "",
    "frames leave NewItems empty (measured, not assumed)",
  );

  // Idempotent: re-granting owned ids yields no ops.
  assert.deepEqual(
    grantOps(s2, "frames", ["dragon_nest_frame_lava"]),
    [],
    "re-grant must be a no-op",
  );
  // Union preserves existing order and appends only the new id.
  const merge = grantOps(s2, "frames", ["dragon_nest_frame_train", "dragon_nest_frame_donut"]);
  assert.deepEqual(merge, [
    {
      path: "SpecialEvents.UserProfileFeature.v.FramesComponent.v.ReceivedItems",
      value:
        "dragon_nest_frame_lava,dragon_nest_frame_train,dragon_nest_frame_donut",
    },
  ]);
});

test("cosmetics: equip materializes null ProfileData with the canonical shape", () => {
  const ops = equipOps(openSave(FRESH), "frames", "dragon_nest_frame_lava");
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.path, "SpecialEvents.UserProfileFeature.v.ProfileData.v");

  const r = runApply(FRESH, ops);
  assert.equal(r.ok, true, r.errors.join("; "));
  const s2 = openSave(r.bytes);
  const pd = "SpecialEvents.UserProfileFeature.v.ProfileData.v";
  assert.equal(s2.string(`${pd}.FrameId`), "dragon_nest_frame_lava");
  assert.equal(s2.field(`${pd}.FrameValidUntil`).kind, "tagged-i64");
  // Permanent cosmetics carry 0, not a far-future date — a save the game
  // itself wrote has FrameValidUntil = 0 and StyleValidUntil = 0.
  assert.equal(s2.number(`${pd}.FrameValidUntil`), 0);
  assert.equal(s2.string(`${pd}.FrameFallbackId`), "");

  // Later equips become member-level writes that never disturb siblings.
  const ops2 = [
    ...equipOps(s2, "styles", "four_elements_font_electric"),
    ...equipOps(s2, "badges", "cards_collection_5"),
    ...equipOps(s2, "titles", "expedition_52_gold"),
  ];
  const r2 = runApply(r.bytes, ops2);
  assert.equal(r2.ok, true, r2.errors.join("; "));
  const s3 = openSave(r2.bytes);
  assert.equal(s3.string(`${pd}.StyleId`), "four_elements_font_electric");
  assert.equal(s3.string(`${pd}.BadgeId`), "cards_collection_5");
  assert.equal(s3.string(`${pd}.RankId`), "expedition_52_gold");
  assert.equal(
    s3.string(`${pd}.FrameId`),
    "dragon_nest_frame_lava",
    "frame must be untouched by the other equips",
  );

  const ops3 = equipOps(s3, "frames", "dragon_nest_frame_train");
  assert.deepEqual(ops3, [{ path: `${pd}.FrameId`, value: "dragon_nest_frame_train" }]);
  const r3 = runApply(r2.bytes, ops3);
  assert.equal(r3.ok, true, r3.errors.join("; "));
  const s4 = openSave(r3.bytes);
  assert.equal(s4.string(`${pd}.FrameId`), "dragon_nest_frame_train");
  assert.equal(s4.string(`${pd}.StyleId`), "four_elements_font_electric");
});

test("cosmetics: equipManyOps merges a fresh materialization into one op", () => {
  const ops = equipManyOps(openSave(FRESH), {
    frames: "dragon_nest_frame_train",
    styles: "four_elements_font_electric",
    badges: "cards_collection_5",
    titles: "expedition_52_gold",
    avatars: "51",
  });
  // One wholesale ProfileData set + one avatarId set — no overlapping spans.
  assert.equal(ops.length, 2);
  assert.equal(ops[0]!.path, "SpecialEvents.UserProfileFeature.v.ProfileData.v");
  assert.deepEqual(ops[1], { path: "Properties.avatarId", value: "51" });
  const r = runApply(FRESH, ops);
  assert.equal(r.ok, true, r.errors.join("; "));
  const pd = "SpecialEvents.UserProfileFeature.v.ProfileData.v";
  const s2 = openSave(r.bytes);
  assert.equal(s2.string(`${pd}.FrameId`), "dragon_nest_frame_train");
  assert.equal(s2.string(`${pd}.StyleId`), "four_elements_font_electric");
  assert.equal(s2.string(`${pd}.BadgeId`), "cards_collection_5");
  assert.equal(s2.string(`${pd}.RankId`), "expedition_52_gold");
  // Rank keeps fallback + expiry companions beside RankId (the reference save
  // has RankFallbackId + RankValidUntil; RankId alone is half-formed).
  assert.equal(s2.string(`${pd}.RankFallbackId`), "default");
  assert.equal(s2.field(`${pd}.RankValidUntil`).kind, "tagged-i64");
  assert.equal(s2.number(`${pd}.FrameValidUntil`), 0);
  assert.equal(s2.string("Properties.avatarId"), "51");

  // On an already-materialized ProfileData it fans out to member-level ops.
  const ops2 = equipManyOps(s2, { frames: "dragon_nest_frame_lava", avatars: "51" });
  assert.deepEqual(ops2, [
    { path: `${pd}.FrameId`, value: "dragon_nest_frame_lava" },
    { path: "Properties.avatarId", value: "51" },
  ]);
});

test("cosmetics: avatar flags materialize from null then merge per-flag", () => {
  const g1 = grantOps(openSave(FRESH), "avatars", ["14", "51"]);
  assert.deepEqual(g1, [
    { path: "Avatars", value: { unlocked14: true, unlocked51: true } },
  ]);
  const r1 = runApply(FRESH, g1);
  assert.equal(r1.ok, true, r1.errors.join("; "));

  const s2 = openSave(r1.bytes);
  assert.equal(s2.field("Avatars").kind, "object");
  assert.equal(s2.field("Avatars.unlocked14").value, true);

  // Idempotent + merge: only genuinely missing ids produce ops — two sibling
  // creates that share one closing-brace anchor (amended, not overlapping).
  assert.deepEqual(grantOps(s2, "avatars", ["14", "51"]), []);
  const g2 = grantOps(s2, "avatars", ["51", "60", "77"]);
  assert.deepEqual(g2, [
    { path: "Avatars.unlocked60", value: true, create: true },
    { path: "Avatars.unlocked77", value: true, create: true },
  ]);
  const r2 = runApply(r1.bytes, g2);
  assert.equal(r2.ok, true, r2.errors.join("; "));

  const s3 = openSave(r2.bytes);
  assert.equal(s3.field("Avatars.unlocked60").value, true);
  assert.equal(s3.field("Avatars.unlocked77").value, true);
  assert.equal(s3.field("Avatars.unlocked14").value, true, "sibling flags survive merges");

  // Equipping an avatar is a plain string write to Properties.avatarId.
  const eq = equipOps(s3, "avatars", "51");
  assert.deepEqual(eq, [{ path: "Properties.avatarId", value: "51" }]);
  const r3 = runApply(r2.bytes, eq);
  assert.equal(r3.ok, true, r3.errors.join("; "));
  assert.equal(openSave(r3.bytes).string("Properties.avatarId"), "51");
});

test("cosmetics: cosmeticOps grants the equipped item automatically, grant first", () => {
  const ops = cosmeticOps(openSave(FRESH), "badges", { equip: "cards_collection_5" });
  assert.equal(ops.length, 2);
  assert.match(ops[0]!.path, /BadgesComponent\.v\.ReceivedItems$/);
  assert.match(ops[1]!.path, /ProfileData\.v$/);
  const r = runApply(FRESH, ops);
  assert.equal(r.ok, true, r.errors.join("; "));
  const s2 = openSave(r.bytes);
  assert.equal(
    s2.string("SpecialEvents.UserProfileFeature.v.BadgesComponent.v.ReceivedItems"),
    "cards_collection_5",
  );
  assert.equal(
    s2.string("SpecialEvents.UserProfileFeature.v.ProfileData.v.BadgeId"),
    "cards_collection_5",
  );

  // An explicit grant list replaces the automatic one but keeps the equip.
  const ops2 = cosmeticOps(s2, "badges", {
    grant: ["cards_collection_1_gold"],
    equip: "cards_collection_1_gold",
  });
  assert.equal(ops2.length, 2);
  const r2 = runApply(r.bytes, ops2);
  assert.equal(r2.ok, true, r2.errors.join("; "));
  assert.equal(
    openSave(r2.bytes).string(
      "SpecialEvents.UserProfileFeature.v.BadgesComponent.v.ReceivedItems",
    ),
    "cards_collection_5,cards_collection_1_gold",
    "grant merges, never clobbers",
  );
});

test("savegame: sibling creates into one parent amend a single anchor", () => {
  const save = openSave(toBytes('{"Avatars":{"unlocked14":true},"n":1}'));
  save.create("Avatars.unlocked51", true);
  save.create("Avatars.unlocked60", true);
  save.create("Avatars.unlocked77", true);
  const { bytes } = save.commit();
  const doc = JSON.parse(new TextDecoder().decode(bytes));
  assert.deepEqual(doc.Avatars, {
    unlocked14: true,
    unlocked51: true,
    unlocked60: true,
    unlocked77: true,
  });
  assert.equal(doc.n, 1, "unrelated siblings untouched");
});

test("cosmetics: unknown ids are rejected loudly", () => {
  const save = openSave(FRESH);
  assert.throws(() => grantOps(save, "frames", ["frame_that_never_existed"]), SaveError);
  assert.throws(() => equipOps(save, "styles", "four_elements_font_zzz"), SaveError);
  assert.throws(() => grantOps(save, "titles", [""]), SaveError);
});

test("cosmetics: missing wrappers are recreated with their tagged shape", () => {
  // A save that never had RanksComponent / ProfileData at all (defensive
  // path): the wrapper itself must be created so the {"t":"ds","v":...}
  // shape survives — create() would otherwise emit a literal "ProfileData.v"
  // key.
  const bare = toBytes(
    JSON.stringify({
      Properties: { avatarId: "3" },
      SpecialEvents: {
        UserProfileFeature: {
          t: "ds",
          v: { FramesComponent: { t: "ds", v: { NewItems: "", ReceivedItems: "" } } },
        },
      },
    }),
  );
  const save = openSave(bare);
  const ops = [
    ...grantOps(save, "titles", ["expedition_52_gold"]),
    ...equipOps(save, "frames", "dragon_nest_frame_lava"),
  ];
  const r = runApply(bare, ops);
  assert.equal(r.ok, true, r.errors.join("; "));
  const s2 = openSave(r.bytes);
  const base = "SpecialEvents.UserProfileFeature.v";
  assert.equal(s2.field(`${base}.RanksComponent`).tag, "ds");
  assert.equal(
    s2.string(`${base}.RanksComponent.v.ReceivedItems`),
    "expedition_52_gold",
  );
  assert.equal(s2.field(`${base}.ProfileData`).tag, "ds");
  assert.equal(s2.string(`${base}.ProfileData.v.FrameId`), "dragon_nest_frame_lava");

  // A save without the Avatars group at root: it is created at root level.
  const bare2 = toBytes(JSON.stringify({ Properties: { avatarId: "3" } }));
  assert.deepEqual(grantOps(openSave(bare2), "avatars", ["14"]), [
    { path: "Avatars", value: { unlocked14: true }, create: true },
  ]);
});

test(
  "cosmetics: full grant+equip batch survives the live container codec",
  { skip: haveLiveFixture ? false : `live container not found at ${LIVE_FIXTURE}` },
  () => {
    const raw = new Uint8Array(readFileSync(LIVE_FIXTURE));
    const dec = decodeSave(raw);
    const save = openSave(dec.bytes);
    const all = (kind: Parameters<typeof grantOps>[1]): string[] => {
      const g = COSMETICS.find((g) => g.kind === kind)!;
      return g.items.map((it) => it.id);
    };
    const ops = [
      ...grantOps(save, "frames", all("frames")),
      ...grantOps(save, "styles", all("styles")),
      ...grantOps(save, "badges", all("badges")),
      ...grantOps(save, "titles", all("titles")),
      ...grantOps(save, "avatars", all("avatars")),
      ...equipManyOps(save, {
        frames: "dragon_nest_frame_train",
        styles: "four_elements_font_electric",
        badges: "cards_collection_5",
        titles: "expedition_52_gold",
      }),
    ];
    const applied = runApply(dec.bytes, ops);
    assert.equal(applied.ok, true, applied.errors.join("; "));
    const reEncoded = encodeSave(applied.bytes, dec);
    const dec2 = decodeSave(reEncoded);
    const doc = JSON.parse(new TextDecoder().decode(dec2.bytes));
    const v = doc.SpecialEvents.UserProfileFeature.v;
    const list = (p: string): string[] => v[p].v.ReceivedItems.split(",").filter(Boolean);
    const includes = (p: string, ids: string[]): void => {
      const owned = list(p);
      for (const id of ids) assert.ok(owned.includes(id), `${p}: ${id} not granted`);
    };
    includes(
      "FramesComponent",
      COSMETICS.find((g) => g.kind === "frames")!.items.map((it) => it.id),
    );
    includes(
      "AttributeComponent",
      COSMETICS.find((g) => g.kind === "styles")!.items.map((it) => it.id),
    );
    includes(
      "BadgesComponent",
      COSMETICS.find((g) => g.kind === "badges")!.items.map((it) => it.id),
    );
    includes(
      "RanksComponent",
      COSMETICS.find((g) => g.kind === "titles")!.items.map((it) => it.id),
    );
    assert.equal(
      Object.keys(doc.Avatars).filter((k) => k.startsWith("unlocked")).length >= 176,
      true,
    );
    assert.equal(v.ProfileData.v.FrameId, "dragon_nest_frame_train");
    assert.equal(v.ProfileData.v.StyleId, "four_elements_font_electric");
    assert.equal(v.ProfileData.v.BadgeId, "cards_collection_5");
    assert.equal(v.ProfileData.v.RankId, "expedition_52_gold");
    assert.equal(dec2.keyId, dec.keyId, "codec key must ride along re-encode");
  },
);
