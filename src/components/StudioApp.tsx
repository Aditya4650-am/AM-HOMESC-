import { useEffect, useRef, useState, type CSSProperties } from "react";
import { StudioProvider, useStudio, type SectionId } from "../lib/studio.tsx";
import { ToastProvider, AmEmpty, useToast } from "./ui.tsx";
import { LockScreen } from "../sections/LockScreen.tsx";
import { api, downloadSave, type LicenseSnap } from "../lib/api.ts";
import { DashboardSection } from "../sections/DashboardSection.tsx";
import { StatsSection } from "../sections/StatsSection.tsx";
import { CardsSection } from "../sections/CardsSection.tsx";
import { AvatarsSection } from "../sections/AvatarsSection.tsx";
import { CosmeticsKindSection } from "../sections/CosmeticsKindSection.tsx";
import { DecorationsSection } from "../sections/DecorationsSection.tsx";
import { HomePassSection } from "../sections/HomePassSection.tsx";
import { FreshStartSection } from "../sections/FreshStartSection.tsx";
import { HomeCloneSection } from "../sections/HomeCloneSection.tsx";
import { OwnerSection } from "../sections/OwnerSection.tsx";
import { PetsSection } from "../sections/PetsSection.tsx";
import { CoreSection } from "../sections/CoreSection.tsx";
import { CurrenciesSection } from "../sections/CurrenciesSection.tsx";
import { ItemsSection } from "../sections/ItemsSection.tsx";
import { QuestsSection } from "../sections/QuestsSection.tsx";
import { RoomsSection } from "../sections/RoomsSection.tsx";
import { CollectionsSection } from "../sections/CollectionsSection.tsx";
import { CostumesSection } from "../sections/CostumesSection.tsx";
import { EventsSection } from "../sections/EventsSection.tsx";
import { Match3Section } from "../sections/Match3Section.tsx";
import { ExplorerSection } from "../sections/ExplorerSection.tsx";
import { CosmeticsSection } from "../sections/CosmeticsSection.tsx";
import { ReviewSection } from "../sections/ReviewSection.tsx";

/**
 * AM TECH Homescapes Tool — exact recreation of the supplied 1536×1024
 * dashboard screenshot, with all supported tabs integrated into the same
 * shell: title bar (brand · window controls · device picker · Connect · Push),
 * sidebar (nav entries + separator + artwork), banner, three pill tabs and one
 * panel that swaps content per tab.
 *
 * The flow mirrors the main IGG tool: pick the instance, press Connect to read
 * that client's live save, edit in any tab, then press Push & Launch — the
 * save is written back and the game is reopened on the new data. Every control
 * is real; the window controls perform honest in-app minimize / maximize /
 * close (a browser cannot control the OS window).
 */

export function StudioApp() {
  const [license, setLicense] = useState<LicenseSnap | null>(null);
  return (
    <ToastProvider>
      {license ? (
        <StudioProvider>
          <Shell owner={license.owner} />
        </StudioProvider>
      ) : (
        <LockScreen onUnlocked={setLicense} />
      )}
    </ToastProvider>
  );
}

type WinState = "max" | "windowed" | "min" | "closed";

interface NavDef {
  id: SectionId;
  label: string;
  icon: string;
}

const NAV_MAIN: NavDef[] = [
  { id: "dashboard", label: "Dashboard", icon: "assets/ui/nav-home.png" },
  { id: "stats", label: "Stats", icon: "assets/ui/nav-stats.png" },
  { id: "cards", label: "Cards", icon: "assets/ui/nav-cards.png" },
];

/**
 * Every section the engine can drive is reachable from here.
 *
 * This sidebar used to list 12 entries while `src/sections/` held 24 complete
 * tabs — currencies, items, quests, rooms, collections, costumes, events,
 * match-3, explorer, boosters, lives, cosmetics and the review screen were
 * all written, typechecked and never mounted. They are grouped and rendered as
 * a two-column grid so the whole tool fits without hunting below the fold.
 */
interface NavGroup {
  title: string;
  items: NavDef[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: "Content",
    items: [
      { id: "currencies", label: "Currencies", icon: "gi/Coins.webp" },
      { id: "items", label: "Items", icon: "gi/Chest.webp" },
      { id: "quests", label: "Quests", icon: "gi/Gold_Medal.webp" },
      { id: "rooms", label: "Rooms", icon: "gi/rm/Bedroom.png" },
      { id: "collections", label: "Collections", icon: "gi/ui/Cards2.png" },
      { id: "costumes", label: "Costumes", icon: "gi/ch/Characters.webp" },
      { id: "events", label: "Events", icon: "gi/ev/Tickets.webp" },
      { id: "match3", label: "Match 3", icon: "gi/Rocket.webp" },
      { id: "explorer", label: "Explorer", icon: "gi/ui/Mansion_Rooms.png" },
      { id: "pets", label: "Pets", icon: "assets/ui/nav-badges.png" },
    ],
  },
  {
    title: "Boosters",
    items: [
      { id: "boosters", label: "Boosters", icon: "gi/Hammer.webp" },
      { id: "lives", label: "Lives", icon: "gi/Unlimited_Lives.webp" },
    ],
  },
  {
    title: "Customise",
    items: [
      { id: "frames", label: "Frames", icon: "assets/ui/nav-frames.png" },
      { id: "styles", label: "Styles", icon: "assets/ui/nav-styles.png" },
      { id: "badges", label: "Badges", icon: "assets/ui/nav-badges.png" },
      { id: "avatars", label: "Avatars", icon: "pp/PP_Austin_Nursery.webp" },
      { id: "decorations", label: "Decorations", icon: "assets/ui/nav-decor.png" },
      { id: "cosmetics", label: "All cosmetics", icon: "gi/ui/Badge-picture-1.png" },
    ],
  },
  {
    title: "Tools",
    items: [
      { id: "homepass", label: "Home Pass", icon: "assets/ui/nav-homepass.png" },
      { id: "freshstart", label: "Fresh Start", icon: "assets/ui/nav-stats.png" },
      { id: "homeclone", label: "IGG Account", icon: "assets/ui/nav-home.png" },
      { id: "review", label: "Review", icon: "assets/ui/save-glyph.png" },
      { id: "owner", label: "Owner", icon: "assets/ui/nav-badges.png" },
    ],
  },
];

interface PillDef {
  id: SectionId;
  label: string;
  icon: string;
  /** Exact pill width measured from the reference screenshot. */
  width: string;
}

const PILLS: PillDef[] = [
  { id: "dashboard", label: "Dashboard", icon: "assets/ui/nav-home.png", width: "229px" },
  { id: "stats", label: "Stats", icon: "assets/ui/nav-stats.png", width: "195px" },
  { id: "cards", label: "Cards", icon: "assets/ui/nav-cards.png", width: "217px" },
];

function Shell({ owner }: { owner: boolean }) {
  const {
    loading,
    overview,
    bootError,
    section,
    setSection,
    devices,
    serial,
    setSerial,
    refreshDevices,
    values,
    deviceSerial,
    connect,
    connecting,
    openSaveFile,
    openingFile,
    push,
    pushing,
  } = useStudio();
  const [win, setWin] = useState<WinState>("max");
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useToast();

  useEffect(() => {
    void refreshDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (win === "closed") {
    return (
      <div className="am-winpanel">
        <img src="assets/ui/app-icon.png" alt="" />
        <div className="am-winpanel-title">AM TECH Homescapes Tool is closed</div>
        <div className="am-winpanel-detail">
          The session is still on the server — reopen the tool to keep editing.
        </div>
        <button type="button" className="am-ghost am-ghost--primary" onClick={() => setWin("max")}>
          Reopen tool
        </button>
      </div>
    );
  }

  if (win === "min") {
    return (
      <>
        <div className="am-desktop am-desktop--on" />
        <div className="am-taskbar">
          <img src="assets/ui/app-icon.png" alt="" />
          <span>AM TECH Homescapes Tool</span>
          <button
            type="button"
            className="am-ghost am-ghost--primary"
            onClick={() => setWin("max")}
          >
            Restore
          </button>
          <button
            type="button"
            className="am-close"
            title="Close"
            aria-label="Close"
            onClick={() => setWin("closed")}
          >
            ×
          </button>
        </div>
      </>
    );
  }

  const deviceList = devices?.devices ?? [];
  const connected = deviceSerial !== null;
  /* Identify WHOSE game is loaded — the pulled client's in-game name + level. */
  const clientName =
    connected && typeof values["Properties.name"] === "string" ? (values["Properties.name"] as string) : null;
  const clientLevel =
    connected && typeof values["Properties.LID_Lvl"] === "number"
      ? (values["Properties.LID_Lvl"] as number)
      : connected && typeof values["Properties.level"] === "number"
        ? (values["Properties.level"] as number)
        : null;
  const statusText = connected
    ? `${clientName ?? "Client game"}${clientLevel !== null ? ` · lvl ${clientLevel}` : ""}`
    : serial
      ? "Not connected"
      : "No device";

  return (
    <div className={win === "windowed" ? "am-desktop am-desktop--on" : "am-desktop"}>
      <div className="am-root">
        {/* ------------------------------------------------------ title bar -- */}
        <header className="am-titlebar">
          <img className="am-tb-icon" src="assets/ui/app-icon.png" alt="" />
          <div className="am-tb-text">
            <div className="am-tb-name">
              <span className="am-accent">Homescapes</span> Tool
            </div>
            <div className="am-tb-sub">Game Data Center</div>
          </div>

          <div className="am-winctl" role="group" aria-label="Window controls">
            <img src="assets/ui/winctl.png" alt="" />
            <button
              type="button"
              className="am-winctl-btn am-winctl-btn--min"
              title="Minimize"
              aria-label="Minimize"
              onClick={() => setWin("min")}
            />
            <button
              type="button"
              className="am-winctl-btn am-winctl-btn--max"
              title={win === "max" ? "Restore" : "Maximize"}
              aria-label="Toggle maximize"
              onClick={() => setWin(win === "max" ? "windowed" : "max")}
            />
            <button
              type="button"
              className="am-winctl-btn am-winctl-btn--close"
              title="Close"
              aria-label="Close"
              onClick={() => setWin("closed")}
            />
          </div>

          <div className="am-tb-right am-tb-right--tools">
            {/*
              Open a save straight from this machine. Without this a hosted
              deployment was unusable: ADB is not reachable from a container, so
              "Connect" could never succeed and no file could be chosen.
            */}
            <input
              ref={fileInput}
              type="file"
              accept=".db,.hscbak,.bak,.bin,application/octet-stream"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void openSaveFile(file);
              }}
            />
            <button
              type="button"
              className="am-ghost"
              onClick={() => fileInput.current?.click()}
              disabled={openingFile}
              title="Open a SaveGame.db from this computer"
            >
              {openingFile ? "Opening…" : "Open save"}
            </button>

            <select
              className="am-select am-select--device"
              value={serial ?? ""}
              onChange={(e) => setSerial(e.target.value || null)}
              title="Which emulator / phone to connect to"
              disabled={deviceList.length === 0}
            >
              {deviceList.length === 0 ? (
                <option value="">No device detected</option>
              ) : (
                deviceList.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))
              )}
            </select>

            <button
              type="button"
              className="am-ghost am-ghost--icon"
              onClick={() => void refreshDevices()}
              title="Rescan for emulators / phones"
              aria-label="Rescan devices"
            >
              ↻
            </button>

            <span
              className={connected ? "am-chip am-chip--static" : "am-chip am-chip--off am-chip--static"}
              title={
                connected
                  ? `Live save loaded from ${deviceSerial}`
                  : "Press Connect to read the client's live game"
              }
            >
              <span className="am-chip-dot" />
              {statusText}
            </span>

            <button
              type="button"
              className="am-ghost am-ghost--primary"
              onClick={() => void connect()}
              disabled={connecting || !serial}
              title="Read the client's live save off the device"
            >
              {connecting ? "Connecting…" : connected ? "Reconnect" : "Connect"}
            </button>

            <button
              type="button"
              className="am-ghost"
              onClick={() => void push()}
              disabled={pushing || !serial || !connected}
              title={
                connected
                  ? "Write the save to the device and open the game"
                  : "Press Connect first to read the client's live save"
              }
            >
              {pushing ? "Pushing…" : "Push & Launch"}
            </button>
          </div>
        </header>

        {/* ----------------------------------------------------- body/shell -- */}
        <div className="am-body">
          <aside className="am-sidebar">
            <button
              type="button"
              className="am-logo"
              title="Go to Dashboard"
              onClick={() => setSection("dashboard")}
            >
              <img src="assets/ui/logo.png" alt="AM TECH Homescapes Tool" />
            </button>

            <nav className="am-nav" aria-label="Primary">
              {NAV_MAIN.map((n) => (
                <NavItem key={n.id} def={n} />
              ))}
            </nav>

            <div className="am-sep" />

            {NAV_GROUPS.map((group) => {
              const items = group.items.filter((n) => n.id !== "owner" || owner);
              if (items.length === 0) return null;
              return (
                <section className="am-navgroup" key={group.title} aria-label={group.title}>
                  <h2 className="am-navgroup-title">{group.title}</h2>
                  <nav className="am-nav am-nav--grid">
                    {items.map((n) => (
                      <NavItem key={n.id} def={n} />
                    ))}
                  </nav>
                </section>
              );
            })}

            <img className="am-art" src="assets/ui/art.png" alt="" />
          </aside>

          <div className="am-main">
            <img
              className="am-banner"
              src="assets/ui/banner.png"
              alt="Homescapes — House of the Week"
            />

            <div className="am-pills" role="tablist" aria-label="Sections">
              {PILLS.map((p) => {
                const active = section === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`am-pill${active ? " am-pill--active" : ""}`}
                    style={{ "--pw": p.width } as CSSProperties}
                    onClick={() => setSection(p.id)}
                  >
                    <img src={p.icon} alt="" />
                    <span>{p.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="am-content">
              {bootError ? (
                <AmEmpty
                  title="Cannot reach the studio server"
                  detail={`${bootError} — start it with "npm run server", then reload the page.`}
                />
              ) : loading && !overview ? (
                <div className="am-empty">
                  <div className="am-empty-title">Loading session…</div>
                  <div className="am-empty-detail">Reading overview and live field values.</div>
                </div>
              ) : (
                /* Keep <Content /> mounted through a RELOAD (loading && overview):
                   unmounting it here tore down every section's local state — mode,
                   set filter, ticked cards, the delivery dialog — on each refresh,
                   so a send that awaited reload() finished into a dead component. */
                <Content />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- sidebar -- */

function NavItem({ def }: { def: NavDef }) {
  const { section, setSection } = useStudio();
  const active = section === def.id;
  return (
    <button
      type="button"
      className={`am-item${active ? " am-item--active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={() => setSection(def.id)}
    >
      <span className="am-item-icon">
        <img src={def.icon} alt="" />
      </span>
      <span className="am-item-label">{def.label}</span>
    </button>
  );
}

/* ---------------------------------------------------------------- content -- */

function Content() {
  const { section } = useStudio();
  switch (section) {
    case "currencies":
      return <CurrenciesSection />;
    case "items":
      return <ItemsSection />;
    case "quests":
      return <QuestsSection />;
    case "rooms":
      return <RoomsSection />;
    case "collections":
      return <CollectionsSection />;
    case "costumes":
      return <CostumesSection />;
    case "events":
      return <EventsSection />;
    case "match3":
      return <Match3Section />;
    case "explorer":
      return <ExplorerSection sectionId="explorer" />;
    case "boosters":
      return <CoreSection groupId="boosters" />;
    case "lives":
      return <CoreSection groupId="lives" />;
    case "core":
      return <CoreSection groupId="core" />;
    case "cosmetics":
      return <CosmeticsSection />;
    case "review":
      return <ReviewSection />;
    case "stats":
      return <StatsSection />;
    case "cards":
      return <CardsSection />;
    case "frames":
      return <CosmeticsKindSection kind="frames" />;
    case "styles":
      return <CosmeticsKindSection kind="styles" />;
    case "badges":
      return <CosmeticsKindSection kind="badges" />;
    case "avatars":
      return <AvatarsSection />;
    case "decorations":
      return <DecorationsSection />;
    case "homepass":
      return <HomePassSection />;
    case "freshstart":
      return <FreshStartSection />;
    case "homeclone":
      return <HomeCloneSection />;
    case "pets":
      return <PetsSection />;
    case "owner":
      return <OwnerSection />;
    default:
      return <DashboardSection />;
  }
}
