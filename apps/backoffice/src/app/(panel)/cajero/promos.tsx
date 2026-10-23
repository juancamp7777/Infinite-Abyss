"use client";

import { useState } from "react";
import { Eye, Flame, Gift, Image as ImageIcon, Plus, RefreshCw, SmilePlus, Trash2, Zap } from "lucide-react";
import { Badge, Button, Card, Field, inputCls } from "@/components/ui";
import { MoneyInput, PctInput, Toggle, WindowsEditor, type TimeWindow } from "./editors";

interface Base { id: string; name: string; active: boolean; observeOnly: boolean; windows: TimeWindow[]; maxClaimsPerPlayer: number; maxClaimsTotal: number | null; message: string }
export type Promo = Base & (
  | { type: "flash"; keyword: string; bonusPct: number; minDeposit: string | null }
  | { type: "gift"; keyword: string; chips: string }
  | { type: "streak"; steps: number[] }
  | { type: "choice"; options: Array<{ trigger: string; bonusPct: number; reply: string }> }
  | { type: "post_withdraw"; bonusPct: number }
  | { type: "flyer"; bonusPct: number; keyword: string }
);

const TYPES = [
  { type: "flash", icon: Zap, title: "Bono Flash", text: "El cliente escribe una palabra (ej. ABYSS) y su próxima carga lleva bono." },
  { type: "gift", icon: Gift, title: "Regalo de fichas", text: "Escribe la palabra y recibe fichas sin cargar. Con tope de reclamos." },
  { type: "streak", icon: Flame, title: "Racha de cargas", text: "Bono que sube en la 1ª, 2ª y 3ª carga del día." },
  { type: "choice", icon: SmilePlus, title: "Bono a elección", text: "El cliente elige su bono mandando un emoji o palabra." },
  { type: "post_withdraw", icon: RefreshCw, title: "Bono post-retiro", text: "Quien retira y vuelve a cargar el mismo día recibe bono." },
  { type: "flyer", icon: ImageIcon, title: "Bono por flyer", text: "El cliente manda la captura del flyer y su carga lleva bono." },
] as const;

const fresh = (type: Promo["type"]): Promo => {
  const base: Base = { id: crypto.randomUUID().slice(0, 12), name: TYPES.find((t) => t.type === type)!.title, active: false, observeOnly: true, windows: [], maxClaimsPerPlayer: 1, maxClaimsTotal: null, message: "" };
  switch (type) {
    case "flash": return { ...base, type, keyword: "ABYSS", bonusPct: 20, minDeposit: null };
    case "gift": return { ...base, type, keyword: "REGALO", chips: "500000", maxClaimsTotal: 100 };
    case "streak": return { ...base, type, steps: [10, 20, 30] };
    case "choice": return { ...base, type, options: [{ trigger: "🔥", bonusPct: 20, reply: "¡Elegiste fuego! 20 % en tu carga." }, { trigger: "💎", bonusPct: 30, reply: "¡Diamante! 30 % en tu carga." }] };
    case "post_withdraw": return { ...base, type, bonusPct: 15 };
    case "flyer": return { ...base, type, bonusPct: 20, keyword: "" };
  }
};

/** Promos del día (las de RoboBeast, sin IDs a mano): cada una nace en modo observación para medir antes de pagar. */
export function PromosEditor({ value, onChange, currency }: { value: Promo[]; onChange(v: Promo[]): void; currency: string }) {
  const [adding, setAdding] = useState(false);
  const set = (i: number, p: Promo) => onChange(value.map((x, j) => (j === i ? p : x)));
  return (
    <Card title={`Promos del día (${value.length})`} actions={<Button variant="ghost" onClick={() => setAdding((a) => !a)}><Plus className="mr-1 inline h-4 w-4" aria-hidden />Nueva promo</Button>}>
      {adding && (
        <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {TYPES.map(({ type, icon: Icon, title, text }) => (
            <button key={type} type="button" className="rounded-xl border border-white/10 bg-white/[.03] p-3 text-left hover:border-amber-300/60" onClick={() => { onChange([...value, fresh(type)]); setAdding(false); }}>
              <span className="flex items-center gap-2 font-semibold"><Icon className="h-4 w-4 text-amber-300" aria-hidden />{title}</span>
              <span className="mt-1 block text-xs text-white/55">{text}</span>
            </button>
          ))}
        </div>
      )}
      {value.length === 0 && !adding && <p className="text-sm text-white/50">Sin promos. Crea una: nace apagada y en modo observación, así mides antes de regalar.</p>}
      <div className="space-y-3">
        {value.map((p, i) => <PromoCard key={p.id} p={p} currency={currency} onChange={(x) => set(i, x)} onRemove={() => { if (confirm(`¿Eliminar «${p.name}»?`)) onChange(value.filter((_, j) => j !== i)); }} />)}
      </div>
    </Card>
  );
}

function PromoCard({ p, onChange, onRemove, currency }: { p: Promo; onChange(p: Promo): void; onRemove(): void; currency: string }) {
  const meta = TYPES.find((t) => t.type === p.type)!;
  const Icon = meta.icon;
  const f = `pr-${p.id}`;
  return (
    <details className="rounded-xl border border-white/10 bg-white/[.02]" open={!p.active}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 p-3">
        <Icon className="h-4 w-4 text-amber-300" aria-hidden />
        <b>{p.name}</b>
        <span className="text-xs text-white/45">{meta.title}</span>
        <span className="ml-auto flex gap-1">
          {p.active ? (p.observeOnly ? <Badge tone="warn"><Eye className="mr-1 inline h-3 w-3" aria-hidden />Observando</Badge> : <Badge tone="good">Activa · paga</Badge>) : <Badge>Apagada</Badge>}
        </span>
      </summary>
      <div className="space-y-3 border-t border-white/5 p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nombre interno" htmlFor={`${f}-n`}><input id={`${f}-n`} className={inputCls} maxLength={60} value={p.name} onChange={(e) => onChange({ ...p, name: e.target.value })} /></Field>
          {"keyword" in p && (
            <Field label={p.type === "flyer" ? "Palabra (opcional, además de la captura)" : "Palabra que activa la promo"} htmlFor={`${f}-k`}>
              <input id={`${f}-k`} className={inputCls} maxLength={40} value={p.keyword} onChange={(e) => onChange({ ...p, keyword: e.target.value } as Promo)} />
            </Field>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {"bonusPct" in p && <Field label="Bono" htmlFor={`${f}-b`}><PctInput id={`${f}-b`} value={p.bonusPct} onChange={(bonusPct) => onChange({ ...p, bonusPct } as Promo)} /></Field>}
          {p.type === "flash" && <Field label="Carga mínima para el bono" htmlFor={`${f}-m`}><MoneyInput id={`${f}-m`} currency={currency} value={p.minDeposit} placeholder="La general" onChange={(minDeposit) => onChange({ ...p, minDeposit })} /></Field>}
          {p.type === "gift" && <Field label="Fichas de regalo" htmlFor={`${f}-c`}><MoneyInput id={`${f}-c`} currency={currency} value={p.chips} onChange={(chips) => onChange({ ...p, chips: chips ?? "0" })} /></Field>}
          <Field label="Veces por jugador" htmlFor={`${f}-pp`}><input id={`${f}-pp`} type="number" min={1} max={100} className={`${inputCls} w-24`} value={p.maxClaimsPerPlayer} onChange={(e) => onChange({ ...p, maxClaimsPerPlayer: Math.max(1, Math.min(100, Math.round(Number(e.target.value) || 1))) })} /></Field>
          <Field label="Tope total de reclamos" htmlFor={`${f}-tt`}><input id={`${f}-tt`} type="number" min={1} className={`${inputCls} w-28`} placeholder="Sin tope" value={p.maxClaimsTotal ?? ""} onChange={(e) => onChange({ ...p, maxClaimsTotal: e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : null })} /></Field>
        </div>
        {p.type === "streak" && (
          <div className="flex flex-wrap items-end gap-3">
            {p.steps.map((s, k) => <Field key={k} label={`${k + 1}ª carga`} htmlFor={`${f}-s${k}`}><PctInput id={`${f}-s${k}`} value={s} onChange={(v) => onChange({ ...p, steps: p.steps.map((x, j) => (j === k ? v : x)) })} /></Field>)}
            {p.steps.length < 5 && <Button variant="ghost" onClick={() => onChange({ ...p, steps: [...p.steps, p.steps.at(-1) ?? 10] })}>+ Escalón</Button>}
            {p.steps.length > 2 && <Button variant="ghost" onClick={() => onChange({ ...p, steps: p.steps.slice(0, -1) })}>− Escalón</Button>}
          </div>
        )}
        {p.type === "choice" && (
          <div className="space-y-2">
            {p.options.map((o, k) => (
              <div key={k} className="grid gap-2 sm:grid-cols-[6rem_8rem_1fr_auto]">
                <input aria-label={`Disparador opción ${k + 1}`} className={inputCls} maxLength={20} value={o.trigger} onChange={(e) => onChange({ ...p, options: p.options.map((x, j) => (j === k ? { ...x, trigger: e.target.value } : x)) })} />
                <PctInput id={`${f}-o${k}`} value={o.bonusPct} onChange={(v) => onChange({ ...p, options: p.options.map((x, j) => (j === k ? { ...x, bonusPct: v } : x)) })} />
                <input aria-label={`Respuesta opción ${k + 1}`} className={inputCls} maxLength={300} value={o.reply} onChange={(e) => onChange({ ...p, options: p.options.map((x, j) => (j === k ? { ...x, reply: e.target.value } : x)) })} />
                <button type="button" disabled={p.options.length <= 2} className="text-white/40 hover:text-red-300 disabled:opacity-30" aria-label="Quitar opción" onClick={() => onChange({ ...p, options: p.options.filter((_, j) => j !== k) })}><Trash2 className="h-4 w-4" aria-hidden /></button>
              </div>
            ))}
            {p.options.length < 4 && <Button variant="ghost" onClick={() => onChange({ ...p, options: [...p.options, { trigger: "⭐", bonusPct: 10, reply: "" }] })}>+ Opción</Button>}
          </div>
        )}
        <Field label="Mensaje al aplicar la promo" htmlFor={`${f}-msg`}><textarea id={`${f}-msg`} rows={2} maxLength={600} className={inputCls} value={p.message} onChange={(e) => onChange({ ...p, message: e.target.value })} /></Field>
        <div>
          <p className="mb-1 text-sm font-semibold">Vigencia</p>
          <WindowsEditor value={p.windows} onChange={(windows) => onChange({ ...p, windows })} empty="Sin franjas: vale todo el día mientras esté activa." />
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          <Toggle label="Activa" checked={p.active} onChange={(active) => onChange({ ...p, active })} />
          <Toggle label="Modo observación" hint="Detecta y registra quién la usaría, pero no paga ni avisa. Apágalo cuando quieras que pague." checked={p.observeOnly} onChange={(observeOnly) => onChange({ ...p, observeOnly })} />
        </div>
        <div className="flex justify-end"><Button variant="danger" onClick={onRemove}><Trash2 className="mr-1 inline h-4 w-4" aria-hidden />Eliminar promo</Button></div>
      </div>
    </details>
  );
}
