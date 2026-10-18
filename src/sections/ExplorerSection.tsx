import { useEffect, useMemo, useState } from "react";
import { api, type DiscoveredField } from "../lib/api.ts";
import { useStudio } from "../lib/studio.tsx";
import { Badge, Button, EmptyState, Panel, Spinner, useToast } from "../components/ui.tsx";

/**
 * Prefix-discovered sections: Avatars, event currencies, rooms and quests.
 *
 * Nothing here is hard-coded. The server walks the save and returns every
 * leaf field under a prefix, so a game update that renames a key shows up as
 * a missing row rather than as a silent edit to the wrong bytes.
 */
export function ExplorerSection({ sectionId }: { sectionId: string }) {
  const { overview, pending, setPending } = useStudio();
  const toast = useToast();
  const section = overview?.prefixSections.find((s) => s.id === sectionId);

  const [fields, setFields] = useState<DiscoveredField[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [showZero, setShowZero] = useState(!section?.hideZero);

  useEffect(() => {
    if (!section) return;
    let cancelled = false;
    // Key search runs on the SERVER so sections that are truncated at the
    // page limit (live events hold tens of thousands of leaves) remain fully
    // searchable — debounce so each keystroke does not re-walk the save.
    const timer = setTimeout(() => {
      setLoading(true);
      api
        .discover(section.prefix, undefined, 2000, query.trim())
        .then((f) => {
          if (!cancelled) setFields(f);
        })
        .catch((err: unknown) => {
          if (!cancelled) toast.err("Could not read section", err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [section, toast, query]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return fields.filter((f) => {
      if (!showZero && (f.value === 0 || f.value === false || f.value === "0")) return false;
      if (!q) return true;
      return f.path.toLowerCase().includes(q) || String(f.value).toLowerCase().includes(q);
    });
  }, [fields, query, showZero]);

  if (!section) {
    return <EmptyState title="Section not found" />;
  }

  return (
    <Panel
      title={section.label}
      description={section.description}
      actions={
        <div className="flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter…"
            className="w-44 rounded-lg border border-line-2 bg-app px-2.5 py-1.5 text-xs text-ink outline-none transition focus:border-gold"
          />
          <Button variant="subtle" onClick={() => setShowZero((v) => !v)}>
            {showZero ? "Hide empty" : "Show empty"}
          </Button>
        </div>
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 py-10 text-ink-3">
          <Spinner size={15} /> <span className="text-sm">Reading save…</span>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={fields.length === 0 ? `No "${section.prefix}" fields in this save` : "Nothing matches"}
        />
      ) : (
        <div className="max-h-[62vh] overflow-y-auto pr-1">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-panel">
              <tr className="text-ink-3">
                <th className="py-2 pr-4 font-medium">Key</th>
                <th className="py-2 pr-4 font-medium">Value</th>
                <th className="py-2 font-medium">Set</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <Row key={f.path} field={f} staged={pending.get(f.path)} onStage={setPending} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 flex items-center gap-3 text-[11px] text-ink-3">
        <Badge>{rows.length.toLocaleString("en-US")} shown</Badge>
        <span>of {fields.length.toLocaleString("en-US")} discovered</span>
      </div>
    </Panel>
  );
}

function Row({
  field,
  staged,
  onStage,
}: {
  field: DiscoveredField;
  staged: unknown;
  onStage: (path: string, value: number | string | boolean) => void;
}) {
  const numeric = field.kind === "number" || field.kind === "tagged-i64" || field.kind === "tagged-f";
  const boolish = field.kind === "boolean";
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const display = staged !== undefined ? String(staged) : String(field.value);

  const commit = () => {
    if (draft.trim() === "") {
      setEditing(false);
      return;
    }
    if (numeric) {
      const n = Number(draft);
      if (!Number.isFinite(n)) return;
      onStage(field.path, n);
    } else if (boolish) {
      // Booleans must stay booleans in the file — stage a real true/false.
      const v = draft.trim().toLowerCase();
      if (v !== "true" && v !== "false" && v !== "1" && v !== "0") return;
      onStage(field.path, v === "true" || v === "1");
    } else {
      onStage(field.path, draft);
    }
    setEditing(false);
  };

  return (
    <tr className="border-t border-line/60 hover:bg-panel-2/60">
      <td className="max-w-[26rem] truncate py-1.5 pr-4 font-mono text-ink-2" title={field.path}>
        {field.key || <span className="text-ink-3">(root)</span>}
      </td>
      <td className="py-1.5 pr-4 font-mono">
        <span className={staged !== undefined ? "text-gold-2" : "text-ink"}>{display}</span>
      </td>
      <td className="py-1.5">
        {editing ? (
          <input
            autoFocus
            value={draft}
            inputMode={numeric ? "numeric" : "text"}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
            className="w-28 rounded border border-gold bg-app px-2 py-1 font-mono text-xs text-ink outline-none"
          />
        ) : (
          <button
            onClick={() => {
              setDraft(display);
              setEditing(true);
            }}
            className="rounded border border-line-2 px-2 py-1 text-[11px] text-ink-3 transition hover:border-gold/60 hover:text-gold-2"
          >
            Edit
          </button>
        )}
      </td>
    </tr>
  );
}
