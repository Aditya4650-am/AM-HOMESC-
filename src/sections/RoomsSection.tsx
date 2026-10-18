import { useEffect, useMemo, useState } from "react";
import { api, type DiscoveredField } from "../lib/api.ts";
import { useStudio } from "../lib/studio.tsx";
import { BTN, ROOM_EXTRAS } from "../lib/icons.ts";
import {
  Bar,
  ChipToggle,
  EmptyState,
  GameIcon,
  KpiTile,
  PanelHead,
  SearchBox,
  Spinner,
  StateBadge,
  useToast,
} from "../components/ui.tsx";

/**
 * Mansion rooms — `RoomDesign.<id>` design state.
 *
 * Each room is a `{t, v}` wrapper: `.t` is a tag-name leaf (hidden, never
 * editable), `.v` is either `null` (room never started) or the object holding
 * `isAvailable`, `completedActions` (a JSON string) and friends. Only the
 * booleans are staged — action lists stay byte-identical.
 */
const PREFIX = "RoomDesign.";

/** Nominal action budget per room, used for the progress bar. */
const ACTION_CAP = 12;

interface RoomInfo {
  id: string;
  label: string;
  /** `RoomDesign.<id>.v` exists as a null leaf — the room was never started. */
  hasNullV: boolean;
  /** Any `<id>.v.*` leaf exists — the design object is materialized. */
  hasNestedV: boolean;
  started: boolean;
  availablePath: string | null;
  availableLive: boolean | null;
  gatePath: string | null;
  gateLive: boolean | null;
  unloadPath: string | null;
  unloadLive: boolean | null;
  actionsPath: string | null;
  actionsRaw: unknown;
  done: number | null;
  /** `RoomDesign.<id>.v.state` — free-form stage string (read-only here). */
  statePath: string | null;
  stateValue: string | null;
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

/** Real picture for a well-known room id, else null (the card keeps its emoji). */
function roomPic(id: string): string | null {
  const key = id.toLowerCase();
  for (const [kw, src] of ROOM_PICS) if (key.includes(kw)) return src;
  for (const [kw, src] of ROOM_EXTRAS) if (key.includes(kw)) return src;
  return null;
}

/** Count the actions in a `completedActions` JSON string, defensively. */
function countActions(raw: unknown): number | null {
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw !== "string" || raw.trim() === "") return typeof raw === "string" ? 0 : null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed && typeof parsed === "object") return Object.keys(parsed as object).length;
    return null;
  } catch {
    return null;
  }
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
        hasNullV: false,
        hasNestedV: false,
        started: false,
        availablePath: null,
        availableLive: null,
        gatePath: null,
        gateLive: null,
        unloadPath: null,
        unloadLive: null,
        actionsPath: null,
        actionsRaw: null,
        done: null,
        statePath: null,
        stateValue: null,
      };
      map.set(id, r);
    }

    if (rest === "t") continue; // tag name — hidden on purpose
    if (rest === "v") {
      if (f.kind === "null" || f.value === null) r.hasNullV = true;
      continue;
    }
    if (rest.startsWith("v.")) r.hasNestedV = true;
    if (rest === "v.isAvailable") {
      r.availablePath = f.path;
      r.availableLive = typeof f.value === "boolean" ? f.value : null;
    } else if (rest === "v.isManuallyUnloaded") {
      r.unloadPath = f.path;
      r.unloadLive = typeof f.value === "boolean" ? f.value : null;
    } else if (rest === "v.checkCurrencyToCompleteAction") {
      r.gatePath = f.path;
      r.gateLive = typeof f.value === "boolean" ? f.value : null;
    } else if (rest === "v.completedActions") {
      r.actionsPath = f.path;
      r.actionsRaw = f.value;
      r.done = countActions(f.value);
    } else if (rest === "v.state") {
      r.statePath = f.path;
      r.stateValue = typeof f.value === "string" ? f.value : String(f.value);
    }
  }

  const out = [...map.values()];
  for (const r of out) r.started = r.hasNestedV && !r.hasNullV;
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

export function RoomsSection() {
  const { overview, values, pending, setPending, clearPending, pushLog } = useStudio();
  const toast = useToast();
  const [fields, setFields] = useState<DiscoveredField[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!overview) {
      setFields([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      api
        .discover(PREFIX, undefined, 2000, query.trim())
        .then((f) => {
          if (!cancelled) setFields(f);
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            toast.err("Could not read rooms", err instanceof Error ? err.message : String(err));
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

  /**
   * Server-side key search reaches keys beyond the first page; the same
   * needle is re-applied locally so filtering is instant and correct even
   * while the debounced refetch is in flight.
   */
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return fields;
    return fields.filter((f) => f.path.toLowerCase().includes(q));
  }, [fields, query]);

  const rooms = useMemo(() => buildRooms(visible), [visible]);

  /* ------------------------------------------------------------ staging -- */

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

  const unlockAll = () => {
    let n = 0;
    for (const r of rooms) {
      const path = r.availablePath;
      if (!path) continue;
      if (effBool(path, r.availableLive) === true) continue;
      stageBool(path, r.availableLive, true);
      n++;
    }
    pushLog("info", "🔓 Unlock ALL rooms", `${n} field${n === 1 ? "" : "s"} staged`);
  };

  const clearStaged = () => {
    let n = 0;
    for (const r of rooms) {
      for (const p of [r.availablePath, r.gatePath]) {
        if (p && pending.has(p)) {
          clearPending(p);
          n++;
        }
      }
    }
    pushLog("info", "↩️ Clear staged room edits", `${n} field${n === 1 ? "" : "s"} cleared`);
  };

  /* --------------------------------------------------------------- stats -- */

  const availableCount = rooms.filter((r) => effBool(r.availablePath, r.availableLive) === true)
    .length;
  const progressCount = rooms.filter((r) => (r.done ?? 0) > 0).length;
  const notStartedCount = rooms.filter((r) => !r.started).length;
  const stagedCount = rooms.reduce(
    (n, r) =>
      n +
      (r.availablePath && pending.has(r.availablePath) ? 1 : 0) +
      (r.gatePath && pending.has(r.gatePath) ? 1 : 0),
    0,
  );

  /* -------------------------------------------------------------- render -- */

  return (
    <div className="flex flex-col gap-4">
      <Bar hint="Tap a room, then Save & Push.">
        <button
          className="preset-pill inline-flex items-center gap-1.5"
          onClick={unlockAll}
          title="Stage isAvailable = true for every room that carries the field"
        >
          <GameIcon src={BTN.unlockArea} emoji="🔓" size={15} />
          Unlock ALL rooms
        </button>
        <button
          className="preset-pill"
          onClick={clearStaged}
          title="Drop staged room edits only — other sections keep theirs"
        >
          ↩️ Clear staged
        </button>
        <SearchBox value={query} onChange={setQuery} placeholder="Search rooms…" />
      </Bar>

      <div className="stagger-in grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          emoji="🏠"
          label="Rooms"
          value={rooms.length}
          title="Distinct RoomDesign.* ids discovered"
        />
        <KpiTile emoji="✅" label="Available" value={availableCount} title="isAvailable = true" />
        <KpiTile
          emoji="🔧"
          label="In progress"
          value={progressCount}
          title="completedActions holds at least one action"
        />
        <KpiTile emoji="🚧" label="Not started" value={notStartedCount} />
      </div>

      {stagedCount > 0 ? (
        <div className="flex items-center gap-2">
          <StateBadge tone="gold">staged {stagedCount}</StateBadge>
          <span className="text-xs text-ink-3">room toggle{stagedCount === 1 ? "" : "s"} waiting for Save &amp; Push</span>
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 rounded-xl border border-line bg-panel px-4 py-6 text-sm text-ink-3">
          <Spinner size={15} />
          Reading room design states…
        </div>
      ) : rooms.length === 0 ? (
        <EmptyState
          title={query.trim() ? "No room keys match" : "This save has no rooms"}
        />
      ) : (
        <>
          <div className="stagger-in grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rooms.map((room) => (
              <RoomCard
                key={room.id}
                room={room}
                pending={pending}
                onStage={stageBool}
                onEff={effBool}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- card -- */

function RoomCard({
  room,
  pending,
  onStage,
  onEff,
}: {
  room: RoomInfo;
  pending: Map<string, number | string | boolean>;
  onStage: (path: string, live: boolean | null, next: boolean) => void;
  onEff: (path: string | null, live: boolean | null) => boolean | null;
}) {
  const { availablePath, gatePath, unloadPath, actionsPath } = room;
  const pic = roomPic(room.id);
  const avail = onEff(availablePath, room.availableLive);
  const gate = onEff(gatePath, room.gateLive);
  const unloaded = onEff(unloadPath, room.unloadLive) === true;
  const staged =
    (availablePath !== null && pending.has(availablePath)) ||
    (gatePath !== null && pending.has(gatePath));

  const status = !room.started ? (
    <StateBadge>not started</StateBadge>
  ) : avail === true ? (
    <StateBadge tone="ready">available</StateBadge>
  ) : avail === false ? (
    <StateBadge tone="warn">locked</StateBadge>
  ) : (
    <StateBadge>no availability flag</StateBadge>
  );

  const done = room.done ?? 0;
  const cap = Math.max(ACTION_CAP, done);
  const pct = Math.min(100, Math.round((done / cap) * 100));

  return (
    <section className="panel">
      <PanelHead
        tone="gold"
        icon={
          pic ? (
            <GameIcon src={pic} emoji="🏠" size={40} className="rounded-xl border border-line" />
          ) : (
            roomEmoji(room.id)
          )
        }
      >
        {room.label}
      </PanelHead>

      <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
        {status}
        {room.stateValue ? <StateBadge tone="cyan">state: {room.stateValue}</StateBadge> : null}
        {staged ? <StateBadge tone="gold">staged</StateBadge> : null}
        {unloaded ? <StateBadge tone="warn">manually unloaded</StateBadge> : null}
      </div>

      {!room.started ? (
        <div className="text-[11px] italic text-ink-3">🚧 Not started in this save</div>
      ) : (
        <div className="flex flex-col gap-2">
          {availablePath ? (
            <ChipToggle
              emoji="🔓"
              label="Available"
              checked={avail === true}
              onChange={() => onStage(availablePath, room.availableLive, !(avail === true))}
              title={
                room.availableLive === null
                  ? "Stage isAvailable"
                  : `isAvailable ${String(room.availableLive)} → ${String(!(avail === true))}`
              }
            />
          ) : null}

          {gatePath ? (
            <ChipToggle
              emoji="💱"
              label="Currency-gated actions"
              checked={gate === true}
              onChange={() => onStage(gatePath, room.gateLive, !(gate === true))}
              title="Stage checkCurrencyToCompleteAction"
            />
          ) : null}

          {actionsPath ? (
            room.done === null ? (
              <div className="flex items-center gap-2 text-[11px] text-ink-3">
                <span className="truncate font-mono" title={String(room.actionsRaw ?? "")}>
                  {String(room.actionsRaw ?? "")}
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <div className="mini-bar">
                  <div className="mini-bar__fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-ink-2">{done} actions</span>
                  <span className="font-mono text-ink-3">
                    {done}/{cap}
                  </span>
                </div>
              </div>
            )
          ) : room.stateValue ? null : (
            <div className="text-[11px] text-ink-3">No action list recorded yet.</div>
          )}
        </div>
      )}
    </section>
  );
}
