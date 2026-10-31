import { useEffect, useMemo, useState } from "react";
import { AmActions } from "./AmActions.tsx";
import { AmBar, AmEmpty, AmTile, useToast } from "../components/ui.tsx";
import { useStudio } from "../lib/studio.tsx";
import { api, type DiscoveredField } from "../lib/api.ts";
import { ROOM_EXTRAS } from "../lib/icons.ts";

/**
 * Decorations — room design & decoration flags under `RoomDesign.*`.
 *
 * One clean list: every room is a clickable tile toggling `v.isAvailable`
 * (staged locally, written by Save). Only that flag is offered here, exactly
 * like the legacy RoomsSection's primary toggle — every other room field
 * (`completedActions`, `v.state`, `isManuallyUnloaded`,
 * `checkCurrencyToCompleteAction`) stays read-only.
 */
const PREFIX = "RoomDesign.";
/** Installed decoration steps: `StepsState.<room>.v.<item|theme> = 1`. */
const STEP_PREFIX = "StepsState.";

interface RoomInfo {
  id: string;
  label: string;
  availablePath: string | null;
  availableLive: boolean | null;
}

interface StepRoom {
  id: string;
  label: string;
  total: number;
  done: number;
  /** Numeric leaves that are not yet 1. */
  todo: { path: string; value: number }[];
}

function Head({ title }: { title: string }) {
  return (
    <div className="am-panel-head">
      <img src="assets/ui/panel-bars.png" alt="" />
      <h2 className="am-panel-title">{title}</h2>
    </div>
  );
}

/** `LivingRoom` → `Living Room`. */
function prettify(raw: string): string {
  const spaced = raw
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  return spaced
    .split(" ")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Fallback badge only for rooms with no obtainable picture. */
function roomEmoji(name: string): string {
  if (/liv|lounge|hall|sitting|foyer|salon/i.test(name)) return "🛋️";
  if (/bed|boudoir/i.test(name)) return "🛏️";
  if (/kitchen|dining|dine/i.test(name)) return "🍳";
  if (/art|gallery|studio|office|library/i.test(name)) return "🎨";
  return "🏠";
}

/** Room id keyword → real room picture (shipped in /gi/rm). */
const ROOM_PICS: ReadonlyArray<readonly [string, string]> = [
  ["kitchen", "/gi/rm/Day_1_Kitchen.webp"],
  ["library", "/gi/rm/Day_1_Library.webp"],
  ["living", "/gi/rm/Day_1_Living_Room.webp"],
  ["garage", "/gi/rm/Day_1_Garage.webp"],
  ["garden", "/gi/rm/Day_1_Garden.webp"],
  ["lodge", "/gi/rm/Day_1_Lodge_Hall.webp"],
  ["party", "/gi/rm/Day_1_Party_Room.webp"],
  ["guest", "/gi/rm/Day_2_Guest_House.webp"],
  ["boat", "/gi/rm/Boat-house-day-1.webp"],
  ["relax", "/gi/rm/Relaxition-room-day-1.webp"],
  ["hall", "/gi/rm/Day_3_Hall.webp"],
  ["wedding", "/gi/rm/Wedding_Makeover.webp"],
  ["makeover", "/gi/rm/Makeover_Cash.webp"],
];

function roomPic(id: string): string | null {
  const key = id.toLowerCase();
  for (const [kw, src] of ROOM_PICS) if (key.includes(kw)) return src;
  for (const [kw, src] of ROOM_EXTRAS) if (key.includes(kw)) return src;
  return null;
}

function buildRooms(fields: DiscoveredField[]): RoomInfo[] {
  const map = new Map<string, RoomInfo>();
  for (const f of fields) {
    const dot = f.key.indexOf(".");
    if (dot < 0) continue;
    const id = f.key.slice(0, dot);
    const rest = f.key.slice(dot + 1);

    let r = map.get(id);
    if (!r) {
      r = {
        id,
        label: prettify(id),
        availablePath: null,
        availableLive: null,
      };
      map.set(id, r);
    }

    if (rest === "t" || rest === "v") continue; // tag / wrapper — never editable
    if (rest === "v.isAvailable") {
      r.availablePath = f.path;
      r.availableLive = typeof f.value === "boolean" ? f.value : null;
    }
  }

  const out = [...map.values()];
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/* ------------------------------------------------------------------ main -- */

export function DecorationsSection() {
  const { overview, values, pending, setPending, clearPending, pushLog } = useStudio();
  const toast = useToast();
  const [fields, setFields] = useState<DiscoveredField[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [steps, setSteps] = useState<DiscoveredField[]>([]);
  const [stepErr, setStepErr] = useState<string | null>(null);

  useEffect(() => {
    if (!overview) {
      setFields([]);
      setFetchErr(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      api
        .discover(PREFIX, undefined, 2000, query.trim())
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
            toast.err("Could not read room decorations", msg);
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [overview, query, toast]);

  // Decoration completion lives in a separate root. It is large (thousands of
  // leaves), so it is read once per save, not on every filter keystroke.
  useEffect(() => {
    if (!overview) {
      setSteps([]);
      setStepErr(null);
      return;
    }
    let cancelled = false;
    api
      .discover(STEP_PREFIX, overview.meta.id, 6000)
      .then((f) => {
        if (!cancelled) {
          setSteps(f);
          setStepErr(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setStepErr(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [overview]);

  const stepRooms = useMemo(() => {
    const map = new Map<string, StepRoom>();
    for (const f of steps) {
      const rest = f.key.startsWith(STEP_PREFIX) ? f.key.slice(STEP_PREFIX.length) : f.key;
      const dot = rest.indexOf(".");
      if (dot < 0) continue;
      const id = rest.slice(0, dot);
      if (typeof f.value !== "number") continue;
      let r = map.get(id);
      if (!r) {
        r = { id, label: prettify(id), total: 0, done: 0, todo: [] };
        map.set(id, r);
      }
      r.total++;
      if (f.value === 1) r.done++;
      else r.todo.push({ path: f.path, value: f.value });
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [steps]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return fields;
    return fields.filter((f) => f.path.toLowerCase().includes(q));
  }, [fields, query]);

  const rooms = useMemo(() => buildRooms(visible), [visible]);

  /* ------------------------------------------------------------- staging -- */

  const effBool = (path: string | null, live: boolean | null): boolean | null => {
    if (!path) return null;
    const p = pending.get(path);
    if (typeof p === "boolean") return p;
    return live;
  };

  const stageBool = (path: string, live: boolean | null, next: boolean) => {
    const current = values[path] ?? live;
    if (current === next) clearPending(path);
    else setPending(path, next);
  };

  const toggleRoom = (r: RoomInfo) => {
    if (!r.availablePath) {
      toast.info(
        "No availability flag",
        `${r.label} carries no isAvailable field in this save — there is nothing to stage.`,
      );
      return;
    }
    stageBool(r.availablePath, r.availableLive, !(effBool(r.availablePath, r.availableLive) === true));
  };

  const setAllRooms = (next: boolean) => {
    let n = 0;
    for (const r of rooms) {
      const path = r.availablePath;
      if (!path) continue;
      if (effBool(path, r.availableLive) === next) continue;
      stageBool(path, r.availableLive, next);
      n++;
    }
    pushLog(
      "info",
      next ? "Select all room flags" : "Deselect all room flags",
      `${n} field${n === 1 ? "" : "s"} staged`,
    );
  };

  const stagedKeys = useMemo(
    () =>
      [...pending.keys()].filter((k) => k.startsWith(PREFIX) || k.startsWith(STEP_PREFIX)),
    [pending],
  );

  const completeRoom = (room: StepRoom) => {
    if (room.todo.length === 0) {
      toast.info("Already complete", `${room.label} has no unfinished decoration steps.`);
      return;
    }
    for (const item of room.todo) setPending(item.path, 1);
    pushLog(
      "info",
      `Completed ${room.label} decorations`,
      `${room.todo.length} step${room.todo.length === 1 ? "" : "s"} staged — press Save, then Push`,
    );
  };

  const completeAllRooms = () => {
    let n = 0;
    for (const room of stepRooms) {
      for (const item of room.todo) {
        setPending(item.path, 1);
        n++;
      }
    }
    if (n === 0) {
      toast.info("Nothing to complete", "Every decoration step in this save is already done.");
      return;
    }
    pushLog("info", "Completed all decorations", `${n} step${n === 1 ? "" : "s"} staged`);
    toast.ok("All decoration steps staged", `${n} step${n === 1 ? "" : "s"} — press Save, then Push.`);
  };

  const clearStaged = () => {
    const n = stagedKeys.length;
    for (const k of stagedKeys) clearPending(k);
    pushLog("info", "Clear staged decoration edits", `${n} field${n === 1 ? "" : "s"} cleared`);
  };

  const availableCount = rooms.filter((r) => effBool(r.availablePath, r.availableLive) === true)
    .length;

  /* -------------------------------------------------------------- render -- */

  if (!overview) {
    return (
      <section className="am-panel">
        <Head title="Decorations" />
        <AmEmpty
          title="No save loaded"
          detail="Press Connect in the title bar to read your client's live game."
        />
      </section>
    );
  }

  return (
    <section className="am-panel">
      <Head title="Decorations" />

      <div className="am-row" style={{ margin: "12px 0 14px" }}>
        <input
          className="am-input"
          value={query}
          placeholder="Filter rooms…"
          aria-label="Filter rooms"
          onChange={(e) => setQuery(e.target.value)}
        />
        {stagedKeys.length > 0 ? (
          <button
            type="button"
            className="am-ghost"
            onClick={clearStaged}
            title="Drop staged RoomDesign.* edits without touching any other section"
          >
            Revert staged ({stagedKeys.length})
          </button>
        ) : null}
        {loading ? <span className="am-hint">Loading…</span> : null}
      </div>

      {fetchErr ? (
        <AmEmpty title="Could not read room decorations" detail={fetchErr} />
      ) : loading && rooms.length === 0 ? (
        <div className="am-empty">
          <div className="am-empty-title">Loading…</div>
          <div className="am-empty-detail">Reading RoomDesign.* decoration states…</div>
        </div>
      ) : rooms.length === 0 ? (
        <AmEmpty
          title={query.trim() ? "No room keys match" : "This save has no rooms"}
          detail={
            query.trim()
              ? "No RoomDesign.* key contains that text — clear the filter to see every room."
              : "RoomDesign.* is not present in the loaded save, so there are no decoration flags to edit."
          }
        />
      ) : (
        <>
          <div style={{ marginTop: 2 }}>
            <AmBar
              count={availableCount}
              total={rooms.length}
              onAll={() => setAllRooms(true)}
              onNone={() => setAllRooms(false)}
            />
          </div>

          <div className="am-grid" style={{ marginTop: 12 }}>
            {rooms.map((r) => (
              <AmTile
                key={r.id}
                on={effBool(r.availablePath, r.availableLive) === true}
                onToggle={() => toggleRoom(r)}
                label={r.label}
                art={roomPic(r.id) ?? undefined}
                emoji={roomEmoji(r.id)}
              />
            ))}
          </div>
        </>
      )}

      {stepRooms.length > 0 ? (
        <div style={{ marginTop: 18 }}>
          <div className="am-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div className="am-label" style={{ margin: 0 }}>
                Decoration steps
              </div>
              <div className="am-hint" style={{ marginTop: 2 }}>
                <code>StepsState.&lt;room&gt;.v.&lt;item&gt; = 1</code> records an applied decoration
                step. Completing them marks every step done so the room's decor is unlocked in game.
              </div>
            </div>
            <button
              type="button"
              className="am-ghost am-ghost--primary"
              onClick={completeAllRooms}
              title="Stage every unfinished decoration step in every room"
            >
              Complete all rooms
            </button>
          </div>

          <div className="am-fieldgrid" style={{ marginTop: 10 }}>
            {stepRooms.map((room) => {
              const stagedHere = room.todo.filter((i) => pending.get(i.path) === 1).length;
              const done = room.done + stagedHere;
              const pct = room.total === 0 ? 100 : Math.round((done / room.total) * 100);
              return (
                <div className="am-field" key={room.id}>
                  <div className="am-field-meta">
                    <div className="am-field-label" title={room.id}>
                      {room.label}
                    </div>
                    <div className="am-field-value">
                      <span className="am-hint">
                        {done}/{room.total} steps · {pct}%
                      </span>
                      {stagedHere > 0 ? <span className="am-staged">staged</span> : null}
                      {room.todo.length > 0 ? (
                        <button
                          type="button"
                          className="am-ghost"
                          style={{ padding: "2px 8px", fontSize: 11 }}
                          onClick={() => completeRoom(room)}
                          title={`Stage the remaining ${room.todo.length} decoration step(s) in ${room.label}`}
                        >
                          Complete
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : stepErr ? (
        <div className="am-hint" style={{ marginTop: 14 }}>
          Decoration steps could not be read: {stepErr}
        </div>
      ) : (
        <div className="am-hint" style={{ marginTop: 14, lineHeight: 1.5 }}>
          This save carries no <code>StepsState.*</code> decoration records — a brand-new cloud save
          has not installed any decor yet. Load a save that has played through rooms (or clone the
          room content from the IGG Account Clone tab) to see decoration steps here.
        </div>
      )}

      <AmActions />
    </section>
  );
}
