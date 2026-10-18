import { useEffect, useMemo, useState } from "react";
import { AmActions } from "./AmActions.tsx";
import { AmBar, AmCheck, AmEmpty, useToast } from "../components/ui.tsx";
import { useStudio } from "../lib/studio.tsx";
import { api, type DiscoveredField } from "../lib/api.ts";

/**
 * Pets — every companion animal, each one a tickable unlock.
 *
 * A pet is a real inventory item in the save: `PlayerItems.GivingPet<Name>`
 * holds `1` while the animal is owned (the rich reference save carries 32 of
 * them). Ticking a pet stages that item to 1, untick stages 0 — the same
 * field the game itself writes when a pet is granted, which is why an
 * unlocked pet shows up roaming the home.
 *
 * The catalogue below is the full set of ids found in the reference save, so
 * pets the *current* account is missing are still offered as a tick. Where a
 * pet already exists in the loaded save its live value drives the checkbox;
 * otherwise the built-in catalogue fills the gap.
 */
const PREFIX = "PlayerItems.GivingPet";

interface PetDef {
  id: string;
  name: string;
  /** A short flavour tag so the wall of buttons is scannable. */
  tag: string;
}

const CATALOG: PetDef[] = [
  { id: "Corgi", name: "Corgi", tag: "dog" },
  { id: "Dog1", name: "Dog", tag: "dog" },
  { id: "BlackCat", name: "Black Cat", tag: "cat" },
  { id: "SiameseCat", name: "Siamese Cat", tag: "cat" },
  { id: "CatSSP", name: "Cat", tag: "cat" },
  { id: "Fox", name: "Fox", tag: "wild" },
  { id: "Monkey", name: "Monkey", tag: "wild" },
  { id: "KoalaSSP", name: "Koala", tag: "wild" },
  { id: "LionSSP", name: "Lion", tag: "wild" },
  { id: "RaccoonSSP", name: "Raccoon", tag: "wild" },
  { id: "Penguin", name: "Penguin", tag: "bird" },
  { id: "PenguinSuit", name: "Penguin (suit)", tag: "bird" },
  { id: "ParrotSSP", name: "Parrot", tag: "bird" },
  { id: "OwlSSP", name: "Owl", tag: "bird" },
  { id: "OwlSSPSuit", name: "Owl (suit)", tag: "bird" },
  { id: "Rabbit1", name: "Rabbit 1", tag: "bunny" },
  { id: "Rabbit2", name: "Rabbit 2", tag: "bunny" },
  { id: "Rabbit3", name: "Rabbit 3", tag: "bunny" },
  { id: "RabbitSSP", name: "Rabbit", tag: "bunny" },
  { id: "MiniPig", name: "Mini Pig", tag: "farm" },
  { id: "MiniPig2", name: "Mini Pig 2", tag: "farm" },
  { id: "PigSSP", name: "Pig", tag: "farm" },
  { id: "AlpacaSSP", name: "Alpaca", tag: "farm" },
  { id: "AlpacasSSP", name: "Alpacas", tag: "farm" },
  { id: "AlpacaMomSSP", name: "Alpaca Mom", tag: "farm" },
  { id: "Robot1", name: "Robot 1", tag: "robot" },
  { id: "Robot2", name: "Robot 2", tag: "robot" },
  { id: "Robot3", name: "Robot 3", tag: "robot" },
  { id: "DroneStage1", name: "Drone (stage 1)", tag: "drone" },
  { id: "DroneStage2", name: "Drone (stage 2)", tag: "drone" },
  { id: "GhostStage1", name: "Ghost (stage 1)", tag: "spooky" },
  { id: "Ship1", name: "Ship", tag: "vehicle" },
];

function Head({ title }: { title: string }) {
  return (
    <div className="am-panel-head">
      <img src="assets/ui/panel-bars.png" alt="" />
      <h2 className="am-panel-title">{title}</h2>
    </div>
  );
}

export function PetsSection() {
  const { overview, values, pending, setPending, clearPending, pushLog } = useStudio();
  const toast = useToast();

  const [found, setFound] = useState<DiscoveredField[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!overview) {
      setFound([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .discover(PREFIX, undefined, 400)
      .then((f) => {
        if (!cancelled) setFound(f);
      })
      .catch(() => {
        if (!cancelled) setFound([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [overview]);

  /** live value of a pet item: staged edit wins, then the save, then absent. */
  const liveOf = (id: string): unknown => {
    const path = `${PREFIX}${id}`;
    if (pending.has(path)) return pending.get(path);
    if (values[path] !== undefined) return values[path];
    const f = found.find((x) => x.path === path);
    return f ? f.value : undefined;
  };

  const inSave = useMemo(() => new Set(found.map((f) => f.path)), [found]);

  const rows = useMemo(() => {
    // bring in any pet the save carries that the catalogue does not know,
    // so a future animal is never invisible.
    const extra: PetDef[] = [];
    for (const f of found) {
      if (f.path.endsWith("AmountStartTime")) continue;
      const id = f.path.slice(PREFIX.length);
      if (id && !CATALOG.some((p) => p.id === id)) extra.push({ id, name: id, tag: "other" });
    }
    return [...CATALOG, ...extra];
  }, [found]);

  const isOwned = (id: string): boolean => {
    const v = liveOf(id);
    return v === 1 || v === true || (typeof v === "number" && v > 0);
  };

  const ownedIds = useMemo(() => rows.filter((p) => isOwned(p.id)).map((p) => p.id), [rows, pending, values, found]);

  const toggle = (p: PetDef) => {
    const path = `${PREFIX}${p.id}`;
    const next = isOwned(p.id) ? 0 : 1;
    setPending(path, next);
    // A fresh unlock gets a matching start stamp, like the game writes.
    if (next === 1) setPending(`${path}AmountStartTime`, Math.floor(Date.now() / 1000));
  };

  const setAll = (on: boolean) => {
    const now = Math.floor(Date.now() / 1000);
    for (const p of rows) {
      setPending(`${PREFIX}${p.id}`, on ? 1 : 0);
      if (on) setPending(`${PREFIX}${p.id}AmountStartTime`, now);
    }
    pushLog(
      "info",
      on ? "Unlock all pets staged" : "Lock all pets staged",
      `${rows.length} animal${rows.length === 1 ? "" : "s"} — press Save, then Push`,
    );
  };

  const clearStaged = () => {
    const keys = [...pending.keys()].filter((k) => k.startsWith(PREFIX));
    for (const k of keys) clearPending(k);
    pushLog("info", "Clear staged pet edits", `${keys.length} field${keys.length === 1 ? "" : "s"} cleared`);
  };

  const stagedCount = [...pending.keys()].filter((k) => k.startsWith(PREFIX) && !k.endsWith("AmountStartTime")).length;

  if (!overview) {
    return (
      <section className="am-panel">
        <Head title="Pets" />
        <AmEmpty
          title="No save loaded"
          detail="Press Connect in the title bar to read your client's live game."
        />
      </section>
    );
  }

  return (
    <section className="am-panel">
      <Head title="Pets" />

      <div className="am-hint" style={{ margin: "8px 0 12px", lineHeight: 1.5 }}>
        Tick an animal to unlock it, untick to remove it. Each tick writes the real
        <code> {PREFIX}&lt;Name&gt;</code> inventory item the game uses, so an unlocked pet appears
        in the home exactly as a granted one does.
      </div>

      <AmBar
        count={ownedIds.length}
        total={rows.length}
        onAll={() => setAll(true)}
        onNone={() => setAll(false)}
        hint={`${inSave.size ? inSave.size : 0} present in this save`}
      />

      {stagedCount > 0 ? (
        <div className="am-row" style={{ margin: "10px 0" }}>
          <button type="button" className="am-ghost" onClick={clearStaged}>
            Revert staged ({stagedCount})
          </button>
        </div>
      ) : null}

      {loading && found.length === 0 ? (
        <div className="am-empty">
          <div className="am-empty-title">Loading…</div>
          <div className="am-empty-detail">Reading {PREFIX}* …</div>
        </div>
      ) : (
        <div className="am-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 8 }}>
          {rows.map((p) => {
            const owned = isOwned(p.id);
            const staged = pending.has(`${PREFIX}${p.id}`);
            return (
              <div
                key={p.id}
                className="am-checkrow"
                style={{
                  padding: "9px 11px",
                  border: "1px solid rgba(30,90,180,0.15)",
                  borderRadius: 10,
                  background: owned ? "rgba(45,120,235,0.06)" : "transparent",
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                }}
              >
                <AmCheck
                  on={owned}
                  onChange={() => toggle(p)}
                  label={
                    <>
                      {p.name}
                      <span className="am-hint" style={{ marginLeft: 6 }}>
                        {p.tag}
                      </span>
                    </>
                  }
                  title={`${owned ? "Owned" : "Not owned"} — ${PREFIX}${p.id}`}
                />
                {staged ? <span className="am-staged">staged</span> : null}
              </div>
            );
          })}
        </div>
      )}

      <AmActions />
    </section>
  );
}
