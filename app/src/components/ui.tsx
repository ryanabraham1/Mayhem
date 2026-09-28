import { useEffect, useState, type ReactNode } from "react";

export function NumberField({
  label, value, onChange, unit, step = 0.01, min, max, digits = 3, hint, disabled,
}: {
  label?: ReactNode; value: number; onChange: (v: number) => void; unit?: string; step?: number;
  min?: number; max?: number; digits?: number; hint?: ReactNode; disabled?: boolean;
}) {
  const fmt = (v: number) => (Number.isFinite(v) ? String(+v.toFixed(digits)) : "");
  const [text, setText] = useState(fmt(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused]);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const commit = () => {
    const v = parseFloat(text);
    if (!Number.isFinite(v)) {
      setText(fmt(value));
      return;
    }
    const c = clamp(v);
    if (c !== value) onChange(c);
    setText(fmt(c));
  };
  const input = (
    <div className="input-wrap">
      <input
        className="input mono"
        inputMode="decimal"
        value={text}
        disabled={disabled}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(); }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const cur = parseFloat(text) || 0;
            const next = clamp(+(cur + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1)).toFixed(10));
            setText(fmt(next));
            onChange(next);
          }
          e.stopPropagation();
        }}
      />
      {unit && <span className="unit">{unit}</span>}
    </div>
  );
  if (!label) return input;
  return (
    <label className="lbl">
      <span className="lbl-text"><span>{label}</span>{hint && <span>{hint}</span>}</span>
      {input}
    </label>
  );
}

export function AngleField({ label, value, onChange, disabled }: {
  label: ReactNode; value: number; onChange: (rad: number) => void; disabled?: boolean;
}) {
  return (
    <NumberField label={label} value={(value * 180) / Math.PI} unit="deg" digits={1} step={1} disabled={disabled}
      onChange={(d) => onChange((d * Math.PI) / 180)} />
  );
}

export function TextField({ label, value, onChange, placeholder }: {
  label?: ReactNode; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const input = (
    <input className="input" value={text} placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onChange(text)}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />
  );
  if (!label) return input;
  return <label className="lbl"><span>{label}</span>{input}</label>;
}

export function Check({ label, checked, onChange, disabled }: {
  label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Seg<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SelectField<T extends string | number>({ label, value, options, onChange }: {
  label?: ReactNode; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  const sel = (
    <select className="select" value={String(value)}
      onChange={(e) => {
        const o = options.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}>
      {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
    </select>
  );
  if (!label) return sel;
  return <label className="lbl"><span>{label}</span>{sel}</label>;
}

export function Card({ title, actions, children, className = "", bodyClass = "card-body" }: {
  title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string;
}) {
  return (
    <div className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          <div className="card-title">{title}</div>
          {actions}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
    </div>
  );
}

export const fmtTime = (s: number) => `${s.toFixed(2)} s`;
