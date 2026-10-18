/**
 * Ban guard for account clones.
 *
 * A Playrix save declares *whose* save it is. In Homescapes that owner identity
 * lives in a small set of `Properties.*` fields — `gameId` (the account GUID),
 * `name`, `avatarId`, `InstallDate`, `InstallType`, `IndicatedVirtualCitizenship`,
 * the install/session clock (`firstPlayTime`, `sessionsCount`, `timeInGame`,
 * `lastSession*`, `lastServerTime`) and the device fingerprint
 * (`ExpeditionModule.DeviceSupportsByKey`) — plus the roots the account declares
 * with (`PAI`, `ASN_SAVE_DATA`) and the social roots that name other players.
 *
 * Measured here on 2026-10-17: a byte-for-byte "full clone" of the level-656
 * community save onto a fresh account landed in game (the client rendered it)
 * and was answered with Playrix's *"our system has flagged your in-game
 * activity as suspicious … we've limited your participation"* warning. The
 * clone had overwritten `Properties.gameId` / `name` / `avatarId` with the
 * donor's, so the uploaded save declared a different player as its owner.
 *
 * The reference tool hit the same wall in Township (`AGENTS.md`, *Identity: why
 * a copy caused an instant Playrix ban*) and solved it by never letting the
 * donor's identity survive (`assertNoForeignIdentity` + a scrubber that
 * rewrites the donor id to ours).
 *
 * Homescapes is fixed the same way, but the *shape* of the operation matters:
 * a partial merge of a level-656 tree onto a level-1 save is internally
 * incoherent and the client crashes on load (also measured). So the clone is
 * **the donor's whole save, with the identity fields rewritten to ours** —
 * coherent content, our owner. `planIdentityOps` produces exactly those
 * rewrites; `snapshotIdentity` / `identityDiff` are the push gate that refuses
 * a result which still carries the donor's identity.
 */

import {
  openSave,
  type EditOp,
  type JsonValue,
} from "../engine/index.ts";

/**
 * **Owner identity** — the fields that say *whose* save this is. Only these are
 * rewritten to our account; everything else (including the install clock and
 * the lifetime history) travels with the transplanted town.
 *
 * This split is the whole fix. The reference tool's measured rule is that the
 * *contradiction* is what a server reads: a transplanted veteran town sitting
 * under counters that say "installed today, 2 sessions, 42 minutes played" is
 * internally impossible, and Playrix answers with the "suspicious activity"
 * warning. The reference records the same thing verbatim —
 *
 *   > `completo` / `novo` transplant the friend's whole town … while our own
 *   > counters said "founded two months ago". The contradiction then sits
 *   > *inside the blocks just copied*. **Copying the history with the town is
 *   > what removes it.**
 *
 * so `InstallDate`, `firstPlayTime`, `sessionsCount`, `timeInGame`,
 * `lastSession*`, `lastServerTime`, `TermsOfUseAcceptedTimestamp`, `LID_*`,
 * `PAI`, `ASN_SAVE_DATA` and `ReinstallsInfo` are deliberately **not** here: a
 * level-656 town has to carry a level-656 history. What stays ours is the
 * account's declared owner (`gameId`, `name`, `avatarId` — the `SaveId` /
 * `mainPlayer` equivalents the reference refuses to import), the device
 * fingerprint, and the social roots that name other players.
 */
export const IDENTITY_PREFIXES: readonly string[] = [
  "Properties.gameId",
  "Properties.name",
  "Properties.avatarId",
  "Properties.InstallType",
  "Properties.IndicatedVirtualCitizenship",
  "Properties.UserProfileRestrictions",
  "Properties.IsDefaultAgeRestrictionsApplied",
  "Properties.CCSecretB",
  "Properties.CCSecretC",
  "Properties.CeReas_",
  "Properties.formatVer",
  "Properties.LastInstalledVersion",
  "Properties.LastInstalledVersionDate",
  "Properties.FirstRunGameVersion",
  "Properties.appsFlyerEmulatorDetectedTracked",
  "Properties.appsFlyerTutorialFinishedTracked",
  "Properties.SwrveUserInfoCheatedTracked",
  "Properties.fbTutorialFinishedTracked",
  "ExpeditionModule.DeviceSupportsByKey",
  "SpecialEvents.UserProfileFeature.v.UserProfileFriendsStorage",
  "SpecialEvents.UserProfileFeature.v.FakeUserProfilesStorage",
  "SpecialEvents.UserProfileFeature.v.GeneratedUserName",
  "SpecialEvents.UserProfileFeature.v.UserProfileStatistics",
  "SpecialEvents.WeeklyContestFeature",
  "SpecialEvents.version_FacebookConnect",
  "SpecialEvents.version_FacebookFan",
];

/**
 * `SpecialEvents.UnifiedLeaderboard` names ~40 other players. It is social
 * data, not ownership, and dropping it wholesale would leave the leaderboard
 * window undefined, so it is deliberately **not** guarded: a leaderboard of
 * other players is normal in every save.
 */

/** Progression the opt-in "keep my level & coins" mode copies back. */
export const PROGRESS_PREFIXES: readonly string[] = [
  "Properties.coins",
  "Properties.coinsForDesign",
  "Properties.earnedCoinsCount",
  "Properties.spentCoinsCount",
  "Properties.realCoins",
  "Properties.boughtCoins",
  "Properties.earnedStars",
  "Properties.spentStars",
  "Properties.LID_Lvl",
  "Properties.LID_Time",
  "Properties.BetaCurrentLevel",
  "Properties.currentChapter",
  "Properties.currentDay",
  "Properties.QuestIndexInChapter",
  "Properties.Clusters",
  "Properties.ShownTutorials",
  "Properties.lives",
  "Properties.lastPlayedDay",
  "Properties.RFM_Checkpoint",
  "Properties.CompletedChaptersAvatarRewardReceived",
  "Properties.CurrentChapterReward",
  "Properties.CurrentChapterRewardStage",
  "Properties.FirstScreenplay",
  "Properties.FirstScreenplayStr",
  "Properties.ACService",
];

/* ================================================================ content ==
 * The deep-research finding behind this split, from the 9.2.101 APK:
 *
 *   - `lib/x86_64/libgame.so` carries a whole `Anticheats` module:
 *     `R1Check` … `R9Check`, `RUCheck`, `BJBCheck`, `CPLCheck`,
 *     `MaxBoostCheck`, `AnticheatManager::CheckIsCheater`,
 *     `SecretValuesKeeper::LoadState/SaveState`, and
 *     `AntiCheat::Analytics::TrackSecretValueModification`, which fires a
 *     `SecretValueValidationFailedEvent` at Amplitude when a save's *secret
 *     values* (the `Properties.CeReas_<ID>` strings, one per check) no longer
 *     derive from the live state.
 *   - The client also reports `cheater`, `cheater_reason`,
 *     `balance_conditions_state`, `balance_hash`, `level`, `max_available_level`,
 *     `chapter`, `first_install_date`, `lifetime`, `inapps_count/sum/max` and the
 *     whole balance set as Amplitude user properties.
 *   - The server side answers with the event `AntiCheat.Server.ScoreValidation.Failed`
 *     and the action `SetPause(`, which is what raises
 *     `IsCheatersRestrictionsActive` and opens `UI_AntiCheat_CheaterWindow` —
 *     the *"our system has flagged your in-game activity as suspicious"* popup.
 *
 * In other words the account's **progress** is scored server-side against the
 * account's own history. That cannot be rewritten from the save, and every
 * full-save transplant measured on 2026-10-17 (byte-for-byte, identity-guarded,
 * and history-travelling) was answered with the warning. What a save *can*
 * safely carry is the account's **content** — the thing you actually look at.
 *
 * So a "complete home" clone transplants content roots and leaves every
 * progression root on the account untouched. `Repairs` alone (the home) is the
 * build already proven clean in game for 5+ minutes; the rest of this list is
 * the same class of data.
 */
/**
 * **Not content — a paid-feature claim, carried because it was explicitly
 * asked for.** Kept as its own list so it can be dropped with one line.
 *
 * `SeasonPassInfoCache` holds `goldenPassPurchased`, `unlockedFree/Gold` and
 * `collectedFree/Gold` for the active season (`SSPProcedure46` on the donor).
 * Research on 9.2.101 (`libgame.so`) shows the Golden Ticket ("Golden Pass") is
 * a **real-money, store-priced purchase validated server-side**:
 * `GetGoldenTicketLocalizedPrice`, `GoldenTicketPurchaseInfoWindow`,
 * `SeasonPassOpenBuyGoldenTicketWindow`, `OnGoldenTicketBought`,
 * `OnSeasonPassGoldenTicketBoughtFailed`, and a staged `ValidatePurchase:` /
 * `PurchaseValidationStage` / `CheckPurchaseParameters: different product id`
 * pipeline over `ConsumePurchase` per store.
 *
 * Measured on the `hstest` account (level 1), 2026-10-17: the cloned cache is
 * **not** reverted by the game — `goldenPassPurchased=true`, `unlockedGold=31`
 * and `seasonPassEventId=SSPProcedure46` all survived the game's own re-save
 * (421 KB -> 495 KB) across a 10-minute watch with no anti-cheat popup. But it
 * also **grants nothing that could be verified**: the tier currency
 * (`Currency.SeasonPass*Points`) is a `PROGRESS_ROOTS` entry we deliberately do
 * not clone and the account has none, the gold-row rewards are delivered
 * server-side, and the pass window is not offered to a level-1 account at all.
 *
 * So this is a client-side claim of a purchase the account never made. It is
 * here because the operator asked for max golden pass; if that is not wanted,
 * empty this list — nothing else in the clone depends on it.
 */
export const SEASON_PASS_STATE: readonly string[] = ["SeasonPassInfoCache"];

export const CONTENT_ROOTS: readonly string[] = [
  "Repairs",
  "RepairsHistory",
  "RoomDesign",
  "GardenObject",
  "RemovedObjects",
  "StorageErasers",
  "Characters",
  "Avatars",
  "Garment",
  "ClusterVsoEffects",
  "GameModifiers",
  "Minigame",
  "Match3",
  ...SEASON_PASS_STATE,
  "PhotoAlbums",
];

/**
 * Roots the server scores against the account's own history. A content clone
 * refuses any of these: they are what `AntiCheat.Server.ScoreValidation`
 * compares, so copying them is the ban.
 */
export const PROGRESS_ROOTS: readonly string[] = [
  "Properties",
  "AccumulatedSatistics",
  "StepsState",
  "PlayerHistory",
  "PlayerStatistic",
  "Incomes",
  "QuestTargets",
  "Quests",
  "DailyBonus",
  "PlayerAchievements",
  "Currency",
  "Buyings",
  "Purchases",
  "SpecialEvents",
  "ExpeditionModule",
  "ASN_SAVE_DATA",
  "DevicesInfo",
  "NewGameEventsAutoStores",
  "GameTrophy",
  "Clan",
  "PAI",
  "UsedIds",
  "Tutorials",
  "AnalyticsProperties",
  "ABTests",
  "AdvertisingIdHist",
  "ExtendedMetricHistory",
  "LastCrashInfo",
  "Mechanics",
  "ReinstallsInfo",
  "PlayerItems",
];

/** A root is refused when it is (or sits under) a progression root. */
export function assertContentRoots(roots: readonly string[]): void {
  for (const r of roots) {
    const top = r.split(".")[0]!;
    if (PROGRESS_ROOTS.includes(top)) {
      throw new Error(
        `refusing to clone "${r}": ${top} is progression the server scores ` +
          `(AntiCheat.Server.ScoreValidation). A content clone only carries ` +
          `what the account shows, never how far it has got.`,
      );
    }
  }
}

/** Lifetime counters a cheated donor can overflow into negatives. */
const COUNTER_PATHS: readonly string[] = [
  "Properties.coins",
  "Properties.earnedCoinsCount",
  "Properties.earnedStars",
  "Properties.spentStars",
  "Properties.spentCoinsCount",
  "Properties.realCoins",
  "Properties.boughtCoins",
];

function isUnder(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => path === p || path.startsWith(`${p}.`));
}

/** Integrity strings the engine recomputes; never copied, never diffed. */
const RECOMPUTED = "Properties.CeReas_";

export interface IdentityPlan {
  ops: EditOp[];
  /** Identity leaves copied from the account we are cloning into. */
  identityOps: number;
  /** Progression leaves copied back when `keepProgress` is set. */
  progressOps: number;
  /** Donor counters dropped because the donor's value was impossible. */
  sanitized: string[];
  /** Overflowed (large-negative) donor values clamped to zero. */
  clamped: string[];
  clampedCount: number;
  /** Identity paths the donor carries that we could not rewrite. */
  unrewritten: string[];
  /** Identity paths where the donor holds a branch the target has as null. */
  branchKept: string[];
}

/**
 * Build the rewrites that put **our** identity onto the donor's save.
 *
 * Every leaf the target holds under an identity (or, in safe mode, progression)
 * prefix is written over the donor's. Paths the donor lacks are created, so
 * `FirstRunGameVersion` and friends survive too.
 */
export function planIdentityOps(
  targetPlain: Uint8Array,
  donorPlain: Uint8Array,
  opts: { keepProgress?: boolean } = {},
): IdentityPlan {
  const target = openSave(targetPlain);
  const donor = openSave(donorPlain);
  // Off by default: keeping our low level/balance under the donor's veteran town
  // is exactly the contradiction the reference measures as the ban trigger.
  const keepProgress = opts.keepProgress === true;

  const ops: EditOp[] = [];
  const sanitized: string[] = [];
  const unrewritten: string[] = [];
  const branchKept: string[] = [];
  let identityOps = 0;
  let progressOps = 0;

  for (const p of target.paths()) {
    if (p.startsWith(RECOMPUTED)) continue;

    const member = target.index.members.get(p);
    if (!member || member.type === "object" || member.type === "array") continue;

    const identity = isUnder(p, IDENTITY_PREFIXES);
    const progress = keepProgress && isUnder(p, PROGRESS_PREFIXES);
    if (!identity && !progress) continue;

    // A counter the donor overflowed into a negative is not something we can
    // import; the target's own value is used, or zero when it is negative too.
    const rawValue = target.field(p).value as JsonValue;
    const value =
      isCounter(p) && typeof rawValue === "number" && rawValue < 0 ? 0 : rawValue;
    if (value !== rawValue) sanitized.push(p);

    // The target stores a bare null where the donor holds a branch of real
    // data (an empty friend list, an unused schedule context). The donor's
    // branch is left standing — it is content, not a declaration of ownership.
    const dm = donor.index.members.get(p);
    if (dm && (dm.type === "object" || dm.type === "array")) {
      if (branchKept.length < 50) branchKept.push(p);
      continue;
    }

    ops.push({ path: p, value });
    if (identity) identityOps++;
    else progressOps++;
  }

  // Counters the donor overflowed that the loop above did not visit (safe mode
  // off, or a counter outside the guarded prefixes) are clamped to zero too —
  // a negative star/coin balance is the one thing a server can read as
  // provably wrong without any inference.
  for (const c of COUNTER_PATHS) {
    if (ops.some((o) => o.path === c)) continue;
    if (!donor.has(c)) continue;
    const dv = donor.field(c).value;
    if (typeof dv === "number" && dv < 0) {
      ops.push({ path: c, value: 0 });
      sanitized.push(c);
    }
  }

  // Identity paths the target holds as a whole object (PAI, ASN_SAVE_DATA) are
  // covered by their leaves above; anything the donor holds that we could not
  // reach is reported instead of silently kept.
  for (const p of IDENTITY_PREFIXES) {
    if (p.startsWith(RECOMPUTED)) continue;
    if (target.has(p) && donor.has(p) && !ops.some((o) => o.path === p || o.path.startsWith(`${p}.`))) {
      const dm = donor.index.members.get(p);
      if (dm && dm.type !== "object" && dm.type !== "array") unrewritten.push(p);
    }
  }

  // Plausibility clamp. The donor is a community save whose lifetime counters
  // have overflowed int32 into large negatives (`-80998` … `-2147482755`). A
  // negative lifetime counter is the one thing a server can read as provably
  // wrong with no inference at all, so those are zeroed. Small negatives (the
  // `-1` "not set" sentinels the game writes itself) are left untouched.
  const covered = new Set(ops.map((o) => o.path));
  const clamped: string[] = [];
  let clampedCount = 0;
  for (const p of donor.paths()) {
    if (covered.has(p)) continue;
    const m = donor.index.members.get(p);
    if (!m || m.type === "object" || m.type === "array") continue;
    const v = donor.field(p).value;
    if (typeof v !== "number" || !(v < -100000)) continue;
    ops.push({ path: p, value: 0 });
    covered.add(p);
    clampedCount++;
    if (clamped.length < 50) clamped.push(p);
  }

  // Shallow-first keeps any created parent ahead of its children.
  ops.sort((a, b) => (a.path.match(/\./g)?.length ?? 0) - (b.path.match(/\./g)?.length ?? 0));

  return { ops, identityOps, progressOps, sanitized, clamped, clampedCount, unrewritten, branchKept };
}

function isCounter(path: string): boolean {
  return COUNTER_PATHS.includes(path);
}

/** Read every identity/device leaf that exists in a save. */
export function snapshotIdentity(plain: Uint8Array): Map<string, string> {
  const save = openSave(plain);
  const out = new Map<string, string>();
  for (const p of save.paths()) {
    if (p.startsWith(RECOMPUTED)) continue;
    if (!isUnder(p, IDENTITY_PREFIXES)) continue;
    const m = save.index.members.get(p);
    if (m && (m.type === "object" || m.type === "array")) continue;
    out.set(p, JSON.stringify(save.field(p).value) ?? "null");
  }
  return out;
}

/** Identity fields the *target* declared that the donor result does not. */
export function identityDiff(
  targetIdentity: Map<string, string>,
  resultPlain: Uint8Array,
): string[] {
  const result = openSave(resultPlain);
  const out: string[] = [];
  for (const [p, v] of targetIdentity) {
    const m = result.index.members.get(p);
    // The target stored a bare null here and the donor holds a real branch
    // (an empty friend list, an unused schedule context): the donor's content
    // stands, which is not a competing declaration of ownership.
    if (m && (m.type === "object" || m.type === "array")) continue;
    if (!result.has(p)) {
      out.push(p);
      continue;
    }
    if ((JSON.stringify(result.field(p).value) ?? "null") !== v) out.push(p);
  }
  return out;
}
