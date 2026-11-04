/**
 * node --experimental-strip-types tools/edit_level.ts INPUT OUTPUT LEVEL [PATH...]
 *
 * Raise/lower the account level in a Homescapes SaveGame.db. Byte-splice only —
 * never re-serializes — then re-encrypts with the same codec key.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeSave, encodeSave } from "../src/engine/codec.ts";
import { runApply } from "../src/engine/operations.ts";

try {
  const [input, output, levelArg, ...extraPaths] = process.argv.slice(2);
  if (!input || !output || levelArg === undefined) {
    throw new Error(
      "Usage: node --experimental-strip-types tools/edit_level.ts INPUT OUTPUT LEVEL [PATH...]",
    );
  }
  if (resolve(input) === resolve(output)) {
    throw new Error("Choose a separate output file to preserve your original save");
  }
  const level = Number(levelArg);
  if (!Number.isInteger(level) || level < 1) throw new Error(`LEVEL must be a positive integer, got ${levelArg}`);

  const codec = decodeSave(new Uint8Array(readFileSync(input)));
  const paths = extraPaths.length > 0 ? extraPaths : ["Properties.LID_Lvl", "Properties.level"];

  const ops = paths.map((path) => ({ path, value: level }));
  const applied = runApply(codec.bytes, ops, { refreshIntegrity: true }, codec);
  if (!applied.ok) {
    throw new Error(`apply failed:\n  ${applied.errors.join("\n  ")}`);
  }

  const encoded = encodeSave(applied.bytes, codec);
  writeFileSync(output, encoded, { flag: "wx" });

  console.log(
    JSON.stringify(
      {
        level,
        paths,
        summary: applied.summary.map((s) => s.label ?? s),
        warnings: applied.warnings,
        errors: applied.errors,
        integrity: applied.integrity,
        inputBytes: applied.inputBytes,
        outputBytes: applied.outputBytes,
        wasEncrypted: applied.wasEncrypted,
        keyId: codec.keyId,
        output,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
