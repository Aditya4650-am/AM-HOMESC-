/**
 * Homescapes save engine — public surface.
 *
 * The single most important invariant in this package:
 *
 *     NEVER re-serialize the save. Always splice raw bytes.
 *
 * Re-serializing a 4.5 MB Playrix save drops >100 KB and corrupts the file
 * (measured: `json.dumps(indent="\t")` yields 4,372,905 bytes against an
 * original of 4,553,170). Every write therefore goes through `RawEdit` spans
 * resolved by a bytes-level scanner, and `assertUntouched` proves afterwards
 * that nothing outside those spans moved.
 */

export {
  scanSpans,
  valueText,
  keyText,
  decodeJsonString,
  firstValueByte,
  ScanError,
  type MemberSpan,
  type SpanIndex,
  type ValueType,
} from "./json-span.ts";

export {
  applyEdits,
  assertUntouched,
  validateEdits,
  encodeJsonNumber,
  encodeJsonString,
  encodeJsonValue,
  fromBytes,
  toBytes,
  PatchError,
  type EditSummary,
  type JsonValue,
  type RawEdit,
} from "./patcher.ts";

export {
  decodeSave,
  encodeSave,
  wrapSave,
  describeContainer,
  describeCodec,
  type CodecKeyId,
  type CodecResult,
} from "./codec.ts";

export { xorKey, XOR_KEY_B64, XOR_KEY_BYTES, XOR_KEY_SHA256 } from "./xor-key.ts";

export {
  f205Key,
  F205_KEY_B64,
  F205_KEY_BYTES,
  F205_KEY_SHA256,
} from "./f205-key.ts";

export {
  openSave,
  SaveGame,
  SaveError,
  type FieldKind,
  type SaveField,
} from "./savegame.ts";

export {
  readIntegrity,
  refreshIntegrity,
  expectedR4Value,
  toU32,
  BOOSTER_PATHS,
  R_PATHS,
  type IntegrityReport,
  type IntegrityRefreshResult,
  type IntegritySlice,
} from "./integrity.ts";

export {
  CATALOG,
  PREFIX_SECTIONS,
  discoverPrefix,
  summarize,
  storageMap,
  type CatalogField,
  type CatalogGroup,
  type Control,
  type DiscoveredField,
  type Overview,
  type PrefixSection,
} from "./catalog.ts";

export {
  runApply,
  applyToContainer,
  type ApplyOptions,
  type ApplyResult,
  type EditOp,
} from "./operations.ts";

export {
  COSMETICS,
  groupOf,
  grantOps,
  equipOps,
  equipManyOps,
  cosmeticOps,
  type CosmeticGroup,
  type CosmeticKind,
  type CosmeticItem,
} from "./cosmetics.ts";

export {
  FRAME_ITEMS,
  STYLE_ITEMS,
  BADGE_ITEMS,
  TITLE_ITEMS,
  AVATAR_ITEMS,
} from "./cosmetics-data.ts";

export {
  CARDS_PER_SET,
  CARD_COUNT,
  SET_COUNT,
  STOCK_CAP,
  BATCH_MAX,
  ALBUM_PATH,
  SETS_PATH,
  GIFT_PATH,
  cardIdOf,
  setOfCard,
  parseSetId,
  readAlbum,
  planGrants,
  type OwnedCard,
  type AlbumState,
  type GrantPlan,
} from "./cards.ts";
