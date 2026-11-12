import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ComponentType,
  type ReactNode,
} from "react";

type Icon = ComponentType<{ size?: number; strokeWidth?: number }>;

export function Button({
  variant = "secondary",
  size = "md",
  icon: IconComponent,
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  icon?: Icon;
}) {
  return (
    <button
      type="button"
      className={`mx-btn mx-btn-${variant} mx-btn-${size} ${className}`}
      {...rest}
    >
      {IconComponent && <IconComponent size={size === "sm" ? 14 : 16} />}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  icon: IconComponent,
  className = "",
  title,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: Icon }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      className={`mx-icon-btn ${className}`}
      {...rest}
    >
      <IconComponent size={16} />
    </button>
  );
}

/** File picker styled as a button. */
export function FileButton({
  accept,
  onFile,
  icon: IconComponent,
  children,
  disabled,
  variant = "secondary",
}: {
  accept: string;
  onFile: (file?: File) => void;
  icon?: Icon;
  children: ReactNode;
  disabled?: boolean;
  variant?: "primary" | "secondary";
}) {
  return (
    <label
      className={`mx-btn mx-btn-${variant} mx-btn-md ${disabled ? "is-disabled" : ""}`}
    >
      {IconComponent && <IconComponent size={16} />}
      {children}
      <input
        type="file"
        accept={accept}
        disabled={disabled}
        hidden
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </label>
  );
}

export function NumberField({
  label,
  value,
  unit,
  change,
  min = 0,
  step: increment = 0.05,
  digits = 4,
}: {
  label: string;
  value: number;
  unit?: string;
  change: (v: number) => void;
  min?: number;
  step?: number;
  /** Decimal places shown; typed values keep their full precision. */
  digits?: number;
}) {
  const shown = String(Number(value.toFixed(digits)));
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  return (
    <label className="mx-field">
      <span className="mx-field-label">{label}</span>
      <span className="mx-number">
        <input
          aria-label={label}
          type="number"
          min={min}
          step={increment}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const number = Number(draft);
            if (draft === shown) return;
            if (draft.trim() && Number.isFinite(number) && number >= min)
              change(number);
            else setDraft(shown);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        {unit && <small>{unit}</small>}
      </span>
    </label>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-field-group">
      <label className="mx-field">
        <span className="mx-field-label">{label}</span>
        {children}
      </label>
      {hint && <span className="mx-field-hint">{hint}</span>}
    </div>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <label className={`mx-toggle ${disabled ? "is-disabled" : ""}`}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="mx-toggle-track" aria-hidden="true" />
      <span className="mx-toggle-text">
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

export function Panel({
  title,
  icon: IconComponent,
  actions,
  children,
  className = "",
  flush,
  label,
}: {
  title?: ReactNode;
  icon?: Icon;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
  label?: string;
}) {
  return (
    <section
      className={`mx-panel ${flush ? "is-flush" : ""} ${className}`}
      aria-label={label}
    >
      {(title || actions) && (
        <header className="mx-panel-head">
          {title && (
            <h2>
              {IconComponent && <IconComponent size={16} />}
              {title}
            </h2>
          )}
          {actions && <div className="mx-panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export type Tone = "neutral" | "accent" | "good" | "warn" | "bad";
export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return <span className={`mx-badge is-${tone}`}>{children}</span>;
}
export function Dot({ tone = "neutral" }: { tone?: Tone }) {
  return <i className={`mx-dot is-${tone}`} aria-hidden="true" />;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; icon?: Icon; title?: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="mx-segmented" role="group" aria-label={label}>
      {options.map(({ value: v, label: text, icon: I, title }) => (
        <button
          type="button"
          key={v}
          className={v === value ? "is-active" : ""}
          aria-pressed={v === value}
          title={title}
          onClick={() => onChange(v)}
        >
          {I && <I size={15} />}
          {text}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  icon: IconComponent,
  title,
  children,
  action,
}: {
  icon: Icon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mx-empty">
      <span className="mx-empty-icon">
        <IconComponent size={22} />
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mx-page-head">
      <div className="mx-page-title">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children}
      {actions && <div className="mx-page-actions">{actions}</div>}
    </header>
  );
}

export function Stat({
  label,
  value,
  unit,
  tone,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  tone?: Tone;
}) {
  return (
    <div className={`mx-stat ${tone ? `is-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>
        {value}
        {unit && <small>{unit}</small>}
      </strong>
    </div>
  );
}

export const deg = (rad: number) => (rad * 180) / Math.PI;
export const rad = (d: number) => (d * Math.PI) / 180;
export function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
export function timeAgo(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}
