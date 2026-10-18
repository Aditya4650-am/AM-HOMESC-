import { useEffect, useMemo, useState } from "react";
import { AmActions } from "./AmActions.tsx";
import { AmBar, AmEmpty, useToast } from "../components/ui.tsx";
import { useStudio } from "../lib/studio.tsx";
import { api, type DiscoveredField } from "../lib/api.ts";
import { AVATAR_PICS, ppUrl } from "../lib/icons.ts";

/**
 * Avatars — ONE grid of clickable avatar buttons.
 *
 * The save stores one boolean per picture (`Avatars.unlockedN`, N = 1..202 in
 * this save) plus the equipped id at `Properties.avatarId` (the same path the
 * engine's cosmetics equip op uses — `src/engine/cosmetics.ts`).
 *
 * Every chip is a real button: clicking it EQUIPS that avatar — it stages
 * `Properties.avatarId = "<N>"` and, when the avatar is not unlocked yet, the
 * unlock flag with it (exactly the grant-then-equip rule of the cosmetics
 * tabs). The bar handles bulk unlocks (Select All / Deselect All), the range
 * inputs unlock an id span, and Revert staged drops this section's edits.
 * Art comes from the shipped /pp pictures (ids 13..116 have mapped art);
 * the rest use the stable glyph rotation — never another surface, no
 * duplicate gallery, no "owned" labels.
 */

const PREFIX = "Avatars.";
const AVATAR_PATH = "Properties.avatarId";

/** Stable glyph rotation — avatar #N always keeps the same face. */
const AVATAR_EMOJI: readonly string[] = [
  "🙂", "😎", "🤠", "🧑‍🚀", "🦸", "🧝", "🧛", "🧙", "🕵️", "🥷",
  "👮", "🎅", "👸", "🧑‍🎨", "👨‍🍳", "🤹", "👰", "🤴", "🧑‍🌾", "🧑‍🔬",
  "🦊", "🐸", "🦄", "🐶", "🐱",
];

const UNLOCKED_RE = /^unlocked(\d+)$/;

interface AvatarRow {
  f: DiscoveredField;
  n: number;
}

function Head({ title }: { title: string }) {
  return (
    <div className="am-panel-head">
      <img src="assets/ui/panel-bars.png" alt="" />
      <h2 className="am-panel-title">{title}</h2>
    </div>
  );
}

export function AvatarsSection() {
  const { overview, values, pending, setPending, clearPending, pushLog } = useStudio();
  const toast = useToast();

  const [fields, setFields] = useState<DiscoveredField[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    if (!overview) {
      setFields([]);
      setFetchErr(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .discover(PREFIX, undefined, 2000)
      .then((f) => {
        if (!cancelled) {
          setFields(f);
          setFetchErr(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setFetchErr(msg);
          toast.err("Could not read avatars", msg);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [overview, toast]);

  /* -------------------------------------------------------------- derived -- */

  const rows = useMemo<AvatarRow[]>(() => {
    const out: AvatarRow[] = [];
    for (const f of fields) {
      if (f.kind !== "boolean" || f.path.endsWith(".t")) continue;
      const m = UNLOCKED_RE.exec(f.key);
      if (m && m[1] !== undefined) out.push({ f, n: Number(m[1]) });
    }
    return out.sort((a, b) => a.n - b.n);
  }, [fields]);

  const maxN = rows.length > 0 ? (rows[rows.length - 1]?.n ?? 1) : 1;

  const liveOf = (f: DiscoveredField): unknown =>
    values[f.path] === undefined ? f.value : values[f.path];
  const effOf = (f: DiscoveredField): unknown => {
    const p = pending.get(f.path);
    return p === undefined ? liveOf(f) : p;
  };

  const unlockedCount = rows.reduce((n, r) => (effOf(r.f) === true ? n + 1 : n), 0);

  const liveAvatar = values[AVATAR_PATH];
  const effAvatarRaw = pending.get(AVATAR_PATH) ?? liveAvatar;
  const effAvatar =
    effAvatarRaw === undefined || effAvatarRaw === null ? null : String(effAvatarRaw);
  const equipStaged = pending.has(AVATAR_PATH);

  const stagedKeys = useMemo(
    () =>
      [...pending.keys()].filter(
        (k) => k.startsWith(PREFIX) || k === AVATAR_PATH,
      ),
    [pending],
  );

  /* ------------------------------------------------------------- staging -- */

  const stageUnlock = (f: DiscoveredField, next: boolean) => {
    if (liveOf(f) === next) clearPending(f.path);
    else setPending(f.path, next);
  };

  /** Chip click — equip this avatar (granting the unlock first if needed). */
  const equip = (row: AvatarRow) => {
    const next = String(row.n);
    const alreadyActive = String(liveAvatar ?? "") === next && effOf(row.f) === true;
    if (alreadyActive) {
      toast.info("Already active", `Avatar #${row.n} is your profile picture.`);
      return;
    }
    if (effOf(row.f) !== true) stageUnlock(row.f, true);
    if (String(liveAvatar ?? "") === next) clearPending(AVATAR_PATH);
    else setPending(AVATAR_PATH, next);
  };

  const selectAll = () => {
    let n = 0;
    for (const r of rows) {
      if (effOf(r.f) === true) continue;
      setPending(r.f.path, true);
      n++;
    }
    if (n > 0) pushLog("info", "Select all avatars", `${n} field${n === 1 ? "" : "s"} staged`);
  };

  const deselectAll = () => {
    let n = 0;
    for (const r of rows) {
      if (!pending.has(r.f.path)) continue;
      clearPending(r.f.path);
      n++;
    }
    if (n > 0) pushLog("info", "Deselect all avatars", `${n} staged edit${n === 1 ? "" : "s"} dropped`);
  };

  const applyRange = () => {
    const lo = from.trim() === "" ? 1 : Math.floor(Number(from.trim()));
    const hi = to.trim() === "" ? maxN : Math.floor(Number(to.trim()));
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      toast.warn("Range not applied", "From / To need whole avatar numbers.");
      return;
    }
    const a = Math.max(1, Math.min(lo, hi));
    const b = Math.min(maxN, Math.max(lo, hi));
    let n = 0;
    for (const r of rows) {
      if (r.n < a || r.n > b) continue;
      if (effOf(r.f) === true) continue;
      setPending(r.f.path, true);
      n++;
    }
    if (n === 0) {
      toast.info("Nothing to unlock", `Avatars #${a}–#${b} are already unlocked.`);
      return;
    }
    pushLog("info", "Unlock range staged", `${n} field${n === 1 ? "" : "s"} (#${a}–#${b})`);
  };

  const clearStaged = () => {
    const n = stagedKeys.length;
    for (const k of stagedKeys) clearPending(k);
    pushLog("info", "Clear staged avatar edits", `${n} field${n === 1 ? "" : "s"} cleared`);
  };

  /* -------------------------------------------------------------- render -- */

  if (!overview) {
    return (
      <section className="am-panel">
        <Head title="Avatars" />
        <AmEmpty
          title="No save loaded"
          detail="Press Connect in the title bar to read your client's live game."
        />
      </section>
    );
  }

  return (
    <section className="am-panel">
      <Head title="Avatars" />

      {fetchErr ? (
        <AmEmpty title="Could not read avatars" detail={fetchErr} />
      ) : loading && rows.length === 0 ? (
        <div className="am-empty">
          <div className="am-empty-title">Loading…</div>
          <div className="am-empty-detail">Reading Avatars.* unlock flags…</div>
        </div>
      ) : rows.length === 0 ? (
        <AmEmpty
          title="No avatars in this save"
          detail="Avatars.* is not present in the loaded save, so there are no avatar buttons to offer."
        />
      ) : (
        <>
          <div style={{ marginTop: 4 }}>
            <AmBar
              count={unlockedCount}
              total={rows.length}
              onAll={selectAll}
              onNone={deselectAll}
            />
          </div>

          <div className="am-row" style={{ margin: "12px 0 6px" }}>
            <input
              className="am-input am-input--num"
              value={from}
              placeholder="1"
              inputMode="numeric"
              aria-label="Range from avatar id"
              onChange={(e) => setFrom(e.target.value)}
            />
            <input
              className="am-input am-input--num"
              value={to}
              placeholder={String(maxN)}
              inputMode="numeric"
              aria-label="Range to avatar id"
              onChange={(e) => setTo(e.target.value)}
            />
            <button
              type="button"
              className="am-ghost"
              onClick={applyRange}
              title={`Stage unlocks for avatar ids ${from.trim() || "1"} – ${to.trim() || String(maxN)}`}
            >
              Unlock range
            </button>
            {stagedKeys.length > 0 ? (
              <button
                type="button"
                className="am-ghost"
                onClick={clearStaged}
                title="Drop staged Avatars.* / avatarId edits without touching other sections"
              >
                Revert staged ({stagedKeys.length})
              </button>
            ) : null}
            <span className="am-hint" style={{ marginLeft: "auto" }}>
              Profile picture: {effAvatar === null ? "—" : `#${effAvatar}`}
              {equipStaged ? <span className="am-staged" style={{ marginLeft: 8 }}>staged</span> : null}
            </span>
          </div>

          <div className="am-grid am-grid--ava">
            {rows.map((r) => {
              const unlocked = effOf(r.f) === true;
              const unlockStaged = pending.has(r.f.path);
              const isEq = effAvatar === String(r.n);
              const cls = [
                "am-ava",
                isEq ? "am-ava--eq" : "",
                !isEq && unlockStaged ? "am-ava--stg" : "",
                !isEq && !unlockStaged && unlocked ? "am-ava--on" : "",
              ]
                .filter(Boolean)
                .join(" ");
              const pic = AVATAR_PICS[r.n];
              return (
                <button
                  key={r.f.path}
                  type="button"
                  className={cls}
                  aria-pressed={isEq}
                  title={
                    isEq
                      ? `Avatar #${r.n} — equipped as profile picture (${r.f.path})`
                      : `Equip avatar #${r.n} — ${unlocked ? "unlocked" : "will stage the unlock too"}`
                  }
                  onClick={() => equip(r)}
                >
                  {pic !== undefined ? (
                    <img src={ppUrl(pic)} alt="" loading="lazy" />
                  ) : (
                    <span className="am-ava-emoji" aria-hidden>
                      {AVATAR_EMOJI[r.n % AVATAR_EMOJI.length] ?? "🙂"}
                    </span>
                  )}
                  <span className="am-ava-id">#{r.n}</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      <AmActions />
    </section>
  );
}
