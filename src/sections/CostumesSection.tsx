import { useEffect, useState } from "react";
import { api, type DiscoveredField } from "../lib/api.ts";
import { useStudio } from "../lib/studio.tsx";
import {
  Bar,
  ChipToggle,
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
 * Costumes — Austin's wardrobe, one flag per piece.
 *
 * Keys arrive concatenated: `<item>owned` and `<item>equipped`, all booleans
 * (e.g. `bottom_pants_butlerequipped` → item `bottom_pants_butler`, equipped).
 * The `equipped` suffix is checked first because `owned` is a suffix of it in
 * some legacy keys.
 *
 * Everything stages into the shared pending map; the file is only written on
 * Save & Push. Non-boolean or unknown-suffix leaves are never staged.
 */

const PREFIX = "Garment.";
const OWNED_SUFFIX = "owned";
const EQUIPPED_SUFFIX = "equipped";

interface CostumeItem {
  item: string;
  owned?: DiscoveredField;
  equipped?: DiscoveredField;
}

function splitKey(key: string): { item: string; flag: "owned" | "equipped" } | null {
  if (key.endsWith(EQUIPPED_SUFFIX)) {
    return { item: key.slice(0, -EQUIPPED_SUFFIX.length), flag: "equipped" };
  }
  if (key.endsWith(OWNED_SUFFIX)) {
    return { item: key.slice(0, -OWNED_SUFFIX.length), flag: "owned" };
  }
  return null;
}

const isFlagRow = (f: DiscoveredField): boolean =>
  splitKey(f.key) !== null && f.kind === "boolean" && !f.path.endsWith(".t");

function groupItems(rows: DiscoveredField[]): CostumeItem[] {
  const map = new Map<string, CostumeItem>();
  for (const f of rows) {
    const parsed = splitKey(f.key);
    if (!parsed || f.kind !== "boolean" || f.path.endsWith(".t")) continue;
    let it = map.get(parsed.item);
    if (!it) {
      it = { item: parsed.item };
      map.set(parsed.item, it);
    }
    if (parsed.flag === "owned") it.owned = f;
    else it.equipped = f;
  }
  return [...map.values()].sort((a, b) => a.item.localeCompare(b.item));
}

/** Wardrobe emoji heuristic — keyword first, elegant dress as the fallback. */
const costumeEmoji = (name: string): string => {
  const n = name.toLowerCase();
  if (/(pant|trouser|jean|bottom|short)/.test(n)) return "👖";
  if (/(shirt|blouse|top|sweater|hoodie)/.test(n)) return "👕";
  if (/(shoe|boot|sneaker|sandal|foot)/.test(n)) return "👞";
  if (/(tie|suit|bow|butler|jacket|coat|tuxedo)/.test(n)) return "👔";
  if (/(hat|cap|crown|helmet|head)/.test(n)) return "🎩";
  return "👗";
};

const prettyName = (item: string): string => {
  const s = item.replace(/[_.]+/g, " ").trim();
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : item;
};

export function CostumesSection() {
  const { overview, values, pending, setPending, clearPending, pushLog } = useStudio();

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [all, setAll] = useState<DiscoveredField[] | null>(null);
  const [view, setView] = useState<DiscoveredField[]>([]);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [showEquipped, setShowEquipped] = useState(true);

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

  /* ------------------------------------------------------- value plumbing -- */

  const live = (f: DiscoveredField): unknown => {
    const v = values[f.path];
    return v === undefined ? f.value : v;
  };
  const eff = (f: DiscoveredField): unknown => {
    const p = pending.get(f.path);
    return p === undefined ? live(f) : p;
  };
  const stagedOf = (f: DiscoveredField): number | string | boolean | undefined => {
    const p = pending.get(f.path);
    return p !== undefined && p !== live(f) ? p : undefined;
  };
  const stage = (f: DiscoveredField, v: number | string | boolean) => {
    if (v === live(f)) clearPending(f.path);
    else setPending(f.path, v);
  };
  const toggleFlag = (f: DiscoveredField) => stage(f, eff(f) !== true);

  /* --------------------------------------------------------------- derived -- */

  const allRows = all ?? [];
  const needle = debounced.toLowerCase();
  const rows = needle ? view.filter((f) => f.path.toLowerCase().includes(needle)) : view;

  const allItems = groupItems(allRows);
  const items = groupItems(rows);

  const ownedTotal = allItems.filter((i) => i.owned).length;
  const ownedOn = allItems.reduce((n, i) => (i.owned && eff(i.owned) === true ? n + 1 : n), 0);
  const equippedTotal = allItems.filter((i) => i.equipped).length;
  const equippedOn = allItems.reduce((n, i) => (i.equipped && eff(i.equipped) === true ? n + 1 : n), 0);
  const skipped = allRows.length - allRows.filter(isFlagRow).length;
  const stagedKeys = [...pending.keys()].filter((k) => k.startsWith(PREFIX));

  /* ---------------------------------------------------------- bulk actions -- */

  const ownAll = () => {
    let n = 0;
    for (const it of allItems) {
      if (!it.owned || eff(it.owned) === true) continue;
      setPending(it.owned.path, true);
      n++;
    }
    pushLog("info", "👔 Every wardrobe piece owned", `${n} field${n === 1 ? "" : "s"} staged`);
  };

  const unequipAll = () => {
    let n = 0;
    for (const it of allItems) {
      if (!it.equipped || eff(it.equipped) === false) continue;
      setPending(it.equipped.path, false);
      n++;
    }
    pushLog("info", "🧹 Outfit cleared — nothing equipped", `${n} field${n === 1 ? "" : "s"} staged`);
  };

  const clearStaged = () => {
    const n = stagedKeys.length;
    for (const k of stagedKeys) clearPending(k);
    pushLog("info", "✨ Costume staging cleared", `${n} staged edit${n === 1 ? "" : "s"} dropped`);
  };

  /* ------------------------------------------------------------------ view -- */

  const ownedRows = items.filter((i) => i.owned);
  const equippedRows = items.filter((i) => i.equipped);

  return (
    <div className="flex flex-col gap-4">
      <Bar hint="Own pieces, then Save & Push.">
        <SearchBox value={query} onChange={setQuery} placeholder="Search pieces…" />
        <button
          type="button"
          className="preset-pill"
          onClick={ownAll}
          title="Stage every Garment.<item>owned flag to true"
        >
          👔 Own ALL
        </button>
        <button
          type="button"
          className="preset-pill"
          onClick={unequipAll}
          title="Stage every Garment.<item>equipped flag to false"
        >
          🧹 Unequip all
        </button>
        <button
          type="button"
          className="preset-pill"
          aria-pressed={showEquipped}
          onClick={() => setShowEquipped((v) => !v)}
          title="Show or hide the equipped panel"
        >
          {showEquipped ? "🙈 Hide equipped" : "👁 Show equipped"}
        </button>
        {stagedKeys.length > 0 ? (
          <button
            type="button"
            className="preset-pill"
            onClick={clearStaged}
            title="Drop staged Garment edits without touching anything else"
          >
            ✨ Clear staged ({stagedKeys.length})
          </button>
        ) : null}
      </Bar>

      {all === null && !fetchErr ? (
        <Panel title="Reading wardrobe…">
          <div className="flex items-center justify-center gap-3 py-10 text-sm text-ink-3">
            <Spinner />
            <span>Scanning the save for Garment owned / equipped flags…</span>
          </div>
        </Panel>
      ) : all !== null && allRows.length === 0 ? (
        <EmptyState title="No Garment.* fields in this save" />
      ) : all !== null ? (
        <>
          {/* KPI strip */}
          <div className="stagger-in grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiTile
              emoji="👔"
              label="Pieces owned"
              value={`${ownedOn}/${ownedTotal}`}
              title="Garment.<item>owned flags currently true"
            />
            <KpiTile
              emoji="💃"
              label="Equipped"
              value={`${equippedOn}/${equippedTotal}`}
              title="Garment.<item>equipped flags currently true"
            />
            <KpiTile
              emoji="🧺"
              label="Wardrobe pieces"
              value={String(allItems.length)}
              title={`Distinct items under ${PREFIX}`}
            />
            <KpiTile
              emoji="✍️"
              label="Staged edits"
              value={String(stagedKeys.length)}
              title="Garment.* changes waiting for Save & Push"
            />
          </div>

          <div className="stagger-in grid gap-4">
            {/* Owned */}
            <Panel>
              <PanelHead
                tone="cyan"
                icon="👗"
                right={
                  stagedKeys.length > 0 ? (
                    <StateBadge tone="gold">{stagedKeys.length} staged</StateBadge>
                  ) : (
                    <StateBadge tone="ready">{ownedOn} owned</StateBadge>
                  )
                }
              >
                Owned pieces
              </PanelHead>

              {ownedRows.length === 0 ? (
                <EmptyState
                  title={needle ? "No pieces match the search" : "No owned flags present"}
                />
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {ownedRows.map((it) => {
                    const f = it.owned!;
                    const on = eff(f) === true;
                    const staged = stagedOf(f);
                    return (
                      <ChipToggle
                        key={f.path}
                        emoji={costumeEmoji(it.item)}
                        label={`${prettyName(it.item)}${staged !== undefined ? " ✎" : on ? " ✓" : ""}`}
                        checked={on}
                        onChange={() => toggleFlag(f)}
                        title={`${prettyName(it.item)} — ${on ? "owned" : "not owned"}${
                          staged !== undefined ? ` (staged ${String(live(f))} → ${String(staged)})` : ""
                        } · ${f.path}`}
                      />
                    );
                  })}
                </div>
              )}
            </Panel>

            {/* Equipped */}
            {showEquipped ? (
              <Panel>
                <PanelHead
                  tone="gold"
                  icon="🎩"
                  right={
                    equippedOn > 0 ? (
                      <StateBadge tone="ready">{equippedOn} worn</StateBadge>
                    ) : (
                      <StateBadge>nothing worn</StateBadge>
                    )
                  }
                >
                  Equipped
                </PanelHead>

                {equippedRows.length === 0 ? (
                  <EmptyState
                    title={needle ? "No equipped flags match the search" : "No equipped flags present"}
                  />
                ) : (
                  <div className="flex flex-col gap-2">
                    {equippedRows.map((it) => {
                      const f = it.equipped!;
                      const on = eff(f) === true;
                      const staged = stagedOf(f);
                      return (
                        <FeatureRow
                          key={f.path}
                          emoji={costumeEmoji(it.item)}
                          name={prettyName(it.item)}
                          controls={
                            <>
                              <StateBadge tone={on ? "ready" : "neutral"}>
                                {on ? "equipped" : "not worn"}
                              </StateBadge>
                              {staged !== undefined ? <StateBadge tone="gold">staged</StateBadge> : null}
                              <button
                                type="button"
                                className="preset-pill"
                                aria-pressed={on}
                                onClick={() => toggleFlag(f)}
                                title={`${on ? "Remove" : "Equip"} ${prettyName(it.item)}`}
                              >
                                {on ? "Remove" : "Equip"}
                              </button>
                            </>
                          }
                        />
                      );
                    })}
                  </div>
                )}
              </Panel>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
