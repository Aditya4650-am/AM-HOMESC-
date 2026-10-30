import { useEffect, useState } from "react";
import { AmEmpty } from "../components/ui.tsx";
import { useStudio } from "../lib/studio.tsx";
import { api, type MaxGPPreview } from "../lib/api.ts";

export function MaxGPPanel() {
  const { overview, pending, applying, loading, connecting, pushing, maxGP } = useStudio();
  const [preview, setPreview] = useState<MaxGPPreview | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [savedSession, setSavedSession] = useState<string | null>(null);
  const sessionId = overview?.meta.id;

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);
    if (!sessionId) { setReading(false); return; }
    setReading(true);
    api.maxGPPreview(sessionId).then((value) => {
      if (!cancelled) setPreview(value);
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (!cancelled) setReading(false);
    });
    return () => { cancelled = true; };
  }, [overview, sessionId, retry]);

  const busy = applying || loading || connecting || pushing;
  const apply = async () => {
    const result = await maxGP();
    if (result && sessionId) setSavedSession(sessionId);
  };

  return (
    <div style={{ marginBottom: 24 }}>
      <h3 className="am-panel-title" style={{ margin: "16px 0" }}>MAX_GP</h3>
      {!overview ? (
        <AmEmpty title="No save loaded" detail="Connect a device or open a save to use MAX_GP." />
      ) : (
        <>
          <div className="am-label">Points + Golden Ticket</div>
          <p className="am-hint" style={{ lineHeight: 1.6 }}>
            Detect the season automatically and save both changes with one click.
          </p>
          <div aria-live="polite" aria-busy={reading}>
            {reading ? <p className="am-hint">Detecting season…</p> : null}
            {error ? (
              <>
                <AmEmpty title="Could not detect a season" detail={error} />
                <button type="button" className="am-ghost" disabled={busy} onClick={() => setRetry((x) => x + 1)}>Retry detection</button>
              </>
            ) : null}
            {preview ? (
              <div className="am-fieldgrid">
                {[
                  ["Season", preview.season],
                  ["Golden Ticket", preview.source],
                  ["Points", "10,000"],
                  ["Previous points", "9,999"],
                  ["Ticket quantity", "1"],
                ].map(([label, value]) => (
                  <div className="am-field" key={label}>
                    <div className="am-field-meta">
                      <div className="am-field-label">{label}</div>
                      <div className="am-field-value" style={{ overflowWrap: "anywhere" }}>{value}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <div className="am-row" style={{ margin: "18px 0", gap: 12, flexWrap: "wrap" }}>
            <button type="button" className="am-ghost am-ghost--primary"
              disabled={!preview || reading || busy || pending.size > 0}
              onClick={() => void apply()}>
              {applying ? "Saving…" : "MAX_GP — Points + Golden Ticket"}
            </button>
            {preview && !reading ? <span className="am-hint">{preview.changes ? `${preview.changes} field(s) to update` : "Both values are already set"}</span> : null}
          </div>
          {pending.size > 0 ? <p className="am-hint">Save or revert staged edits first to enable MAX_GP.</p> : null}
          {savedSession === sessionId ? (
            <p className="am-hint" role="status">MAX_GP saved to this session. Press Push to apply it to the game, or export the edited save.</p>
          ) : null}
          <p className="am-hint" style={{ lineHeight: 1.6 }}>MAX_GP saves the edit immediately. Press Push afterwards to update your connected game.</p>
        </>
      )}
    </div>
  );
}
