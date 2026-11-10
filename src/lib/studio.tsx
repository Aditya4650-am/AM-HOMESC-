import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  ApiError,
  downloadSave,
  type AdbInfo,
  type ApplyResponse,
  type MaxGPResponse,
  type EditOp,
  type OverviewPayload,
} from "./api.ts";
import { useToast } from "../components/ui.tsx";
import { clearToken } from "./auth-store.ts";

export type SectionId =
  | "dashboard"
  | "stats"
  | "cards"
  | "frames"
  | "styles"
  | "badges"
  | "decorations"
  | "homepass"
  | "devices"
  | "core"
  | "boosters"
  | "lives"
  | "cosmetics"
  | "avatars"
  | "pets"
  | "freshstart"
  | "homeclone"
  | "owner";

/** One line in the sidebar activity log. */
export interface LogEntry {
  id: number;
  tone: "ok" | "warn" | "err" | "info";
  msg: string;
  detail?: string;
  at: string;
}

interface StudioState {
  loading: boolean;
  bootError: string | null;
  overview: OverviewPayload | null;
  /** Live values for the curated catalogue fields (path -> value). */
  values: Record<string, unknown>;
  /** Field edits staged in the browser, keyed by JSON path. */
  pending: Map<string, number | string | boolean>;
  /** Result of the most recent apply, for the audit trail. */
  lastApply: ApplyResponse | null;
  setPending: (path: string, value: number | string | boolean) => void;
  clearPending: (path?: string) => void;
  /** Apply staged edits to the session. Resolves true when every op landed. */
  applyPending: () => Promise<boolean>;
  applying: boolean;
  maxGP: () => Promise<MaxGPResponse | null>;
  resetSession: () => Promise<void>;
  reload: () => Promise<void>;
  section: SectionId;
  setSection: (s: SectionId) => void;
  devices: AdbInfo | null;
  devicesLoading: boolean;
  refreshDevices: () => Promise<void>;
  serial: string | null;
  setSerial: (s: string | null) => void;
  /** Which device the ACTIVE session was pulled from (null = local file). */
  deviceSerial: string | null;
  setDeviceSerial: (s: string | null) => void;
  /**
   * The one button that matters: read the client's live save off the selected
   * device and make it the session every tab edits.
   */
  connect: () => Promise<void>;
  connecting: boolean;
  /**
   * Open a `SaveGame.db` from this machine. This is how a save enters a HOSTED
   * deployment (a container has no ADB), and it is also the fastest path for a
   * client who already has a pulled save.
   */
  /** Write the session back to the device and relaunch the game. */
  push: () => Promise<void>;
  pushing: boolean;
  /**
   * Register (or clear with `null`) the active section's own save callback so
   * the shared `push()` can flush it first. Sections with local-only staged
   * state (cosmetics grant/equip) call this on mount and clear it on unmount.
   */
  setSectionSave: (fn: (() => Promise<boolean>) | null) => void;
  /** Activity log, newest first. */
  log: LogEntry[];
  pushLog: (tone: LogEntry["tone"], msg: string, detail?: string) => void;
}

const Ctx = createContext<StudioState | null>(null);

let logSeq = 0;

// Native bridge — available when running inside the desktop EXE (pywebview).
// When present, ADB operations happen locally; otherwise we fall back to the
// server-side HTTP API (works only when the server can reach adb).
function nativeBridge(): {
  devices: () => Promise<{ id: string; label: string }[]>;
  pull: (serial: string) => Promise<{ ok: boolean; b64: string; file: string; package: string }>;
  push: (serial: string, b64: string, options?: { restart?: boolean }) => Promise<{ ok: boolean; error?: string; toolBackup?: string }>;
  /** The packaged EXE version, compared against the server's release. */
  version: () => string;
  /** Download a verified release and swap the running EXE in place. */
  installUpdate: (
    release: { version: string; downloadUrl: string; sha256: string },
  ) => Promise<{ ok: boolean; reason?: string; version?: string }>;
} | undefined {
  return (window as unknown as { hcNative?: any }).hcNative;
}

/** Numeric-aware version compare: "0.2.0" > "0.10.0" is false, etc. */
function compareVersions(a: string, b: string): number {
  const pa = (a || "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = (b || "").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function useStudio(): StudioState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStudio must be used inside <StudioProvider>");
  return ctx;
}

export function StudioProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [overview, setOverview] = useState<OverviewPayload | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [pending, setPendingMap] = useState<Map<string, number | string | boolean>>(new Map());
  const [lastApply, setLastApply] = useState<ApplyResponse | null>(null);
  const [applying, setApplying] = useState(false);
  const [section, setSection] = useState<SectionId>("dashboard");
  const [devices, setDevices] = useState<AdbInfo | null>(null);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [serial, setSerial] = useState<string | null>(null);
  const [deviceSerial, setDeviceSerial] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);

  const pushLog = useCallback((tone: LogEntry["tone"], msg: string, detail?: string) => {
    setLog((prev) =>
      [{ id: ++logSeq, tone, msg, detail, at: new Date().toLocaleTimeString("en-GB") }, ...prev].slice(0, 60),
    );
  }, []);

  /** Pull the authoritative server state (overview + curated values). */
  const sync = useCallback(async () => {
    try {
      const [ov, vals] = await Promise.all([api.overview(), api.values()]);
      setOverview(ov);
      setValues(vals);
      setBootError(null);
      /*
       * Restore the device link. A session pulled from a client is named
       * `device:<serial>`, so a reload can land back on the same client
       * instead of claiming "Not connected" while its data is already on
       * screen — the badge and the loaded save used to disagree until the
       * operator pressed Connect a second time.
       */
      const pulled = /^device:(.+)$/.exec(ov.meta?.name ?? "");
      const restored = pulled?.[1];
      if (restored) {
        setDeviceSerial(restored);
        setSerial((prev) => prev ?? restored);
      }
      return true;
    } catch (err) {
      // A 409 simply means no save is loaded yet — that is the normal first
      // screen, not an error worth alarming the user about.
      if (err instanceof ApiError && err.licenseRequired) {
        // The activation token expired or was revoked: drop it and return to
        // the lock screen instead of leaving every tab silently broken.
        clearToken();
        window.location.reload();
        return false;
      }
      if (err instanceof ApiError && err.status === 409) {
        setOverview(null);
        setValues({});
        setBootError(null);
      } else {
        setBootError(err instanceof Error ? err.message : String(err));
      }
      return false;
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const ok = await sync();
      if (ok) setPendingMap(new Map());
    } finally {
      setLoading(false);
    }
  }, [sync]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Self-update poll.
   *
   * The EXE is a thin shell that loads the UI from this server, so a UI deploy
   * reaches every installed copy with no rebuild. Only a change to the EXE
   * binary ships a release zip, which the server publishes. When that version
   * is newer than the running EXE's, hand the release to the native installer
   * (download + SHA-256 verify + atomic swap + relaunch). Runs once on mount
   * and every 15 minutes; a missed poll never breaks the studio. No-op in a
   * browser, where there is no EXE to update.
   */
  useEffect(() => {
    const native = nativeBridge();
    if (!native || typeof native.version !== "function") return;
    let stopped = false;
    const tick = async () => {
      try {
        const current = native.version();
        const r = await api.getUpdate();
        const rel = r.release;
        if (stopped || !rel?.downloadUrl || compareVersions(rel.version, current) <= 0) return;
        // Never retry the same version in a loop after it already installed.
        const marker = `hc-auto-update-${rel.version}`;
        try {
          if (localStorage.getItem(marker) === "done") return;
        } catch {
          /* private mode: proceed anyway */
        }
        const res = await native.installUpdate(rel);
        if (res?.ok) {
          try {
            localStorage.setItem(marker, "done");
          } catch {
            /* ignore */
          }
          toast.ok("Updating…", `Installing ${rel.version} — the tool will reopen.`);
        } else if (res?.reason) {
          toast.err("Update failed", res.reason);
        }
      } catch {
        /* a missed poll must never break the studio */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 15 * 60 * 1000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [toast]);

  const setPending = useCallback((path: string, value: number | string | boolean) => {
    setPendingMap((prev) => {
      const next = new Map(prev);
      next.set(path, value);
      return next;
    });
  }, []);

  const clearPending = useCallback((path?: string) => {
    setPendingMap((prev) => {
      if (!path) return new Map();
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
  }, []);

  const applyPending = useCallback(async (): Promise<boolean> => {
    if (pending.size === 0) return true;
    setApplying(true);
    try {
      const ops: EditOp[] = [...pending].map(([path, value]) => ({ path, value }));
      const res: ApplyResponse = await api.apply(ops, true, overview?.meta.id);
      setLastApply(res);
      if (!res.ok) {
        toast.err("Edit refused", res.errors.join("\n"));
        pushLog("err", "Edits refused", res.errors[0]);
        return false;
      }
      setPendingMap(new Map());
      await sync();
      const n = res.summary.length;
      const integrityNote =
        res.integrity && res.integrity.applied.length > 0
          ? ` (+${res.integrity.applied.length} integrity string${res.integrity.applied.length === 1 ? "" : "s"})`
          : "";
      toast.ok(
        `${n} field${n === 1 ? "" : "s"} patched${integrityNote}`,
        `${res.inputBytes.toLocaleString("en-US")} → ${res.outputBytes.toLocaleString("en-US")} bytes`,
      );
      pushLog(
        "ok",
        `${n} field${n === 1 ? "" : "s"} patched`,
        res.summary
          .slice(0, 3)
          .map((s) => s.label)
          .join(",") + (res.summary.length > 3 ? ` +${res.summary.length - 3}` : ""),
      );
      for (const w of res.warnings) toast.warn("Check this", w);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.err("Apply failed", msg);
      pushLog("err", "Apply failed", msg);
      return false;
    } finally {
      setApplying(false);
    }
  }, [pending, overview, sync, toast, pushLog]);

  const maxGP = useCallback(async (): Promise<MaxGPResponse | null> => {
    if (!overview || applying || connecting || pushing || loading) return null;
    if (pending.size) {
      toast.warn("Save staged edits first", "Save or revert your staged edits before MAX_GP.");
      return null;
    }
    setApplying(true);
    try {
      const result = await api.maxGP(overview.meta.id);
      setLastApply(result);
      await sync();
      toast.ok("MAX_GP saved", `${result.season} · Points 10,000 · Golden Ticket 1. Press Push to update the game.`);
      pushLog("ok", "MAX_GP saved", `${result.season}: ${result.changes} field(s) changed`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.err("MAX_GP failed", message);
      pushLog("err", "MAX_GP failed", message);
      return null;
    } finally {
      setApplying(false);
    }
  }, [overview, applying, connecting, pushing, loading, pending, sync, toast, pushLog]);

  const resetSession = useCallback(async () => {
    try {
      await api.reset();
      setPendingMap(new Map());
      await sync();
      toast.ok("Session reset", "Back to the original container bytes.");
      pushLog("info", "Session reset", "original container bytes restored");
    } catch (err) {
      toast.err("Reset failed", err instanceof Error ? err.message : String(err));
    }
  }, [sync, toast, pushLog]);

  const refreshDevices = useCallback(async () => {
    setDevicesLoading(true);
    try {
      const native = nativeBridge();
      if (native) {
        const list = await native.devices();
        setDevices({ found: list.length > 0, path: "native", devices: list, message: list.length > 0 ? "ok" : "no device connected" });
        if (list.length > 0 && !serial) setSerial(list[0]!.id);
      } else {
        const info = await api.devices();
        setDevices(info);
        if (info.devices.length > 0 && !serial) setSerial(info.devices[0]!.id);
      }
    } catch (err) {
      setDevices({ found: false, path: "", devices: [], message: err instanceof Error ? err.message : String(err) });
    } finally {
      setDevicesLoading(false);
    }
  }, [serial]);

  /**
   * CONNECT — the one button that matters. Reads the client's live save off the
   * selected device and makes it the session every tab edits, exactly like the
   * main IGG tool. No file paths, no manual imports.
   */
  const connect = useCallback(async () => {
    if (!serial) {
      toast.err("No device", "No emulator or phone detected — start one, then press Connect.");
      return;
    }
    setConnecting(true);
    try {
      const native = nativeBridge();
      let who = "";
      if (native) {
        // Desktop EXE path: pull via native bridge (local ADB).
        const pulled = await native.pull(serial);
        if (!pulled.ok) throw new Error((pulled as any).error ?? "pull failed");
        const session = await api.uploadSave(`device:${serial}`, pulled.b64);
        setDeviceSerial(serial);
        setPendingMap(new Map());
        await sync();
        // Identify whose game we just read.
        try {
          const [n, l] = await Promise.all([
            api.field("Properties.name").catch(() => null),
            api.field("Properties.LID_Lvl").catch(() => api.field("Properties.level")).catch(() => null),
          ]);
          const nm = typeof n?.value === "string" && n.value ? n.value : "";
          const lv = typeof l?.value === "number" ? l.value : null;
          who = nm ? `${nm}${lv !== null ? ` · level ${lv}` : ""}` : "";
        } catch { /* nicety */ }
        const fields = session?.meta?.fieldCount;
        toast.ok(who ? `Connected — ${who}` : "Connected", fields ? `${fields.toLocaleString("en-US")} fields read from ${serial}` : serial);
        pushLog("ok", who ? `Connected — ${who}` : "Connected to device", serial);
      } else {
        // Browser / server-side path.
        const res = await api.pull(serial);
        setDeviceSerial(serial);
        setPendingMap(new Map());
        await sync();
        try {
          const [n, l] = await Promise.all([
            api.field("Properties.name").catch(() => null),
            api.field("Properties.LID_Lvl").catch(() => api.field("Properties.level")).catch(() => null),
          ]);
          const nm = typeof n?.value === "string" && n.value ? n.value : "";
          const lv = typeof l?.value === "number" ? l.value : null;
          who = nm ? `${nm}${lv !== null ? ` · level ${lv}` : ""}` : "";
        } catch { /* nicety */ }
        const fields = res.overview?.meta?.fieldCount;
        toast.ok(who ? `Connected — ${who}` : "Connected", fields ? `${fields.toLocaleString("en-US")} fields read from ${serial}` : serial);
        pushLog("ok", who ? `Connected — ${who}` : "Connected to device", serial);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.err("Connect failed", msg);
      pushLog("err", "Connect failed", msg);
    } finally {
      setConnecting(false);
    }
  }, [serial, sync, toast, pushLog]);

  /**
   * PUSH — write the session back to the device and relaunch the game, so the
   * client is already open on the new save when the button returns.
   */
  /**
   * The ACTIVE section's own persistence callback (cosmetics grants/equips).
   *
   * Sections keep that state locally — it never enters the shared `pending`
   * map — so before this existed the title-bar Push exported the session
   * WITHOUT the staged unlock: the tab said "staged", the game showed nothing,
   * and only the section's own Save button worked. Registering it here lets
   * the ONE shared `push()` flush a section's local edits first, exactly like
   * the IGG tool's single Save & push. A ref (not state) so `push` never
   * closes over a stale callback.
   */
  const sectionSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const setSectionSave = useCallback((fn: (() => Promise<boolean>) | null) => {
    sectionSaveRef.current = fn;
  }, []);

  const push = useCallback(async () => {
    if (!serial) {
      toast.err("No device", "Press Connect first so the tool knows which client to write to.");
      return;
    }
    if (!deviceSerial) {
      toast.err(
        "Nothing to push",
        "Press Connect (or run a clone) first so the tool is holding a save that came from this client.",
      );
      return;
    }
    // A section with its own persistence (cosmetics) must land BEFORE the
    // flush below — it is not in `pending`. A refusal aborts the push so we
    // never write a save that is missing the staged unlock.
    const saver = sectionSaveRef.current;
    if (saver) {
      const saved = await saver();
      if (!saved) return;
    }
    // Flush staged field edits BEFORE exporting. This title-bar Push used to
    // export the session as-is, silently dropping whatever the operator had
    // typed but not yet Saved — the single biggest "I edited it but the game
    // shows nothing" cause. A refusal aborts the push rather than writing a
    // stale save.
    if (pending.size > 0) {
      const flushed = await applyPending();
      if (!flushed) return;
    }
    setPushing(true);
    try {
      const native = nativeBridge();
      if (native) {
        // Desktop EXE path: export session bytes, push via native bridge.
        const sessionId = overview?.meta.id;
        const blob = await downloadSave(sessionId);
        const buf = await blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        // Convert to base64 for the native bridge (matches igg tool's push signature).
        let b64 = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          b64 += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        b64 = btoa(b64);
        const res = await native.push(serial, b64, { restart: true });
        if ((res as any).error) throw new Error((res as any).error);
        toast.ok("Pushed — game is opening", res.toolBackup ? `auto-backup: ${res.toolBackup}` : serial);
        pushLog("ok", "Save pushed + game relaunched", res.toolBackup ?? serial);
      } else {
        // Browser / server-side path.
        const res = await api.push(serial, true, overview?.meta.id);
        if (res.error) throw new Error(res.error);
        toast.ok("Pushed — game is opening", res.toolBackup ? `auto-backup: ${res.toolBackup}` : serial);
        pushLog("ok", "Save pushed + game relaunched", res.toolBackup ?? serial);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.err("Push failed", msg);
      pushLog("err", "Push failed", msg);
    } finally {
      setPushing(false);
    }
  }, [serial, deviceSerial, overview, pending, applyPending, toast, pushLog]);

  const value = useMemo<StudioState>(
    () => ({
      loading,
      bootError,
      overview,
      values,
      pending,
      lastApply,
      setPending,
      clearPending,
      applyPending,
      applying,
      maxGP,
      resetSession,
      reload,
      section,
      setSection,
      devices,
      devicesLoading,
      refreshDevices,
      serial,
      setSerial,
      deviceSerial,
      setDeviceSerial,
      connect,
      connecting,
      push,
      pushing,
      setSectionSave,
      log,
      pushLog,
    }),
    [
      loading,
      bootError,
      overview,
      values,
      pending,
      lastApply,
      setPending,
      clearPending,
      applyPending,
      applying,
      maxGP,
      resetSession,
      reload,
      section,
      devices,
      devicesLoading,
      refreshDevices,
      serial,
      deviceSerial,
      connect,
      connecting,
      push,
      pushing,
      setSectionSave,
      log,
      pushLog,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
