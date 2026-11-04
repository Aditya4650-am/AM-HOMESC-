/**
 * node --experimental-strip-types tools/bytediff.ts A.db B.db
 * Finds differing byte ranges between two files (raw, pre-decode).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error("Usage: node --experimental-strip-types tools/bytediff.ts A.db B.db");
  process.exit(1);
}
const a = readFileSync(resolve(aPath));
const b = readFileSync(resolve(bPath));
console.log(`A=${a.length} bytes  B=${b.length} bytes  delta=${b.length - a.length}`);

const min = Math.min(a.length, b.length);
const ranges: Array<[number, number]> = [];
let start = -1;
for (let i = 0; i < min; i++) {
  if (a[i] !== b[i]) {
    if (start < 0) start = i;
  } else if (start >= 0) {
    ranges.push([start, i - 1]);
    start = -1;
  }
}
if (start >= 0) ranges.push([start, min - 1]);
if (a.length !== b.length) ranges.push([min, Math.max(a.length, b.length) - 1]);

console.log(`differing ranges: ${ranges.length}`);
for (const [s, e] of ranges.slice(0, 60)) {
  const al = a.subarray(s, Math.min(e + 1, a.length));
  const bl = b.subarray(s, Math.min(e + 1, b.length));
  console.log(`  [${s}..${e}] (${e - s + 1} B)`);
  console.log(`    A: ${Buffer.from(al).toString("hex").slice(0, 160)}`);
  console.log(`    B: ${Buffer.from(bl).toString("hex").slice(0, 160)}`);
  // context: 24 bytes before the range from A
  const ctx = a.subarray(Math.max(0, s - 24), s);
  console.log(`    ctx(A before): ${Buffer.from(ctx).toString("hex")}`);
}
