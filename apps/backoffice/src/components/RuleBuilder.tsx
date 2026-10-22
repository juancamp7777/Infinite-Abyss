"use client";

import { useState } from "react";
import { Button, inputCls } from "./ui";

export type Condition = { field: string; op: string; value?: unknown };
export type Group = { all?: Rule[]; any?: Rule[] };
export type Rule = Condition | Group;

export const FIELDS: Array<{ id: string; label: string; kind: "number" | "text" | "date" | "list" }> = [
  { id: "country", label: "País", kind: "text" },
  { id: "currency", label: "Moneda", kind: "text" },
  { id: "totalDeposits", label: "Total depositado", kind: "number" },
  { id: "depositCount", label: "N.º de depósitos", kind: "number" },
  { id: "totalWithdrawals", label: "Total retirado", kind: "number" },
  { id: "totalWagered", label: "Total apostado", kind: "number" },
  { id: "betCount", label: "N.º de apuestas", kind: "number" },
  { id: "ltv", label: "LTV", kind: "number" },
  { id: "ggr", label: "GGR", kind: "number" },
  { id: "vipScore", label: "VIP score", kind: "number" },
  { id: "churnRisk", label: "Riesgo de abandono (low/medium/high)", kind: "text" },
  { id: "daysSinceLastActivity", label: "Días sin actividad", kind: "number" },
  { id: "activeDays30", label: "Días activos (30d)", kind: "number" },
  { id: "registeredAt", label: "Fecha de registro", kind: "date" },
  { id: "firstDepositAt", label: "Primer depósito", kind: "date" },
  { id: "lastDepositAt", label: "Último depósito", kind: "date" },
  { id: "lastLoginAt", label: "Último login", kind: "date" },
  { id: "lastBetAt", label: "Última apuesta", kind: "date" },
  { id: "favoriteCategory", label: "Categoría favorita", kind: "text" },
  { id: "favoriteGame", label: "Juego favorito", kind: "text" },
  { id: "tags", label: "Etiquetas", kind: "list" },
  { id: "affiliateCode", label: "Código de afiliado", kind: "text" },
  { id: "utmSource", label: "UTM source", kind: "text" },
];

const OPS: Array<{ id: string; label: string }> = [
  { id: "eq", label: "es igual a" }, { id: "neq", label: "es distinto de" }, { id: "gt", label: ">" }, { id: "gte", label: "≥" }, { id: "lt", label: "<" }, { id: "lte", label: "≤" },
  { id: "in", label: "está en (a,b,c)" }, { id: "nin", label: "no está en" }, { id: "contains", label: "contiene" }, { id: "exists", label: "existe" },
  { id: "within_days", label: "en los últimos N días" }, { id: "older_than_days", label: "hace más de N días" },
];

export const isGroup = (r: Rule): r is Group => "all" in r || "any" in r;
const MAX_DEPTH = 4;

export const emptyCondition = (): Condition => ({ field: "totalDeposits", op: "gte", value: 0 });
export const emptyRule = (): Group => ({ all: [emptyCondition()] });

function coerce(op: string, raw: string): unknown {
  if (op === "exists") return undefined;
  if (op === "in" || op === "nin") return raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => (s !== "" && !Number.isNaN(Number(s)) ? Number(s) : s));
  if (["gt", "gte", "lt", "lte", "within_days", "older_than_days"].includes(op)) return raw === "" || Number.isNaN(Number(raw)) ? 0 : Number(raw);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
}

const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === undefined || v === null ? "" : String(v));

function ConditionRow({ c, onChange, onRemove, canRemove }: { c: Condition; onChange(c: Condition): void; onRemove(): void; canRemove: boolean }) {
  const [raw, setRaw] = useState(show(c.value));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Campo" className={`${inputCls} w-52`} value={c.field} onChange={(e) => onChange({ ...c, field: e.target.value })}>
        {FIELDS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
      </select>
      <select aria-label="Operador" className={`${inputCls} w-48`} value={c.op} onChange={(e) => onChange({ field: c.field, op: e.target.value, value: coerce(e.target.value, raw) })}>
        {OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      {c.op !== "exists" && (
        <input aria-label="Valor" className={`${inputCls} w-44`} value={raw} onChange={(e) => { setRaw(e.target.value); onChange({ ...c, value: coerce(c.op, e.target.value) }); }} />
      )}
      <Button variant="ghost" onClick={onRemove} disabled={!canRemove} aria-label="Quitar condición">✕</Button>
    </div>
  );
}

/** Constructor visual del DSL de segmentos: grupos all/any anidados con condiciones. */
export function RuleBuilder({ rule, onChange, depth = 0, onRemove }: { rule: Group; onChange(r: Group): void; depth?: number; onRemove?: () => void }) {
  const mode: "all" | "any" = rule.any ? "any" : "all";
  const children = (rule.all ?? rule.any ?? []) as Rule[];
  const set = (kids: Rule[], m: "all" | "any" = mode) => onChange(m === "all" ? { all: kids } : { any: kids });

  return (
    <div className={`space-y-2 rounded-lg border border-white/10 p-3 ${depth % 2 ? "bg-white/[0.03]" : "bg-black/20"}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-white/60">Cumple</span>
        <select aria-label="Modo del grupo" className={`${inputCls} w-40`} value={mode} onChange={(e) => set(children, e.target.value as "all" | "any")}>
          <option value="all">TODAS (AND)</option>
          <option value="any">ALGUNA (OR)</option>
        </select>
        <span className="text-white/60">de estas reglas:</span>
        {onRemove && <Button variant="ghost" className="ml-auto" onClick={onRemove}>Quitar grupo</Button>}
      </div>
      {children.map((child, i) => (
        <div key={i} className="pl-2">
          {isGroup(child) ? (
            <RuleBuilder rule={child} depth={depth + 1} onChange={(g) => set(children.map((x, j) => (j === i ? g : x)))} onRemove={() => set(children.filter((_, j) => j !== i))} />
          ) : (
            <ConditionRow c={child} canRemove={children.length > 1} onChange={(c) => set(children.map((x, j) => (j === i ? c : x)))} onRemove={() => set(children.filter((_, j) => j !== i))} />
          )}
        </div>
      ))}
      <div className="flex gap-2 pl-2">
        <Button variant="ghost" onClick={() => set([...children, emptyCondition()])}>+ Condición</Button>
        {depth < MAX_DEPTH && <Button variant="ghost" onClick={() => set([...children, { any: [emptyCondition()] }])}>+ Grupo</Button>}
      </div>
    </div>
  );
}
