/* Compare the CONTENT roots (the visible home) of two Homescapes saves,
   leaf by leaf. Read-only.

   Used to answer the two questions a clone always raises:

     1. did the transplant land?   donor vs device right after the push
     2. did the game keep it?      donor vs device after the game re-saved

   Run it against the reference IGG account and a pulled device save:

     node --experimental-strip-types tools/clone_diff.ts \
       data/IGG-account.db pulled-save.hcsbak

   Optional 4th argument prints the value-level diff of one root, which is
   what separates "the game reverted this" from "the clone never wrote it":

     node --experimental-strip-types tools/clone_diff.ts \
       data/IGG-account.db pulled-save.hcsbak Repairs.
*/
import { readFileSync } from "node:fs";
import { openSave, type SaveGame } from "../src/engine/savegame.ts";
import { decodeSave } from "../src/engine/codec.ts";
import { CONTENT_ROOTS } from "../src/server/cloneGuard.ts";

function load(f: string): SaveGame {
  const raw = new Uint8Array(readFileSync(f));
  const c = decodeSave(raw);
  return openSave(c.bytes, c.wasEncrypted);
}

/** Every leaf under a root: path -> compact value. */
function leaves(save: SaveGame, roots: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of save.paths()) {
    const dot = p.indexOf(".");
    const top = dot < 0 ? p : p.slice(0, dot);
    if (!roots.includes(top)) continue;
    const m = save.index.members.get(p);
    if (!m || m.type === "object" || m.type === "array") continue;
    out.set(p, JSON.stringify(save.field(p).value));
  }
  return out;
}

const donor = load(process.argv[2]!);
const device = load(process.argv[3]!);
/** Optional: print every differing leaf under this root (e.g. "Repairs."). */
const detail = process.argv[4];

console.log(`donor: ${process.argv[2]}`);
console.log(`device: ${process.argv[3]}`);

const A = leaves(donor, CONTENT_ROOTS);
const B = leaves(device, CONTENT_ROOTS);
console.log(`\ndonor content leaves: ${A.size}   device content leaves: ${B.size}`);

let same = 0;
let diff = 0;
let onlyA = 0;
let onlyB = 0;
const samples: string[] = [];

for (const [p, v] of A) {
  const dv = B.get(p);
  if (dv === undefined) {
    onlyA++;
    if (samples.length < 8) samples.push(`  donor-only  ${p} = ${v.slice(0, 70)}`);
  } else if (dv !== v) {
    diff++;
    if (samples.length < 8) {
      samples.push(
        `  DIFFERS     ${p}\n                 donor ${v.slice(0, 70)}\n                 dev  ${dv.slice(0, 70)}`,
      );
    }
  } else same++;
}
for (const p of B.keys()) if (!A.has(p)) onlyB++;

console.log(`\n=== donor content vs device content ===`);
console.log(`  identical   ${same}`);
console.log(`  differing   ${diff}`);
console.log(`  donor-only  ${onlyA}`);
console.log(`  device-only ${onlyB}`);
const total = A.size || 1;
console.log(`\n  match: ${((same / total) * 100).toFixed(1)}% of the donor's ${total} content leaves`);

// Per-root breakdown: separates the VISIBLE home (Repairs/RoomDesign/Garden)
// from bookkeeping the game rewrites itself (ptr/eraser/event schedules).
console.log(`\n=== per root ===`);
console.log(
  `  ${"root".padEnd(20)} ${"ident".padStart(6)} ${"differ".padStart(6)} ${"donOnly".padStart(7)} ${"devOnly".padStart(7)}  match%`,
);
for (const root of CONTENT_ROOTS) {
  const pre = `${root}.`;
  let rSame = 0;
  let rDiff = 0;
  let rOnlyA = 0;
  let rOnlyB = 0;
  for (const [p, v] of A) {
    if (p !== root && !p.startsWith(pre)) continue;
    const dv = B.get(p);
    if (dv === undefined) rOnlyA++;
    else if (dv !== v) rDiff++;
    else rSame++;
  }
  for (const p of B.keys()) {
    if (p !== root && !p.startsWith(pre)) continue;
    if (!A.has(p)) rOnlyB++;
  }
  const n = rSame + rDiff + rOnlyA;
  if (n === 0 && rOnlyB === 0) continue;
  const pct = n ? ((rSame / n) * 100).toFixed(1) : "-";
  console.log(
    `  ${root.padEnd(20)} ${String(rSame).padStart(6)} ${String(rDiff).padStart(6)} ${String(rOnlyA).padStart(7)} ${String(rOnlyB).padStart(7)}  ${pct}%`,
  );
}

if (detail) {
  // Full value-level diff of one root: donor vs device.
  const pre = detail.endsWith(".") ? detail : `${detail}.`;
  let shown = 0;
  console.log(`\n=== detail: ${detail} (donor vs device) ===`);
  for (const [p, v] of A) {
    if (p !== detail && !p.startsWith(pre)) continue;
    const dv = B.get(p);
    if (dv === undefined) {
      console.log(`  MISSING on device  ${p}\n      donor ${v.slice(0, 90)}`);
      if (++shown >= 20) break;
    } else if (dv !== v) {
      console.log(`  differs  ${p}\n      donor ${v.slice(0, 90)}\n      dev  ${dv.slice(0, 90)}`);
      if (++shown >= 20) break;
    }
  }
  if (shown === 0) console.log(`  (every ${detail} leaf matches the donor)`);
}

if (samples.length) {
  console.log(`\n=== samples ===`);
  for (const s of samples) console.log(s);
}
