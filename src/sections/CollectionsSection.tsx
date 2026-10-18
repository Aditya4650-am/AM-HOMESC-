import { useEffect, useState, type ReactNode } from "react";
import { api, type DiscoveredField } from "../lib/api.ts";
import { useStudio } from "../lib/studio.tsx";
import { chIcon } from "../lib/icons.ts";
import {
  Bar,
  EmptyState,
  FeatureRow,
  KpiTile,
  Panel,
  PanelHead,
  SearchBox,
  Spinner,
  StateBadge,
} from "../components/ui.tsx";

/**
 * Collections — characters, photo albums and trophies.
 *
 * This is STRUCTURE-heavy data: tag rows (`*.t`), tagged containers and
 * serialized JSON blobs stay read-only; only safe numeric/boolean/plain-string
 * leaves ever reach `setPending`. Read-only rows are capped after the search
 * filter so the DOM stays sane on big saves.
 */

const PREFIX = "Characters.|PhotoAlbums.|GameTrophy.";
const READONLY_CAP = 200;

const NUMERIC_KINDS = new Set(["number", "int", "float", "tagged-i64", "tagged-f"]);

interface GroupSpec {
  prefix: string;
  title: string;
  emoji: string;
  tone: "cyan" | "amber" | "gold" | "navy";
}

const GROUPS: GroupSpec[] = [
  { prefix: "Characters.", title: "Characters", emoji: "👤", tone: "navy" },
  { prefix: "PhotoAlbums.", title: "Photo albums", emoji: "🖼️", tone: "navy" },
  { prefix: "GameTrophy.", title: "Trophies", emoji: "🏆", tone: "gold" },
];

function isBlobString(v: unknown): boolean {
  return typeof v === "string" && (v.startsWith("{") || v.startsWith("[") || v.includes("\r\n"));
}

/** Safe to stage: booleans / numbers / short plain strings — never tags or blobs. */
function isSafeLeaf(f: DiscoveredField): boolean {
  if (f.path.endsWith(".t") || f.kind === "null") return false;
  if (f.kind === "boolean" || NUMERIC_KINDS.has(f.kind)) return true;
  if (f.kind === "string") return !isBlobString(f.value);
  return false;
}

function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "—";
  const s = typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

/** Distinct first path segments under a prefix (skips tag/value markers). */
function countSegments(rows: DiscoveredField[], prefix: string): number {
  const seen = new Set<string>();
  for (const f of rows) {
    if (!f.path.startsWith(prefix)) continue;
    let rest = f.path.slice(prefix.length);
    if (rest.startsWith("v.")) rest = rest.slice(2);
    const seg = rest.split(".")[0];
    if (seg && seg !== "t" && seg !== "v") seen.add(seg);
  }
  return seen.size;
}

/** Character id — the first segment under `Characters.` (skips `v.` markers). */
function charId(path: string): string {
  let rest = path.slice("Characters.".length);
  if (rest.startsWith("v.")) rest = rest.slice(2);
  return rest.split(".")[0] ?? "";
}

/** One editable-or-readonly leaf row. Never stages anything unsafe. */
function LeafRow({ f, icon }: { f: DiscoveredField; icon?: string }) {
  const { values, pending, setPending, clearPending } = useStudio();

  const live = (): unknown => {
    const v = values[f.path];
    return v === undefined ? f.value : v;
  };
  const eff = (): unknown => {
    const p = pending.get(f.path);
    return p === undefined ? live() : p;
  };
  const staged = pending.get(f.path);
  const isStaged = staged !== undefined && staged !== live();

  const stage = (v: number | string | boolean) => {
    if (v === live()) clearPending(f.path);
    else setPending(f.path, v);
  };

  const stagedBadge = isStaged ? <StateBadge tone="gold">staged</StateBadge> : null;
  const safe = isSafeLeaf(f);

  let controls: ReactNode;
  let emoji = "🔒";

  if (safe && f.kind === "boolean") {
    emoji = "🎚️";
    const on = eff() === true;
    controls = (
      <>
        <button
          type="button"
          className="preset-pill"
          aria-pressed={on}
          onClick={() => stage(!on)}
          title={`${on ? "Stage false" : "Stage true"} for ${f.path}`}
        >
          {on ? "✓ true" : "✕ false"}
        </button>
        {stagedBadge}
      </>
    );
  } else if (safe && NUMERIC_KINDS.has(f.kind)) {
    emoji = "🔢";
    controls = (
      <>
        <input
          key={`${f.path}-${String(live())}`}
          className="field field-qty"
          inputMode="numeric"
          defaultValue={String(eff() ?? "")}
          title={isStaged ? `${String(live())} → ${String(staged)}` : `now ${String(eff())}`}
          onBlur={(e) => {
            const s = e.target.value.trim();
            if (s === "") return;
            const n = Number(s);
            if (Number.isFinite(n)) stage(n);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        {stagedBadge}
      </>
    );
  } else if (safe && f.kind === "string") {
    emoji = "🔤";
    controls = (
      <>
        <input
          key={`${f.path}-${String(live())}`}
          className="field w-44"
          defaultValue={String(eff() ?? "")}
          title={isStaged ? `${String(live())} → ${String(staged)}` : `now ${String(eff())}`}
          onBlur={(e) => {
            const s = e.target.value;
            if (s !== String(eff() ?? "")) stage(s);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        {stagedBadge}
      </>
    );
  } else {
    controls = (
      <>
        <span className="max-w-[16rem] truncate font-mono text-[11px] text-ink-3" title={formatValue(f.value)}>
          {formatValue(eff())}
        </span>
      </>
    );
  }

  return <FeatureRow emoji={emoji} icon={icon} name={f.key || f.path} controls={controls} />;
}

export function CollectionsSection() {
  const { overview, pending, setPending, clearPending, pushLog } = useStudio();

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [all, setAll] = useState<DiscoveredField[] | null>(null);
  const [view, setView] = useState<DiscoveredField[]>([]);
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const full = await api.discover(PREFIX, undefined, 2000);
        const narrowed = debounced ? await api.discover(PREFIX, undefined, 2000, debounced) : full;
        if (!alive) return;
        setAll(full);
        setView(narrowed);
        setFetchErr(null);
      } catch (err) {
        if (!alive) return;
        setFetchErr(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [overview, debounced]);

  /* --------------------------------------------------------------- derived -- */

  const allRows = all ?? [];
  const needle = debounced.toLowerCase();
  // Client-side narrowing over the fetched rows (keeps results honest while a
  // search refetch is still in flight).
  const rows = needle ? view.filter((f) => f.path.toLowerCase().includes(needle)) : view;

  const characterCount = countSegments(allRows, "Characters.");
  const albumCount = countSegments(allRows, "PhotoAlbums.");
  const trophyCount = countSegments(allRows, "GameTrophy.");
  const editableTotal = allRows.filter(isSafeLeaf).length;
  const stagedKeys = [...pending.keys()].filter((k) => k.startsWith(PREFIX));

  const clearStaged = () => {
    const n = stagedKeys.length;
    for (const k of stagedKeys) clearPending(k);
    pushLog("info", "✨ Collection staging cleared", `${n} staged edit${n === 1 ? "" : "s"} dropped`);
  };

  /* ------------------------------------------------------------------ view -- */

  return (
    <div className="flex flex-col gap-4">
      <Bar hint="Characters, albums and trophies gathered across the story.">
        <SearchBox value={query} onChange={setQuery} placeholder="Search keys or paths…" />
        {stagedKeys.length > 0 ? (
          <button
            type="button"
            className="preset-pill"
            onClick={clearStaged}
            title="Drop staged collection edits without touching anything else"
          >
            ✨ Clear staged ({stagedKeys.length})
          </button>
        ) : null}
      </Bar>

      {all === null && !fetchErr ? (
        <Panel title="Reading collections…">
          <div className="flex items-center justify-center gap-3 py-10 text-sm text-ink-3">
            <Spinner />
            <span>Scanning Characters / PhotoAlbums / GameTrophy leaves…</span>
          </div>
        </Panel>
      ) : all !== null && allRows.length === 0 ? (
        <EmptyState title="No collection data in this save" />
      ) : all !== null ? (
        <>
          {/* KPI strip */}
          <div className="stagger-in grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiTile
              emoji="👤"
              label="Characters found"
              value={String(characterCount)}
              title="Distinct first segments under Characters."
            />
            <KpiTile
              emoji="🖼️"
              label="Photo albums"
              value={String(albumCount)}
              title="Distinct first segments under PhotoAlbums."
            />
            <KpiTile
              emoji="🏆"
              label="Trophies"
              value={String(trophyCount)}
              title="Distinct first segments under GameTrophy."
            />
            <KpiTile
              emoji="✏️"
              label="Editable leaves"
              value={`${editableTotal}/${allRows.length}`}
              title="Safe numeric/boolean/plain-string leaves in these sections"
            />
          </div>

          <div className="stagger-in grid gap-4">
            {GROUPS.map((g) => {
              const groupRows = rows.filter((f) => f.path.startsWith(g.prefix));
              const safeRows = groupRows.filter(isSafeLeaf);
              const roRows = groupRows.filter((f) => !isSafeLeaf(f));
              const roShown = roRows.slice(0, READONLY_CAP);
              const hidden = roRows.length - roShown.length;
              const groupStaged = stagedKeys.filter((k) => k.startsWith(g.prefix)).length;
              const isCharacters = g.prefix === "Characters.";

              return (
                <Panel key={g.prefix}>
                  <PanelHead
                    tone={g.tone}
                    icon={g.emoji}
                    right={
                      groupStaged > 0 ? (
                        <StateBadge tone="gold">{groupStaged} staged</StateBadge>
                      ) : (
                        <StateBadge tone="cyan">{groupRows.length} leaves</StateBadge>
                      )
                    }
                  >
                    {g.title}
                  </PanelHead>

                  {groupRows.length === 0 ? (
                    <EmptyState
                      title={needle ? `No ${g.title.toLowerCase()} match the search` : `${g.title} not present`}
                    />
                  ) : (
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StateBadge tone="ready">{safeRows.length} editable</StateBadge>
                        <StateBadge>{roRows.length} read-only</StateBadge>
                        {groupStaged > 0 ? <StateBadge tone="gold">{groupStaged} staged</StateBadge> : null}
                      </div>

                      {safeRows.map((f) => (
                        <LeafRow
                          key={f.path}
                          f={f}
                          icon={isCharacters ? chIcon(charId(f.path)) ?? undefined : undefined}
                        />
                      ))}

                      {roShown.map((f) => (
                        <LeafRow
                          key={f.path}
                          f={f}
                          icon={isCharacters ? chIcon(charId(f.path)) ?? undefined : undefined}
                        />
                      ))}
                      {hidden > 0 ? (
                        <div className="text-[11px] text-ink-3">
                          +{hidden} more hidden — narrow with the search box to reach them.
                        </div>
                      ) : null}
                    </div>
                  )}
                </Panel>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
