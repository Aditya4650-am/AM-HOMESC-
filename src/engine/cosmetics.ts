/**
 * Cosmetics operation builders: frames, name styles, badges, titles, avatars.
 *
 * Every save path in this module was proven on a real 9.2.101 device session
 * (fresh account, three full push → relaunch → verify cycles each):
 *
 *  - Ownership lists are comma-separated strings inside the profile feature:
 *      FramesComponent / AttributeComponent(=styles) / BadgesComponent /
 *      RanksComponent(.v.ReceivedItems). Filling them lights up the
 *      corresponding in-game picker grid.
 *      Measured asymmetry, now followed: styles and ranks keep an IDENTICAL
 *      copy in `NewItems`, while frames and badges leave `NewItems` empty.
 *      Writing only ReceivedItems gave styles a picker list the game keeps
 *      mirrored and we did not.
 *  - The equipped selection lives in ProfileData.v:
 *      FrameId / StyleId / BadgeId / RankId, each with *FallbackId +
 *      *ValidUntil companions. This was re-measured against a save the game
 *      itself wrote and two earlier assumptions were wrong:
 *        * Permanent cosmetics use `ValidUntil = 0` (Frame and Style both do)
 *          — not a far-future date. Only Badge/Rank carry an absolute expiry.
 *        * Rank does keep `RankFallbackId` + `RankValidUntil` beside RankId;
 *          RankId alone is a half-formed family the client can discard.
 *      ProfileData.v starts as `null` on fresh installs and may be
 *      materialized wholesale with the canonical field set.
 *  - Avatars are unlock flags `Avatars.unlocked<id> = true` (the save schema
 *    runs unlocked1..unlocked202) plus `Properties.avatarId` for the
 *    equipped id.
 *
 * Grants are idempotent (re-granting owned ids yields no ops) and always
 * MERGE into the existing ownership list — never clobber sibling grants.
 * Always grant BEFORE equipping: the game's picker only offers owned items.
 */

import type { EditOp } from "./operations.ts";
import type { JsonValue } from "./patcher.ts";
import { SaveError, type SaveGame } from "./savegame.ts";
import {
  AVATAR_ITEMS,
  BADGE_ITEMS,
  FRAME_ITEMS,
  STYLE_ITEMS,
  TITLE_ITEMS,
  type CosmeticItem,
} from "./cosmetics-data.ts";

export type { CosmeticItem } from "./cosmetics-data.ts";

export type CosmeticKind = "frames" | "styles" | "badges" | "titles" | "avatars";

export interface CosmeticGroup {
  kind: CosmeticKind;
  label: string;
  description: string;
  /** Comma-separated owned-ids list (list-backed groups). */
  ownershipList?: string;
  /** Unlock flag prefix (avatars: `Avatars.unlocked<id>`). */
  flagPrefix?: string;
  /** Save path of the equipped id. */
  equipPath: string;
  /** Measured against a save the game itself wrote: styles and ranks keep an
   *  identical copy of the ownership list in `NewItems`, while frames and
   *  badges leave `NewItems` empty. Grants must mirror that shape or the
   *  picker reads a list the game never populated. */
  mirrorNewItems?: boolean;
  items: readonly CosmeticItem[];
}

const PROFILE = "SpecialEvents.UserProfileFeature.v";
const PROFILE_DATA_V = `${PROFILE}.ProfileData.v`;
/**
 * Server-normalized expiry used when materializing Fallback/ValidUntil
 * companions locally (2099-01-01). The server rewrites this to its own
 * canonical value on sync — proven: our 4070908800 came back as the
 * server's own timestamp without stripping the equipped id.
 */
const FAR_FUTURE = 4070908800;

export const COSMETICS: readonly CosmeticGroup[] = [
  {
    kind: "frames",
    label: "Avatar frames",
    description: "Border around the avatar. Owned list drives the Frame tab grid.",
    ownershipList: `${PROFILE}.FramesComponent.v.ReceivedItems`,
    equipPath: `${PROFILE_DATA_V}.FrameId`,
    items: FRAME_ITEMS,
  },
  {
    kind: "styles",
    label: "Name styles",
    description: "Nickname font. Owned list lives in AttributeComponent.",
    ownershipList: `${PROFILE}.AttributeComponent.v.ReceivedItems`,
    equipPath: `${PROFILE_DATA_V}.StyleId`,
    mirrorNewItems: true,
    items: STYLE_ITEMS,
  },
  {
    kind: "badges",
    label: "Badges",
    description: "Small icon under the avatar. Owned list drives the Badge tab grid.",
    ownershipList: `${PROFILE}.BadgesComponent.v.ReceivedItems`,
    equipPath: `${PROFILE_DATA_V}.BadgeId`,
    items: BADGE_ITEMS,
  },
  {
    kind: "titles",
    label: "Titles",
    description: "Expedition rank titles — counted by the Titles Achieved stat.",
    ownershipList: `${PROFILE}.RanksComponent.v.ReceivedItems`,
    equipPath: `${PROFILE_DATA_V}.RankId`,
    mirrorNewItems: true,
    items: TITLE_ITEMS,
  },
  {
    kind: "avatars",
    label: "Avatars",
    description: "Profile pictures, unlocked via Avatars.unlocked<id> flags.",
    flagPrefix: "Avatars.unlocked",
    equipPath: "Properties.avatarId",
    items: AVATAR_ITEMS,
  },
];

export function groupOf(kind: CosmeticKind): CosmeticGroup {
  const g = COSMETICS.find((g) => g.kind === kind);
  if (!g) throw new SaveError(`unknown cosmetics group: ${kind}`);
  return g;
}

/** Reject ids that are not in the researched catalog (typos, stale writes). */
function assertIds(g: CosmeticGroup, ids: readonly string[]): void {
  for (const id of ids) {
    if (!g.items.some((it) => it.id === id)) {
      throw new SaveError(`unknown ${g.kind} id: ${JSON.stringify(id)}`);
    }
  }
}

/** Canonical ProfileData content for a fresh (null) materialization.
 *
 *  The shapes below were diffed against a save the game itself wrote, not
 *  assumed. Two things that diff proved and this code now follows:
 *
 *   - Permanent cosmetics carry `ValidUntil = 0`. The game writes 0 for
 *     Frame and Style; only Badge/Rank carry an absolute expiry. Writing a
 *     far-future date for every family did not match anything the client
 *     actually produces.
 *   - Rank keeps a `FallbackId` and a `ValidUntil` beside `RankId`. Writing
 *     RankId alone left a half-formed field family.
 */
function materializeProfile(kind: CosmeticKind, id: string): JsonValue {
  switch (kind) {
    case "frames":
      return {
        FrameId: id,
        FrameFallbackId: "",
        FrameValidUntil: { t: "i64", v: "0" },
      };
    case "styles":
      return {
        StyleId: id,
        StyleFallbackId: "",
        StyleValidUntil: { t: "i64", v: "0" },
      };
    case "badges":
      return {
        BadgeId: id,
        BadgeFallbackId: "",
        BadgeValidUntil: { t: "i64", v: String(FAR_FUTURE) },
      };
    case "titles":
      return {
        RankId: id,
        RankFallbackId: "default",
        RankValidUntil: { t: "i64", v: String(FAR_FUTURE) },
      };
    case "avatars":
      throw new SaveError("avatars do not live in ProfileData");
  }
}

/**
 * Ops granting ownership of `ids` (merged into what the save already has).
 * Empty result = everything already owned (idempotent).
 */
export function grantOps(save: SaveGame, kind: CosmeticKind, ids: readonly string[]): EditOp[] {
  const g = groupOf(kind);
  const wanted = [...new Set(ids)];
  assertIds(g, wanted);
  if (wanted.length === 0) return [];

  // ---- avatars: per-id unlock flags -----------------------------------
  if (g.flagPrefix) {
    /** In-group member name (`unlocked<id>`), vs the full path (`Avatars.unlocked<id>`). */
    const member = (id: string): string => `${g.flagPrefix!.slice(g.flagPrefix!.indexOf(".") + 1)}${id}`;
    const ensure: string[] = [];
    for (const id of wanted) {
      const flag = `${g.flagPrefix}${id}`;
      if (!save.has(flag)) ensure.push(id);
      else if (save.field(flag).value !== true) ensure.push(id);
    }
    if (ensure.length === 0) return [];

    if (!save.has("Avatars")) {
      // Fresh save without the group at all: create it at the root.
      const obj: Record<string, JsonValue> = {};
      for (const id of ensure) obj[member(id)] = true;
      return [{ path: "Avatars", value: obj, create: true }];
    }
    if (save.field("Avatars").kind === "null") {
      // Null group → one wholesale materialization (allowed on null leaves).
      const obj: Record<string, JsonValue> = {};
      for (const id of ensure) obj[member(id)] = true;
      return [{ path: "Avatars", value: obj }];
    }
    // Existing object → per-flag writes (create or flip false→true).
    return ensure.map((id) => {
      const flag = `${g.flagPrefix}${id}`;
      return save.has(flag)
        ? { path: flag, value: true }
        : { path: flag, value: true, create: true };
    });
  }

  // ---- list-backed groups: union into ReceivedItems --------------------
  const listPath = g.ownershipList!;
  const newListPath = listPath.replace(/\.ReceivedItems$/, ".NewItems");
  /** Seed for a component materialized out of `null`: styles and ranks carry
   *  a full copy in NewItems, frames and badges leave it empty. */
  const seedNew = g.mirrorNewItems ? wanted.join(",") : "";

  if (save.has(listPath)) {
    const current = save.string(listPath).split(",").filter(Boolean);
    const merged = [...current];
    for (const id of wanted) if (!merged.includes(id)) merged.push(id);
    if (merged.length === current.length) return []; // all already owned
    const ops: EditOp[] = [{ path: listPath, value: merged.join(",") }];
    if (g.mirrorNewItems) {
      const curNew = save.has(newListPath)
        ? save.string(newListPath).split(",").filter(Boolean)
        : [];
      const mergedNew = [...curNew];
      for (const id of merged) if (!mergedNew.includes(id)) mergedNew.push(id);
      if (mergedNew.length !== curNew.length) {
        ops.push(
          save.has(newListPath)
            ? { path: newListPath, value: mergedNew.join(",") }
            : { path: newListPath, value: mergedNew.join(","), create: true },
        );
      }
    }
    return ops;
  }

  // Ownership list missing: fresh RanksComponent-style `v: null`, or a
  // component that predates the member entirely.
  const compV = listPath.slice(0, listPath.lastIndexOf("."));
  if (save.has(compV)) {
    if (save.field(compV).kind === "null") {
      return [{ path: compV, value: { NewItems: seedNew, ReceivedItems: wanted.join(",") } }];
    }
    return [{ path: listPath, value: wanted.join(","), create: true }];
  }
  const wrapper = compV.slice(0, compV.lastIndexOf("."));
  if (save.has(wrapper)) {
    // Wrapper present but lacking its `v` member: insert it.
    return [
      { path: compV, value: { NewItems: seedNew, ReceivedItems: wanted.join(",") }, create: true },
    ];
  }
  // Defensive: the whole component is missing — recreate the tagged wrapper.
  // (`create()` inserts the remaining path as one literal key, so the wrapper
  // itself must be the created member to keep the {"t":"ds","v":...} shape.)
  return [
    {
      path: wrapper,
      value: { t: "ds", v: { NewItems: seedNew, ReceivedItems: wanted.join(",") } },
      create: true,
    },
  ];
}

/**
 * Ops equipping `id`. Combine with grantOps first so the picker accepts it:
 * `[...grantOps(save, kind, [id]), ...equipOps(save, kind, id)]`.
 * Materializes a fresh `ProfileData.v = null` with the canonical shape.
 */
export function equipOps(save: SaveGame, kind: CosmeticKind, id: string): EditOp[] {
  const g = groupOf(kind);
  assertIds(g, [id]);

  if (kind === "avatars") {
    return save.has(g.equipPath)
      ? [{ path: g.equipPath, value: id }]
      : [{ path: g.equipPath, value: id, create: true }];
  }

  if (!save.has(PROFILE_DATA_V)) {
    const wrapper = `${PROFILE}.ProfileData`;
    // `create()` inserts the remaining path as one literal key, so a missing
    // wrapper must be recreated at wrapper level to keep the tagged shape.
    if (save.has(wrapper)) {
      return [{ path: PROFILE_DATA_V, value: materializeProfile(kind, id), create: true }];
    }
    return [{ path: wrapper, value: { t: "ds", v: materializeProfile(kind, id) }, create: true }];
  }
  if (save.field(PROFILE_DATA_V).kind === "null") {
    return [{ path: PROFILE_DATA_V, value: materializeProfile(kind, id) }];
  }
  if (save.has(g.equipPath)) {
    return [{ path: g.equipPath, value: id }];
  }
  return [{ path: g.equipPath, value: id, create: true }];
}

/**
 * Convenience: grant + equip in one batch (the safe order — grant first).
 * Idempotent: re-running for an already-owned, already-equipped item is a
 * no-op batch (runApply applies zero writes and commits unchanged bytes).
 */
export function cosmeticOps(
  save: SaveGame,
  kind: CosmeticKind,
  opts: { grant?: readonly string[]; equip?: string },
): EditOp[] {
  const ops: EditOp[] = [];
  const grant = opts.grant ?? (opts.equip !== undefined ? [opts.equip] : []);
  ops.push(...grantOps(save, kind, grant));
  if (opts.equip !== undefined) ops.push(...equipOps(save, kind, opts.equip));
  return ops;
}

/**
 * Ops equipping one id per kind in a SINGLE overlap-free batch. Needed
 * because independent equipOps calls on a fresh save would each materialize
 * the same `ProfileData.v = null` span; this merges the canonical field sets
 * into one materialization instead. Member-level equips on an already
 * materialized ProfileData stay per-kind (their spans are disjoint).
 */
export function equipManyOps(
  save: SaveGame,
  equips: Partial<Record<CosmeticKind, string>>,
): EditOp[] {
  const ops: EditOp[] = [];
  const profileKinds = (["frames", "styles", "badges", "titles"] as const).filter(
    (k) => equips[k] !== undefined,
  );
  if (profileKinds.length > 0) {
    if (save.has(PROFILE_DATA_V) && save.field(PROFILE_DATA_V).kind !== "null") {
      for (const k of profileKinds) ops.push(...equipOps(save, k, equips[k]!));
    } else {
      // One wholesale materialization carrying every requested field set
      // (the four field families are disjoint by construction).
      const obj: Record<string, JsonValue> = {};
      for (const k of profileKinds) Object.assign(obj, materializeProfile(k, equips[k]!));
      const wrapper = `${PROFILE}.ProfileData`;
      if (save.has(PROFILE_DATA_V)) ops.push({ path: PROFILE_DATA_V, value: obj });
      else if (save.has(wrapper)) ops.push({ path: PROFILE_DATA_V, value: obj, create: true });
      else ops.push({ path: wrapper, value: { t: "ds", v: obj }, create: true });
    }
  }
  if (equips.avatars !== undefined) ops.push(...equipOps(save, "avatars", equips.avatars));
  return ops;
}
