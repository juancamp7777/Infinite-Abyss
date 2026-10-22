"use client";

import { useId } from "react";

type Props = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  error?: string | null;
  hint?: string;
  autoComplete?: string;
  required?: boolean;
  inputMode?: "text" | "numeric" | "decimal" | "email";
  name?: string;
  placeholder?: string;
  disabled?: boolean;
};

/** Campo con label asociado, ayuda y error enlazados por aria-describedby. */
export function Field({ label, value, onChange, type = "text", error, hint, autoComplete, required, inputMode, name, placeholder, disabled }: Props) {
  const id = useId();
  const errId = `${id}-err`;
  const hintId = `${id}-hint`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-bold text-gray-300 uppercase tracking-widest">
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        required={required}
        inputMode={inputMode}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={[error ? errId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined}
        className="w-full bg-black border border-gold-900/50 rounded-lg p-3 text-white focus:outline-none focus:border-gold-400 disabled:opacity-50"
      />
      {hint && (
        <p id={hintId} className="text-xs text-gray-400">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
