"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { money, toMinor } from "@/lib/format";
import { inputCls } from "@/components/ui";

export interface TimeWindow { days: number[]; start: string; end: string }

const DAYS = ["D", "L", "M", "M", "J", "V", "S"];
const DAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** Interruptor accesible con título y explicación en lenguaje claro. */
export function Toggle({ label, hint, checked, onChange, danger }: { label: string; hint?: string; checked: boolean; onChange(v: boolean): void; danger?: boolean }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-white/10 bg-white/[.02] p-3 hover:border-white/20">
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-white/50">{hint}</span>}
      </span>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input type="checkbox" role="switch" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className={`h-6 w-11 rounded-full transition ${checked ? (danger ? "bg-red-500" : "bg-emerald-500") : "bg-white/15"} peer-focus-visible:ring-2 peer-focus-visible:ring-amber-300`} />
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${checked ? "left-[1.4rem]" : "left-0.5"}`} />
      </span>
    </label>
  );
}

/** Monto en la moneda del casino (lo que se escribe es "50.000"; lo que se guarda, centavos). */
export function MoneyInput({ id, value, onChange, currency, placeholder }: { id: string; value: string | null; onChange(v: string | null): void; currency: string; placeholder?: string }) {
  const shown = (v: string | null) => (v && v !== "0" ? money(v, currency).replace(/^[^\d-]+/, "") : "");
  const [text, setText] = useState(shown(value));
  useEffect(() => setText(shown(value)), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const bad = text.trim() !== "" && !toMinor(text);
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-white/40">{currency}</span>
        <input id={id} inputMode="decimal" className={`${inputCls} w-full ${bad ? "border-red-400" : ""}`} value={text} placeholder={placeholder ?? "0"}
          onChange={(e) => { setText(e.target.value); const m = toMinor(e.target.value); onChange(e.target.value.trim() === "" ? null : m); }} />
      </div>
      {bad && <p className="mt-1 text-xs text-red-300">Escribe un monto como 50.000 o 50.000,50</p>}
    </div>
  );
}

export function PctInput({ id, value, onChange, max = 200 }: { id: string; value: number; onChange(v: number): void; max?: number }) {
  return (
    <div className="flex items-center gap-2">
      <input id={id} type="number" min={0} max={max} className={`${inputCls} w-24`} value={value} onChange={(e) => onChange(Math.max(0, Math.min(max, Math.round(Number(e.target.value) || 0))))} />
      <span className="text-sm text-white/50">%</span>
    </div>
  );
}

const describe = (w: TimeWindow) => {
  const d = w.days.length === 7 ? "Todos los días" : w.days.length === 5 && [1, 2, 3, 4, 5].every((x) => w.days.includes(x)) ? "Lunes a viernes" : w.days.map((x) => DAY_NAMES[x]).join(", ");
  return `${d} · ${w.start} a ${w.end}${w.end <= w.start ? " (termina al día siguiente)" : ""}`;
};

/** Franjas horarias con días de la semana (en RoboBeast aplicaban a todos los días sin poder elegir). */
export function WindowsEditor({ value, onChange, empty }: { value: TimeWindow[]; onChange(v: TimeWindow[]): void; empty: ReactNode }) {
  const set = (i: number, w: TimeWindow) => onChange(value.map((x, j) => (j === i ? w : x)));
  return (
    <div className="space-y-2">
      {value.length === 0 && <p className="text-sm text-white/45">{empty}</p>}
      {value.map((w, i) => (
        <div key={i} className="rounded-xl border border-white/10 bg-white/[.02] p-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1" role="group" aria-label="Días">
              {DAYS.map((d, k) => {
                const on = w.days.includes(k);
                return (
                  <button key={k} type="button" aria-pressed={on} aria-label={DAY_NAMES[k]} onClick={() => { const days = on ? w.days.filter((x) => x !== k) : [...w.days, k].sort(); if (days.length) set(i, { ...w, days }); }}
                    className={`h-8 w-8 rounded-lg text-xs font-bold ${on ? "bg-amber-400 text-black" : "bg-white/5 text-white/50 hover:bg-white/10"}`}>{d}</button>
                );
              })}
            </div>
            <input type="time" aria-label="Desde" className={`${inputCls} w-28`} value={w.start} onChange={(e) => set(i, { ...w, start: e.target.value })} />
            <span className="text-white/40">a</span>
            <input type="time" aria-label="Hasta" className={`${inputCls} w-28`} value={w.end} onChange={(e) => set(i, { ...w, end: e.target.value })} />
            <button type="button" className="ml-auto text-white/40 hover:text-red-300" aria-label="Quitar franja" onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" aria-hidden /></button>
          </div>
          <p className="mt-2 text-xs text-white/45">{describe(w)}</p>
        </div>
      ))}
      <button type="button" className="inline-flex items-center gap-1 text-sm font-semibold text-amber-300 hover:text-amber-200" onClick={() => onChange([...value, { days: [0, 1, 2, 3, 4, 5, 6], start: "20:00", end: "22:00" }])}>
        <Plus className="h-4 w-4" aria-hidden />Agregar franja
      </button>
    </div>
  );
}

/** Vista previa del chat: así ve el jugador los mensajes del bot. */
export function ChatPreview({ botName, lines }: { botName: string; lines: Array<{ from: "bot" | "player"; text: string }> }) {
  const visible = lines.filter((l) => l.text.trim());
  return (
    <div className="rounded-2xl border border-white/10 bg-[#071225] p-3">
      <div className="mb-3 flex items-center gap-2 border-b border-white/10 pb-2">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-amber-300 to-amber-600 text-xs font-black text-black">{botName.slice(0, 2).toUpperCase()}</span>
        <div><div className="text-sm font-semibold">{botName}</div><div className="text-[11px] text-emerald-300">en línea</div></div>
      </div>
      <div className="space-y-2">
        {visible.length === 0 && <p className="py-6 text-center text-xs text-white/40">Escribe los mensajes para ver cómo se verán.</p>}
        {visible.map((l, i) => (
          <div key={i} className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${l.from === "bot" ? "rounded-tl-sm bg-white/10" : "ml-auto rounded-tr-sm bg-amber-400 text-black"}`}>{l.text}</div>
        ))}
      </div>
    </div>
  );
}
