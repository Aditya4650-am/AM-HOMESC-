import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
  | "currencies"
  | "quests"
  | "rooms"
  | "costumes"
  | "collections"
  | "events"
  | "match3"
  | "items"
  | "explorer"
  | "pets"
  | "freshstart"
  | "homeclone"
  | "review"
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
  version: () => string;
} | undefined {
  return (window as unknown as { hcNative?: any }).hcNative;
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
  }, [serial, deviceSerial, overview, toast, pushLog]);

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
      log,
      pushLog,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
