import { useStudio } from "../lib/studio.tsx";

/**
 * Fresh Start — create a new account on the connected device, or put the
 * previous one back.
 *
 * This tab does exactly two things and nothing else:
 *
 *   1. **Create new account** — the bridge copies `SaveGame.db`,
 *      `SaveGame.db.bak` and `SaveGame.db.buf` to this PC, fsyncs that copy,
 *      then removes those three files from the device and relaunches the
 *      game. With no save present the game starts a brand-new account.
 *   2. **Restore previous account** — writes that same copy back with the
 *      directory's own owner and mode, then relaunches.
 *
 * The copy is the whole safety story, so it is taken and confirmed on disk
 * BEFORE the first file is touched, and it lives on the operator's machine —
 * the only machine that can put the account back.
 *
 * The confirmation dialogs are real: `window.confirm` is enabled in the
 * desktop shell (WebView2 default script dialogs), and the server refuses the
 * call without the matching confirmation phrase anyway.
 */
function Head({ title }: { title: string }) {
  return (
    <div className="am-panel-head">
      <img src="assets/ui/panel-bars.png" alt="" />
      <h2 className="am-panel-title">{title}</h2>
    </div>
  );
}

export function FreshStartSection() {
  const {
    overview,
    serial,
    deviceSerial,
    pending,
    pushing,
    applying,
    connecting,
    newAccount,
    restoreDeviceBackup,
  } = useStudio();

  const busy = pushing || applying || connecting;
  /** A fresh start needs a save that came FROM this device — never another. */
  const ready = !!overview && !!serial && serial === deviceSerial && !pending.size && !busy;
  /** Restore only needs the device: it is how you get back after a fresh start. */
  const canRestore = !!serial && !busy;

  return (
    <section className="am-panel">
      <Head title="Fresh Start" />

      <div
        style={{
          margin: "18px 0 8px",
          padding: 24,
          border: "1px solid #a5c5fa",
          borderRadius: 16,
          background: "#eef5ff",
        }}
      >
        <h3 style={{ fontSize: 22, fontWeight: 700, color: "#143e87", margin: "0 0 20px" }}>
          Create new account
        </h3>

        <div className="am-row" style={{ flexWrap: "wrap", gap: 10 }}>
          <button
            type="button"
            className="am-ghost am-ghost--primary"
            disabled={!ready}
            onClick={() => {
              if (
                window.confirm(
                  "Create a new account on the selected device? Current progress will be replaced. You can restore the backup.",
                )
              ) {
                void newAccount();
              }
            }}
          >
            {pushing ? "Processing…" : "Create new account"}
          </button>

          <button
            type="button"
            className="am-ghost"
            disabled={!canRestore}
            onClick={() => {
              if (window.confirm("Restore previous progress on the selected device?")) {
                void restoreDeviceBackup();
              }
            }}
          >
            Restore previous account
          </button>
        </div>

        <p className="am-hint" style={{ margin: "16px 0 0", lineHeight: 1.6 }}>
          Before anything is deleted, <code>SaveGame.db</code>, <code>SaveGame.db.bak</code> and{" "}
          <code>SaveGame.db.buf</code> are copied to this PC.{" "}
          <b>Restore previous account</b> writes exactly those three files back, so the operation
          is reversible until you play past it. The copy is kept at{" "}
          <code>%APPDATA%\Homescapes-Save-Studio\backups</code>.
        </p>

        {!overview && (
          <p className="am-hint" style={{ margin: "14px 0 0" }}>
            Connect a device to continue.
          </p>
        )}
        {!!pending.size && (
          <p className="am-hint" style={{ margin: "14px 0 0" }}>
            Save or discard pending changes before continuing.
          </p>
        )}
      </div>
    </section>
  );
}
