import { useEffect, useMemo, useState } from "react";
import { AmActions } from "./AmActions.tsx";
import { AmBar, AmCheck, AmEmpty, useToast } from "../components/ui.tsx";
import { useStudio } from "../lib/studio.tsx";
import { api, type DiscoveredField } from "../lib/api.ts";

/**
 * Friends Home Clone — transplant a friend's home into the live account.
 *
 * "Using friend id" is the whole point: the friend list below is read from
 * the loaded save's real `UserProfileFriendsStorage` entries (the same save
 * ids the game server addresses card and life gifts with), and the source
 * path understands a `{id}` placeholder so one saved export per friend is
 * enough — `G:\hs_build\friends\{id}.db` becomes that friend's file.
 *
 * The clone itself is a real, server-verified operation: every field under
 * the chosen section is read from the source save and applied into a fresh
 * pull of the connected device. This is the exact flow a furnished home was
 * proven with in game (a late-game living room, garden and courtyard landing
 * on an early account and persisting through play).
 *
 * Honest boundary, stated in the panel: Homescapes has no client API to
 * download another player's home the way Township's fetch-city call does, so
 * the source is a save file you hold for that id — not a live fetch.
 */
const FRIENDS_PREFIX = "SpecialEvents.UserProfileFeature.v.UserProfileFriendsStorage.v.Friends.v.";

const SECTIONS: { prefix: string; label: string }[] = [
  { prefix: "Repairs.", label: "Home & rooms (Repairs.)" },
  { prefix: "SpecialEvents.CardsCollection.", label: "Card album (CardsCollection.)" },
  { prefix: "PlayerItems.", label: "Player items (PlayerItems.)" },
];

/** Sentinel prefix that switches the tab into full-account clone mode. */
const FULL = "__full__";

/**
 * Sentinel prefix for the ban-safe "complete home" clone: every content root
 * (rooms, décor, garden, characters, avatars) but no progression root.
 */
const CONTENT = "__content__";

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

export function HomeCloneSection() {
  const { overview, serial, setDeviceSerial, pushLog, reload } = useStudio();
  const toast = useToast();

  const [friendFields, setFriendFields] = useState<DiscoveredField[]>([]);
  const [friendsErr, setFriendsErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [prefix, setPrefix] = useState(CONTENT);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [manualId, setManualId] = useState("");
  const [srcTemplate, setSrcTemplate] = useState("G:\\hs_build\\friends\\{id}.db");
  const [running, setRunning] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  // Opt-in, and off by default: keeping our own level/coins under the donor's
  // veteran town is the contradiction the server flags.
  const [keepProgress, setKeepProgress] = useState(false);

  useEffect(() => {
    if (!overview) {
      setFriendFields([]);
      setFriendsErr(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .discover(FRIENDS_PREFIX, undefined, 1000)
      .then((f) => {
        if (!cancelled) {
          setFriendFields(f);
          setFriendsErr(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setFriendsErr(msg);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [overview]);

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
    return [...m.values()].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  }, [friendFields]);

  const ids = useMemo(() => {
    const set = new Set<string>(picked);
    const mid = manualId.trim();
    if (mid !== "") set.add(mid);
    return [...set];
  }, [picked, manualId]);

  const resolvePath = (id: string): string =>
    srcTemplate.includes("{id}") ? srcTemplate.split("{id}").join(id) : srcTemplate;

  const previewPaths = ids.map((id) => ({ id, path: resolvePath(id) }));

  const clone = async () => {
    if (!serial) {
      toast.warn("No device connected", "Pick a device in the title bar, then press Connect.");
      return;
    }
    if (ids.length === 0) {
      toast.warn("No friend selected", "Tick a friend, or type a save id.");
      return;
    }
    if (srcTemplate.trim() === "") {
      toast.warn("No source file", "Set the source save path (the {id} placeholder is optional).");
      return;
    }

    setRunning(true);
    setLast(null);
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      const path = resolvePath(id);
      try {
        if (prefix === CONTENT) {
          const res = await api.cloneContent({ path, serial });
          ok++;
          const roots = res.roots.filter((r) => r.fields > 0).length;
          pushLog(
            "ok",
            `Complete home cloned from ${id}`,
            `${res.fields} content fields · ${roots} roots · ${res.warningsTotal} warnings · ` +
              `your level/coins/statistics untouched`,
          );
          if (res.warningsTotal > 0) {
            pushLog("warn", `${res.warningsTotal} warnings`, res.warnings.slice(0, 4).join(" · "));
          }
        } else if (prefix === FULL) {
          const res = await api.cloneFull({ path, serial, keepProgress });
          ok++;
          pushLog(
            "ok",
            `Guarded full clone from ${id}`,
            `${res.donorFields} leaves · rewrote ${res.identityOps} identity fields · ` +
              `${keepProgress ? `kept my progress (${res.progressOps}) · ` : ""}identity intact` +
              `${res.clampedCount ? ` · ${res.clampedCount} impossible values zeroed` : ""}`,
          );
          if (res.identityLeak.length) {
            pushLog("err", "Identity leak — refused", res.identityLeak.slice(0, 6).join(", "));
          }
        } else {
          const res = await api.cloneSection({ path, prefix, serial });
          ok++;
          const warn = res.warnings.length;
          pushLog(
            "ok",
            `Cloned ${prefix} from ${id}`,
            `${res.fields} fields · ${res.summary.length} edits${warn ? ` · ${warn} warnings` : ""} · ${res.source}`,
          );
        }
      } catch (err: unknown) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        pushLog("err", `Clone failed for ${id}`, msg);
      }
    }
    setRunning(false);
    setLast(`${ok} ok · ${failed} failed`);
    if (ok > 0) {
      // The clone routes pull straight off this device, so the active session
      // is device-sourced — mark it so Push is allowed to write it back.
      setDeviceSerial(serial);
      toast.ok(
        prefix === CONTENT
          ? "Complete home cloned — progress untouched"
          : prefix === FULL
            ? "Full account cloned"
            : "Home cloned into the device session",
        `${ok} account${ok === 1 ? "" : "s"} staged. Press Push & Launch to write the save and open the game.`,
      );
      await reload();
    } else {
      toast.err("Nothing cloned", "Every source failed — check the paths and that the device is online.");
    }
  };

  if (!overview) {
    return (
      <section className="am-panel">
        <Head title="Friends Home Clone" />
        <AmEmpty
          title="No save loaded"
          detail="Press Connect in the title bar to read your client's live game first."
        />
      </section>
    );
  }

  return (
    <section className="am-panel">
      <Head title="Friends Home Clone" />

      <div className="am-hint" style={{ margin: "8px 0 14px", lineHeight: 1.5 }}>
        Clone another player's home into your connected device, addressed by their real friend id.
        Use <b>Complete home</b> — it copies every room, decoration, character and avatar but leaves
        your own level, coins and statistics alone, which is what keeps the server's progress check
        quiet. <b>Everything</b> is the old full-account clone and <i>does</i> get flagged. The device
        is re-pulled first, so the clone lands on what the game holds right now; nothing is written
        until you press <b>Push &amp; Launch</b>.
      </div>

      <div className="am-label">What to clone</div>
      <div className="am-row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <button
          type="button"
          className={prefix === CONTENT ? "am-ghost am-ghost--primary" : "am-ghost"}
          aria-pressed={prefix === CONTENT}
          title="Recommended. Copies the friend's whole home — rooms, furniture, décor, garden, characters, avatars — but leaves your own level, coins, statistics, quests and secret values exactly as they are, so the server's progress check has nothing to flag."
          onClick={() => setPrefix(CONTENT)}
        >
          ★ Complete home (recommended)
        </button>
        <button
          type="button"
          className={prefix === FULL ? "am-ghost am-ghost--primary" : "am-ghost"}
          aria-pressed={prefix === FULL}
          title="Adopt the friend's whole save with the ban guard on. Note: a whole save from a much higher account is still flagged by the server's progress check — use Complete home instead."
          onClick={() => setPrefix(FULL)}
        >
          ⚠ Everything (full clone — can be banned)
        </button>
        {SECTIONS.map((s) => (
          <button
            key={s.prefix}
            type="button"
            className={prefix === s.prefix ? "am-ghost am-ghost--primary" : "am-ghost"}
            aria-pressed={prefix === s.prefix}
            onClick={() => setPrefix(s.prefix)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {prefix === CONTENT ? (
        <div className="am-hint" style={{ margin: "0 0 12px", lineHeight: 1.5 }}>
          <b>Complete home (the clone that does not get banned).</b> Copies the friend's{" "}
          <b>content</b> — every room and its furniture, the garden, decorations, characters,
          avatars, costumes and photo albums — onto your connected client. It deliberately does{" "}
          <b>not</b> copy level, stars, coins, statistics, quests, events or the save's secret
          values, so the server's progress score is still computed from <i>your own</i> history and
          finds nothing inconsistent. Your account keeps its level and balance; it just gains the
          friend's house.
        </div>
      ) : null}

      {prefix === FULL ? (
        <div className="am-hint" style={{ margin: "0 0 12px", lineHeight: 1.5 }}>
          <b>Full clone (ban-guarded)</b> takes the friend's whole save — rooms, decorations, items,
          pets, cards, events, passes <i>and the account history behind them</i> — then rewrites only
          the fields that declare <b>whose</b> save it is: your owner id, name, avatar, device
          fingerprint and social roots. Lifetime counters the donor overflowed into a negative are
          zeroed.
          <div style={{ marginTop: 8 }}>
            <b>Why the history travels.</b> A transplanted level-656 town sitting under counters
            that still say “installed today, 2 sessions, 42 minutes played” is internally impossible,
            and that contradiction is what Playrix reads (measured 2026-10-17: a clone that kept the
            low account's install clock was flagged; the reference tool records the same finding —
            <i> “copying the history with the town is what removes it”</i>). So the install date,
            session count, play time, `LID_*` and `PAI`/`ASN_SAVE_DATA` come with the town.
          </div>
          <div style={{ marginTop: 8 }}>
            <AmCheck
              on={keepProgress}
              onChange={() => setKeepProgress((v) => !v)}
              label="Also keep my own level & coins"
              title="Not recommended: leaves your low level/balance under a veteran town, which is exactly the contradiction the server flags"
            />
          </div>
        </div>
      ) : null}

      <div className="am-label">Friends in this save</div>
      {friendsErr ? (
        <div className="am-hint" style={{ margin: "6px 0" }}>
          Could not read the friend list: {friendsErr}
        </div>
      ) : loading && friends.length === 0 ? (
        <div className="am-hint" style={{ margin: "6px 0" }}>
          Reading the friend list…
        </div>
      ) : friends.length === 0 ? (
        <div className="am-hint" style={{ margin: "6px 0" }}>
          This save carries no friend list — type a save id below instead.
        </div>
      ) : (
        <>
          <AmBar
            count={picked.size}
            total={friends.length}
            onAll={() => setPicked(new Set(friends.map((f) => f.id)))}
            onNone={() => setPicked(new Set())}
            hint="each ticked id resolves to its own source file"
          />
          <div className="am-friends">
            {friends.map((f) => (
              <AmCheck
                key={f.id}
                on={picked.has(f.id)}
                onChange={() => {
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (next.has(f.id)) next.delete(f.id);
                    else next.add(f.id);
                    return next;
                  });
                }}
                label={
                  <>
                    {f.name ?? f.id}
                    {f.name ? (
                      <span className="am-hint" style={{ marginLeft: 6 }}>
                        {f.id}
                      </span>
                    ) : null}
                    {f.level !== null ? (
                      <span className="am-hint" style={{ marginLeft: 6 }}>
                        lvl {f.level}
                      </span>
                    ) : null}
                  </>
                }
                title={`${f.name ?? f.id} — save id ${f.id}`}
              />
            ))}
          </div>
        </>
      )}

      <div className="am-label" style={{ marginTop: 14 }}>
        Manual friend id
      </div>
      <div className="am-row" style={{ flexWrap: "wrap", gap: 8 }}>
        <input
          className="am-input"
          value={manualId}
          placeholder="e.g. hbA7pixgD7"
          aria-label="Manual friend save id"
          onChange={(e) => setManualId(e.target.value)}
        />
      </div>

      <div className="am-label" style={{ marginTop: 14 }}>
        Source save path
      </div>
      <div className="am-row" style={{ flexWrap: "wrap", gap: 8 }}>
        <input
          className="am-input"
          style={{ minWidth: 320 }}
          value={srcTemplate}
          placeholder="G:\hs_build\friends\{id}.db"
          aria-label="Source save path template"
          onChange={(e) => setSrcTemplate(e.target.value)}
        />
      </div>
      <div className="am-hint" style={{ margin: "6px 0 0" }}>
        Use <code>{"{id}"}</code> where the friend id belongs, or a fixed path for a single
        source save.
      </div>

      {previewPaths.length > 0 ? (
        <div className="am-hint" style={{ margin: "10px 0 0", lineHeight: 1.5 }}>
          Will read: {previewPaths.map((p) => p.path).join(" · ")}
        </div>
      ) : null}

      <div className="am-row" style={{ margin: "14px 0" }}>
        <button
          type="button"
          className="am-ghost am-ghost--primary"
          disabled={running || !serial}
          title={
            serial
              ? prefix === CONTENT
                ? "Pull the device and transplant every content root (home, décor, characters)"
                : "Pull the device and transplant the selection"
              : "Connect a device first"
          }
          onClick={() => void clone()}
        >
          {running ? "Cloning…" : "Clone into connected device"}
        </button>
        {!serial ? <span className="am-hint">no device connected</span> : null}
        {last ? <span className="am-hint">{last}</span> : null}
      </div>

      <div className="am-hint" style={{ margin: "8px 0 4px", lineHeight: 1.5 }}>
        <b>Honest note.</b> Homescapes exposes no client call to download another player's account
        (unlike Township's fetch-city request), so the clone source is a save file you hold for that
        friend id. The 9.2.101 APK shows the ban is decided <i>server-side</i>: Playrix scores an
        account's progress against its own history (`AntiCheat.Server.ScoreValidation` → the
        “suspicious activity” window), and that score cannot be rewritten from a save. Measured
        2026-10-17: a byte-for-byte full clone <i>and</i> a ban-guarded full clone both ended in the
        warning. <b>Complete home</b> avoids the check entirely by never copying progress — your level,
        balances, statistics and secret values stay yours. Every push backs your save up first, so
        <b> Restore</b> always undoes a clone.
      </div>

      <AmActions />
    </section>
  );
}
