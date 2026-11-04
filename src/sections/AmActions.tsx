import { useState } from "react";
import { useStudio } from "../lib/studio.tsx";
import { useToast } from "../components/ui.tsx";

/**
 * Shared Save / Push action row for every AM-style section.
 *
 * - Save validates and persists what is actually staged (never pretends).
 * - Push hands the ENTIRE device write to the one shared `push()` in the
 *   studio — the same code path the title bar uses. There used to be a second,
 *   divergent push here that skipped the device-serial gate and never touched
 *   the native ADB bridge, so a desktop EXE press behaved differently from the
 *   title bar. Delegating keeps both buttons byte-for-byte identical.
 *
 * `onSave` here is ONLY the Save button's handler. A section that keeps
 * persistence in LOCAL state (like cosmetics) additionally registers a silent
 * push-flush with the studio itself (`setSectionSave`) so the title-bar Push
 * can commit it too — see CosmeticsKindSection. Registering `onSave` here
 * instead would re-pop its "Nothing to save" toast on every empty Push.
 */
export function AmActions({
  onSave,
  saveDisabled,
  saveLabel = "Save",
}: {
  /** Custom save (sections that persist beyond staged field edits). */
  onSave?: () => Promise<boolean>;
  saveDisabled?: boolean;
  saveLabel?: string;
}) {
  const { pending, applyPending, applying, push, pushLog } = useStudio();
  const toast = useToast();
  const [pushing, setPushing] = useState(false);

  const handleSave = async () => {
    if (applying) return;
    if (onSave) {
      await onSave();
      return;
    }
    if (pending.size === 0) {
      toast.info("Nothing to save", "No edits are staged — change a value first.");
      return;
    }
    await applyPending();
  };

  const handlePush = async () => {
    if (pushing || applying) return;
    setPushing(true);
    try {
      // The shared push() flushes the section's registered push-flush (local
      // staged state like cosmetics), then any staged field edits, enforces the
      // device-serial gate (so a save pulled from device A is never written to
      // device B), and uses the native ADB bridge on desktop. One code path,
      // one set of gates, both buttons.
      await push();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.err("Push failed", msg);
      pushLog("err", "Push failed", msg);
    } finally {
      setPushing(false);
    }
  };

  return (
    <div className="am-actions">
      <button
        type="button"
        className="am-btn am-btn-save"
        onClick={() => void handleSave()}
        disabled={applying || saveDisabled}
        title={saveDisabled ? "Load a save first" : "Validate and persist staged edits"}
      >
        <img src="assets/ui/save-glyph.png" alt="" />
        <span>{saveLabel}</span>
      </button>
      <button
        type="button"
        className="am-btn am-btn-push"
        onClick={() => void handlePush()}
        disabled={pushing || applying}
        title="Apply staged edits and write the save to the connected device"
      >
        <img src="assets/ui/push-glyph.png" alt="" />
        <span>{pushing ? "Pushing…" : "Push"}</span>
      </button>
    </div>
  );
}
