import { OwnerConsole } from "../components/OwnerConsole.tsx";

/**
 * Owner tab — the in-studio key console.
 *
 * Same component as the gate's owner modal, so the owner sees one interface in
 * both places. An owner activation token authorises it with no passcode; a
 * client key shows the passcode gate instead of pretending to work.
 */
export function OwnerSection() {
  return (
    <div className="login-scene login-scene--embed">
      <div className="login-card login-card--plain" style={{ padding: 0 }}>
        <OwnerConsole embedded />
      </div>
    </div>
  );
}
