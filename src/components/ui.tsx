"use client";

import { useId } from "react";

export function Button({
  children,
  variant = "secondary",
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  const look = {
    primary: "bg-straw text-straw-ink hover:bg-[#ebc670] font-semibold",
    secondary: "bg-raised text-fg hover:bg-[#35363a] font-medium",
    ghost: "text-muted hover:text-fg font-medium",
  }[variant];
  return (
    <button
      {...rest}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-[3px] px-3.5 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${look} ${className}`}
    >
      {children}
    </button>
  );
}

export function Switch({ label, hint, on, set }: { label: string; hint?: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => set(!on)}
      className="group flex w-full items-center justify-between gap-4 text-left"
    >
      <span>
        <span className="block text-fg">{label}</span>
        {hint && <span className="block text-[12px] text-muted">{hint}</span>}
      </span>
      <span className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors duration-150 ${on ? "bg-straw" : "bg-hairline"}`}>
        <span
          className={`absolute top-[3px] h-3 w-3 rounded-full transition-transform duration-150 ${on ? "translate-x-[17px] bg-straw-ink" : "translate-x-[3px] bg-muted"}`}
        />
      </span>
    </button>
  );
}

export function Slider({
  label,
  value,
  unit = "",
  min,
  max,
  step = 1,
  format,
  disabled,
  set,
}: {
  label: string;
  value: number;
  unit?: string;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  disabled?: boolean;
  set: (v: number) => void;
}) {
  const id = useId();
  return (
    <div className={disabled ? "opacity-40" : undefined}>
      <div className="flex items-baseline justify-between">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id} className="text-muted">
          {format ? format(value) : `${value}${unit}`}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => set(Number(e.target.value))}
        className="w-full"
      />
    </div>
  );
}

export function ColorField({ label, value, set }: { label: string; value: string; set: (v: string) => void }) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <span className="flex items-center gap-2">
        <span className="font-mono text-[12px] text-muted">{value.toUpperCase()}</span>
        <input type="color" value={value} onChange={(e) => set(e.target.value)} className="h-7 w-9 cursor-pointer rounded-[3px] border border-hairline bg-transparent p-0.5" />
      </span>
    </label>
  );
}

/** Thin determinate bar; width eases so 1 Hz updates still read as continuous motion. */
export function Progress({ value, secondary, tone = "straw" }: { value: number; secondary?: number; tone?: "straw" | "pop" | "muted" }) {
  const color = { straw: "bg-straw", pop: "bg-pop", muted: "bg-muted" }[tone];
  return (
    <div className="relative h-1 overflow-hidden rounded-full bg-hairline" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      {secondary !== undefined && (
        <div className="absolute inset-y-0 left-0 bg-[#5a5144] transition-[width] duration-300 ease-linear" style={{ width: `${Math.min(1, secondary) * 100}%` }} />
      )}
      <div className={`absolute inset-y-0 left-0 ${color} transition-[width] duration-300 ease-linear`} style={{ width: `${Math.min(1, value) * 100}%` }} />
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  disabled = [],
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  disabled?: T[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid auto-cols-fr grid-flow-col rounded-[3px] bg-surround p-[3px]">
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={v === value}
          disabled={disabled.includes(v)}
          onClick={() => onChange(v)}
          className={`h-8 rounded-[2px] px-2 text-[13px] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-35 ${
            v === value ? "bg-raised font-medium text-fg" : "text-muted hover:text-fg"
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export function TextField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[12px] text-muted">
        {label}
      </label>
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-[3px] border border-transparent bg-surround px-2.5 font-mono text-[12px] text-fg placeholder:font-sans placeholder:text-[13px] placeholder:text-faint focus:border-hairline focus:outline-none"
      />
    </div>
  );
}

/** Presence indicator that doesn't rely on color: filled = present, ring = missing. */
export function Status({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${ok ? "text-fg" : "text-muted"}`}>
      <span className={`h-2 w-2 rounded-full ${ok ? "bg-straw" : "border border-muted"}`} aria-hidden />
      {children}
    </span>
  );
}

/** Choices that need a sentence to be understood. */
export function RadioList<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string, string][];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-[12px] text-muted">{label}</legend>
      <div className="space-y-px overflow-hidden rounded-[3px]">
        {options.map(([v, title, hint]) => (
          <label
            key={v}
            className={`flex cursor-pointer items-start gap-3 px-3 py-2 transition-colors duration-150 ${v === value ? "bg-raised" : "bg-surround hover:bg-[#1f2021]"}`}
          >
            <input type="radio" className="mt-1 accent-[#e0b85c]" checked={v === value} onChange={() => onChange(v)} />
            <span>
              <span className="block text-fg">{title}</span>
              <span className="block text-[12px] text-muted">{hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A labeled group of controls. */
export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[12px] text-muted">{label}</p>
      {children}
      {hint && <p className="text-[12px] text-muted">{hint}</p>}
    </div>
  );
}

/** A titled block inside a panel, separated from the next by space rather than a box. */
export function Group({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-b border-hairline px-4 py-4 last:border-b-0">
      <div className="flex items-baseline justify-between">
        <h3 className="font-cond text-[15px] font-semibold tracking-[0.01em] text-fg">{title}</h3>
        {aside && <span className="text-[12px] text-muted">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

export function Tabs<T extends string>({
  label,
  value,
  tabs,
  onChange,
}: {
  label: string;
  value: T;
  tabs: [T, string, boolean?][];
  onChange: (v: T) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-hairline px-3">
      {tabs.map(([v, l, dot]) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={v === value}
          onClick={() => onChange(v)}
          className={`relative flex h-11 items-center gap-1.5 px-2.5 text-[13px] transition-colors duration-150 ${
            v === value ? "font-medium text-fg" : "text-muted hover:text-fg"
          }`}
        >
          {l}
          {dot && <span className="h-1.5 w-1.5 rounded-full bg-straw" aria-label="active" />}
          {v === value && <span className="absolute inset-x-2 -bottom-px h-[2px] bg-straw" aria-hidden />}
        </button>
      ))}
    </div>
  );
}
