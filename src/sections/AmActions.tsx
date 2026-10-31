import { useState } from "react";
import { api } from "../lib/api.ts";
import { useStudio } from "../lib/studio.tsx";
import { useToast } from "../components/ui.tsx";

/**
 * Shared Save / Push action row for every AM-style section.
 *
 * - Save validates and persists what is actually staged (never pretends).
 * - Push applies pending edits first, then writes the save to the connected
 *   device — or says honestly that no device is connected. It never
 *   simulates a live-game update.
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
  const { pending, applyPending, applying, serial, pushLog, overview } = useStudio();
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
      // 0) A section with its own persistence (cosmetics grants, equips) must
      //    land BEFORE the push. Skipping this used to push a save that never
      //    contained the staged unlock — the tab showed "staged" while the
      //    game showed nothing.
      if (onSave) {
        const saved = await onSave();
        if (!saved) return; // onSave already explained the refusal
      }
      // 1) Persist staged field edits first — a push always sends saved bytes.
      if (pending.size > 0) {
        const ok = await applyPending();
        if (!ok) return; // applyPending already explained the refusal
      }
      // 2) Honest device gate.
      if (!serial) {
        toast.warn(
          "No device connected",
          "Connect an emulator or device over ADB, then press Push again.",
        );
        pushLog("warn", "Push skipped — no device connected");
        return;
      }
      // 3) Real push over ADB.
      pushLog("info", `Pushing save to ${serial}…`);
      const res = await api.push(serial, true, overview?.meta.id);
      if (res.error) {
        toast.err("Push failed", res.error);
        pushLog("err", "Push failed", res.error);
        return;
      }
      const bits = [res.file ?? "save pushed"];
      if (res.toolBackup) bits.push("tool backup kept");
      if (res.relaunched) bits.push("game relaunched");
      toast.ok("Pushed to device", bits.join(" · "));
      pushLog("ok", `Pushed save to ${serial}`, res.relaunched ? "game relaunched" : undefined);
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
