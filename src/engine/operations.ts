/**
 * Operation layer between the HTTP API and the engine.
 *
 * A request is a list of field writes plus a couple of safety toggles. The
 * result is the patched bytes plus a full audit trail the UI renders as a
 * diff — the user must always be able to see exactly which bytes changed and
 * why before anything is pushed to a device.
 */

import { CATALOG, type CatalogField } from "./catalog.ts";
import { decodeSave, encodeSave, type CodecResult } from "./codec.ts";
import { refreshIntegrity, type IntegrityRefreshResult } from "./integrity.ts";
import type { EditSummary, JsonValue } from "./patcher.ts";
import { openSave, SaveError, type SaveGame } from "./savegame.ts";

export interface EditOp {
  path: string;
  value: JsonValue;
  /** Insert a NEW member into an existing object instead of editing a leaf. */
  create?: boolean;
  /** Append one element to an EXISTING array (the `OwnedCards` album, lists). */
  append?: boolean;
}

export interface ApplyOptions {
  /** Bring the proven-derived `CeReas_R1` / `CeReas_R4` strings back in sync. */
  refreshIntegrity?: boolean;
}

export interface ApplyResult {
  ok: boolean;
  /** UTF-8 JSON bytes of the patched save, still in plain-JSON form. */
  bytes: Uint8Array;
  summary: EditSummary[];
  integrity: IntegrityRefreshResult | null;
  warnings: string[];
  errors: string[];
  inputBytes: number;
  outputBytes: number;
  wasEncrypted: boolean;
}

const catalogIndex = new Map<string, CatalogField>();
for (const g of CATALOG) for (const f of g.fields) catalogIndex.set(f.path, f);

/**
 * The game's statistics live in a TAGGED dictionary:
 *
 *   SpecialEvents.UserProfileFeature.v.UserProfileStatistics
 *     { "t": "ds", "v": { "FirstTryWins": 12, … } }
 *
 * A fresh account may not have the `v` member (or the whole `UserProfileStatistics`
 * object) yet. A plain `create()` would splice the remainder as one literal key
 * — `"v.FirstTryWins": 12` — which the game never reads, so the card kept
 * saying "not in save" after a successful Save. This helper creates the
 * missing shape at the right level instead.
 */
const PROFILE_V = "SpecialEvents.UserProfileFeature.v";
const PROFILE_STAT_ROOT = `${PROFILE_V}.UserProfileStatistics`;

function taggedDictionaryOp(save: SaveGame, path: string, value: JsonValue): EditOp | null {
  if (path !== PROFILE_STAT_ROOT && !path.startsWith(`${PROFILE_STAT_ROOT}.`)) return null;
  const key = path.slice(path.lastIndexOf(".") + 1);
  const dictionary = `${PROFILE_STAT_ROOT}.v`;

  if (save.has(dictionary)) {
    const field = save.field(dictionary);
    // The game writes this dictionary two ways depending on version:
    //   older/newer:  "v": { "FirstTryWins": 12, … }        (bare object)
    //   some builds:  "v": "{\"FirstTryWins\":12,…}"          (JSON text)
    // A byte-splice into the string form is impossible (its parent is a
    // string), so rewrite the whole string with one extra member. Same value,
    // same encoding — the game keeps reading it exactly as before.
    if (field.span.type === "string") {
      let decoded: Record<string, JsonValue> = {};
      try {
        const parsed: unknown = JSON.parse(field.value as string);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          decoded = parsed as Record<string, JsonValue>;
        }
      } catch {
        // A malformed dictionary is replaced with a clean one — better than a
        // write that silently does nothing.
      }
      decoded[key] = value;
      return { path: dictionary, value: JSON.stringify(decoded) };
    }
    // Wrapper exists: `null` is materialized wholesale, an object gets a member.
    if (field.kind === "null") return { path: dictionary, value: { [key]: value } };
    if (field.span.type === "object") return { path, value, create: true };
    return null;
  }
  if (save.has(PROFILE_STAT_ROOT)) {
    return { path: dictionary, value: { [key]: value }, create: true };
  }
  if (save.has(PROFILE_V)) {
    return { path: PROFILE_STAT_ROOT, value: { t: "ds", v: { [key]: value } }, create: true };
  }
  return null;
}

/**
 * When `…UserProfileStatistics.v` is stored as JSON *text*, every stat write
 * has to rewrite that one string. Merging them first keeps a batch (the
 * dashboard saves several cards at once) from clobbering itself: each later
 * op would otherwise parse the original string and drop the earlier keys.
 */
function coalesceStringDictionary(save: SaveGame, ops: readonly EditOp[]): EditOp[] {
  const dictionary = `${PROFILE_STAT_ROOT}.v`;
  if (!save.has(dictionary)) return [...ops];
  const field = save.field(dictionary);
  if (field.span.type !== "string") return [...ops];

  const merged = new Map<string, JsonValue>();
  const rest: EditOp[] = [];
  for (const op of ops) {
    const isStat =
      (op.path === PROFILE_STAT_ROOT || op.path.startsWith(`${PROFILE_STAT_ROOT}.`)) && !save.has(op.path);
    if (isStat) merged.set(op.path.slice(op.path.lastIndexOf(".") + 1), op.value);
    else rest.push(op);
  }
  if (merged.size === 0) return [...ops];

  let decoded: Record<string, JsonValue> = {};
  try {
    const parsed: unknown = JSON.parse(field.value as string);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      decoded = parsed as Record<string, JsonValue>;
    }
  } catch {
    // Replace the malformed string with a clean dictionary.
  }
  for (const [key, value] of merged) decoded[key] = value;
  rest.push({ path: dictionary, value: JSON.stringify(decoded) });
  return rest;
}

/** Cross-check a requested value against the catalogue's declared bounds. */
function validateOp(save: SaveGame, op: EditOp): string[] {
  const warnings: string[] = [];
  const meta = catalogIndex.get(op.path);
  if (!meta) return warnings; // unknown/discovered field — no declared bounds

  if (typeof op.value === "number") {
    if (meta.min !== undefined && op.value < meta.min) {
      warnings.push(`${meta.label}: ${op.value} is below the safe minimum ${meta.min}`);
    }
    if (meta.max !== undefined && op.value > meta.max) {
      warnings.push(`${meta.label}: ${op.value} exceeds the safe maximum ${meta.max}`);
    }
    if (save.has(op.path) && meta.control === "int" && !Number.isInteger(op.value)) {
      warnings.push(`${meta.label}: ${op.value} is not an integer; it will be rejected`);
    }
  }

  // Semantic warnings that bounds alone do not express.
  if (
    (op.path === "Properties.LID_Lvl" || op.path === "Properties.level") &&
    typeof op.value === "number" &&
    save.has(op.path)
  ) {
    const current = save.number(op.path);
    if (op.value > current + 200) {
      warnings.push(
        `Level ${current} → ${op.value} is a very large jump; later orders may be un-completable.`,
      );
    }
  }
  if (op.path === "Properties.coins" && typeof op.value === "number" && op.value > 2_000_000_000) {
    warnings.push("Coins above ~2B sit at the edge of the signed 32-bit range the client uses.");
  }
  return warnings;
}

/**
 * Apply a batch of edits to decoded plain-JSON save bytes.
 * Never re-serializes: every write is a byte splice.
 */
export function runApply(
  plainBytes: Uint8Array,
  ops: readonly EditOp[],
  opts: ApplyOptions = {},
  codec?: CodecResult,
): ApplyResult {
  const save: SaveGame = openSave(plainBytes, codec?.wasEncrypted ?? false);
  const warnings: string[] = codec?.warning ? [codec.warning] : [];
  const errors: string[] = [];
  const batch = coalesceStringDictionary(save, ops);

  for (const op of batch) {
    try {
      warnings.push(...validateOp(save, op));
      if (op.append) {
        save.append(op.path, op.value);
      } else if (op.create) {
        save.create(op.path, op.value);
      } else if (!save.has(op.path)) {
        // A path THROUGH an array that does not resolve is a row that is not
        // there yet. `create()` would splice a literal `"OwnedCards[4]…"`
        // member into the parent object and corrupt the save — a new row can
        // only be appended to the array itself.
        const row = /^(.*)\[(\d+)\]/.exec(op.path);
        if (row?.[1] !== undefined && row[2] !== undefined) {
          throw new SaveError(
            `${op.path} is not an existing array row — a new row must be appended to ${row[1]}`,
          );
        }
        // Tagged dictionaries (`…UserProfileStatistics.v`) need their wrapper
        // recreated, not a dotted literal key.
        const tagged = taggedDictionaryOp(save, op.path, op.value);
        if (tagged) {
          if (tagged.create) save.create(tagged.path, tagged.value);
          else save.set(tagged.path, tagged.value);
          warnings.push(`${op.path} did not exist in this save and was created`);
          continue;
        }
        // Catalog fields absent from this save (fresh installs lack
        // `Properties.level`, `PlayerItems.*`, …) are created on write so a
        // typed value never dead-ends in a "unknown path" refusal.
        save.create(op.path, op.value);
        warnings.push(`${op.path} did not exist in this save and was created`);
      } else {
        save.set(op.path, op.value);
      }
    } catch (err) {
      errors.push(err instanceof SaveError ? err.message : String(err));
    }
  }

  if (errors.length > 0) {
    save.discard();
    return {
      ok: false,
      bytes: plainBytes,
      summary: [],
      integrity: null,
      warnings,
      errors,
      inputBytes: plainBytes.length,
      outputBytes: plainBytes.length,
      wasEncrypted: codec?.wasEncrypted ?? false,
    };
  }

  let integrity: IntegrityRefreshResult | null = null;
  if (opts.refreshIntegrity) {
    try {
      integrity = refreshIntegrity(save);
    } catch (err) {
      warnings.push(`integrity refresh skipped: ${(err as Error).message}`);
    }
  }

  let out: Uint8Array;
  let summary: EditSummary[];
  try {
    const committed = save.commit();
    out = committed.bytes;
    summary = committed.summary;
  } catch (err) {
    return {
      ok: false,
      bytes: plainBytes,
      summary: [],
      integrity,
      warnings,
      errors: [(err as Error).message],
      inputBytes: plainBytes.length,
      outputBytes: plainBytes.length,
      wasEncrypted: codec?.wasEncrypted ?? false,
    };
  }

  return {
    ok: true,
    bytes: out,
    summary,
    integrity,
    warnings,
    errors,
    inputBytes: plainBytes.length,
    outputBytes: out.length,
    wasEncrypted: codec?.wasEncrypted ?? false,
  };
}

/** Convenience wrapper that decodes a container, applies, and re-encodes. */
export function applyToContainer(
  containerBytes: Uint8Array,
  ops: readonly EditOp[],
  opts: ApplyOptions = {},
): ApplyResult & { encoded: Uint8Array } {
  const codec = decodeSave(containerBytes);
  const res = runApply(codec.bytes, ops, opts, codec);
  const encoded = res.ok ? encodeSave(res.bytes, codec) : containerBytes;
  return { ...res, encoded };
}
