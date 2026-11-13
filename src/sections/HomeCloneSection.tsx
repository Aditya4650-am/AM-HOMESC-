import { useEffect, useState } from "react";
import { AmActions } from "./AmActions.tsx";
import { AmEmpty, useToast } from "../components/ui.tsx";
import { useStudio } from "../lib/studio.tsx";
import { api, type CloneSourceResponse, type SeasonPassUnlockResponse } from "../lib/api.ts";

/**
 * IGG Account Clone — put one specific account's home onto any connected
 * client.
 *
 * The feature has exactly one source: `data/IGG-account.db`, the IGG account
 * shipped with the tool. There is no friend list, no manual id and no path to
 * fill in, because "which account do I clone" is not a question this panel
 * asks any more — the server resolves the file itself, so a clone cannot be
 * pointed at the wrong save.
 *
 * What lands on the device is the account's **content**: every room and the
 * furniture unlocked in it (`Repairs`), the chosen design per room
 * (`RoomDesign`), the garden (`GardenObject`), plus characters, avatars,
 * costumes and photo albums. That is the whole visible house, not the donor's
 * name.
 *
 * What deliberately does NOT travel is **progress**: level, stars, coins,
 * statistics, quests, events and the account's secret values stay the
 * connected client's own — unless the operator ticks the optional
 * "also copy level, stars and coins" box, which asks the server for the same
 * bounded, mirror-refreshed five leaves (level, match-3 level, coins, earned
 * and spent stars) and reports every value before → after. That split is the
 * entire ban guard — the 9.2.101 APK
 * shows Playrix scores an account's progress server-side against its own
 * history (`AntiCheat.Server.ScoreValidation`), and every full-save transplant
 * measured on 2026-10-17 was answered with the "suspicious activity" warning,
 * while the content-only clone ran clean. See `server/cloneGuard.ts`.
 *
 * Nothing is written until the operator presses Push in the action row, which
 * backs the device's save up first, so Restore always undoes a clone.
 */
export function HomeCloneSection() {
  const { overview, serial, setDeviceSerial, pushLog, reload } = useStudio();
  const toast = useToast();

  const [source, setSource] = useState<CloneSourceResponse | null>(null);
  const [sourceErr, setSourceErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  /**
   * Opt-in progression copy. OFF by default: the clone carries the donor's
   * house and nothing else, which is the build measured clean in game. Ticked
   * by the operator, the server additionally writes the donor's level, stars
   * and coins — bounded (coins clamped, big level jumps warned) and reported
   * back as before → after.
   */
  const [withProgress, setWithProgress] = useState(false);

  const [spRunning, setSpRunning] = useState(false);
  const [spResult, setSpResult] = useState<SeasonPassUnlockResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .cloneSource()
      .then((s) => {
        if (!cancelled) setSource(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) setSourceErr(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const clone = async () => {
    if (!serial) {
      toast.warn("No device connected", "Pick a device in the title bar, then press Connect.");
      return;
    }
    if (source && !source.exists) {
      toast.err(
        "Clone account missing",
        `The tool cannot find its built-in account at ${source.path}.`,
      );
      return;
    }

    setRunning(true);
    setLast(null);
    try {
      // No path: the server reads its own data/IGG-account.db, so what lands on
      // this device is always that one account. `progression` is only ever sent
      // when the operator ticked the box — the default clone stays content-only.
      const res = await api.cloneContent({ serial, progression: withProgress });
      if (!res.ok) {
        pushLog("err", "Clone failed", res.errors.slice(0, 4).join(" · ") || "unknown error");
        toast.err("Clone failed", res.errors[0] ?? "unknown error");
        setLast("failed");
        return;
      }
      const roots = res.roots.filter((r) => r.fields > 0);
      const prog = res.progression;
      pushLog(
        "ok",
        "IGG account cloned",
        `${res.fields} content fields · ${roots.length} roots · ` +
          `${res.warningsTotal} warnings` +
          (prog && prog.copied.length
            ? ` · progression: ${prog.copied.length} fields copied`
            : " · your level/coins/statistics untouched"),
      );
      if (res.warningsTotal > 0) {
        pushLog("warn", `${res.warningsTotal} warnings`, res.warnings.slice(0, 4).join(" · "));
      }
      if (prog) {
        for (const n of prog.notes) pushLog("warn", "Progression note", n);
        for (const p of prog.copied) {
          pushLog(
            "warn",
            `Copied ${p.path}`,
            `${p.from === null ? "absent" : p.from} → ${p.to}`,
          );
        }
        for (const d of prog.dropped) pushLog("warn", "Progression not copied", d);
      }
      setLast(
        prog && prog.copied.length
          ? `${res.fields} fields · ${roots.length} roots · ${prog.copied.length} progression`
          : `${res.fields} fields · ${roots.length} roots staged`,
      );
      // The clone route pulls straight off this device, so the active session is
      // device-sourced — mark it so Push is allowed to write it back.
      setDeviceSerial(serial);
      toast.ok(
        prog && prog.copied.length
          ? "IGG account cloned + level/stars/coins copied"
          : "IGG home cloned — your progress untouched",
        prog && prog.copied.length
          ? prog.copied.map((p) => `${p.path.split(".")[1]} ${p.from ?? "—"} → ${p.to}`).join(" · ")
          : "Press Push to write the save and open the game.",
      );
      await reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      pushLog("err", "Clone failed", msg);
      toast.err("Clone failed", msg);
      setLast("failed");
    } finally {
      setRunning(false);
    }
  };

  /**
   * Golden Pass, both rows, one tap — and unlike the clone above this one
   * pushes itself, because the operator asked for the unlock and the write in
   * a single action. The response carries every field it touched, so the log
   * states the values rather than a bare "done".
   */
  const unlockSeasonPass = async () => {
    if (!serial) {
      toast.warn("No device connected", "Pick a device in the title bar, then press Connect.");
      return;
    }
    setSpRunning(true);
    setSpResult(null);
    try {
      const res = await api.seasonPassUnlock(serial);
      setSpResult(res);
      if (!res.ok) {
        pushLog("err", "Golden Pass unlock failed", res.pushError ?? "unknown error");
        toast.err("Golden Pass unlock failed", res.pushError ?? "unknown error");
        return;
      }
      pushLog(
        "warn",
        `State written but NOT kept — ${res.season}`,
        `${res.pointsPath} written as ${res.points} and ${res.completedStages} of 31 stages ` +
          `marked complete; the game deletes the points currency on the next sync, so the ` +
          `pass still renders at stage 1/31.`,
      );
      pushLog("warn", "Gold row not unlocked", res.goldRow.reason);
      for (const n of res.notes) pushLog("warn", "Golden Pass note", n);
      if (res.warningsTotal > 0) {
        pushLog("warn", `${res.warningsTotal} warnings`, res.warnings.slice(0, 4).join(" · "));
      }
      toast.warn(
        "Written, but the game strips it",
        "The tier currency is server-owned and was removed; the pass did not unlock.",
      );
      await reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      pushLog("err", "Golden Pass unlock failed", msg);
      toast.err("Golden Pass unlock failed", msg);
    } finally {
      setSpRunning(false);
    }
  };

  if (!overview) {
    return (
      <section className="am-panel">
        <Head title="IGG Account Clone" />
        <AmEmpty
          title="No save loaded"
          detail="Press Connect in the title bar to read your client's live game first."
        />
      </section>
    );
  }

  return (
    <section className="am-panel">
      <Head title="IGG Account Clone" />

      <div className="am-label">Source account</div>
      {sourceErr ? (
        <div className="am-hint" style={{ margin: "6px 0" }}>
          Could not read the clone source: {sourceErr}
        </div>
      ) : !source ? (
        <div className="am-hint" style={{ margin: "6px 0" }}>
          Reading the source account…
        </div>
      ) : (
        <div className="am-hint" style={{ margin: "6px 0", lineHeight: 1.5, wordBreak: "break-all" }}>
          <b>IGG account</b> — <code>{source.path}</code>
          {source.exists ? (
            <span> · {(source.bytes / (1024 * 1024)).toFixed(2)} MB</span>
          ) : (
            <span style={{ color: "#c0392b" }}> · file missing</span>
          )}
        </div>
      )}

      <label
        className="am-hint"
        style={{ display: "flex", gap: 8, alignItems: "center", margin: "14px 0 0", cursor: "pointer" }}
      >
        <input
          type="checkbox"
          checked={withProgress}
          onChange={(e) => setWithProgress(e.target.checked)}
        />
        <span>Also copy level, stars and coins</span>
      </label>

      <div className="am-row" style={{ margin: "16px 0" }}>
        <button
          type="button"
          className="am-ghost am-ghost--primary"
          disabled={running || !serial || (source !== null && !source.exists)}
          title={
            serial
              ? "Pull the device, then transplant the IGG account's whole home into it"
              : "Connect a device first"
          }
          onClick={() => void clone()}
        >
          {running ? "Cloning…" : "Clone IGG account"}
        </button>
        {!serial ? <span className="am-hint">no device connected</span> : null}
        {last ? <span className="am-hint">{last}</span> : null}
      </div>

      <div className="am-label" style={{ marginTop: 8 }}>
        Golden Pass
      </div>

      <div className="am-row" style={{ margin: "16px 0" }}>
        <button
          type="button"
          className="am-ghost am-ghost--primary"
          disabled={spRunning || !serial}
          title={
            serial
              ? "Pull the device, write the season-pass progress, push and relaunch"
              : "Connect a device first"
          }
          onClick={() => void unlockSeasonPass()}
        >
          {spRunning ? "Writing…" : "Write Golden Pass progress"}
        </button>
        {!serial ? <span className="am-hint">no device connected</span> : null}
      </div>

      {spResult ? (
        <div
          className="am-hint"
          style={{ margin: "6px 0 0", lineHeight: 1.6, fontFamily: "monospace", fontSize: 12 }}
        >
          {spResult.ok ? (
            <>
              season <b>{spResult.season}</b>
              {spResult.eventPresent ? null : " · event NOT live on this account"}
              <br />
              wrote: {spResult.completedStages} of 31 stages · {spResult.pointsPath} ={" "}
              <b>{spResult.points}</b>
              <br />
              measured: the game deletes {spResult.pointsPath} on the next sync — the pass does
              not unlock
              <br />
              gold row: <b>not unlocked</b> — {spResult.goldRow.reason}
              <br />
              {spResult.highlights.map(({ path, before, after }) => (
                <span key={path} style={{ display: "block" }}>
                  {path}: {String(before ?? "—")} → <b>{String(after)}</b>
                </span>
              ))}
              <br />
              pushed · {spResult.bytes.toLocaleString()} bytes · relaunched{" "}
              {spResult.relaunched ? "yes" : "no"}
            </>
          ) : (
            <>failed: {spResult.pushError ?? "unknown error"}</>
          )}
        </div>
      ) : null}

      <AmActions />
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
