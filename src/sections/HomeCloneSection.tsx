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
 * connected client's own. That split is the entire ban guard — the 9.2.101 APK
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
      // this device is always that one account.
      const res = await api.cloneContent({ serial });
      if (!res.ok) {
        pushLog("err", "Clone failed", res.errors.slice(0, 4).join(" · ") || "unknown error");
        toast.err("Clone failed", res.errors[0] ?? "unknown error");
        setLast("failed");
        return;
      }
      const roots = res.roots.filter((r) => r.fields > 0);
      pushLog(
        "ok",
        "IGG account cloned",
        `${res.fields} content fields · ${roots.length} roots · ` +
          `${res.warningsTotal} warnings · your level/coins/statistics untouched`,
      );
      if (res.warningsTotal > 0) {
        pushLog("warn", `${res.warningsTotal} warnings`, res.warnings.slice(0, 4).join(" · "));
      }
      setLast(`${res.fields} fields · ${roots.length} roots staged`);
      // The clone route pulls straight off this device, so the active session is
      // device-sourced — mark it so Push is allowed to write it back.
      setDeviceSerial(serial);
      toast.ok(
        "IGG home cloned — your progress untouched",
        "Press Push to write the save and open the game.",
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

      <div className="am-hint" style={{ margin: "8px 0 14px", lineHeight: 1.5 }}>
        Clone one account — the <b>IGG account</b> shipped with this tool — into whichever client
        you have connected. It brings the whole house: every room and the furniture unlocked in it,
        the garden, the decorations, characters, avatars, costumes and photo albums. Your own level,
        coins, stars and statistics stay exactly as they are, which is what keeps the server's
        progress check quiet. The device is re-pulled first, so the clone lands on what the game
        holds right now, and nothing is written until you press <b>Push</b>.
      </div>

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
      {source && !source.exists ? (
        <div className="am-hint" style={{ margin: "6px 0" }}>
          The built-in account file is not where the tool expects it, so cloning is disabled until
          it is restored.
        </div>
      ) : null}

      <div className="am-label" style={{ marginTop: 14 }}>
        What lands on your device
      </div>
      <div className="am-hint" style={{ margin: "6px 0 0", lineHeight: 1.6 }}>
        <b>Copied</b> — every room and its repairs (so the house is built and its furniture is
        unlocked), every room design the IGG account owns (this is what keeps the decorated
        variants — the seasonal and event designs — on show instead of resetting to the plain base
        ones), the furniture design chosen in each room, the garden and its decorations,
        removed/erased objects, characters, avatars, costumes, minigames, match-3 state and photo
        albums.
        <br />
        <b>Left yours</b> — level, stars, coins, lives, statistics, quests, events, season passes,
        player items and the save's secret values. Your account keeps its own history; it just gains
        the IGG house.
      </div>

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

      <div className="am-hint" style={{ margin: "8px 0 4px", lineHeight: 1.5 }}>
        <b>Honest note.</b> Homescapes exposes no client call to download another player's account,
        so the clone source is a save file held by the tool — this panel never fetches anything
        live. The 9.2.101 APK shows the ban is decided <i>server-side</i>: Playrix scores an
        account's progress against its own history (`AntiCheat.Server.ScoreValidation` → the
        “suspicious activity” window), and that score cannot be rewritten from a save. Measured
        2026-10-17: a byte-for-byte full clone <i>and</i> a ban-guarded full clone both ended in the
        warning. <b>That is why this clone copies content only</b> — never progress — so your level,
        balances, statistics and secret values stay yours. Every push backs your save up first, so{" "}
        <b>Restore</b> always undoes a clone.
      </div>

      <div className="am-label" style={{ marginTop: 20 }}>
        Golden Pass — tested, does not unlock
      </div>
      <div className="am-hint" style={{ margin: "6px 0 0", lineHeight: 1.6 }}>
        <b>Measured result, 2026-10-20 — real in-game test.</b> The free-row state was written and
        pushed to the live device, and read back from the game's own re-saved file: all 31 stages,
        <code>currProgress=30</code>, <code>currentOpenedStageIndex=31</code> all <i>survived
        untouched</i>, and the account was <b>not</b> rolled back (level 40, 123,456 coins, 42
        stars, 13 areas — all intact, no popup). But the game <b>deleted{" "}
        <code>Currency.SSPProcedure46Points</code></b>, and the pass rendered at stage 1 of 31 with
        the next stage locked at <code>0/1</code>. <b>The displayed tier derives from that currency
        server-side, not from the completion cache</b> — so with it removed the progress is inert.
        <br />
        <b>Both rows are therefore unreachable from the save.</b> The free row needs a tier currency
        the server owns and strips on the next sync; the gold row needs the golden ticket, which{" "}
        <code>libgame.so</code> prices, sells and validates through{" "}
        <code>ValidatePurchase</code>/<code>ConsumePurchase</code>, reporting{" "}
        <code>payer_type</code> and <code>inapps_count/sum</code> upward.{" "}
        <code>LogEventComponent.goldenPassBought</code> reads <code>true</code> on the maxed donor
        and <code>false</code> here — but it asserts a receipt this account never made, so writing
        it would be purchase spoofing, which this tool does not do.
        <br />
        <b>The research below is real and reusable</b> — the 59-component registry, the 31-stage
        record shape and the three components that carry pass state are all measured, and are what
        proved the mechanism closed. The button still runs and still reports honestly; it just does
        not claim an unlock the game will not keep.
        <br />
        Every push backs your save up first.
      </div>

      <div className="am-row" style={{ margin: "16px 0" }}>
        <button
          type="button"
          className="am-ghost am-ghost--primary"
          disabled={spRunning || !serial}
          title={
            serial
              ? "Pull the device, write the season-pass progress, push and relaunch. Measured NOT to unlock: the game strips the tier currency."
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
