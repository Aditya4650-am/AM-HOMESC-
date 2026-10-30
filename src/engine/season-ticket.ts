/** Season-local Points / GoldenTicket edits, discovered from GameModifiers. */
import type { SaveGame } from "./savegame.ts";
import type { EditOp } from "./operations.ts";
import { decodeSave, encodeSave } from "./codec.ts";
import { openSave } from "./savegame.ts";
import { runApply } from "./operations.ts";

export interface SeasonTicketCandidate {
  season: string;
  source: string;
  modifierPath: string;
  inProgress: boolean;
  expirationTime: number | null;
}

export interface SeasonTicketOptions {
  action: "points" | "goldenTicket" | "both";
  /** Defaults to 10,000; prevAmount is max(0, points - 1). */
  points?: number;
  /** Resolve ambiguity explicitly; must exist in local GameModifiers. */
  season?: string;
}

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const safeId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]+$/.test(v);

/** isActive may be false before activation, so it is NOT a discovery filter. */
export function discoverSeasonTickets(save: SaveGame): SeasonTicketCandidate[] {
  const result: SeasonTicketCandidate[] = [];
  for (const path of save.children("GameModifiers")) {
    const v: unknown = save.field(path).value; // field() unwraps {t:"ds", v:...}
    if (!record(v) || !safeId(v.groupId) || !safeId(v.source)) continue;
    if (!v.source.endsWith("GoldenTicket") || /RemoteGroup$/i.test(v.groupId)) continue;
    // A source shared with a RemoteGroup must never select that remote group.
    const localEffects = Object.values(v).filter(record).map((x) =>
      x.t === "ds" && record(x.v) ? x.v : x,
    ).filter((x) => x.isLocalPlayer === true);
    if (localEffects.length === 0) continue;
    const expirations = localEffects.map((x) => x.expirationTime)
      .filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    const statePath = `SpecialEvents.${v.groupId}.v.statesGraph.v.ptr.v.currentState`;
    result.push({
      season: v.groupId, source: v.source, modifierPath: path,
      inProgress: save.has(statePath) && save.field(statePath).value === "InProgress",
      expirationTime: expirations.length ? Math.max(...expirations) : null,
    });
  }
  return result;
}

/** Pure planner: no mutation, no donor, no fixed season name, no time field. */
export function planSeasonTicket(save: SaveGame, options: SeasonTicketOptions) {
  if (!["points", "goldenTicket", "both"].includes(options.action)) {
    throw new Error("action must be points, goldenTicket or both");
  }
  const candidates = discoverSeasonTickets(save);
  let choices = candidates;
  if (options.season !== undefined) {
    choices = choices.filter((x) => x.season === options.season);
  } else if (choices.length > 1) {
    const live = choices.filter((x) => x.inProgress);
    if (live.length) choices = live;
    // Rank by saved expiry, not the computer clock (saves may be historical).
    if (choices.length > 1 && choices.every((x) => x.expirationTime !== null)) {
      const latest = Math.max(...choices.map((x) => x.expirationTime!));
      choices = choices.filter((x) => x.expirationTime === latest);
    }
  }
  if (choices.length !== 1) {
    throw new Error(choices.length === 0
      ? "No matching local GoldenTicket found in GameModifiers"
      : `Ambiguous season; supply options.season: ${choices.map((x) => x.season).join(", ")}`);
  }
  const selected = choices[0]!;
  const ops: EditOp[] = [];
  const points = options.points ?? 10_000;
  if (options.action !== "goldenTicket" && (!Number.isSafeInteger(points) || points < 0)) {
    throw new Error("points must be a non-negative safe integer");
  }
  const writeMembers = (parent: string, members: Record<string, number>) => {
    if (!save.has(parent)) {
      ops.push({ path: parent, value: members, create: true });
      return;
    }
    if (save.span(parent).type !== "object") throw new Error(`${parent} must be an object`);
    for (const [key, value] of Object.entries(members)) {
      const path = `${parent}.${key}`;
      // Refuse nested Currency shapes; dots must belong to the literal key.
      if (save.has(path) && !save.children(parent).includes(path)) {
        throw new Error(`${path} is nested; expected a flat literal member of ${parent}`);
      }
      if (save.has(path)) {
        if (save.span(path).type !== "number") throw new Error(`${path} must be a bare number`);
        if (save.field(path).value !== value) ops.push({ path, value });
      } else ops.push({ path, value, create: true });
    }
  };
  if (options.action !== "goldenTicket") writeMembers("Currency", {
    [`${selected.season}Points.amount`]: points,
    [`${selected.season}Points.prevAmount`]: Math.max(0, points - 1),
  });
  if (options.action !== "points") writeMembers("PlayerItems", { [selected.source]: 1 });
  return { ...selected, action: options.action, ops };
}

/** One-call helper for plain or supported encrypted SaveGame.db containers. */
export function editSeasonTicket(input: Uint8Array, options: SeasonTicketOptions) {
  const codec = decodeSave(input);
  const plan = planSeasonTicket(openSave(codec.bytes), options);
  const result = runApply(codec.bytes, plan.ops, { refreshIntegrity: false }, codec);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return { ...plan, bytes: result.bytes, encoded: encodeSave(result.bytes, codec), summary: result.summary };
}
