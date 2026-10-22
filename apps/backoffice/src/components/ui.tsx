"use client";

import { useState, type ReactNode } from "react";

export const inputCls =
  "w-full rounded-md border border-white/15 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-400/40 disabled:opacity-50";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold text-white">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-white/60">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, children, className = "", actions }: { title?: string; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <section className={`rounded-xl border border-white/10 bg-white/[0.04] p-4 ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-medium uppercase tracking-wide text-white/70">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

type BtnVariant = "primary" | "ghost" | "danger";
export function Button({ variant = "primary", className = "", ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant }) {
  const v = {
    primary: "bg-violet-600 text-white hover:bg-violet-500",
    ghost: "border border-white/15 text-white/90 hover:bg-white/10",
    danger: "bg-red-600/80 text-white hover:bg-red-500",
  }[variant];
  return (
    <button
      type="button"
      {...p}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 disabled:cursor-not-allowed disabled:opacity-50 ${v} ${className}`}
    />
  );
}

export function Spinner({ label = "Cargando…" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-3 py-8 text-sm text-white/60">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-violet-400" />
      {label}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
      <span>{message}</span>
      {onRetry && (
        <Button variant="ghost" onClick={onRetry}>
          Reintentar
        </Button>
      )}
    </div>
  );
}

export function Empty({ children = "Sin datos para mostrar." }: { children?: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-white/15 p-8 text-center text-sm text-white/50">{children}</div>;
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "ok"; children: ReactNode }) {
  const c = { info: "border-sky-400/40 bg-sky-400/10 text-sky-100", warn: "border-amber-400/40 bg-amber-400/10 text-amber-100", ok: "border-emerald-400/40 bg-emerald-400/10 text-emerald-100" }[tone];
  return (
    <div role={tone === "warn" ? "alert" : "status"} className={`rounded-lg border p-3 text-sm ${c}`}>
      {children}
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "bad" | "warn" }) {
  const c = { neutral: "bg-white/10 text-white/80", good: "bg-emerald-500/20 text-emerald-200", bad: "bg-red-500/20 text-red-200", warn: "bg-amber-500/20 text-amber-200" }[tone];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${c}`}>{children}</span>;
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-white/70">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-white/40">{hint}</p>}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
      <div className="text-xs uppercase tracking-wide text-white/50">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-red-300" : "text-white"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-white/40">{sub}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: NoInfer<T>; label: string }>; value: T; onChange: (v: NoInfer<T>) => void }) {
  return (
    <div role="tablist" className="mb-4 flex flex-wrap gap-1 border-b border-white/10">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 ${value === t.id ? "border-violet-400 text-white" : "border-transparent text-white/60 hover:text-white"}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
  className?: string;
}

/** Tabla paginada en cliente, con scroll horizontal en móvil. */
export function DataTable<T>({ rows, columns, pageSize = 10, empty, rowKey, onRowClick }: { rows: T[]; columns: Column<T>[]; pageSize?: number; empty?: ReactNode; rowKey?: (r: T, i: number) => string; onRowClick?: (r: T) => void }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const cur = Math.min(page, pages - 1);
  const slice = rows.slice(cur * pageSize, cur * pageSize + pageSize);
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-white/5 text-xs uppercase text-white/50">
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={`px-3 py-2 font-medium ${c.className ?? ""}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {slice.map((r, i) => (
              <tr
                key={rowKey ? rowKey(r, i) : i}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                className={onRowClick ? "cursor-pointer hover:bg-white/5" : ""}
              >
                {columns.map((c) => (
                  <td key={c.key} className={`px-3 py-2 align-top text-white/90 ${c.className ?? ""}`}>
                    {c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="mt-3 flex items-center justify-between text-xs text-white/60">
          <span>
            {cur * pageSize + 1}–{Math.min(rows.length, (cur + 1) * pageSize)} de {rows.length}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" disabled={cur === 0} onClick={() => setPage(cur - 1)} aria-label="Página anterior">
              ←
            </Button>
            <span aria-live="polite">
              {cur + 1}/{pages}
            </span>
            <Button variant="ghost" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} aria-label="Página siguiente">
              →
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function NeedOperator() {
  return <Notice tone="warn">Elige un operador en la barra superior para ver esta sección.</Notice>;
}
