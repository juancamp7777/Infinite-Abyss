"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Circle, Coffee, LogIn, LogOut, Play, Wallet } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useApi, useApiClient } from "@/lib/hooks";
import { Badge, Button, Card, Empty, ErrorBox, Field, inputCls, NeedOperator, Notice, PageHeader, Spinner } from "@/components/ui";

interface Member { id: string; name: string; role: string; currency: string; timezone: string }
interface Session { id: string; status: "working" | "paused" | "closed"; kind: "normal" | "extra" | "dayoff"; startedAt: string; lateMinutes: number; netMinutesSoFar?: number }
interface Shift { id: string; label: string; startsAt: string; endsAt: string }
interface Me { member: Member; session: Session | null; shifts: Shift[] }
interface Check { day: string; shiftLabel: string | null; items: Array<{ id: string; title: string; done: boolean }> }
interface Task { id: string; title: string; description: string; status: "todo" | "doing" | "done"; dueAt?: string }
interface CashSession { id: string; box: string; currency: string; status: "open" | "closed"; openingBalance: string; openedAt: string; expectedBalance?: string; declaredBalance?: string; difference?: string }

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : "Error inesperado");
const hm = (min: number) => `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
const when = (iso: string) => new Date(iso).toLocaleString("es", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const KIND = { normal: "Jornada normal", extra: "Horas extra", dayoff: "Franco trabajado" } as const;

function Clock({ me, reload }: { me: Me; reload(): void }) {
  const { call } = useApiClient();
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const act = async (path: string, body?: unknown) => {
    setErr(null);
    try { await call(`/crew/v1/me/${path}`, { method: "POST", body: body ?? {} }); reload(); } catch (e) { setErr(errMsg(e)); }
  };
  const s = me.session;
  const net = s ? (s.netMinutesSoFar ?? 0) + (s.status === "working" ? Math.floor(tick / 2) : 0) : 0;
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-4">
        <span className={`grid h-14 w-14 place-items-center rounded-2xl ${s ? (s.status === "working" ? "bg-emerald-400/15 text-emerald-300" : "bg-amber-400/15 text-amber-300") : "bg-white/5 text-white/40"}`}>
          {s ? (s.status === "working" ? <Play aria-hidden className="h-6 w-6" /> : <Coffee aria-hidden className="h-6 w-6" />) : <LogIn aria-hidden className="h-6 w-6" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-lg font-bold">{s ? (s.status === "working" ? "Trabajando" : "En pausa") : "Fuera de turno"}</div>
          <div className="text-sm text-white/50">
            {s ? <>{KIND[s.kind]} desde {when(s.startedAt)} · {hm(net)} netas{s.lateMinutes ? <> · <span className="text-amber-300">{s.lateMinutes} min tarde</span></> : null}</> : `Hola, ${me.member.name}`}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {!s && <><Button onClick={() => void act("clock-in")}><LogIn aria-hidden className="h-4 w-4" /> Fichar entrada</Button><Button variant="ghost" onClick={() => void act("clock-in", { extra: true })}>Entrar a horas extra</Button></>}
          {s?.status === "working" && <Button variant="ghost" onClick={() => void act("pause")}><Coffee aria-hidden className="h-4 w-4" /> Pausa</Button>}
          {s?.status === "paused" && <Button variant="ghost" onClick={() => void act("resume")}><Play aria-hidden className="h-4 w-4" /> Volver</Button>}
          {s && <Button variant="danger" onClick={() => void act("clock-out")}><LogOut aria-hidden className="h-4 w-4" /> Fichar salida</Button>}
        </div>
      </div>
      {err && <div className="mt-3"><Notice tone="warn">{err}</Notice></div>}
    </Card>
  );
}

function Checklist({ reloadKey }: { reloadKey: number }) {
  const { call } = useApiClient();
  const c = useApi<Check>("/crew/v1/me/checklist", { k: reloadKey });
  const [data, setData] = useState<Check | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const cur = data ?? c.data;
  const toggle = async (id: string, done: boolean) => {
    setErr(null);
    try { setData(await call<Check>(`/crew/v1/me/checklist/${id}`, { method: "POST", body: { done } })); } catch (e) { setErr(errMsg(e)); }
  };
  return (
    <Card title={`Checklist del turno${cur?.shiftLabel ? ` · ${cur.shiftLabel}` : ""}`}>
      {c.loading && !cur ? <Spinner /> : !cur?.items.length ? <Empty>Sin tareas de checklist para hoy.</Empty> : (
        <ul className="space-y-1.5">
          {cur.items.map((i) => (
            <li key={i.id}>
              <button type="button" onClick={() => void toggle(i.id, !i.done)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/5">
                {i.done ? <CheckCircle2 aria-hidden className="h-4 w-4 text-emerald-400" /> : <Circle aria-hidden className="h-4 w-4 text-white/30" />}
                <span className={i.done ? "text-white/40 line-through" : ""}>{i.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {err && <p className="mt-2 text-xs text-amber-300">{err}</p>}
    </Card>
  );
}

function Tasks() {
  const { call } = useApiClient();
  const t = useApi<{ items: Task[] }>("/crew/v1/me/tasks");
  const move = async (id: string, status: Task["status"]) => {
    try { await call(`/crew/v1/me/tasks/${id}`, { method: "PATCH", body: { status } }); t.reload(); } catch { /* el error se ve al recargar */ }
  };
  return (
    <Card title="Mis tareas">
      {t.loading ? <Spinner /> : !t.data?.items.length ? <Empty>No tienes tareas asignadas.</Empty> : (
        <ul className="space-y-2">
          {t.data.items.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-white/[.03] px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className={x.status === "done" ? "text-white/40 line-through" : "font-medium"}>{x.title}</div>
                {x.dueAt && <div className="text-xs text-white/40">Vence {when(x.dueAt)}</div>}
              </div>
              <select className={`${inputCls} py-1 text-xs`} value={x.status} onChange={(e) => void move(x.id, e.target.value as Task["status"])} aria-label={`Estado de ${x.title}`}>
                <option value="todo">Por hacer</option><option value="doing">En curso</option><option value="done">Hecha</option>
              </select>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CashBox({ me }: { me: Me }) {
  const { call } = useApiClient();
  const list = useApi<{ items: CashSession[] }>("/crew/v1/cash");
  const [box, setBox] = useState("Caja principal");
  const [opening, setOpening] = useState("");
  const [mv, setMv] = useState({ type: "in" as "in" | "out", amount: "", concept: "" });
  const [declared, setDeclared] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const open = list.data?.items.find((s) => s.status === "open");
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try { await fn(); setMsg({ tone: "ok", text: ok }); list.reload(); } catch (e) { setMsg({ tone: "warn", text: errMsg(e) }); }
  };
  const digits = (v: string) => v.replace(/\D/g, "");
  return (
    <Card title="Caja del turno" actions={<Wallet aria-hidden className="h-4 w-4 text-white/40" />}>
      {list.loading ? <Spinner /> : !open ? (
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <input className={inputCls} value={box} onChange={(e) => setBox(e.target.value)} aria-label="Nombre de la caja" />
          <input className={inputCls} value={opening} onChange={(e) => setOpening(digits(e.target.value))} placeholder={`Saldo inicial (${me.member.currency}, unidades mínimas)`} aria-label="Saldo inicial" />
          <Button onClick={() => void run(() => call("/crew/v1/cash", { method: "POST", body: { box, currency: me.member.currency, openingBalance: opening || "0" } }), "Caja abierta")}>Abrir caja</Button>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2"><Badge tone="warn">Abierta</Badge><span className="font-semibold">{open.box}</span><span className="text-white/45">desde {when(open.openedAt)}</span></div>
          <div className="grid gap-2 sm:grid-cols-[auto_1fr_2fr_auto]">
            <select className={inputCls} value={mv.type} onChange={(e) => setMv({ ...mv, type: e.target.value as "in" | "out" })} aria-label="Tipo de movimiento"><option value="in">Ingreso</option><option value="out">Egreso</option></select>
            <input className={inputCls} value={mv.amount} onChange={(e) => setMv({ ...mv, amount: digits(e.target.value) })} placeholder="Monto" aria-label="Monto" />
            <input className={inputCls} value={mv.concept} onChange={(e) => setMv({ ...mv, concept: e.target.value })} placeholder="Concepto" aria-label="Concepto" />
            <Button variant="ghost" disabled={!mv.amount || mv.concept.trim().length < 2} onClick={() => void run(async () => { await call(`/crew/v1/cash/${open.id}/movements`, { method: "POST", body: mv }); setMv({ ...mv, amount: "", concept: "" }); }, "Movimiento registrado")}>Registrar</Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Field label="Saldo contado al cerrar" htmlFor="decl"><input id="decl" className={inputCls} value={declared} onChange={(e) => setDeclared(digits(e.target.value))} /></Field>
            <Button className="self-end" variant="danger" disabled={!declared} onClick={() => void run(async () => {
              const r = await call<CashSession>(`/crew/v1/cash/${open.id}/close`, { method: "POST", body: { declaredBalance: declared } });
              setDeclared("");
              if (r.difference && r.difference !== "0") throw new ApiError(`Caja cerrada con diferencia de ${r.difference} (esperado ${r.expectedBalance}).`, 200);
            }, "Caja cerrada sin diferencias ✓")}>Cerrar caja</Button>
          </div>
        </div>
      )}
      {msg && <div className="mt-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
    </Card>
  );
}

export default function CrewPage() {
  const { operatorId } = useApiClient();
  const me = useApi<Me>(operatorId ? "/crew/v1/me" : null);
  if (!operatorId) return <><PageHeader title="Crew · Mi turno" /><NeedOperator /></>;
  return (
    <>
      <PageHeader title="Crew · Mi turno" subtitle="Ficha tu jornada, completa el checklist, gestiona tus tareas y la caja del turno." />
      {me.loading ? <Spinner /> : me.error ? (
        <ErrorBox message={me.error.includes("no está en el equipo") ? "Tu usuario aún no forma parte del equipo. Pide a un administrador que te agregue en Crew · Gestión." : me.error} onRetry={me.reload} />
      ) : me.data && (
        <div className="space-y-3">
          <Clock me={me.data} reload={me.reload} />
          <div className="grid gap-3 lg:grid-cols-2">
            <Checklist reloadKey={me.data.session ? 1 : 0} />
            <Tasks />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <CashBox me={me.data} />
            <Card title="Próximos turnos">
              {!me.data.shifts.length ? <Empty>Sin turnos planificados.</Empty> : (
                <ul className="space-y-1.5 text-sm">{me.data.shifts.map((s) => <li key={s.id} className="flex justify-between gap-2 rounded-lg bg-white/[.03] px-3 py-1.5"><span className="font-medium">{s.label}</span><span className="text-white/50">{when(s.startsAt)} → {new Date(s.endsAt).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}</span></li>)}</ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
