import { useCallback, useEffect, useState } from "react";
import { AmActions } from "./AmActions.tsx";
import { AmBar, AmCheck, AmEmpty, useToast } from "../components/ui.tsx";
import { useStudio } from "../lib/studio.tsx";
import {
  api,
  type CosmeticGroupInfo,
  type CosmeticsState,
} from "../lib/api.ts";

/**
 * One cosmetics tab (frames / styles / badges).
 *
 * Mirrors the legacy CosmeticsSection: the catalog comes from
 * GET /api/cosmetics/catalog (whose groups are built in engine/cosmetics.ts,
 * so the kind strings are the server's own `"frames" | "styles" | "badges"`),
 * ownership/equipped state from GET /api/cosmetics/state, and every change
 * goes through POST /api/cosmetics — a merge-safe operation that unions into
 * the save's ownership lists and never clobbers what the save already has.
 *
 * Staging is local (grant / equip selections in useState) until Save runs
 * `api.cosmeticsApply` inside `onSave`.
 */

/** Ids the game grants to every account; always rendered as owned. */
const BASELINE: Record<string, readonly string[]> = {
  frames: ["default", "blue", "orange", "red"],
  styles: ["default"],
};

const KIND_TITLE: Record<string, string> = {
  frames: "Frames",
  styles: "Name styles",
  badges: "Badges",
};

/** Catalog is session-independent — cache it for the whole tab lifetime. */
let catalogCache: Promise<CosmeticGroupInfo[]> | null = null;
function loadCatalog(): Promise<CosmeticGroupInfo[]> {
  if (!catalogCache) {
    catalogCache = api.cosmeticsCatalog().catch((err: unknown) => {
      catalogCache = null;
      throw err;
    });
  }
  return catalogCache;
}

export function CosmeticsKindSection({ kind }: { kind: string }) {
  const { overview } = useStudio();
  const toast = useToast();
  const sessionId = overview?.meta.id;

  const [catalog, setCatalog] = useState<CosmeticGroupInfo[] | null>(null);
  const [state, setState] = useState<CosmeticsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [grantStaged, setGrantStaged] = useState<string[]>([]);
  const [equipStaged, setEquipStaged] = useState<string | undefined>(undefined);

  const refreshState = useCallback(async () => {
    try {
      setState(await api.cosmeticsState(sessionId));
    } catch {
      // A failed refresh keeps the already-rendered grid; Save already reported
      // the apply result, so no extra alarm is warranted here.
    }
  }, [sessionId]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const [cats, st] = await Promise.all([loadCatalog(), api.cosmeticsState(sessionId)]);
        if (!alive) return;
        setCatalog(cats);
        setState(st);
        setFetchErr(null);
      } catch (err) {
        if (!alive) return;
        const msg = err instanceof Error ? err.message : String(err);
        setFetchErr(msg);
        toast.err("Cannot load cosmetics", msg);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessionId, toast]);

  /* -------------------------------------------------------------- derived -- */

  const group = catalog?.find((g) => g.kind === kind) ?? null;
  const title = group?.label ?? KIND_TITLE[kind] ?? kind;

  /** Live ownership (baseline + save list) — staging can only ADD to this. */
  const ownedIds = new Set<string>(BASELINE[kind] ?? []);
  for (const id of state?.[kind]?.owned ?? []) ownedIds.add(id);

  /** What the save will own once staged grants are saved. */
  const effectiveOwned = new Set<string>(ownedIds);
  for (const id of grantStaged) effectiveOwned.add(id);

  const liveEquipped = state?.[kind]?.equipped ?? null;
  const effEquipped = equipStaged ?? liveEquipped;

  const stageGrantAll = () => {
    if (!group) return;
    const missing = group.items.map((it) => it.id).filter((id) => !effectiveOwned.has(id));
    if (missing.length === 0) return;
    setGrantStaged((s) => [...new Set([...s, ...missing])]);
  };

  const toggleGrant = (id: string) => {
    if (grantStaged.includes(id)) {
      setGrantStaged((s) => s.filter((x) => x !== id));
      return;
    }
    if (ownedIds.has(id)) {
      toast.info(
        "Already owned",
        "Ownership lists only merge in this tool — items you already own are never removed.",
      );
      return;
    }
    setGrantStaged((s) => [...s, id]);
  };

  const stageEquip = (id: string) => {
    setEquipStaged(id);
    // The picker only offers owned items — stage the unlock too (grant first).
    if (!ownedIds.has(id)) setGrantStaged((s) => [...new Set([...s, id])]);
  };

  /* ---------------------------------------------------------------- save -- */

  const apply = async (): Promise<boolean> => {
    if (!group) {
      toast.err("Cosmetics unavailable", `The server catalog has no group with kind "${kind}".`);
      return false;
    }
    const grant = grantStaged.length > 0 ? { [kind]: grantStaged } : undefined;
    const equip =
      equipStaged !== undefined && equipStaged !== liveEquipped ? { [kind]: equipStaged } : undefined;

    if (!grant && !equip) {
      toast.info("Nothing to save", "No unlock or equip change is staged on this tab.");
      return true;
    }

    try {
      const r = await api.cosmeticsApply({
        sessionId,
        ...(grant ? { grant } : {}),
        ...(equip ? { equip } : {}),
      });
      if (!r.ok) {
        toast.err("Cosmetics apply failed", r.errors.join("; ") || "unknown error");
        return false;
      }
      toast.ok(
        "Cosmetics applied",
        `${r.summary.length} edit${r.summary.length === 1 ? "" : "s"} · ` +
          `${r.inputBytes} → ${r.outputBytes} bytes`,
      );
      setGrantStaged([]);
      setEquipStaged(undefined);
      await refreshState();
      return true;
    } catch (err) {
      toast.err("Cosmetics apply failed", err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  /* -------------------------------------------------------------- render -- */

  if (!overview) {
    return (
      <section className="am-panel">
        <Head title={title} />
        <AmEmpty
          title="No save loaded"
          detail="Press Connect in the title bar to read your client's live game."
        />
      </section>
    );
  }

  return (
    <section className="am-panel">
      <Head title={title} />

      {fetchErr ? (
        <AmEmpty title="Cosmetics unavailable" detail={fetchErr} />
      ) : loading && (!catalog || !state) ? (
        <div className="am-empty">
          <div className="am-empty-title">Loading…</div>
          <div className="am-empty-detail">Reading the cosmetics catalog and ownership state…</div>
        </div>
      ) : !group || !state ? (
        <AmEmpty
          title="No such cosmetics group"
          detail={`The server catalog has no group with kind "${kind}". This tab only offers kinds the catalog serves (frames / styles / badges).`}
        />
      ) : (
        <>
          <div style={{ marginTop: 4 }}>
            <AmBar
              count={group.items.filter((it) => effectiveOwned.has(it.id)).length}
              total={group.items.length}
              onAll={stageGrantAll}
              onNone={() => setGrantStaged([])}
            />
          </div>

          <div style={{ marginTop: 6 }}>
            {group.items.map((it) => {
              const staged = grantStaged.includes(it.id);
              const owned = ownedIds.has(it.id);
              const equipped = effEquipped === it.id;
              return (
                <div className="am-checkrow am-checkrow--cos" key={it.id}>
                  {it.icon ? (
                    <img className="am-cos-tile" src={it.icon} alt="" />
                  ) : it.swatch ? (
                    // The basic frames are named for the colour they render, so
                    // showing that colour is the item itself, not stand-in art.
                    <div
                      className="am-cos-tile am-cos-tile--swatch"
                      style={{ background: it.swatch }}
                      aria-hidden="true"
                    />
                  ) : (
                    // No client art exists for this id. Dashed border + monogram
                    // marks the tile as a placeholder so it is never mistaken
                    // for the game's own icon.
                    <div
                      className="am-cos-tile am-cos-tile--noart"
                      title="No client art shipped for this id"
                      aria-hidden="true"
                    >
                      <span>{it.mono ?? "—"}</span>
                    </div>
                  )}
                  <div className="am-cos-body">
                    <AmCheck
                      on={effectiveOwned.has(it.id)}
                      onChange={() => toggleGrant(it.id)}
                      label={
                        <>
                          {it.label}
                          {staged ? (
                            <span className="am-staged" style={{ marginLeft: 8 }}>
                              staged
                            </span>
                          ) : null}
                        </>
                      }
                      title={
                        owned
                          ? "Owned by this save — ownership cannot be removed here"
                          : staged
                            ? "Unlock staged — click to drop it"
                            : "Click to stage an unlock"
                      }
                    />
                  </div>
                  <button
                    type="button"
                    className={
                      equipped ? "am-ghost am-ghost--primary am-equip" : "am-ghost am-equip"
                    }
                    aria-pressed={equipped}
                    title={
                      equipped
                        ? "Currently equipped — clicking stages nothing"
                        : owned
                          ? "Equip this item"
                          : "Equip and stage its unlock"
                    }
                    onClick={() => {
                      if (equipped) {
                        toast.info("Already equipped", `${it.label} is the active choice.`);
                        return;
                      }
                      stageEquip(it.id);
                    }}
                  >
                    Equip
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      <AmActions onSave={apply} />
    </section>
  );
}

function Head({ title }: { title: string }) {
  return (
    <div className="am-panel-head">
      <img src="assets/ui/panel-bars.png" alt="" />
      <h2 className="am-panel-title">{title}</h2>
    </div>
  );
}
