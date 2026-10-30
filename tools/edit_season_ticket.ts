/** node --experimental-strip-types tools/edit_season_ticket.ts INPUT OUTPUT ACTION [POINTS] [SEASON] */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { editSeasonTicket, type SeasonTicketOptions } from "../src/engine/season-ticket.ts";

try {
  const [input, output, action, points, season] = process.argv.slice(2);
  if (!input || !output || !["points", "goldenTicket", "both"].includes(action ?? "")) {
    throw new Error("Usage: node --experimental-strip-types tools/edit_season_ticket.ts INPUT OUTPUT points|goldenTicket|both [POINTS=10000] [SEASON]");
  }
  if (resolve(input) === resolve(output)) throw new Error("Choose a separate output file to preserve your original save");
  const result = editSeasonTicket(new Uint8Array(readFileSync(input)), {
    action: action as SeasonTicketOptions["action"],
    points: points === undefined ? undefined : Number(points), season,
  });
  writeFileSync(output, result.encoded, { flag: "wx" });
  console.log(JSON.stringify({ season: result.season, source: result.source, ops: result.ops, output }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
