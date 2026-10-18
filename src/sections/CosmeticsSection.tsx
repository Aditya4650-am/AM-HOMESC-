/**
 * Cosmetics — unlock & equip frames, name styles, badges, titles and avatars.
 *
 * Every change goes through POST /api/cosmetics, which builds merge-safe
 * ops server-side (grant lists union with what the save already owns, a fresh
 * null ProfileData is materialized once with the canonical shape). The client
 * only stages intent, so a double click or a stale grid can never clobber
 * ownership the save already has — proven end-to-end on a live device:
 * grants light up the in-game picker grids, equips render on the profile
 * card, and both survive the server sync (see G:\hs_build\shot-*.png).
 *
 * Baseline items (the four default frames and the default name style) are
 * always visible in the game regardless of ownership, so they render as owned
 * here even when the ownership list is empty.
 */

import { useCallback, useEffect, useState } from "react";
import {
  api,
  type CosmeticGroupInfo,
  type CosmeticsState,
} from "../lib/api.ts";
import { useStudio } from "../lib/studio.tsx";
import { BTN } from "../lib/icons.ts";
import {
  Bar,
  Button,
  EmptyState,
  GameIcon,
  KpiTile,
  Panel,
  PanelHead,
  Spinner,
  StateBadge,
  useToast,
} from "../components/ui.tsx";

/** Ids the game grants to every account; never dimmed in the grid. */
const BASELINE: Record<string, readonly string[]> = {
  frames: ["default", "blue", "orange", "red"],
  styles: ["default"],
};

/** Category emoji + header tone per group kind (unknown kinds stay presentable). */
const KIND_EMOJI: Record<string, string> = {
  frames: "🖼️",
  styles: "🎨",
  badges: "🛡️",
  titles: "🏷️",
  avatars: "🎭",
};
const KIND_TONE: Record<string, "cyan" | "amber" | "gold" | "navy"> = {
  frames: "gold",
  styles: "cyan",
  badges: "amber",
  titles: "navy",
  avatars: "cyan",
};

/** Original game art per category (the emoji stays as the GameIcon fallback). */
const KIND_PIC: Record<string, string> = {
  frames: "/gi/ui/Badge-picture-1.png",
  styles: "/gi/ui/Badge-picture-2.png",
  badges: "/gi/ui/Badge-picture-3.png",
  titles: BTN.cards,
  avatars: "/pp/PP_Austin_Nursery.webp",
};

export function CosmeticsSection() {
  const { overview, reload } = useStudio();
  const toast = useToast();
  const sessionId = overview?.meta.id;

  const [groups, setGroups] = useState<CosmeticGroupInfo[] | null>(null);
  const [state, setState] = useState<CosmeticsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [grantStaged, setGrantStaged] = useState<Record<string, string[]>>({});
  const [equipStaged, setEquipStaged] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cats, st] = await Promise.all([
        api.cosmeticsCatalog(),
        api.cosmeticsState(sessionId),
      ]);
      setGroups(cats);
      setState(st);
    } catch (err) {
      toast.err("Cannot load cosmetics", (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sessionId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const isOwned = (kind: string, id: string): boolean =>
    (BASELINE[kind]?.includes(id) ?? false) || (state?.[kind]?.owned.includes(id) ?? false);

  const stageEquip = (kind: string, id: string) => {
    setEquipStaged((s) => ({ ...s, [kind]: id }));
    if (!isOwned(kind, id)) {
      setGrantStaged((s) => ({ ...s, [kind]: [...new Set([...(s[kind] ?? []), id])] }));
    }
  };

  const stageGrantAll = (g: CosmeticGroupInfo) => {
    const missing = g.items.map((it) => it.id).filter((id) => !isOwned(g.kind, id));
    if (missing.length === 0) return;
    setGrantStaged((s) => ({ ...s, [g.kind]: [...new Set([...(s[g.kind] ?? []), ...missing])] }));
  };

  const unstageGrant = (kind: string, id: string) => {
    setGrantStaged((s) => ({ ...s, [kind]: (s[kind] ?? []).filter((x) => x !== id) }));
  };

  const grantTotal = Object.values(grantStaged).reduce((n, ids) => n + ids.length, 0);
  const equipTotal = Object.keys(equipStaged).length;
  const stagedTotal = grantTotal + equipTotal;

  const apply = async () => {
    setApplying(true);
    try {
      const grant: Record<string, string[]> = {};
      for (const [kind, ids] of Object.entries(grantStaged)) {
        if (ids.length > 0) grant[kind] = ids;
      }
      const r = await api.cosmeticsApply({ sessionId, grant, equip: equipStaged });
      if (!r.ok) {
        toast.err("Cosmetics apply failed", r.errors.join("; ") || "unknown error");
        return;
      }
      toast.ok(
        "Cosmetics applied",
        `${r.summary.length} edit${r.summary.length === 1 ? "" : "s"} · ` +
          `${r.inputBytes} → ${r.outputBytes} bytes`,
      );
      setGrantStaged({});
      setEquipStaged({});
      await load();
      await reload();
    } catch (err) {
      toast.err("Cosmetics apply failed", (err as Error).message);
    } finally {
      setApplying(false);
    }
  };

  if (loading && !groups) {
    return (
      <div className="flex items-center gap-3 text-ink-3">
        <Spinner size={16} />
        <span className="text-sm">Loading cosmetics catalog…</span>
      </div>
    );
  }
  if (!groups || !state) {
    return <EmptyState title="Cosmetics unavailable" detail="The server did not return a catalog." />;
  }

  const ownedIdsOf = (g: CosmeticGroupInfo): Set<string> => {
    const ids = new Set<string>(BASELINE[g.kind] ?? []);
    for (const id of state[g.kind]?.owned ?? []) ids.add(id);
    return ids;
  };
  const ownedTotal = groups.reduce((n, g) => {
    const ids = ownedIdsOf(g);
    return n + g.items.filter((it) => ids.has(it.id)).length;
  }, 0);
  const equippedTotal = groups.filter((g) => state[g.kind]?.equipped).length;

  return (
    <div className="stagger-in flex flex-col gap-5 pb-24">
      <div>
        <h1 className="text-lg font-semibold text-ink">Cosmetics</h1>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-3 gap-3">
        <KpiTile
          emoji="🧸"
          label="Owned items"
          value={ownedTotal.toLocaleString("en-US")}
          title="Baseline items always count as owned"
        />
        <KpiTile
          emoji="👗"
          label="Equipped"
          value={`${equippedTotal} / ${groups.length}`}
          title="One equipped item per group"
        />
        <KpiTile
          emoji="✨"
          label="Staged edits"
          value={stagedTotal.toLocaleString("en-US")}
          title={`${grantTotal} to unlock · ${equipTotal} to equip`}
        />
      </div>

      <Bar hint="Tap a tile to unlock & equip.">
        {stagedTotal > 0 ? (
          <span className="badge-pop inline-flex">
            <StateBadge tone="gold">{stagedTotal} staged</StateBadge>
          </span>
        ) : null}
      </Bar>

      {groups.map((g) => {
        const ownedIds = ownedIdsOf(g);
        return (
          <GroupPanel
            key={g.kind}
            group={g}
            ownedIds={ownedIds}
            equipped={state[g.kind]?.equipped ?? null}
            grantStaged={grantStaged[g.kind] ?? []}
            equipStaged={equipStaged[g.kind]}
            onEquip={stageEquip}
            onGrantAll={stageGrantAll}
            onUnstageGrant={unstageGrant}
          />
        );
      })}

      {stagedTotal > 0 ? (
        <div className="sticky bottom-0 flex items-center justify-between gap-4 rounded-xl border border-gold/25 bg-gold/8 px-5 py-3 backdrop-blur">
          <div className="badge-pop text-[13px] text-gold-2">
            {grantTotal > 0 ? `${grantTotal} to unlock` : null}
            {grantTotal > 0 && equipTotal > 0 ? " · " : null}
            {equipTotal > 0 ? `${equipTotal} to equip` : null}
          </div>
          <div className="flex gap-2">
            <Button
              variant="subtle"
              onClick={() => {
                setGrantStaged({});
                setEquipStaged({});
              }}
            >
              Discard
            </Button>
            <Button variant="gold" loading={applying} onClick={() => void apply()}>
              Apply to save
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GroupPanel({
  group: g,
  ownedIds,
  equipped,
  grantStaged,
  equipStaged,
  onEquip,
  onGrantAll,
  onUnstageGrant,
}: {
  group: CosmeticGroupInfo;
  ownedIds: Set<string>;
  equipped: string | null;
  grantStaged: string[];
  equipStaged: string | undefined;
  onEquip: (kind: string, id: string) => void;
  onGrantAll: (g: CosmeticGroupInfo) => void;
  onUnstageGrant: (kind: string, id: string) => void;
}) {
  const ownedCount = g.items.filter((it) => ownedIds.has(it.id)).length;
  const canUnlockAll = g.items.some((it) => !ownedIds.has(it.id));
  const pic = KIND_PIC[g.kind];

  return (
    <Panel
      title={
        <PanelHead
          tone={KIND_TONE[g.kind] ?? "cyan"}
          icon={
            pic ? (
              <GameIcon src={pic} emoji={KIND_EMOJI[g.kind] ?? "✨"} size={22} className="rounded-lg" />
            ) : (
              KIND_EMOJI[g.kind] ?? "✨"
            )
          }
          right={
            <>
              <StateBadge tone="ready">
                {ownedCount} / {g.items.length} owned
              </StateBadge>
              {equipped ? (
                <span className="badge-pop inline-flex">
                  <StateBadge tone="gold">equipped: {equipped}</StateBadge>
                </span>
              ) : null}
            </>
          }
        >
          {g.label}
        </PanelHead>
      }
      actions={
        canUnlockAll ? (
          <button
            className="preset-pill"
            onClick={() => onGrantAll(g)}
            title={`Stage every unowned ${g.label} item for unlock`}
          >
            ✨ Unlock all
          </button>
        ) : null
      }
    >
      <div
        className={`grid gap-1.5 ${
          g.kind === "avatars"
            ? "max-h-64 grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] overflow-y-auto pr-1"
            : "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        }`}
      >
        {g.items.map((it) => (
          <ItemChip
            key={it.id}
            kind={g.kind}
            id={it.id}
            label={it.label}
            owned={ownedIds.has(it.id)}
            grantStaged={grantStaged.includes(it.id)}
            equipped={equipStaged === it.id}
            isCurrentlyEquipped={equipped === it.id}
            onClick={() => onEquip(g.kind, it.id)}
            onUnstage={() => onUnstageGrant(g.kind, it.id)}
          />
        ))}
      </div>
    </Panel>
  );
}

function ItemChip({
  kind,
  id,
  label,
  owned,
  grantStaged,
  equipped,
  isCurrentlyEquipped,
  onClick,
  onUnstage,
}: {
  kind: string;
  id: string;
  label: string;
  owned: boolean;
  grantStaged: boolean;
  equipped: boolean;
  isCurrentlyEquipped: boolean;
  onClick: () => void;
  onUnstage: () => void;
}) {
  const shown = kind === "avatars" ? `#${id}` : label;
  const active = equipped || isCurrentlyEquipped;
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      title={`${id}${isCurrentlyEquipped ? " (equipped)" : ""}${owned ? "" : " — clicking unlocks + equips"}`}
      className={`inv-chip relative ${
        active
          ? ""
          : grantStaged
            ? "outline-2 outline-dashed outline-gold/60"
            : owned
              ? ""
              : "opacity-60 hover:opacity-100"
      }`}
    >
      <span className="inv-chip__check" aria-hidden>
        ✓
      </span>
      <span className="inv-chip__emoji" aria-hidden>
        {KIND_EMOJI[kind] ?? "✨"}
      </span>
      <span className="inv-chip__label">{shown}</span>
      {grantStaged ? (
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onUnstage();
          }}
          className="badge-pop absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-err text-[10px] text-white"
          title="Remove from unlock list"
        >
          ×
        </span>
      ) : null}
    </button>
  );
}
