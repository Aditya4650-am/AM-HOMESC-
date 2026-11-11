import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLatestChecksum,
  DEFAULT_UPDATE_REPO,
  UPDATE_ASSET,
} from "./release.ts";

const SHA = "428b2d3febd5803881b93d13d45ed1dac0640f7feef1d8c74d98eea3baea5a88";

test("parses a redirected checksum URL into a tag-pinned release", () => {
  const finalUrl = `https://github.com/${DEFAULT_UPDATE_REPO}/releases/download/v1.1.1/${UPDATE_ASSET}.sha256`;
  const rec = parseLatestChecksum(DEFAULT_UPDATE_REPO, finalUrl, `${SHA}  ${UPDATE_ASSET}\n`);
  assert.ok(rec);
  assert.equal(rec.version, "1.1.1");
  assert.equal(rec.sha256, SHA);
  // The zip is pinned to the same tag the checksum came from, so a release
  // published mid-install can never mismatch the bytes that were verified.
  assert.equal(rec.downloadUrl, `https://github.com/${DEFAULT_UPDATE_REPO}/releases/download/v1.1.1/${UPDATE_ASSET}`);
});

test("accepts the coreutils two-space and binary-marker checksum forms", () => {
  const finalUrl = `https://github.com/o/r/releases/download/v2.0.0/${UPDATE_ASSET}.sha256`;
  for (const body of [`${SHA}  ${UPDATE_ASSET}`, `${SHA} *${UPDATE_ASSET}`, `\n${SHA}\n`]) {
    const rec = parseLatestChecksum("o/r", finalUrl, body);
    assert.ok(rec, body);
    assert.equal(rec.sha256, SHA);
  }
});

test("refuses a release with no usable checksum", () => {
  const finalUrl = `https://github.com/o/r/releases/download/v2.0.0/${UPDATE_ASSET}.sha256`;
  // Unverified swaps must never be offered: no checksum, no update.
  assert.equal(parseLatestChecksum("o/r", finalUrl, "not a checksum\n"), null);
  assert.equal(parseLatestChecksum("o/r", finalUrl, ""), null);
  assert.equal(parseLatestChecksum("o/r", finalUrl, "deadbeef  file\n"), null);
});

test("refuses a URL that never resolved to a tag-pinned asset", () => {
  // The stable latest/download URL before it redirects (or a 404 body).
  assert.equal(parseLatestChecksum("o/r", `https://github.com/o/r/releases/latest/download/${UPDATE_ASSET}.sha256`, SHA), null);
  assert.equal(parseLatestChecksum("o/r", "https://example.com/something", SHA), null);
});

test("refuses a checksum for a different asset than the client EXE", () => {
  const finalUrl = `https://github.com/o/r/releases/download/v2.0.0/other-asset.zip.sha256`;
  assert.equal(parseLatestChecksum("o/r", finalUrl, SHA), null);
});

test("refuses a tag that carries no version number", () => {
  const finalUrl = `https://github.com/o/r/releases/download/latest/${UPDATE_ASSET}.sha256`;
  assert.equal(parseLatestChecksum("o/r", finalUrl, SHA), null);
});

test("strips a leading v and requires a numeric version", () => {
  const ok = parseLatestChecksum("o/r", `https://github.com/o/r/releases/download/v0.1.0/${UPDATE_ASSET}.sha256`, SHA);
  assert.equal(ok?.version, "0.1.0");
  const bare = parseLatestChecksum("o/r", `https://github.com/o/r/releases/download/1.2.3/${UPDATE_ASSET}.sha256`, SHA);
  assert.equal(bare?.version, "1.2.3");
});
