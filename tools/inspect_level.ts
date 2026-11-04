/** node --experimental-strip-types tools/inspect_level.ts INPUT */
import { readFileSync } from "node:fs";
import { decodeSave } from "../src/engine/codec.ts";
import { openSave } from "../src/engine/savegame.ts";

const input = process.argv.slice(2)[0];
if (!input) throw new Error("Usage: node --experimental-strip-types tools/inspect_level.ts INPUT");

const raw = new Uint8Array(readFileSync(input));
const codec = decodeSave(raw);
const save = openSave(codec.bytes, codec.wasEncrypted);

const probes = [
  "Properties.LID_Lvl",
  "Properties.level",
  "Properties.coins",
  "Properties.earnedStars",
  "Properties.spentStars",
  "Properties.name",
  "Properties.lives.current",
  "Properties.CeReas_R1",
  "Properties.CeReas_R4",
];
for (const p of probes) {
  if (!save.has(p)) {
    console.log(`${p} = <absent>`);
    continue;
  }
  const f = save.field(p);
  console.log(`${p} = ${JSON.stringify(f.value)}   (type=${f.span.type})`);
}

// Hunt every key whose name mentions level/lvl.
const hits: string[] = [];
const walk = (path: string, value: unknown, depth: number): void => {
  if (depth > 6 || hits.length > 60) return;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const child = path ? `${path}.${k}` : k;
      if (/lvl|level/i.test(k) && (typeof v === "number" || typeof v === "string")) {
        hits.push(`${child} = ${JSON.stringify(v)}`);
      }
      walk(child, v, depth + 1);
    }
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length && i < 4; i++) walk(`${path}[${i}]`, value[i], depth + 1);
  }
};
walk("", JSON.parse(new TextDecoder().decode(codec.bytes)), 0);
console.log("\n=== level-ish keys ===");
for (const h of hits) console.log("  " + h);

console.log(`\ncontainer: ${JSON.stringify(codec.container ?? null)}  wasEncrypted=${codec.wasEncrypted}`);
