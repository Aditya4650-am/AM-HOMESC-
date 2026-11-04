/**
 * node --experimental-strip-types tools/diff_save.ts A.db B.db
 * Deep-diff two Playrix-encoded SaveGame.db files: walks both trees and reports
 * every added/removed/changed leaf with JSON paths.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeSave, withEmptyValuesAsNull } from "../src/engine/codec.ts";

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error("Usage: node --experimental-strip-types tools/diff_save.ts A.db B.db");
  process.exit(1);
}

function parse(bytes: Uint8Array): unknown {
  const codec = decodeSave(bytes);
  if (codec.keyId === null && codec.confidence === "heuristic") {
    throw new Error(`could not decode container: ${codec.warning ?? "unknown"}`);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(codec.bytes);
  return JSON.parse(withEmptyValuesAsNull(text));
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const MAX = 400;
const out: string[] = [];
let n = 0;

function walk(a: unknown, b: unknown, path: string): void {
  if (n >= MAX) return;
  if (a === b) return;
  const ao = isObj(a), bo = isObj(b);
  if (ao && bo) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of [...keys].sort()) {
      const ap = path ? `${path}.${k}` : k;
      const av = (a as Record<string, unknown>)[k];
      const bv = (b as Record<string, unknown>)[k];
      if (k in (a as object) && !(k in (b as object))) {
        out.push(`- ${ap} = ${JSON.stringify(av)}`);
        n++;
      } else if (!(k in (a as object)) && k in (b as object)) {
        out.push(`+ ${ap} = ${JSON.stringify(bv)}`);
        n++;
      } else {
        walk(av, bv, ap);
      }
      if (n >= MAX) return;
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`~ ${path}.length ${a.length} -> ${b.length}`);
      n++;
    }
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len && n < MAX; i++) walk(a[i], b[i], `${path}[${i}]`);
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push(`~ ${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    n++;
  }
}

const aBytes = new Uint8Array(readFileSync(resolve(aPath)));
const bBytes = new Uint8Array(readFileSync(resolve(bPath)));
console.log(`A=${aPath} (${aBytes.length} bytes)`);
console.log(`B=${bPath} (${bBytes.length} bytes)`);
const a = parse(aBytes);
const b = parse(bBytes);
walk(a, b, "");
if (out.length === 0) console.log("(no structural differences)");
else {
  console.log(`\n=== ${out.length} difference(s) ===`);
  for (const line of out) console.log(line);
  if (n >= MAX) console.log(`... truncated at ${MAX}`);
}
