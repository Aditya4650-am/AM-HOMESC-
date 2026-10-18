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

  for (const op of ops) {
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
