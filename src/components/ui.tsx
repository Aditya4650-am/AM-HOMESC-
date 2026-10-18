import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/* ----------------------------------------------------------------- toast -- */

export interface Toast {
  id: number;
  tone: "ok" | "warn" | "err" | "info";
  title: string;
  detail?: string;
}

interface ToastApi {
  push: (t: Omit<Toast, "id">) => void;
  ok: (title: string, detail?: string) => void;
  warn: (title: string, detail?: string) => void;
  err: (title: string, detail?: string) => void;
  info: (title: string, detail?: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

let toastSeq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = ++toastSeq;
      setToasts((prev) => [...prev.slice(-4), { ...t, id }]);
      // Errors linger; everything else clears on its own.
      const ms = t.tone === "err" ? 9000 : 4200;
      timers.current.set(id, setTimeout(() => dismiss(id), ms));
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      push,
      ok: (title, detail) => push({ tone: "ok", title, detail }),
      warn: (title, detail) => push({ tone: "warn", title, detail }),
      err: (title, detail) => push({ tone: "err", title, detail }),
      info: (title, detail) => push({ tone: "info", title, detail }),
    }),
    [push],
  );

  const toneRing: Record<Toast["tone"], string> = {
    ok: "border-ok/40 bg-ok/10",
    warn: "border-warn/40 bg-warn/10",
    err: "border-err/40 bg-err/10",
    info: "border-info/40 bg-info/10",
  };
  const toneText: Record<Toast["tone"], string> = {
    ok: "text-ok",
    warn: "text-warn",
    err: "text-err",
    info: "text-info",
  };

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(26rem,92vw)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`animate-rise pointer-events-auto rounded-lg border bg-panel/95 p-3 shadow-xl shadow-black/10 backdrop-blur-md ${toneRing[t.tone]}`}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className={`text-sm font-semibold ${toneText[t.tone]}`}>{t.title}</div>
                {t.detail ? (
                  <div className="mt-1 text-xs leading-relaxed break-words text-ink-2">{t.detail}</div>
                ) : null}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                className="shrink-0 rounded p-1 text-ink-3 transition hover:bg-panel-3 hover:text-ink"
                aria-label="Dismiss"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------------------------------------------------------------- layout -- */

export function Panel({
  title,
  description,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-line bg-panel shadow-lg shadow-black/10 ${className}`}>
      {title || actions ? (
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-semibold tracking-wide text-ink">{title}</h2> : null}
            {description ? <p className="mt-1 text-xs leading-relaxed text-ink-3">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className="p-5">{children}</div>
    </section>
  );
}

/* ---------------------------------------------------------------- button -- */

type ButtonVariant = "gold" | "ghost" | "danger" | "subtle";

const buttonVariants: Record<ButtonVariant, string> = {
  gold: "bg-gold text-[#3b2a00] hover:brightness-105 disabled:bg-gold-dim disabled:text-ink-3",
  ghost: "border border-line-2 bg-panel-2 text-ink hover:border-gold/50 hover:text-gold-2",
  subtle: "bg-panel-2 text-ink-2 hover:bg-panel-3 hover:text-ink",
  danger: "border border-err/40 bg-err/10 text-err hover:bg-err/20",
};

export function Button({
  variant = "ghost",
  className = "",
  loading = false,
  disabled,
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  loading?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${buttonVariants[variant]} ${className}`}
    >
      {loading ? <Spinner size={13} /> : null}
      {children}
    </button>
  );
}

export function Spinner({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={`animate-spin-slow ${className}`} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ form -- */

export function NumberField({
  label,
  hint,
  value,
  onCommit,
  min,
  max,
  warning,
}: {
  label: string;
  hint?: string;
  value: number | null;
  onCommit: (n: number) => void;
  min?: number;
  max?: number;
  warning?: string;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync when the server value changes underneath us (after an apply).
  useEffect(() => {
    if (!dirty) setDraft(value === null ? "" : String(value));
  }, [value, dirty]);

  const commit = () => {
    if (draft.trim() === "") {
      setError("enter a value");
      return;
    }
    const n = Number(draft);
    if (!Number.isFinite(n)) {
      setError("not a number");
      return;
    }
    if (min !== undefined && n < min) {
      setError(`min ${min}`);
      return;
    }
    if (max !== undefined && n > max) {
      setError(`max ${max.toLocaleString("en-US")}`);
      return;
    }
    setError(null);
    setDirty(false);
    if (n !== value) onCommit(n);
  };

  return (
    <label className="block">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        {value !== null ? (
          <span className="font-mono text-[11px] text-ink-3">now {value.toLocaleString("en-US")}</span>
        ) : null}
      </div>
      <input
        type="number"
        inputMode="numeric"
        value={draft}
        min={min}
        max={max}
        onChange={(e) => {
          setDraft(e.target.value);
          setDirty(true);
          setError(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(value === null ? "" : String(value));
            setDirty(false);
            setError(null);
          }
        }}
        className={`mt-1.5 w-full rounded-lg border bg-app px-3 py-2 font-mono text-sm text-ink outline-none transition ${
          error ? "border-err" : "border-line-2 focus:border-gold"
        }`}
      />
      {error ? (
        <div className="mt-1 text-[11px] text-err">{error}</div>
      ) : warning ? (
        <div className="mt-1 text-[11px] leading-snug text-warn/80">{warning}</div>
      ) : hint ? (
        <div className="mt-1 text-[11px] leading-snug text-ink-3">{hint}</div>
      ) : null}
    </label>
  );
}

export function TextField({
  label,
  hint,
  value,
  onCommit,
}: {
  label: string;
  hint?: string;
  value: string | null;
  onCommit: (s: string) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  return (
    <label className="block">
      <span className="text-[13px] font-medium text-ink">{label}</span>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
        className="mt-1.5 w-full rounded-lg border border-line-2 bg-app px-3 py-2 font-mono text-sm text-ink outline-none transition focus:border-gold"
      />
      {hint ? <div className="mt-1 text-[11px] text-ink-3">{hint}</div> : null}
    </label>
  );
}

/* ----------------------------------------------------------------- misc -- */

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "gold" | "ok" | "warn" | "err" | "info";
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    neutral: "border-line-2 bg-panel-2 text-ink-2",
    gold: "border-gold/40 bg-gold/10 text-gold-2",
    ok: "border-ok/40 bg-ok/10 text-ok",
    warn: "border-warn/40 bg-warn/10 text-warn",
    err: "border-err/40 bg-err/10 text-err",
    info: "border-info/40 bg-info/10 text-info",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-2 px-6 py-12 text-center">
      <div className="text-sm font-medium text-ink-2">{title}</div>
      {detail ? <div className="max-w-md text-xs leading-relaxed text-ink-3">{detail}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function KeyValue({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/60 py-1.5 last:border-0">
      <span className="text-xs text-ink-3">{k}</span>
      <span className="font-mono text-xs text-ink">{v}</span>
    </div>
  );
}

/* --------------------------------------------------------- premium kit -- */

/** Uppercase toned card header (matches `.panel-head` in styles.css). */
export function PanelHead({
  tone = "cyan",
  icon,
  children,
  right,
}: {
  tone?: "cyan" | "amber" | "gold" | "navy";
  icon?: ReactNode;
  children: ReactNode;
  right?: ReactNode;
}) {
  const toneCls =
    tone === "amber"
      ? "panel-head--amber"
      : tone === "gold"
        ? "panel-head--gold"
        : tone === "navy"
          ? "panel-head--violet"
          : "";
  return (
    <div className={`panel-head ${toneCls}`}>
      {icon ? <span aria-hidden>{icon}</span> : null}
      <span>{children}</span>
      {right ? <span className="panel-head__right">{right}</span> : null}
    </div>
  );
}

/** Real game icon (webp) with emoji fallback when the asset is missing. */
export function GameIcon({
  src,
  emoji,
  size = 20,
  className = "",
}: {
  src: string;
  emoji: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <span className={className} style={{ fontSize: size * 0.8, lineHeight: 1 }} aria-hidden>
        {emoji}
      </span>
    );
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      loading="lazy"
      onError={() => setFailed(true)}
      className={className}
      style={{ width: size, height: size, objectFit: "contain", display: "block" }}
    />
  );
}

/** KPI tile: emoji block + big tabular number + label. */
export function KpiTile({
  emoji,
  icon,
  value,
  label,
  title,
}: {
  emoji: string;
  icon?: string;
  value: ReactNode;
  label: string;
  title?: string;
}) {
  return (
    <div className="kpi-tile" title={title}>
      <span className="kpi-emoji" aria-hidden>
        {icon ? <GameIcon src={icon} emoji={emoji} size={26} /> : emoji}
      </span>
      <div className="min-w-0">
        <div className="kpi-num truncate">{value}</div>
        <div className="kpi-label truncate">{label}</div>
      </div>
    </div>
  );
}

/** Preset pill button (aria-pressed for selected state). */
export function PresetPill({
  children,
  active = false,
  gold = false,
  title,
  onClick,
}: {
  children: ReactNode;
  active?: boolean;
  gold?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={`preset-pill ${gold ? "preset-pill--gold" : ""}`}
    >
      {children}
    </button>
  );
}

/** Row of preset pills + optional custom quantity box. */
export function PresetRow({
  options,
  active,
  onPick,
  children,
}: {
  options: Array<{ label: string; value: number | "max"; title?: string }>;
  active?: number | "max" | null;
  onPick: (v: number | "max") => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((o) => (
        <PresetPill
          key={o.label}
          gold
          title={o.title}
          active={active === o.value}
          onClick={() => onPick(o.value)}
        >
          {o.label}
        </PresetPill>
      ))}
      {children}
    </div>
  );
}

/** Toggle-chip inventory tile (check square + emoji + label). */
export function ChipToggle({
  emoji,
  label,
  checked,
  onChange,
  title,
}: {
  emoji: string;
  label: string;
  checked: boolean;
  onChange: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      title={title ?? label}
      onClick={onChange}
      className="inv-chip"
    >
      <span className="inv-chip__check" aria-hidden>
        ✓
      </span>
      <span className="inv-chip__emoji" aria-hidden>
        {emoji}
      </span>
      <span className="inv-chip__label">{label}</span>
    </button>
  );
}

/** Badge pill (`.state-badge` family). */
export function StateBadge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "ready" | "gold" | "navy" | "cyan" | "warn";
  children: ReactNode;
}) {
  const map = {
    neutral: "",
    ready: "state-badge--ready",
    gold: "state-badge--gold",
    navy: "state-badge--violet",
    cyan: "state-badge--cyan",
    warn: "state-badge--warn",
  } as const;
  return <span className={`state-badge ${map[tone]}`}>{children}</span>;
}

/** Section hint bar: text left, bulk action buttons right. */
export function Bar({ hint, children }: { hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {hint ? <p className="mr-auto text-sm text-ink-2">{hint}</p> : null}
      {children}
    </div>
  );
}

/** Search input with leading glyph (`.field-shell` family). */
export function SearchBox({
  value,
  onChange,
  placeholder = "Search…",
  className = "",
}: {
  value: string;
  onChange: (s: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <span className={`field-shell ${className}`}>
      <span className="field-shell__icon" aria-hidden>
        🔍
      </span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="field w-48"
      />
    </span>
  );
}

/**
 * Tonal stat card: emoji + label + big mono input + preset pills + staged
 * indicator. `live` is the server value; `staged` the pending override.
 * Presets receive the value to stage (`"max"` resolves via `maxValue`).
 */
export function StatCard({
  tone,
  emoji,
  icon,
  label,
  live,
  staged,
  presets,
  maxValue,
  hint,
  warning,
  min,
  max,
  onCommit,
}: {
  tone: number;
  emoji: string;
  icon?: string;
  label: string;
  live: number | null;
  staged?: number;
  presets?: Array<{ label: string; value: number; title?: string }>;
  maxValue?: number;
  hint?: string;
  warning?: string;
  min?: number;
  max?: number;
  onCommit: (n: number) => void;
}) {
  const shown = staged !== undefined ? staged : live;
  const isStaged = staged !== undefined && staged !== live;
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) setDraft(shown === null ? "" : String(shown));
  }, [shown, dirty]);

  const commit = () => {
    if (draft.trim() === "") {
      setErr("required");
      return;
    }
    const n = Number(draft);
    if (!Number.isFinite(n)) {
      setErr("not a number");
      return;
    }
    if (min !== undefined && n < min) {
      setErr(`min ${min}`);
      return;
    }
    if (max !== undefined && n > max) {
      setErr(`max ${max.toLocaleString("en-US")}`);
      return;
    }
    setErr(null);
    setDirty(false);
    if (n !== shown) onCommit(n);
  };

  return (
    <div className="stat-card" data-tone={String(((tone - 1) % 7) + 1)}>
      <div className="stat-title">
        <span className="stat-emoji" aria-hidden>
          {icon ? <GameIcon src={icon} emoji={emoji} size={18} /> : emoji}
        </span>
        <span className="truncate">{label}</span>
        {isStaged ? (
          <span className="ml-auto">
            <StateBadge tone="gold">staged</StateBadge>
          </span>
        ) : null}
      </div>
      <input
        className="stat-value"
        inputMode="numeric"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setDirty(true);
          setErr(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDirty(false);
            setErr(null);
            setDraft(shown === null ? "" : String(shown));
          }
        }}
      />
      {presets && presets.length > 0 ? (
        <PresetRow
          options={presets.map((p) => ({ label: p.label, value: p.value, title: p.title }))}
          active={isStaged ? staged : null}
          onPick={(v) => {
            const target = v === "max" ? maxValue : Number(v);
            if (typeof target === "number" && Number.isFinite(target)) onCommit(target);
          }}
        />
      ) : null}
      {err ? (
        <div className="text-[11px] text-err">{err}</div>
      ) : isStaged ? (
        <div className="font-mono text-[11px] text-ink-3">
          {String(live)} → {String(staged)}
        </div>
      ) : warning ? (
        <div className="text-[11px] leading-snug text-warn">{warning}</div>
      ) : hint ? (
        <div className="text-[11px] leading-snug text-ink-3">{hint}</div>
      ) : null}
    </div>
  );
}

/** Premium feature row: icon tile + name/sub + right-aligned controls. */
export function FeatureRow({
  emoji,
  icon,
  name,
  sub,
  controls,
}: {
  emoji: string;
  icon?: string;
  name: ReactNode;
  sub?: ReactNode;
  controls?: ReactNode;
}) {
  return (
    <div className="feature-row">
      <span className="feature-row__icon" aria-hidden>
        {icon ? <GameIcon src={icon} emoji={emoji} size={21} /> : emoji}
      </span>
      <div className="min-w-0">
        <div className="feature-row__name">{name}</div>
        {sub ? <div className="feature-row__sub">{sub}</div> : null}
      </div>
      {controls ? <div className="feature-row__controls">{controls}</div> : null}
    </div>
  );
}

/* ==========================================================================
   AM reference components — recreated to match the supplied dashboard
   screenshot (light blue / white, blue checkboxes, ghost buttons).
   ========================================================================== */

/** Reference-matched checkbox. Reflects real application state via `on`. */
export function AmCheck({
  on,
  onChange,
  label,
  title,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  title?: string;
}) {
  const btn = (
    <button
      type="button"
      className={`am-check ${on ? "am-check--on" : ""}`}
      role="checkbox"
      aria-checked={on}
      title={title}
      onClick={() => onChange(!on)}
    >
      {on ? (
        <svg viewBox="0 0 16 16" aria-hidden>
          <path
            d="M3.2 8.4l3 3 6.6-6.8"
            fill="none"
            stroke="#ffffff"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </button>
  );
  if (label === undefined) return btn;
  return (
    <span
      className="am-checkrow-left"
      onClick={() => onChange(!on)}
      role="presentation"
    >
      {btn}
      <span>{label}</span>
    </span>
  );
}

/** Select All / Deselect bar with a live selection count. */
export function AmBar({
  count,
  total,
  onAll,
  onNone,
  hint,
}: {
  count: number;
  total: number;
  onAll: () => void;
  onNone: () => void;
  hint?: string;
}) {
  return (
    <div className="am-checkbar">
      <button type="button" className="am-ghost am-ghost--primary" onClick={onAll}>
        Select All
      </button>
      <button type="button" className="am-ghost" onClick={onNone}>
        Deselect All
      </button>
      <span className="am-checkbar-count">
        {count} / {total} selected
      </span>
      {hint ? <span className="am-hint">{hint}</span> : null}
    </div>
  );
}

/** Selectable asset tile used by the Cards / Frames / Styles / Badges grids. */
export function AmTile({
  on,
  onToggle,
  label,
  art,
  emoji,
  state,
}: {
  on: boolean;
  onToggle: () => void;
  label: ReactNode;
  art?: string;
  emoji?: string;
  state?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`am-tile ${on ? "am-tile--on" : ""}`}
      aria-pressed={on}
      onClick={onToggle}
    >
      {art ? (
        <img className="am-tile-art" src={art} alt="" loading="lazy" />
      ) : (
        <span className="am-tile-emoji" aria-hidden>
          {emoji ?? "❔"}
        </span>
      )}
      <span className="am-tile-label">{label}</span>
      {state !== undefined ? <span className="am-tile-state">{state}</span> : null}
    </button>
  );
}

/** Shared "no save loaded" state — honest, per the spec's integrity rules. */
export function AmEmpty({
  title,
  detail,
  actions,
}: {
  title: string;
  detail: string;
  actions?: ReactNode;
}) {
  return (
    <div className="am-empty">
      <div className="am-empty-title">{title}</div>
      <div className="am-empty-detail">{detail}</div>
      {actions ? <div className="am-empty-actions">{actions}</div> : null}
    </div>
  );
}
