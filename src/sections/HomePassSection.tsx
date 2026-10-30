import { MaxGPPanel } from "./MaxGPPanel.tsx";
import { useEffect, useMemo, useState } from "react";
import { AmActions } from "./AmActions.tsx";
import { AmCheck, AmEmpty, useToast } from "../components/ui.tsx";
import { useStudio } from "../lib/studio.tsx";
import { api, type DiscoveredField } from "../lib/api.ts";

/**
 * Home Pass — the season pass held in `SeasonPassInfoCache.*`.
 *
 * Mirrors the legacy EventsSection's season-pass block, which is the source of
 * truth for what this tool supports: `unlockedFree` and `unlockedGold` are
 * staged numeric edits (presets 10 / 31 / 50 / 100 as in the source), and
 * `goldenPassPurchased` is a staged boolean. The reward counters
 * (`collectedFree`, `collectedGold`) and `seasonPassEventId` are never written
 * — the legacy editor never wrote them, so no control is offered.
 */
const SEASON_PREFIX = "SeasonPassInfoCache.";
const PAGE_CAP = 100;

const TIER_PRESETS = [10, 31, 50, 100];

function Head({ title }: { title: string }) {
  return (
    <div className="am-panel-head">
      <img src="assets/ui/panel-bars.png" alt="" />
      <h2 className="am-panel-title">{title}</h2>
    </div>
  );
}

function displayValue(v: unknown): string {
  if (v === null) return "—";
  if (v === undefined) return "—";
  if (typeof v === "string") return v === "" ? '""' : v;
  if (typeof v === "number") return v.toLocaleString("en-US");
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return `${v.length} items`;
  if (typeof v === "object") return `${Object.keys(v as object).length} keys`;
  return String(v);
}

export function HomePassSection() {
  const { overview, values, pending, setPending, clearPending, pushLog } = useStudio();
  const toast = useToast();

  const [season, setSeason] = useState<DiscoveredField[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  useEffect(() => {
    if (!overview) {
      setSeason([]);
      setFetchErr(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .discover(SEASON_PREFIX, undefined, PAGE_CAP)
      .then((f) => {
        if (!cancelled) {
          setSeason(f);
          setFetchErr(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setFetchErr(msg);
          toast.err("Could not read season pass", msg);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [overview, toast]);

  /* -------------------------------------------------------------- lookup -- */

  const find = (name: string): DiscoveredField | null =>
    season.find((f) => f.key === name || f.key.endsWith(`.${name}`)) ?? null;

  const unlockedFree = useMemo(() => find("unlockedFree"), [season]);
  const unlockedGold = useMemo(() => find("unlockedGold"), [season]);
  const golden = useMemo(
    () => season.find((f) => (f.key === "goldenPassPurchased" || f.key.endsWith(".goldenPassPurchased")) && f.kind === "boolean") ?? null,
    [season],
  );

  const liveOf = (f: DiscoveredField | null): unknown => {
    if (!f) return undefined;
    return values[f.path] === undefined ? f.value : values[f.path];
  };

  const stagedKeys = useMemo(
    () => [...pending.keys()].filter((k) => k.startsWith(SEASON_PREFIX)),
    [pending],
  );

  const clearStaged = () => {
    const n = stagedKeys.length;
    for (const k of stagedKeys) clearPending(k);
    pushLog("info", "Clear staged pass edits", `${n} field${n === 1 ? "" : "s"} cleared`);
  };

  const stage = (f: DiscoveredField, next: number | boolean) => {
    const live = liveOf(f);
    if (live === next) clearPending(f.path);
    else setPending(f.path, next);
  };

  const goldenChecked =
    golden !== null && (typeof pending.get(golden.path) === "boolean"
      ? pending.get(golden.path)
      : liveOf(golden)) === true;

  /* ------------------------------------------------------- quick actions -- */

  const FULL_TRACK = 31;

  const stageMaxBothRows = () => {
    const counted = [
      "unlockedFree",
      "unlockedGold",
      "collectedFree",
      "collectedGold",
      "normalRewardsCollectedCount",
      "premiumRewardsCollectedCount",
    ];
    let n = 0;
    for (const name of counted) {
      const f = find(name);
      if (f && typeof liveOf(f) === "number") {
        setPending(f.path, FULL_TRACK);
        n++;
      }
    }
    if (golden) {
      setPending(golden.path, true);
      n++;
    }
    if (n === 0) {
      toast.warn("Nothing to max", "SeasonPassInfoCache.* carries no numeric tier fields here.");
      return;
    }
    pushLog(
      "info",
      "Max both pass rows staged",
      `${n} field${n === 1 ? "" : "s"} — free + gold unlocked to ${FULL_TRACK}, golden flag on`,
    );
    toast.ok("Pass maxed", `Both rows staged to the full ${FULL_TRACK} tiers. Press Save, then Push.`);
  };

  const stageGoldValues = () => {
    let n = 0;
    const coins = values["Properties.coins"];
    if (typeof coins === "number") {
      setPending("Properties.coins", coins + 15000);
      n++;
    }
    const boosters = overview?.catalog.find((g) => g.label === "Boosters");
    if (boosters) {
      for (const f of boosters.fields) {
        const cur = values[f.path];
        if (typeof cur === "number") {
          setPending(f.path, cur + 30);
          n++;
        }
      }
    }
    const lives = values["Properties.lives.current"];
    if (typeof lives === "number") {
      setPending("Properties.lives.current", 8);
      n++;
    }
    if (n === 0) {
      toast.warn("Nothing staged", "Coins, boosters and lives were not found in this save.");
      return;
    }
    pushLog(
      "info",
      "Gold-track values staged",
      `${n} field${n === 1 ? "" : "s"} — coins +15,000, boosters +30 each, lives 8`,
    );
    toast.ok("Gold values staged", `${n} field${n === 1 ? "" : "s"} granted locally. Press Save.`);
  };

  /* -------------------------------------------------------------- render -- */

  if (!overview) {
    return (
      <section className="am-panel">
        <Head title="Home Pass" />
        <AmEmpty
          title="No save loaded"
          detail="Press Connect in the title bar to read your client's live game."
        />
      </section>
    );
  }

  return (
    <section className="am-panel">
      <Head title="Home Pass" />

      <MaxGPPanel />
      <div className="am-label">Legacy pass controls</div>

      {stagedKeys.length > 0 ? (
        <div className="am-row" style={{ margin: "12px 0 14px" }}>
          <button
            type="button"
            className="am-ghost"
            onClick={clearStaged}
            title="Drop staged SeasonPassInfoCache.* edits without touching any other section"
          >
            Revert staged ({stagedKeys.length})
          </button>
        </div>
      ) : null}

      {fetchErr ? (
        <AmEmpty title="Could not read season pass" detail={fetchErr} />
      ) : loading && season.length === 0 ? (
        <div className="am-empty">
          <div className="am-empty-title">Loading…</div>
          <div className="am-empty-detail">Reading SeasonPassInfoCache.* …</div>
        </div>
      ) : season.length === 0 ? (
        <AmEmpty
          title="No season pass in this save"
          detail="SeasonPassInfoCache.* is not present in the loaded save, so there are no pass values to edit."
        />
      ) : (
        <>
          <div className="am-label">Quick actions</div>
          <div className="am-row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
            <button
              type="button"
              className="am-ghost am-ghost--primary"
              onClick={stageMaxBothRows}
              title={`Unlock all ${FULL_TRACK} tiers on the free and gold rows and set the golden flag`}
            >
              Max both rows (up + down)
            </button>
            <button
              type="button"
              className="am-ghost"
              onClick={stageGoldValues}
              title="Grant the gold-track value package locally: coins, boosters and lives"
            >
              Grant gold values
            </button>
          </div>

          <div className="am-label">Tier unlocks</div>
          <div className="am-fieldgrid">
            {unlockedFree ? (
              <TierRow
                key={unlockedFree.path}
                f={unlockedFree}
                label="Unlocked (free track)"
                presets={TIER_PRESETS}
                onStage={stage}
              />
            ) : null}
            {unlockedGold ? (
              <TierRow
                key={unlockedGold.path}
                f={unlockedGold}
                label="Unlocked (gold track)"
                presets={TIER_PRESETS}
                onStage={stage}
              />
            ) : null}
          </div>

          {golden ? (
            <>
              <div className="am-label">Golden pass</div>
              <div className="am-checkrow" style={{ padding: "9px 0" }}>
                <AmCheck
                  on={goldenChecked}
                  onChange={() => stage(golden, !goldenChecked)}
                  label="Golden pass purchased"
                  title={
                    goldenChecked
                      ? "Golden pass is on — click to stage false"
                      : "Stage goldenPassPurchased = true"
                  }
                />
                {pending.get(golden.path) !== undefined ? (
                  <span className="am-staged">staged</span>
                ) : null}
              </div>
            </>
          ) : null}

          <div className="am-hint" style={{ margin: "14px 0 4px", lineHeight: 1.5 }}>
            These legacy controls edit the pass cache and local reward values.
            Use MAX_GP above to update the detected season's Points and Golden Ticket together.
          </div>
        </>
      )}

      <AmActions />
    </section>
  );
}

/* ------------------------------------------------------------- tier row -- */

/** Commit-on-blur tier counter with the legacy presets. */
function TierRow({
  f,
  label,
  presets,
  onStage,
}: {
  f: DiscoveredField;
  label: string;
  presets: number[];
  onStage: (f: DiscoveredField, next: number) => void;
}) {
  const { values, pending } = useStudio();
  const toast = useToast();

  const live = values[f.path] === undefined ? f.value : values[f.path];
  const staged = pending.get(f.path);
  const eff = staged === undefined ? live : staged;
  const isStaged = staged !== undefined && staged !== live;
  const numeric = typeof live === "number";

  const [draft, setDraft] = useState(String(eff ?? ""));
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setDraft(String(eff ?? ""));
  }, [eff, dirty]);

  const commitValue = (n: number) => {
    if (typeof live !== "number") {
      toast.warn("Value not staged", `${label} is not a numeric field in this save.`);
      return;
    }
    if (n !== eff) onStage(f, n);
  };

  const commit = () => {
    const raw = draft.trim();
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n)) {
      toast.warn("Value not staged", `${label} needs a finite number.`);
      setDirty(false);
      setDraft(String(eff ?? ""));
      return;
    }
    setDirty(false);
    commitValue(n);
  };

  if (!numeric) {
    return (
      <div className="am-field">
        <div className="am-field-meta">
          <div className="am-field-label" title={f.path}>
            {label}
          </div>
          <div className="am-field-value">
            <span className="am-hint">{displayValue(eff)} (read-only)</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="am-field">
      <div className="am-field-meta">
        <div className="am-field-label" title={f.path}>
          {label}
        </div>
        <div className="am-field-value" style={{ flexWrap: "wrap" }}>
          <input
            className="am-field-input"
            inputMode="numeric"
            value={draft}
            aria-label={label}
            title={isStaged ? `${String(live)} → ${String(staged)}` : `now ${String(eff ?? "")}`}
            onChange={(e) => {
              setDraft(e.target.value);
              setDirty(true);
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
          />
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              className="am-ghost"
              title={`Stage ${p}${p === 31 ? " — a full pass, 31 tiers" : ""}`}
              onClick={() => {
                setDraft(String(p));
                setDirty(false);
                commitValue(p);
              }}
            >
              {p}
            </button>
          ))}
          {isStaged ? <span className="am-staged">staged</span> : null}
        </div>
      </div>
    </div>
  );
}
