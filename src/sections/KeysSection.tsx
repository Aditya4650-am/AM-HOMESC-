import { OwnerPanel } from "./OwnerPanel.tsx";

/**
 * Keys tab — the owner's client-key generation & management screen, live in
 * the dashboard chrome. Mirrors the IGG tool's Control / key panel.
 *
 * Reuses the same OwnerPanel used on the lock screen so behaviour is identical
 * regardless of entry point.
 */
export function KeysSection() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold tracking-wide text-ink">License keys</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-3">
          Generate client keys, or list / revoke / reset devices for existing ones. This tab requires the owner
          passcode (<span className="font-mono">HS_OWNER</span>) and applies to the deployed server.
        </p>
      </div>
      <OwnerPanel />
    </div>
  );
}
