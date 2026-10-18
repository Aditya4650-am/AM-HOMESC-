import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { asciiTokens, decodeBlkZstd, isBlk, uniqueTokens } from "./upk.ts";

const SAMPLE = fileURLToPath(new URL("../../test-data/Features.vso", import.meta.url));

let sampleBytes: Uint8Array | null = null;
let sampleDec: { header: Uint8Array; data: Uint8Array } | null = null;

test("upk: BLK(zstd) magic detection", async () => {
  sampleBytes = new Uint8Array(await readFile(SAMPLE));
  assert.equal(isBlk(sampleBytes), true, "sample Features.vso should be BLK");
  assert.equal(isBlk(new Uint8Array([0x00, 0x01, 0x02])), false);
});

test("upk: BLK(zstd) round-trip on the official APK's Features.vso", async () => {
  if (!sampleBytes) return;
  sampleDec = decodeBlkZstd(sampleBytes);
  assert.ok(sampleDec, "Features.vso carries a zstd frame");
  assert.ok(sampleDec.header.length > 0);
  assert.ok(sampleDec.data.length > 10000, `decoded payload ${sampleDec.data.length} bytes`);
});

test("upk: token pool extraction finds feature names", async () => {
  if (!sampleDec) return;
  const tokens = uniqueTokens(asciiTokens(sampleDec.data));
  assert.ok(tokens.includes("CardsCollectionLoader"), "CardsCollectionLoader token present");
  assert.ok(tokens.includes("gffCoreFeatureCondition"), "gffCoreFeatureCondition token present");
  assert.ok(tokens.length > 50, `token pool size ${tokens.length}`);
  const again = uniqueTokens(asciiTokens(sampleDec.data));
  assert.deepEqual(tokens, again, "uniqueTokens is order-stable");
});

test("upk: non-BLK files decode to null", () => {
  assert.equal(decodeBlkZstd(new Uint8Array(64)), null);
});
