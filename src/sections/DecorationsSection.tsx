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

interface RoomInfo {
  id: string;
  label: string;
  availablePath: string | null;
  availableLive: boolean | null;
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
    () => [...pending.keys()].filter((k) => k.startsWith(PREFIX)),
    [pending],
  );

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

      <AmActions />
    </section>
  );
}
