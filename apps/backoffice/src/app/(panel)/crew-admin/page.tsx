"use client";

import { useState } from "react";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useApi, useApiClient } from "@/lib/hooks";
import { Badge, Button, Card, Empty, ErrorBox, inputCls, NeedOperator, Notice, PageHeader, Spinner, Tabs } from "@/components/ui";
import { Leaderboard } from "@/components/Ascend";

interface Member { id: string; name: string; role: string; team?: string | null; currency: string; payType: "monthly" | "hourly"; baseAmount: string; timezone: string; dayOff?: number | null; active: boolean; backofficeUserId?: string | null }
interface Live { id: string; memberId: string; memberName: string; status: string; kind: string; startedAt: string; lateMinutes: number; netMinutesSoFar: number }
interface Shift { id: string; memberId: string; label: string; startsAt: string; endsAt: string }
interface Task { id: string; title: string; assigneeId?: string | null; status: "todo" | "doing" | "done"; dueAt?: string | null }
interface Item { id: string; title: string; shiftLabel: string; active: boolean }
interface Ann { id: string; title: string; body: string; severity: string; mandatory: boolean; reads: number; createdAt: string }
interface Cash { id: string; box: string; currency: string; status: string; openedAt: string; closedAt?: string; expectedBalance?: string; declaredBalance?: string; difference?: string; reopenReason?: string }
interface PayRow { member: { id: string; name: string; role: string; currency: string; payType: string }; result: { normalMinutes: number; extraMinutes: number; base: string; overtime: string; bonuses: string; discounts: string; total: string }; adjustments: Array<{ id: string; type: string; amount: string; note: string }>; closed: { paidAt?: string | null } | null }

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : "Error inesperado");
const when = (iso: string) => new Date(iso).toLocaleString("es", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const hours = (min: number) => `${(min / 60).toFixed(1)} h`;
const DAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

function useRun(reload: () => void) {
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try { await fn(); setMsg({ tone: "ok", text: ok }); reload(); } catch (e) { setMsg({ tone: "warn", text: errMsg(e) }); }
  };
  return { msg, run };
}

function LiveTab() {
  const { call } = useApiClient();
  const l = useApi<{ items: Live[] }>("/crew/v1/admin/live");
  const { msg, run } = useRun(l.reload);
  if (l.loading) return <Spinner />;
  return (
    <Card title="En turno ahora">
      {!l.data?.items.length ? <Empty>Nadie fichado en este momento.</Empty> : (
        <ul className="space-y-2 text-sm">
          {l.data.items.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-lg bg-white/[.03] px-3 py-2">
              <span className="min-w-0 flex-1 font-medium">{s.memberName}</span>
              <Badge tone={s.status === "working" ? "good" : "warn"}>{s.status === "working" ? "Trabajando" : "En pausa"}</Badge>
              <span className="text-white/50">desde {when(s.startedAt)} · {hours(s.netMinutesSoFar)}</span>
              {s.lateMinutes > 0 && <Badge tone="bad">{s.lateMinutes} min tarde</Badge>}
              <Button variant="ghost" onClick={() => void run(() => call(`/crew/v1/admin/members/${s.memberId}/clock-out`, { method: "POST", body: {} }), "Jornada cerrada")}>Cerrar jornada</Button>
            </li>
          ))}
        </ul>
      )}
      {msg && <div className="mt-2"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
    </Card>
  );
}

function TeamTab({ members, reload }: { members: Member[]; reload(): void }) {
  const { call } = useApiClient();
  const empty = { name: "", role: "cajero", team: "", currency: "ARS", payType: "monthly" as const, baseAmount: "", timezone: "America/Argentina/Buenos_Aires", dayOff: "", backofficeUserId: "" };
  const [f, setF] = useState(empty);
  const [editing, setEditing] = useState<string | null>(null);
  const { msg, run } = useRun(reload);
  const body = () => ({ name: f.name, role: f.role, team: f.team || null, currency: f.currency, payType: f.payType, baseAmount: f.baseAmount || "0", timezone: f.timezone, dayOff: f.dayOff === "" ? null : Number(f.dayOff), backofficeUserId: f.backofficeUserId || null });
  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <Card title="Equipo">
        {!members.length ? <Empty>Agrega a tu primer integrante.</Empty> : (
          <ul className="space-y-1.5 text-sm">
            {members.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-white/[.03] px-3 py-2">
                <div className="min-w-0 flex-1"><div className="font-medium">{m.name}</div><div className="text-xs text-white/45">{m.role}{m.team ? ` · ${m.team}` : ""} · {m.timezone} · franco {m.dayOff == null ? "—" : DAYS[m.dayOff]}{m.backofficeUserId ? " · con acceso" : " · sin usuario"}</div></div>
                <Badge tone={m.active ? "good" : "neutral"}>{m.active ? "Activo" : "Inactivo"}</Badge>
                <Button variant="ghost" onClick={() => { setEditing(m.id); setF({ name: m.name, role: m.role, team: m.team ?? "", currency: m.currency, payType: m.payType as "monthly", baseAmount: m.baseAmount, timezone: m.timezone, dayOff: m.dayOff == null ? "" : String(m.dayOff), backofficeUserId: m.backofficeUserId ?? "" }); }}>Editar</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={editing ? "Editar integrante" : "Nuevo integrante"}>
        <div className="space-y-2">
          <input className={`${inputCls} w-full`} placeholder="Nombre" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Nombre" />
          <div className="grid grid-cols-2 gap-2">
            <input className={inputCls} placeholder="Rol (cajero, agente…)" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} aria-label="Rol" />
            <input className={inputCls} placeholder="Equipo" value={f.team} onChange={(e) => setF({ ...f, team: e.target.value })} aria-label="Equipo" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <select className={inputCls} value={f.payType} onChange={(e) => setF({ ...f, payType: e.target.value as "monthly" })} aria-label="Tipo de pago"><option value="monthly">Mensual</option><option value="hourly">Por hora</option></select>
            <input className={inputCls} placeholder="Monto (mín.)" value={f.baseAmount} onChange={(e) => setF({ ...f, baseAmount: e.target.value.replace(/\D/g, "") })} aria-label="Sueldo o valor hora" />
            <input className={inputCls} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} aria-label="Moneda" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select className={inputCls} value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} aria-label="Zona horaria">
              <option value="America/Argentina/Buenos_Aires">Argentina</option><option value="America/Bogota">Colombia</option><option value="America/Mexico_City">México</option><option value="America/Lima">Perú</option><option value="America/Santiago">Chile</option><option value="UTC">UTC</option>
            </select>
            <select className={inputCls} value={f.dayOff} onChange={(e) => setF({ ...f, dayOff: e.target.value })} aria-label="Día de franco"><option value="">Sin franco fijo</option>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
          </div>
          <input className={`${inputCls} w-full`} placeholder="Id de usuario de backoffice (para que pueda fichar)" value={f.backofficeUserId} onChange={(e) => setF({ ...f, backofficeUserId: e.target.value.trim() })} aria-label="Usuario de backoffice" />
          <div className="flex gap-2">
            <Button className="flex-1" disabled={f.name.trim().length < 2} onClick={() => void run(async () => {
              await call(editing ? `/crew/v1/admin/members/${editing}` : "/crew/v1/admin/members", { method: editing ? "PUT" : "POST", body: body() });
              setF(empty); setEditing(null);
            }, "Guardado")}><Plus aria-hidden className="h-4 w-4" /> {editing ? "Guardar" : "Agregar"}</Button>
            {editing && <Button variant="ghost" onClick={() => { setEditing(null); setF(empty); }}>Cancelar</Button>}
          </div>
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        </div>
      </Card>
    </div>
  );
}

function ShiftsTab({ members }: { members: Member[] }) {
  const { call } = useApiClient();
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + 14 * 86_400_000);
  const s = useApi<{ items: Shift[] }>("/crew/v1/admin/shifts", { from: from.toISOString(), to: to.toISOString() });
  const [f, setF] = useState({ memberId: "", label: "Mañana", day: from.toISOString().slice(0, 10), start: "06:00", end: "14:00" });
  const { msg, run } = useRun(s.reload);
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? "—";
  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <Card title="Próximas dos semanas">
        {s.loading ? <Spinner /> : !s.data?.items.length ? <Empty>Sin turnos planificados.</Empty> : (
          <ul className="space-y-1.5 text-sm">{s.data.items.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-white/[.03] px-3 py-1.5">
              <span className="min-w-0 flex-1"><b>{name(x.memberId)}</b> · {x.label}</span>
              <span className="text-white/50">{when(x.startsAt)} → {new Date(x.endsAt).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}</span>
              <button type="button" className="text-white/30 hover:text-red-300" aria-label="Borrar turno" onClick={() => void run(() => call(`/crew/v1/admin/shifts/${x.id}`, { method: "DELETE" }), "Turno borrado")}><Trash2 aria-hidden className="h-4 w-4" /></button>
            </li>
          ))}</ul>
        )}
      </Card>
      <Card title="Planificar turno">
        <div className="space-y-2">
          <select className={`${inputCls} w-full`} value={f.memberId} onChange={(e) => setF({ ...f, memberId: e.target.value })} aria-label="Integrante"><option value="">Elige integrante…</option>{members.filter((m) => m.active).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
          <input className={`${inputCls} w-full`} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} aria-label="Nombre del turno" />
          <div className="grid grid-cols-3 gap-2">
            <input type="date" className={inputCls} value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} aria-label="Día" />
            <input type="time" className={inputCls} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} aria-label="Inicio" />
            <input type="time" className={inputCls} value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} aria-label="Fin" />
          </div>
          <p className="text-xs text-white/40">Horas en tu zona horaria actual; si el fin es menor que el inicio, termina al día siguiente.</p>
          <Button className="w-full" disabled={!f.memberId} onClick={() => void run(() => {
            const startsAt = new Date(`${f.day}T${f.start}`);
            let endsAt = new Date(`${f.day}T${f.end}`);
            if (endsAt <= startsAt) endsAt = new Date(endsAt.getTime() + 86_400_000);
            return call("/crew/v1/admin/shifts", { method: "POST", body: { memberId: f.memberId, label: f.label, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() } });
          }, "Turno planificado")}>Agregar turno</Button>
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        </div>
      </Card>
    </div>
  );
}

function TasksTab({ members }: { members: Member[] }) {
  const { call } = useApiClient();
  const t = useApi<{ items: Task[] }>("/crew/v1/admin/tasks");
  const [f, setF] = useState({ title: "", assigneeId: "" });
  const { msg, run } = useRun(t.reload);
  const name = (id?: string | null) => members.find((m) => m.id === id)?.name ?? "Sin asignar";
  return (
    <Card title="Tareas del equipo">
      <div className="mb-3 flex flex-wrap gap-2">
        <input className={`${inputCls} min-w-0 flex-1`} placeholder="Nueva tarea" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} aria-label="Nueva tarea" />
        <select className={inputCls} value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })} aria-label="Asignar a"><option value="">Sin asignar</option>{members.filter((m) => m.active).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
        <Button disabled={f.title.trim().length < 2} onClick={() => void run(async () => { await call("/crew/v1/admin/tasks", { method: "POST", body: { title: f.title, assigneeId: f.assigneeId || null } }); setF({ title: "", assigneeId: "" }); }, "Tarea creada")}>Crear</Button>
      </div>
      {t.loading ? <Spinner /> : !t.data?.items.length ? <Empty>Sin tareas.</Empty> : (
        <ul className="space-y-1.5 text-sm">{t.data.items.map((x) => (
          <li key={x.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-white/[.03] px-3 py-1.5">
            <span className={`min-w-0 flex-1 ${x.status === "done" ? "text-white/40 line-through" : ""}`}>{x.title}</span>
            <span className="text-xs text-white/45">{name(x.assigneeId)}</span>
            <Badge tone={x.status === "done" ? "good" : x.status === "doing" ? "warn" : "neutral"}>{x.status === "done" ? "Hecha" : x.status === "doing" ? "En curso" : "Por hacer"}</Badge>
            <button type="button" className="text-white/30 hover:text-red-300" aria-label="Borrar tarea" onClick={() => void run(() => call(`/crew/v1/admin/tasks/${x.id}`, { method: "DELETE" }), "Tarea borrada")}><Trash2 aria-hidden className="h-4 w-4" /></button>
          </li>
        ))}</ul>
      )}
      {msg && <div className="mt-2"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
    </Card>
  );
}

function ChecklistTab() {
  const { call } = useApiClient();
  const c = useApi<{ items: Item[] }>("/crew/v1/admin/checklist");
  const [f, setF] = useState({ title: "", shiftLabel: "" });
  const { msg, run } = useRun(c.reload);
  return (
    <Card title="Checklist por turno">
      <div className="mb-3 flex flex-wrap gap-2">
        <input className={`${inputCls} min-w-0 flex-1`} placeholder="Ítem (p. ej. Revisar cuentas receptoras)" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} aria-label="Ítem" />
        <input className={inputCls} placeholder="Turno (vacío = todos)" value={f.shiftLabel} onChange={(e) => setF({ ...f, shiftLabel: e.target.value })} aria-label="Turno" />
        <Button disabled={f.title.trim().length < 2} onClick={() => void run(async () => { await call("/crew/v1/admin/checklist", { method: "POST", body: f }); setF({ title: "", shiftLabel: "" }); }, "Ítem agregado")}>Agregar</Button>
      </div>
      {!c.data?.items.length ? <Empty>Sin ítems.</Empty> : (
        <ul className="space-y-1.5 text-sm">{c.data.items.map((i) => (
          <li key={i.id} className="flex items-center gap-2 rounded-lg bg-white/[.03] px-3 py-1.5">
            <span className="min-w-0 flex-1">{i.title}</span><span className="text-xs text-white/45">{i.shiftLabel || "Todos los turnos"}</span>
            <label className="inline-flex items-center gap-1 text-xs"><input type="checkbox" checked={i.active} onChange={(e) => void run(() => call(`/crew/v1/admin/checklist/${i.id}`, { method: "PATCH", body: { active: e.target.checked } }), "Actualizado")} /> Activo</label>
          </li>
        ))}</ul>
      )}
      {msg && <div className="mt-2"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
    </Card>
  );
}

function AnnouncementsTab() {
  const { call } = useApiClient();
  const a = useApi<{ items: Ann[] }>("/crew/v1/admin/announcements");
  const [f, setF] = useState({ title: "", body: "", severity: "info", mandatory: false });
  const { msg, run } = useRun(a.reload);
  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <Card title="Avisos enviados">
        {!a.data?.items.length ? <Empty>Sin avisos.</Empty> : (
          <ul className="space-y-2 text-sm">{a.data.items.map((x) => (
            <li key={x.id} className="rounded-lg bg-white/[.03] px-3 py-2">
              <div className="flex flex-wrap items-center gap-2"><b className="min-w-0 flex-1">{x.title}</b>{x.mandatory && <Badge tone="warn">Obligatorio</Badge>}<span className="text-xs text-white/45">{x.reads} lecturas · {when(x.createdAt)}</span></div>
              <p className="mt-1 whitespace-pre-wrap text-white/60">{x.body}</p>
            </li>
          ))}</ul>
        )}
      </Card>
      <Card title="Nuevo aviso">
        <div className="space-y-2">
          <input className={`${inputCls} w-full`} placeholder="Título" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} aria-label="Título" />
          <textarea className={`${inputCls} w-full`} rows={4} placeholder="Mensaje" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} aria-label="Mensaje" />
          <div className="flex flex-wrap items-center gap-2">
            <select className={inputCls} value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })} aria-label="Importancia"><option value="info">Informativo</option><option value="warning">Importante</option><option value="critical">Crítico</option></select>
            <label className="inline-flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.mandatory} onChange={(e) => setF({ ...f, mandatory: e.target.checked })} /> Confirmación obligatoria</label>
          </div>
          <Button className="w-full" disabled={f.title.trim().length < 2 || f.body.trim().length < 2} onClick={() => void run(async () => { await call("/crew/v1/admin/announcements", { method: "POST", body: f }); setF({ title: "", body: "", severity: "info", mandatory: false }); }, "Aviso enviado")}>Enviar al equipo</Button>
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        </div>
      </Card>
    </div>
  );
}

function CashTab() {
  const { call } = useApiClient();
  const c = useApi<{ items: Cash[] }>("/crew/v1/cash");
  const [reason, setReason] = useState<Record<string, string>>({});
  const { msg, run } = useRun(c.reload);
  return (
    <Card title="Cajas del equipo">
      {!c.data?.items.length ? <Empty>Aún no se abrió ninguna caja.</Empty> : (
        <ul className="space-y-2 text-sm">{c.data.items.map((x) => (
          <li key={x.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-white/[.03] px-3 py-2">
            <div className="min-w-0 flex-1"><b>{x.box}</b> <span className="text-white/45">· {when(x.openedAt)}{x.closedAt ? ` → ${when(x.closedAt)}` : ""}</span>{x.reopenReason && <div className="text-xs text-amber-300">Reabierta: {x.reopenReason}</div>}</div>
            {x.status === "closed" ? (
              <>
                <span className="text-xs text-white/60">esperado {x.expectedBalance} · contado {x.declaredBalance}</span>
                <Badge tone={x.difference === "0" ? "good" : "bad"}>{x.difference === "0" ? "Cuadra" : `Diferencia ${x.difference}`}</Badge>
                <input className={`${inputCls} w-40 py-1 text-xs`} placeholder="Motivo de reapertura" value={reason[x.id] ?? ""} onChange={(e) => setReason({ ...reason, [x.id]: e.target.value })} aria-label="Motivo de reapertura" />
                <Button variant="ghost" disabled={(reason[x.id] ?? "").trim().length < 3} onClick={() => void run(() => call(`/crew/v1/admin/cash/${x.id}/reopen`, { method: "POST", body: { reason: reason[x.id] } }), "Caja reabierta (queda auditado)")}><RotateCcw aria-hidden className="h-4 w-4" /> Reabrir</Button>
              </>
            ) : <Badge tone="warn">Abierta</Badge>}
          </li>
        ))}</ul>
      )}
      {msg && <div className="mt-2"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
    </Card>
  );
}

function PayrollTab() {
  const { call } = useApiClient();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const p = useApi<{ items: PayRow[] }>("/crew/v1/admin/payroll", { month });
  const [adj, setAdj] = useState({ memberId: "", type: "bonus", amount: "", note: "" });
  const { msg, run } = useRun(p.reload);
  return (
    <Card title="Nómina" actions={<input type="month" className={`${inputCls} py-1 text-sm`} value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Mes" />}>
      {p.loading ? <Spinner /> : p.error ? <ErrorBox message={p.error} onRetry={p.reload} /> : !p.data?.items.length ? <Empty>Sin integrantes activos.</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs text-white/45"><tr><th className="py-2">Integrante</th><th>Horas</th><th>Extra/franco</th><th className="text-right">Base</th><th className="text-right">Extra</th><th className="text-right">Ajustes</th><th className="text-right">Total</th><th className="pl-3">Estado</th></tr></thead>
            <tbody>{p.data.items.map((r) => (
              <tr key={r.member.id} className="border-t border-white/5">
                <td className="py-2"><b>{r.member.name}</b><div className="text-xs text-white/45">{r.member.role} · {r.member.payType === "monthly" ? "mensual" : "por hora"}</div></td>
                <td>{hours(r.result.normalMinutes)}</td><td>{hours(r.result.extraMinutes)}</td>
                <td className="text-right font-mono">{r.result.base}</td><td className="text-right font-mono">{r.result.overtime}</td>
                <td className="text-right font-mono">{BigInt(r.result.bonuses) - BigInt(r.result.discounts)}</td>
                <td className="text-right font-mono font-bold">{r.member.currency} {r.result.total}</td>
                <td className="pl-3">{!r.closed ? <Badge tone="neutral">Abierto</Badge> : r.closed.paidAt ? <Badge tone="good">Pagado</Badge> : (
                  <Button variant="ghost" onClick={() => void run(() => call(`/crew/v1/admin/payroll/${month}/${r.member.id}/paid`, { method: "POST", body: {} }), "Marcado como pagado")}>Marcar pagado</Button>
                )}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2 border-t border-white/5 pt-3">
        <select className={inputCls} value={adj.memberId} onChange={(e) => setAdj({ ...adj, memberId: e.target.value })} aria-label="Integrante del ajuste"><option value="">Ajuste para…</option>{p.data?.items.map((r) => <option key={r.member.id} value={r.member.id}>{r.member.name}</option>)}</select>
        <select className={inputCls} value={adj.type} onChange={(e) => setAdj({ ...adj, type: e.target.value })} aria-label="Tipo de ajuste"><option value="bonus">Bono</option><option value="discount">Descuento</option></select>
        <input className={inputCls} placeholder="Monto" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value.replace(/\D/g, "") })} aria-label="Monto del ajuste" />
        <input className={`${inputCls} min-w-0 flex-1`} placeholder="Nota" value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} aria-label="Nota" />
        <Button variant="ghost" disabled={!adj.memberId || !adj.amount} onClick={() => void run(async () => { await call("/crew/v1/admin/payroll/adjustments", { method: "POST", body: { ...adj, month } }); setAdj({ memberId: "", type: "bonus", amount: "", note: "" }); }, "Ajuste agregado")}>Agregar ajuste</Button>
        <Button onClick={() => window.confirm(`¿Cerrar la nómina de ${month}? Queda congelada.`) && void run(() => call(`/crew/v1/admin/payroll/${month}/close`, { method: "POST", body: {} }), "Mes cerrado y congelado")}>Cerrar mes</Button>
      </div>
      {msg && <div className="mt-2"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
    </Card>
  );
}

type Tab = "live" | "ranking" | "team" | "shifts" | "tasks" | "checklist" | "announcements" | "cash" | "payroll";
export default function CrewAdminPage() {
  const { operatorId } = useApiClient();
  const members = useApi<{ items: Member[] }>(operatorId ? "/crew/v1/admin/members" : null);
  const [tab, setTab] = useState<Tab>("live");
  if (!operatorId) return <><PageHeader title="Crew · Gestión" /><NeedOperator /></>;
  const list = members.data?.items ?? [];
  return (
    <>
      <PageHeader title="Crew · Gestión del equipo" subtitle="Turnos, fichajes en vivo, tareas, checklist, avisos, cajas y nómina de tu equipo." />
      <div className="mb-3 overflow-x-auto"><Tabs tabs={[
        { id: "live", label: "En vivo" }, { id: "ranking", label: "Ranking" }, { id: "team", label: "Equipo" }, { id: "shifts", label: "Turnos" }, { id: "tasks", label: "Tareas" },
        { id: "checklist", label: "Checklist" }, { id: "announcements", label: "Avisos" }, { id: "cash", label: "Cajas" }, { id: "payroll", label: "Nómina" },
      ]} value={tab} onChange={setTab} /></div>
      {members.error && <ErrorBox message={members.error} onRetry={members.reload} />}
      {tab === "live" && <LiveTab />}
      {tab === "ranking" && <Leaderboard />}
      {tab === "team" && <TeamTab members={list} reload={members.reload} />}
      {tab === "shifts" && <ShiftsTab members={list} />}
      {tab === "tasks" && <TasksTab members={list} />}
      {tab === "checklist" && <ChecklistTab />}
      {tab === "announcements" && <AnnouncementsTab />}
      {tab === "cash" && <CashTab />}
      {tab === "payroll" && <PayrollTab />}
    </>
  );
}
