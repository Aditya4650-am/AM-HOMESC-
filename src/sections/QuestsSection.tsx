import { useEffect, useMemo, useState } from "react";
import { api, type DiscoveredField } from "../lib/api.ts";
import { useStudio } from "../lib/studio.tsx";
import { BTN, GI } from "../lib/icons.ts";
import {
  Bar,
  EmptyState,
  GameIcon,
  KpiTile,
  Panel,
  PanelHead,
  SearchBox,
  Spinner,
  StateBadge,
  useToast,
} from "../components/ui.tsx";

/**
 * Quests — story tasks and side quests as premium completion cards.
 *
 * Every quest id exposes a `.t` tag (hidden), a `.v` serialized JSON blob
 * (READ-ONLY) and `.v.collected`, the boolean completion flag. Toggling a
 * card stages only that boolean — the blob bytes stay untouched. All edits
 * land in the shared pending map; Save & Push writes the container.
 */
export function QuestsSection() {
  const { overview, pending, setPending, clearPending, pushLog } = useStudio();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [fields, setFields] = useState<DiscoveredField[]>([]);
  const [loading, setLoading] = useState(true);

  // Server-side key search, debounced so each keystroke does not re-walk the
  // save. `overview` identity changes after every apply → auto refetch.
  useEffect(() => {
    if (!overview) {
      setFields([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .discover("Quests.", undefined, 2000, query.trim())
        .then((f) => {
          if (!cancelled) setFields(f);
        })
        .catch((err: unknown) => {
          if (!cancelled)
            toast.err("Could not read quests", err instanceof Error ? err.message : String(err));
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

  const { quests, pointer, others } = useMemo(() => {
    const map = new Map<string, QuestEntry>();
    let lastCompleted: DiscoveredField | null = null;
    const other: DiscoveredField[] = [];
    const get = (id: string): QuestEntry => {
      let e = map.get(id);
      if (!e) {
        e = { id };
        map.set(id, e);
      }
      return e;
    };
    for (const f of fields) {
      if (f.key === "lastCompletedQuest") {
        lastCompleted = f;
        continue;
      }
      if (f.key.endsWith(".v.collected")) {
        get(f.key.slice(0, -".v.collected".length)).collected = f;
        continue;
      }
      if (f.key.endsWith(".v")) {
        get(f.key.slice(0, -2)).blob = f;
        continue;
      }
      if (f.key.endsWith(".t")) {
        get(f.key.slice(0, -2)).tag = f;
        continue;
      }
      other.push(f);
    }
    const list = [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
    return { quests: list, pointer: lastCompleted, others: other };
  }, [fields]);

  const isDone = (q: QuestEntry): boolean => {
    if (!q.collected) return false;
    const staged = pending.get(q.collected.path);
    return (staged !== undefined ? staged : q.collected.value) === true;
  };

  const total = quests.length;
  const collected = quests.filter(isDone).length;
  const pct = total > 0 ? Math.round((collected / total) * 100) : 0;

  const collectedFlags = useMemo(
    () => fields.filter((f) => f.key.endsWith(".v.collected")),
    [fields],
  );

  const completeAll = () => {
    let n = 0;
    for (const f of collectedFlags) {
      if (f.value === true) {
        clearPending(f.path);
        continue;
      }
      setPending(f.path, true);
      n++;
    }
    pushLog("info", "Complete ALL", `${n} field${n === 1 ? "" : "s"} staged`);
  };

  const resetAll = () => {
    let n = 0;
    for (const f of collectedFlags) {
      if (f.value === false) {
        clearPending(f.path);
        continue;
      }
      setPending(f.path, false);
      n++;
    }
    pushLog("info", "Reset all quests", `${n} field${n === 1 ? "" : "s"} staged`);
  };

  const clearStaged = () => {
    let n = 0;
    for (const f of collectedFlags) {
      if (pending.has(f.path)) {
        clearPending(f.path);
        n++;
      }
    }
    if (pointer && pending.has(pointer.path)) {
      clearPending(pointer.path);
      n++;
    }
    pushLog("info", "Clear staged", `${n} staged edit${n === 1 ? "" : "s"} reverted`);
  };

  if (!overview) {
    return (
      <EmptyState
        title="No save loaded"
        detail="Load a save file or pull one from a device to browse its quests."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Bar hint="Tap a quest, then Save & Push.">
        <button
          className="preset-pill inline-flex items-center gap-1.5"
          onClick={completeAll}
          title="Stage every .v.collected flag to true"
        >
          <GameIcon src={BTN.newDay} emoji="✅" size={15} />
          Complete ALL
        </button>
        <button className="preset-pill" onClick={resetAll} title="Stage every .v.collected flag to false">
          🔄 Reset all
        </button>
        <button className="preset-pill" onClick={clearStaged}>
          ↩️ Clear staged
        </button>
        <SearchBox value={query} onChange={setQuery} placeholder="Search quests…" />
      </Bar>

      {/* KPI strip */}
      <div className="stagger-in grid grid-cols-2 gap-3 sm:grid-cols-3">
        <KpiTile emoji="📋" label="Quests" value={total.toLocaleString("en-US")} title="quest ids discovered under Quests." />
        <KpiTile emoji="✅" label="Collected" value={collected.toLocaleString("en-US")} title="completion flags currently true (staged counts)" />
        <KpiTile emoji="📈" label="Progress" value={`${pct}%`} title={`${collected} of ${total} complete`} />
      </div>

      {/* Progress card */}
      <div className="panel">
        <PanelHead tone="gold" icon="🗺️" right={<StateBadge tone={pct >= 100 ? "ready" : "cyan"}>{pct >= 100 ? "story complete" : "in progress"}</StateBadge>}>
          Story progress
        </PanelHead>
        <div className="flex items-center gap-3">
          <div className="mini-bar flex-1">
            <div className="mini-bar__fill mini-bar__fill--gold" style={{ width: `${pct}%` }} />
          </div>
          <span className="shrink-0 text-xs font-semibold text-ink-2">
            {collected}/{total} complete
          </span>
        </div>
      </div>

      {loading && fields.length === 0 ? (
        <div className="flex items-center gap-2 py-10 text-ink-3">
          <Spinner size={15} />
          <span className="text-sm">Reading quests…</span>
        </div>
      ) : fields.length === 0 ? (
        <EmptyState
          title={query ? "Nothing matches" : "No Quests. fields in this save"}
          detail={
            query
              ? "No quest key contains that text — try another word, or clear the search."
              : "This profile has not recorded any quest state yet — that is normal before the first side quest unlocks."
          }
        />
      ) : (
        <>
          {/* Quest cards */}
          <div className="stagger-in grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {quests.map((q) => (
              <QuestCard key={q.id} quest={q} />
            ))}
          </div>

          {pointer ? <ProgressPointer field={pointer} /> : null}

          {others.length > 0 ? (
            <Panel title="Other quest fields">
              <div className="flex flex-col gap-1.5">
                {others.map((f) => (
                  <div key={f.path} className="flex items-center gap-3 rounded-lg bg-panel-2 px-3 py-1.5 text-xs">
                    <span className="min-w-0 flex-1 truncate font-mono text-ink-2" title={f.path}>
                      {f.key || "(root)"}
                    </span>
                    <span className="max-w-[14rem] truncate font-mono text-ink-3">
                      {String(f.value)}
                    </span>
                  </div>
                ))}
              </div>
            </Panel>
          ) : null}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- quest card -- */

interface QuestEntry {
  id: string;
  collected?: DiscoveredField;
  tag?: DiscoveredField;
  blob?: DiscoveredField;
}

function QuestCard({ quest }: { quest: QuestEntry }) {
  const { pending, setPending, clearPending } = useStudio();
  const flag = quest.collected;
  const live = flag ? flag.value === true : false;
  const staged = flag ? pending.get(flag.path) : undefined;
  const done = flag ? (staged !== undefined ? staged === true : live) : false;
  const isStaged = staged !== undefined && staged !== live;
  const emoji = questEmoji(quest.id);
  const iconSrc = questIcon(quest.id);

  const toggle = () => {
    if (!flag) return;
    const next = !done;
    if (next === flag.value) clearPending(flag.path);
    else setPending(flag.path, next);
  };

  return (
    <div className="panel">
      <PanelHead
        tone="cyan"
        icon={iconSrc ? <GameIcon src={iconSrc} emoji={emoji} size={20} /> : emoji}
        right={
          isStaged ? (
            <span className="badge-pop">
              <StateBadge tone="gold">staged</StateBadge>
            </span>
          ) : done ? (
            <StateBadge tone="ready">collected</StateBadge>
          ) : (
            <StateBadge tone="neutral">pending</StateBadge>
          )
        }
      >
        {prettifyQuestId(quest.id)}
      </PanelHead>
      <div className="flex items-center justify-between gap-3">
        {flag ? (
          <button className="preset-pill" onClick={toggle}>
            {done ? "↩️ Undo" : "✅ Mark done"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------- progress pointer -- */

function ProgressPointer({ field }: { field: DiscoveredField }) {
  const { pending, setPending, clearPending } = useStudio();
  const staged = pending.get(field.path);
  const live = typeof field.value === "string" ? field.value : "";
  const shown = typeof staged === "string" ? staged : live;
  const isStaged = staged !== undefined && staged !== live;

  return (
    <div className="panel">
      <PanelHead
        tone="navy"
        icon="🧭"
        right={isStaged ? <StateBadge tone="gold">staged</StateBadge> : <StateBadge tone="cyan">pointer</StateBadge>}
      >
        Progress pointer
      </PanelHead>
      <div className="flex flex-wrap items-center gap-3">
        <input
          key={`${field.path}-${live}`}
          className="field min-w-0 flex-1"
          defaultValue={shown}
          spellCheck={false}
          title={isStaged ? `${live} → ${shown} (staged)` : `now ${live || "(empty)"}`}
          onBlur={(e) => {
            const s = e.target.value;
            // Never stage serialized blobs or multi-line payloads.
            const t = s.trimStart();
            if (s.includes("\r\n") || t.startsWith("{") || t.startsWith("[")) return;
            if (s === live) clearPending(field.path);
            else setPending(field.path, s);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- helpers -- */

function questEmoji(id: string): string {
  if (id.includes("Fix")) return "🔧";
  if (id.includes("Arrange") || id.includes("Decor")) return "🛋️";
  if (id.includes("Connect")) return "🔌";
  return "📋";
}

/** Real game icon for the quest keywords that have a good match. */
function questIcon(id: string): string | undefined {
  if (/fix|repair|build|carpentry|assemble|install/i.test(id)) return GI.hammer;
  if (/clean|wash|sweep|broom/i.test(id)) return GI.broom;
  if (/collect|gather|pack|chest/i.test(id)) return GI.chest;
  return undefined;
}

function prettifyQuestId(id: string): string {
  return id
    .replace(/^chWing_/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
