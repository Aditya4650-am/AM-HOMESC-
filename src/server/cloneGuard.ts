/**
 * Ban guard for home clones.
 *
 * The deep-research finding behind this module, from the 9.2.101 APK:
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
 *
 * The full-account clone that used to live here — the identity rewriting,
 * the negative-counter clamping and the identity-leak push gate — was removed
 * with the UI mode it served, measured 2026-10-17 to end in the warning every
 * time. Nothing in this module will carry a progression root again.
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

/**
 * What a clone may carry: the things a player *looks at*.
 *
 * `Repairs` is the room/furniture unlock state (the house itself), `RoomDesign`
 * the chosen furniture per room, `GardenObject` the garden, and the rest are
 * characters, avatars, costumes and photo albums — the whole visible home.
 */
export const CONTENT_ROOTS: readonly string[] = [
  "Repairs",
  "RepairsHistory",
  /**
   * The design-ownership registry — `StepsState.<area>.v.<Object>|<design>` =
   * `0 | 1 | 2`, plus a `.t = "ds"` type tag per area. Measured on the IGG
   * account 2026-10-18: 2,593 leaves, of which 2,588 are `Object|design` flags
   * whose ONLY distinct values are 0, 1 and 2, and 5 are `.t` tags. No level,
   * no currency, no counter, no timestamp — it records *which room designs an
   * account owns*, which is exactly what `RoomDesign` and `Repairs` describe.
   *
   * It used to sit in `PROGRESS_ROOTS`, which is what made a cloned house lose
   * its decor. The game validates `Repairs.<area>.v.<Object>.step` against this
   * registry on load; with the registry absent (a fresh account has none at
   * all) every design the donor had chosen failed validation and was rewritten
   * to a base step — `Christmas2020_Decor` -> `new1`, `Retro_Decor` ->
   * `lentern`, `3_PartyRoom` -> `2`, and the Wing closed behind it. Measured
   * end to end 2026-10-18: staged clone carried the donor values correctly and
   * the game overwrote all of them on its own next save.
   *
   * Ownership of a room design is home content, not account progress, so this
   * is the correct side of the line. It is documented here rather than in the
   * array below because the reclassification is a measured claim, not a guess.
   */
  "StepsState",
  /**
   * The repair task system, and the reason a cloned house still said
   * *"Complete tasks to unlock new rooms."* with every room shut.
   *
   * Measured on the IGG account 2026-10-18:
   *   `QuestTargets.<taskId> = "Area,Object,Step"` — the catalog of available
   *     repair tasks. Donor 330 entries; a fresh account has **1**.
   *   `Quests.<taskId>.v.collected = true` — which of those tasks are done.
   *     Donor ~120; a fresh account ~4.
   *
   * The loop is: complete a task, its object advances one step, and finishing
   * an area's tasks is what opens the next room. `Repairs.<area>.v.@opened` is
   * *derived* from it — there is no separate unlock registry in the save, and
   * writing `@opened = true` by hand is rewritten to `false` on the game's own
   * next save (measured: staged clone carried true, device read false).
   *
   * Both roots hold the repair story of the house — which tasks exist and
   * which have been completed — which is the same subject as `Repairs` and
   * `StepsState`, both already cloned and both measured clean. Neither holds a
   * balance, a level, a statistic or a purchase; `QuestTargets` values are
   * literal `"Area,Object,Step"` coordinates and `Quests` values are a boolean.
   */
  "QuestTargets",
  "Quests",
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
/**
 * Roots the server scores against the account's own history. A content clone
 * refuses any of these: they are what `AntiCheat.Server.ScoreValidation`
 * compares, so copying them is the ban.
 *
 * `StepsState` was moved OUT of this list to `CONTENT_ROOTS` on 2026-10-18:
 * measured on the IGG account it is 2,588 `Object|design` ownership flags whose
 * only values are 0/1/2 — room-design ownership, not progression. Keeping it
 * here is what made a cloned house silently lose its decor.
 *
 * `QuestTargets` / `Quests` were moved OUT on the same date and for the same
 * reason: a repair-task catalog and its collected flags — the bookkeeping
 * behind `Repairs`, which already lives in `CONTENT_ROOTS` — not account
 * progression. Keeping them here is what left a cloned house with every room
 * shut and the game saying "Complete tasks to unlock new rooms."
 */
export const PROGRESS_ROOTS: readonly string[] = [
  "Properties",
  "AccumulatedSatistics",
  "PlayerHistory",
  "PlayerStatistic",
  "Incomes",
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
