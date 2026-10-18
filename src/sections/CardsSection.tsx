import { useEffect, useMemo, useState } from "react";
import { AmActions } from "./AmActions.tsx";
import { AmBar, AmCheck, AmEmpty, useToast } from "../components/ui.tsx";
import { useStudio } from "../lib/studio.tsx";
import { api, type DiscoveredField } from "../lib/api.ts";
import {
  BATCH_MAX,
  CARD_COUNT,
  CARDS_PER_SET,
  SET_COUNT,
  STOCK_CAP,
  cardIdOf,
  setOfCard,
} from "../engine/cards.ts";

/**
 * Cards — the real Homescapes card album under `SpecialEvents.CardsCollection.*`
 * (376 save paths; nothing else belongs in this tab).
 *
 * Panels (all driven by one prefix discovery, plus `POST /api/cards/grant`
 * for writes):
 *  - Send cards: friend mode picks recipients from the save's OWN friend
 *    list (UserProfileFriendsStorage…Friends.v.<saveId>, with player names),
 *    plus a manual save-id input and the main tool's delay field; card
 *    selection is ticking only (ref: "Ticking is the only selection
 *    mechanic"); quantity mirrors the card stock cap.
 *      · Send to a friend — validated plan, then an honest result: this
 *        editor has NO game-server connection (the main tool delivers via
 *        Playrix SendBox + device token; neither exists here), so nothing
 *        is ever staged or simulated. The event's own window in the game
 *        client is the only route a real box takes.
 *      · Send to myself — REAL local work, straight through the engine's
 *        plan builder: a card the album already holds gets `inStockCount`
 *        bumped in place, a card it has never seen gets a whole
 *        `OwnedCards` row APPENDED, and every touched set's derived
 *        `lastSeenProgress` is re-derived so the window's progress bars
 *        agree with the tiles afterwards.
 *  - Cards grid: the WHOLE catalog — `card_01`..`card_150`, all 150 ids in
 *    the 15 sets of 10 the event divides them into, owned or not, each
 *    card its own tickable button under a per-set header with a
 *    tick-the-set toggle and the set's completion bar. Exactly the layout
 *    your IGG Cards tab uses, so granting a card you have never held is
 *    the same one click as topping up one you hold.
 *  - Received gifts: HistoryComponent receipts, read-only.
 */

const PREFIX = "SpecialEvents.CardsCollection.";
const FRIENDS_PREFIX =
  "SpecialEvents.UserProfileFeature.v.UserProfileFriendsStorage.v.Friends.v.";

const DELAY_DEFAULT = 800;
const DELAY_MIN = 300;
const DELAY_MAX = 10_000;
const HISTORY_CAP = 8;
const ID_RE = /^[A-Za-z0-9]{4,24}$/;

const OWNED_ID_RE = /^v\.Core\.v\.OwnedCards\[(\d+)\]\.v\.cardId$/;
const OWNED_STOCK_RE = /^v\.Core\.v\.OwnedCards\[(\d+)\]\.v\.inStockCount$/;
const HISTORY_RE = /^v\.HistoryComponent\.v\.History\[(\d+)\]\.v\.PacksRecieved\[(\d+)\]$/;

/**
 * `PackLevel3;[{card_id:card_142,set_id:set_15,…},…];{"event_id":…,"reason":"CollectionChest3"}`
 * → pack level, receipt reason, and the contained card ids (read-only history).
 */
function parsePack(raw: string): { level: string | null; reason: string | null; cards: string[] } {
  const parts = raw.split(";");
  const level = (parts[0] ?? "").replace(/^PackLevel/, "Level ") || null;
  const joined = parts.slice(1).join(";");
  const cards: string[] = [];
  const re = /card_id:(card_\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(joined)) !== null) {
    if (m[1] !== undefined) cards.push(m[1].replace(/^card_/, "#"));
  }
  const rm = /"reason":"([^"]+)"/.exec(joined);
  return { level, reason: rm && rm[1] !== undefined ? rm[1] : null, cards };
}

/** `card_08` → 8. */
function cardNumber(id: string): number | null {
  const m = /(\d+)/.exec(id);
  return m && m[1] !== undefined ? Number(m[1]) : null;
}

/** The main tool's rule: 10 cards per set, `card_08` → `set_01`. */
function setOf(num: number): string {
  return `set_${String(Math.floor((num - 1) / 10) + 1).padStart(2, "0")}`;
}

interface OwnedCard {
  cardId: string;
  num: number;
  set: string;
  stockPath: string | null;
  stockLive: number | null;
}

interface Friend {
  id: string;
  name: string | null;
  level: number | null;
}

function Head({ title }: { title: string }) {
  return (
    <div className="am-panel-head">
      <img src="assets/ui/panel-bars.png" alt="" />
      <h2 className="am-panel-title">{title}</h2>
    </div>
  );
}

/** One card as the delivery popup shows it. */
type DeliveredTile = {
  num: number;
  cardId: string;
  set: string;
  /** `inStockCount` after the write — what the album will hold. */
  stock: number;
  kind: "new" | "topped";
};

/**
 * The popup's verdict: every card the run actually wrote, plus the tallies
 * that explain it. Set only when the WHOLE run succeeded — a partial run is
 * reported in the log and the toast instead, so the dialog never claims more
 * than landed.
 */
type DeliveryReport = {
  tiles: DeliveredTile[];
  requested: number;
  written: number;
  added: number;
  topped: number;
  capped: number;
  waves: number;
};

const tileOf = (num: number, stock: number, kind: "new" | "topped"): DeliveredTile => ({
  num,
  cardId: cardIdOf(num),
  set: `set_${String(setOfCard(num)).padStart(2, "0")}`,
  stock,
  kind,
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function CardsSection() {
  const { overview, values, pending, setPending, clearPending, pushLog, reload } = useStudio();
  const toast = useToast();

  const [fields, setFields] = useState<DiscoveredField[]>([]);
  const [friendFields, setFriendFields] = useState<DiscoveredField[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  const [mode, setMode] = useState<"friend" | "self">("friend");
  const [setFilter, setSetFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pickedFriends, setPickedFriends] = useState<Set<string>>(new Set());
  const [manualId, setManualId] = useState("");
  const [qty, setQty] = useState(1);
  const [delay, setDelay] = useState(String(DELAY_DEFAULT));
  const [delivered, setDelivered] = useState<DeliveryReport | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!overview) {
      setFields([]);
      setFriendFields([]);
      setFetchErr(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.discover(PREFIX, undefined, 2000),
      api.discover(FRIENDS_PREFIX, undefined, 1000),
    ])
      .then(([cards, friends]) => {
        if (cancelled) return;
        setFields(cards);
        setFriendFields(friends);
        setFetchErr(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setFetchErr(msg);
        toast.err("Could not read the card album", msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [overview, toast]);

  /* -------------------------------------------------------------- derived -- */

  const album = useMemo<OwnedCard[]>(() => {
    const map = new Map<number, OwnedCard>();
    for (const f of fields) {
      const idm = OWNED_ID_RE.exec(f.key);
      if (idm && idm[1] !== undefined) {
        const i = Number(idm[1]);
        const cardId = String(f.value);
        const num = cardNumber(cardId);
        if (num === null) continue;
        const prev = map.get(i);
        const row: OwnedCard = prev ?? {
          cardId,
          num,
          set: setOf(num),
          stockPath: null,
          stockLive: null,
        };
        map.set(i, row);
        continue;
      }
      const sm = OWNED_STOCK_RE.exec(f.key);
      if (sm && sm[1] !== undefined) {
        const i = Number(sm[1]);
        const row = map.get(i);
        if (row) {
          row.stockPath = f.path;
          row.stockLive = typeof f.value === "number" ? f.value : null;
        }
      }
    }
    // A stock leaf can arrive before its cardId leaf — resolve in a 2nd pass.
    for (const f of fields) {
      const sm = OWNED_STOCK_RE.exec(f.key);
      if (!sm || sm[1] === undefined) continue;
      const row = map.get(Number(sm[1]));
      if (row && row.stockPath === null) {
        row.stockPath = f.path;
        row.stockLive = typeof f.value === "number" ? f.value : null;
      }
    }
    return [...map.values()].sort((a, b) => a.num - b.num);
  }, [fields]);

  const effStock = (c: OwnedCard): number | null => {
    if (c.stockPath === null) return null;
    const p = pending.get(c.stockPath);
    if (typeof p === "number") return p;
    if (typeof values[c.stockPath] === "number") return values[c.stockPath] as number;
    return c.stockLive;
  };

  /** True once the save actually carries the album row list — the whole grid
   *  below is inert (and honestly reported as such) when it does not. */
  const albumPresent = useMemo(
    () => fields.some((f) => f.key.startsWith("v.Core.v.OwnedCards[")),
    [fields],
  );

  /** `card_07` -> the owned row, so a tile can show its live stock. */
  const ownedByNum = useMemo(() => {
    const m = new Map<number, OwnedCard>();
    for (const c of album) m.set(c.num, c);
    return m;
  }, [album]);

  /**
   * The WHOLE catalog — `card_01` .. `card_150`, in the 15 sets of 10 the
   * event divides them into, owned or not. This is the exact layout your
   * IGG Cards tab uses: every group visible at once, each card its own
   * tickable button, so granting a card you have never seen is the same
   * one click as topping up one you hold.
   */
  const catalog = useMemo(
    () =>
      Array.from({ length: CARD_COUNT }, (_, i) => {
        const num = i + 1;
        return {
          num,
          cardId: cardIdOf(num),
          set: setOf(num),
          owned: ownedByNum.get(num) ?? null,
        };
      }),
    [ownedByNum],
  );

  /** `set_01` -> its 10 card numbers, ascending; the whole catalog grouped. */
  const groups = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const c of catalog) {
      const list = m.get(c.set);
      if (list) list.push(c.num);
      else m.set(c.set, [c.num]);
    }
    return [...m.entries()];
  }, [catalog]);

  const visibleGroups = setFilter === "all" ? groups : groups.filter(([s]) => s === setFilter);

  const ownedIn = (nums: readonly number[]) =>
    nums.reduce((n, num) => (ownedByNum.has(num) ? n + 1 : n), 0);

  const totalCopies = album.reduce((n, c) => n + (effStock(c) ?? 0), 0);

  const friends = useMemo<Friend[]>(() => {
    const m = new Map<string, Friend>();
    for (const f of friendFields) {
      const dot = f.key.indexOf(".");
      if (dot < 0) continue;
      const id = f.key.slice(0, dot);
      const rest = f.key.slice(dot + 1);
      let fr = m.get(id);
      if (!fr) {
        fr = { id, name: null, level: null };
        m.set(id, fr);
      }
      if (rest === "v.playerName" && typeof f.value === "string") fr.name = f.value;
      else if (rest === "v.playerLevel" && typeof f.value === "number") fr.level = f.value;
    }
    return [...m.values()].sort((a, b) =>
      (a.name ?? a.id).localeCompare(b.name ?? b.id),
    );
  }, [friendFields]);

  const history = useMemo(() => {
    const rows: { hi: number; pi: number; level: string | null; reason: string | null; cards: string[] }[] = [];
    for (const f of fields) {
      const m = HISTORY_RE.exec(f.key);
      if (m && m[1] !== undefined && m[2] !== undefined && typeof f.value === "string" && f.value !== "") {
        const p = parsePack(f.value);
        rows.push({ hi: Number(m[1]), pi: Number(m[2]), ...p });
      }
    }
    return rows.sort((a, b) => b.hi - a.hi || b.pi - a.pi).slice(0, HISTORY_CAP);
  }, [fields]);

  const stagedKeys = useMemo(
    () => [...pending.keys()].filter((k) => k.startsWith(PREFIX)),
    [pending],
  );

  /* ------------------------------------------------------------- staging -- */

  const toggleCard = (num: number) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(num)) n.delete(num);
      else n.add(num);
      return n;
    });
  };

  const selectVisible = () => {
    setSelected((s) => {
      const n = new Set(s);
      for (const [, nums] of visibleGroups) for (const num of nums) n.add(num);
      return n;
    });
  };

  const clearSelection = () => setSelected(new Set());

  /** Tick (or untick) all 10 cards of one set — the group toggle. */
  const toggleSet = (set: string, on: boolean) => {
    const nums = groups.find(([s]) => s === set)?.[1] ?? [];
    setSelected((s) => {
      const n = new Set(s);
      for (const num of nums) {
        if (on) n.add(num);
        else n.delete(num);
      }
      return n;
    });
  };

  const toggleFriend = (id: string) => {
    setPickedFriends((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const pickAllFriends = () => setPickedFriends(new Set(friends.map((f) => f.id)));
  const clearFriends = () => setPickedFriends(new Set());

  const clearStaged = () => {
    const n = stagedKeys.length;
    for (const k of stagedKeys) clearPending(k);
    pushLog("info", "Clear staged card edits", `${n} field${n === 1 ? "" : "s"} cleared`);
  };

  /* ---------------------------------------------------------------- send -- */

  /** Tick order is the catalog's own order, so plans read `#1, #2, #9 …`. */
  const selectedCards = [...selected].sort((a, b) => a - b);

  const onSend = () => {
    if (selectedCards.length === 0) {
      toast.warn("No cards selected", "Tick at least one card in the grid first.");
      return;
    }
    const copies = qty;

    if (mode === "friend") {
      const recipients = [...pickedFriends];
      const mid = manualId.trim();
      if (mid !== "") {
        if (!ID_RE.test(mid)) {
          toast.warn("Save ID not valid", "4–24 letters or digits, e.g. Br6ZA5fBqm.");
          return;
        }
        if (!recipients.includes(mid)) recipients.push(mid);
      }
      if (recipients.length === 0) {
        toast.warn("No recipient", "Tick a friend from the list or type a save ID.");
        return;
      }
      const d = Math.min(DELAY_MAX, Math.max(DELAY_MIN, Math.floor(Number(delay) || DELAY_DEFAULT)));
      const plan =
        `${selectedCards.length} card${selectedCards.length === 1 ? "" : "s"} × ` +
        `${recipients.length} friend${recipients.length === 1 ? "" : "s"} × ${copies} cop${copies === 1 ? "y" : "ies"}` +
        ` · ${d} ms delay`;
      toast.info(
        "Friend delivery needs the game server",
        "This tool edits the save file offline — it has no Playrix server connection, " +
          "so card boxes cannot actually be delivered. Nothing was staged.",
      );
      pushLog("warn", "Friend send not executed — no game-server connection", plan);
      return;
    }

    /* To myself — REAL write, sent in waves. The engine's plan builder decides
       the shape of every card: an owned card bumps `inStockCount` in place, a
       card the album has never seen gets a whole `OwnedCards` row appended, and
       every touched set's derived `lastSeenProgress` is re-derived so the
       collection window's progress bars agree with the tiles afterwards.
       A selection bigger than one grant's cap goes out as sequential waves of
       BATCH_MAX paced by the delay field — 100 cards a wave. */
    void (async () => {
      setBusy(true);
      try {
        const d = Math.min(
          DELAY_MAX,
          Math.max(DELAY_MIN, Math.floor(Number(delay) || DELAY_DEFAULT)),
        );
        const waves: number[][] = [];
        for (let i = 0; i < selectedCards.length; i += BATCH_MAX) {
          waves.push(selectedCards.slice(i, i + BATCH_MAX));
        }

        const bumps: { num: number; from: number; to: number }[] = [];
        const added: number[] = [];
        const capped: number[] = [];
        const failed: string[] = [];

        for (let w = 0; w < waves.length; w++) {
          if (w > 0) await sleep(d);
          const r = await api.cardsGrant({ cards: waves[w] as number[], copies });
          if (!r.ok) {
            failed.push(
              `wave ${w + 1}/${waves.length}: ${r.errors.join(" · ") || "the engine refused the write"}`,
            );
            continue;
          }
          bumps.push(...r.plan.bumps);
          added.push(...r.plan.added);
          capped.push(...r.plan.capped);
        }

        // Re-read whatever landed BEFORE reporting, so the popup's counts are
        // the album's own rather than the request's echo.
        await reload();

        if (failed.length > 0) {
          pushLog("err", "Album grant incomplete", failed.join(" · "));
          toast.err(
            "Grant incomplete",
            `${bumps.length + added.length} cards written, then: ${failed.join(" · ")}`,
          );
          return;
        }

        const written = bumps.length + added.length;
        if (written === 0) {
          toast.info(
            "Nothing to grant",
            capped.length > 0
              ? `All ${capped.length} selected card${capped.length === 1 ? " is" : "s are"} already at the maximum of ${STOCK_CAP} copies.`
              : "Nothing selected to grant.",
          );
          return;
        }

        const want = Math.min(STOCK_CAP, Math.max(1, Math.trunc(copies)));
        const tiles = [
          ...bumps.map((b) => tileOf(b.num, b.to, "topped")),
          ...added.map((n) => tileOf(n, want, "new")),
        ].sort((a, b) => a.num - b.num);

        pushLog(
          "info",
          "Album grant written",
          `${written} card${written === 1 ? "" : "s"} across ${waves.length} wave${waves.length === 1 ? "" : "s"}` +
            ` · ${added.length} new · ${bumps.length} topped up · ${capped.length} already full` +
            " — press Push to put them on the device",
        );
        toast.ok(
          "Copies granted",
          `${written} card${written === 1 ? "" : "s"} written. Press Push to deliver.`,
        );
        setSelected(new Set());
        setDelivered({
          tiles,
          requested: selectedCards.length,
          written,
          added: added.length,
          topped: bumps.length,
          capped: capped.length,
          waves: waves.length,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pushLog("err", "Album grant failed", msg);
        toast.err("Grant failed", msg);
      } finally {
        setBusy(false);
      }
    })();
  };

  /* -------------------------------------------------------------- render -- */

  if (!overview) {
    return (
      <section className="am-panel">
        <Head title="Cards" />
        <AmEmpty
          title="No save loaded"
          detail="Press Connect in the title bar to read your client's live game."
        />
      </section>
    );
  }

  return (
    <section className="am-panel">
      <Head title="Cards" />

      {fetchErr ? (
        <AmEmpty title="Could not read the card album" detail={fetchErr} />
      ) : loading && fields.length === 0 ? (
        <div className="am-empty">
          <div className="am-empty-title">Loading…</div>
          <div className="am-empty-detail">Reading SpecialEvents.CardsCollection.* …</div>
        </div>
      ) : !albumPresent ? (
        <AmEmpty
          title="No card album in this save"
          detail="SpecialEvents.CardsCollection.v.Core.v.OwnedCards is not present in this save, so the card event is not live for this account and there is nothing to grant into."
        />
      ) : (
        <>
          {/* ------------------------------------------------------------ send */}
          <div className="am-label">Send cards</div>
          <div className="am-row">
            <button
              type="button"
              className={mode === "friend" ? "am-ghost am-ghost--primary" : "am-ghost"}
              aria-pressed={mode === "friend"}
              title="Pick recipients from your own friend list"
              onClick={() => setMode("friend")}
            >
              To a friend
            </button>
            <button
              type="button"
              className={mode === "self" ? "am-ghost am-ghost--primary" : "am-ghost"}
              aria-pressed={mode === "self"}
              title="Bring copies into your own album (a real local save edit)"
              onClick={() => setMode("self")}
            >
              To myself
            </button>
          </div>

          {mode === "friend" ? (
            <>
              <div className="am-row" style={{ margin: "10px 0 4px" }}>
                <button type="button" className="am-ghost" onClick={pickAllFriends}>
                  Select all friends
                </button>
                <button type="button" className="am-ghost" onClick={clearFriends}>
                  Clear
                </button>
                <span className="am-hint">
                  {pickedFriends.size} of {friends.length} friends selected
                </span>
              </div>

              {friends.length === 0 ? (
                <div className="am-hint" style={{ margin: "6px 0" }}>
                  This save carries no friend list — type a save ID below instead.
                </div>
              ) : (
                <div className="am-friends">
                  {friends.map((f) => (
                    <AmCheck
                      key={f.id}
                      on={pickedFriends.has(f.id)}
                      onChange={() => toggleFriend(f.id)}
                      label={
                        <>
                          {f.name ?? f.id}
                          {f.name ? <span className="am-hint" style={{ marginLeft: 6 }}>{f.id}</span> : null}
                        </>
                      }
                      title={`${f.name ?? f.id}${f.level !== null ? ` · level ${f.level}` : ""} — save id ${f.id}`}
                    />
                  ))}
                </div>
              )}

              <div className="am-row" style={{ margin: "10px 0 0" }}>
                <input
                  className="am-input"
                  value={manualId}
                  placeholder="Manual save ID (e.g. Br6ZA5fBqm)"
                  aria-label="Manual recipient save id"
                  onChange={(e) => setManualId(e.target.value)}
                />
                <span className="am-hint">Delay</span>
                <input
                  className="am-input am-input--num"
                  value={delay}
                  inputMode="numeric"
                  aria-label="Delay between sends in milliseconds"
                  onChange={(e) => setDelay(e.target.value)}
                />
                <span className="am-hint">ms</span>
              </div>
            </>
          ) : null}

          <div className="am-row" style={{ margin: "12px 0 0" }}>
            <span className="am-hint">Copies per card</span>
            {[1, 2, 3, 4].map((q) => (
              <button
                key={q}
                type="button"
                className={qty === q ? "am-ghost am-ghost--primary" : "am-ghost"}
                aria-pressed={qty === q}
                title={`Stage +${q} cop${q === 1 ? "y" : "ies"} per selected card (stock caps at ${STOCK_CAP})`}
                onClick={() => setQty(q)}
              >
                {q}
              </button>
            ))}
            <button
              type="button"
              className="am-ghost am-ghost--primary am-equip"
              style={{ marginLeft: "auto" }}
              disabled={busy}
              title={
                mode === "friend"
                  ? "Validate the plan and report the honest outcome"
                  : `Write the ticked cards into the album — ${BATCH_MAX} a wave, ${selected.size} ticked`
              }
              onClick={onSend}
            >
              {busy ? "Sending…" : "Send"}
            </button>
          </div>

          {/* ----------------------------------------------------------- cards */}
          <div className="am-label">
            Cards — the whole catalog: {CARD_COUNT} cards in {SET_COUNT} sets of {CARDS_PER_SET}
          </div>
          <AmBar
            count={selected.size}
            total={CARD_COUNT}
            onAll={selectVisible}
            onNone={clearSelection}
            hint={`${album.length} owned · ${totalCopies} copies held · cap ${STOCK_CAP}`}
          />

          <div className="am-row" style={{ margin: "10px 0 8px" }}>
            <button
              type="button"
              className={setFilter === "all" ? "am-ghost am-ghost--primary" : "am-ghost"}
              onClick={() => setSetFilter("all")}
            >
              All {SET_COUNT}
            </button>
            {groups.map(([s, nums]) => (
              <button
                key={s}
                type="button"
                className={setFilter === s ? "am-ghost am-ghost--primary" : "am-ghost"}
                title={`${ownedIn(nums)} of ${CARDS_PER_SET} cards owned in ${s}`}
                onClick={() => setSetFilter(s)}
              >
                {s} · {ownedIn(nums)}/{CARDS_PER_SET}
              </button>
            ))}
          </div>

          {/* Every group at once — 10 cards per set, each card its own button,
              owned or not, so a grant to a card you have never held is the
              same one click as topping up one you hold. Ticking is the only
              selection mechanic: the send path reads `selected` and nothing
              else, so exactly the ticked cards go out. */}
          {visibleGroups.map(([set, nums]) => {
            const owned = ownedIn(nums);
            const onCount = nums.filter((n) => selected.has(n)).length;
            const allOn = nums.length > 0 && onCount === nums.length;
            const pct = Math.round((owned / nums.length) * 100);
            return (
              <div className="am-cardset" key={set}>
                <div className="am-cardset-head">
                  <button
                    type="button"
                    className={allOn ? "am-ghost am-ghost--primary" : "am-ghost"}
                    aria-pressed={allOn}
                    title={`Tick or untick every card of ${set}`}
                    onClick={() => toggleSet(set, !allOn)}
                  >
                    {allOn ? "Untick set" : "Tick set"}
                  </button>
                  <b className="am-cardset-name">
                    {set} · {owned}/{CARDS_PER_SET}
                  </b>
                  <span className="am-setbar">
                    <i style={{ width: `${pct}%` }} />
                  </span>
                  <span className="am-hint">{onCount} ticked</span>
                </div>

                <div className="am-grid am-grid--cards">
                  {nums.map((num) => {
                    const c = catalog[num - 1];
                    if (!c) return null;
                    const on = selected.has(num);
                    const stock = c.owned ? effStock(c.owned) : null;
                    return (
                      <button
                        key={num}
                        type="button"
                        className={
                          on
                            ? "am-cell am-cell--sel"
                            : c.owned
                              ? "am-cell am-cell--owned"
                              : "am-cell"
                        }
                        aria-pressed={on}
                        title={
                          `${c.cardId} (${c.set}) — ` +
                          (c.owned
                            ? stock !== null
                              ? `${stock} in stock`
                              : "owned"
                            : "not in the album yet — granting it appends the row") +
                          ` — click to ${on ? "unselect" : "select"}`
                        }
                        onClick={() => toggleCard(num)}
                      >
                        <span className="am-cell-num">#{num}</span>
                        <span className="am-cell-stock">
                          {c.owned ? (stock !== null ? `×${stock}` : "owned") : "—"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* --------------------------------------------------------- history */}
          {history.length > 0 ? (
            <>
              <div className="am-label">Received gifts</div>
              {history.map((h) => (
                <div className="am-log-row" key={`${h.hi}.${h.pi}`}>
                  <b>
                    H{h.hi}·P{h.pi}
                  </b>
                  <span>
                    {h.level ?? "Pack"}
                    {h.reason ? ` · ${h.reason}` : ""}
                    {h.cards.length > 0 ? ` · ${h.cards.join(" ")}` : ""}
                  </span>
                </div>
              ))}
            </>
          ) : null}

          {stagedKeys.length > 0 ? (
            <div className="am-row" style={{ marginTop: 14 }}>
              <button
                type="button"
                className="am-ghost"
                onClick={clearStaged}
                title="Drop staged CardsCollection.* edits without touching other sections"
              >
                Revert staged ({stagedKeys.length})
              </button>
            </div>
          ) : null}
        </>
      )}

      <AmActions />

      {/* ------------------------------------------------- delivery popup -- */}
      {/* The run's "all sent" moment, in the shape your IGG Cards tab uses:
          a scrim that dismisses, a centred dialog that lists every card the
          write actually landed. It opens ONLY when the whole run succeeded —
          a partial or refused run reports through the log and the toast, so
          the dialog never claims more than went in. */}
      {delivered ? (
        <div
          className="am-overlay"
          role="presentation"
          onClick={() => setDelivered(null)}
        >
          <div
            className="am-modal am-modal--cards"
            role="dialog"
            aria-modal="true"
            aria-label="Cards delivered"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="am-modal-head">
              <span className="am-tick" aria-hidden="true">
                ✓
              </span>
              <h3 className="am-modal-title">Cards delivered</h3>
              <button
                type="button"
                className="am-close"
                aria-label="Close"
                onClick={() => setDelivered(null)}
              >
                ×
              </button>
            </div>

            <p className="am-hint am-tally">
              {delivered.written} of {delivered.requested} ticked · {delivered.added} new ·{" "}
              {delivered.topped} topped up
              {delivered.capped > 0 ? ` · ${delivered.capped} already full` : ""}
              {delivered.waves > 1 ? ` · ${delivered.waves} waves of ${BATCH_MAX}` : ""}
            </p>

            <div className="am-tiles am-grid am-grid--cards">
              {delivered.tiles.map((t) => (
                <div className={`am-tile am-tile--${t.kind}`} key={t.num}>
                  <span className="am-tile-num">#{t.num}</span>
                  <span className="am-tile-id">{t.cardId}</span>
                  <span className="am-tile-meta">
                    {t.set} · ×{t.stock}
                  </span>
                  <span className={`am-tile-flag am-tile-flag--${t.kind}`}>
                    {t.kind === "new" ? "NEW" : "TOPPED"}
                  </span>
                </div>
              ))}
            </div>

            <p className="am-hint am-deliver-note">
              These are in the album now. Press <b>Push</b> to put them on the device — the
              game's own <b>Send</b> button then delivers a duplicate to a friend.
            </p>

            <button
              type="button"
              className="am-ghost am-ghost--primary am-equip am-modal-ok"
              onClick={() => setDelivered(null)}
            >
              OK
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
