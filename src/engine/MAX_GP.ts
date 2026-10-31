/**
 * MAX_GP — the one-click season action.
 *
 * Writes BOTH halves of a maxed season in one plan:
 *
 *   Currency.<season>Points.amount    = 10_000
 *   Currency.<season>Points.prevAmount = 9_999
 *   PlayerItems.<season>GoldenTicket   = 1
 *
 * …with the season discovered from `GameModifiers` (never hard-coded), and
 * idempotent: a second run on its own output produces zero ops and identical
 * bytes.
 *
 * ## Why this file is thin
 *
 * It used to be a ~90-line copy of `season-ticket.ts` — the same
 * `discoverSeasonTickets`, the same `planSeasonTicket`, the same flat-key
 * writer — so a fix to the discovery rules had to be made twice and the two
 * copies could drift. The planner now lives in exactly one place and this module
 * is the named entry point the API calls.
 *
 * ## A note on the number
 *
 * `seasonpass.ts` writes the ladder's own ceiling (845 for `SSPProcedure46`)
 * because 10 000 is what the donor save holds and the donor's every season
 * currency reads ~10 000, i.e. tool-generated rather than earned. MAX_GP is a
 * different, explicitly requested action: it writes the maximum the season
 * track can show, and 10 000 sits above the top rung on every measured ladder.
 * Both policies are stated here and in `seasonpass.ts` so the difference is a
 * decision, not an accident.
 */
import type { EditOp } from "./operations.ts";
import { decodeSave, encodeSave } from "./codec.ts";
import { openSave } from "./savegame.ts";
import { runApply } from "./operations.ts";
import { editSeasonTicket, planSeasonTicket, type SeasonTicketOptions } from "./season-ticket.ts";

export interface MAXGPPlan {
  season: string;
  source: string;
  modifierPath: string;
  inProgress: boolean;
  expirationTime: number | null;
  action: SeasonTicketOptions["action"];
  ops: EditOp[];
}

/** The documented MAX_GP points value. */
export const MAX_GP_POINTS = 10_000;

/**
 * Plan the MAX_GP write against an already-decoded save. Nothing is written and
 * nothing is pushed: the caller applies these ops through its own session.
 */
export function planMaxGP(save: Parameters<typeof planSeasonTicket>[0], points = MAX_GP_POINTS): MAXGPPlan {
  return planSeasonTicket(save, { action: "both", points }) as MAXGPPlan;
}

/** One-call helper for plain or supported encrypted SaveGame.db containers. */
export function MAX_GP(input: Uint8Array, points = MAX_GP_POINTS) {
  const codec = decodeSave(input);
  const plan = planSeasonTicket(openSave(codec.bytes), { action: "both", points });
  const result = runApply(codec.bytes, plan.ops, { refreshIntegrity: false }, codec);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return {
    ...plan,
    bytes: result.bytes,
    encoded: encodeSave(result.bytes, codec),
    summary: result.summary,
  };
}

export { editSeasonTicket };
