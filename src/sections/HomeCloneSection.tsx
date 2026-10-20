import { useEffect, useState } from "react";
import { AmActions } from "./AmActions.tsx";
import { AmEmpty, useToast } from "../components/ui.tsx";
import { useStudio } from "../lib/studio.tsx";
import { api, type CloneSourceResponse } from "../lib/api.ts";

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
