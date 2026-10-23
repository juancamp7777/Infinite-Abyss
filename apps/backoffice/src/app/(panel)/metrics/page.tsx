"use client";

import { useMemo, useState } from "react";
import { Bot, Clock3, HandCoins, MessageSquare, Receipt, UserPlus, Users, Wallet } from "lucide-react";
import { useApi, useApiClient } from "@/lib/hooks";
import { money } from "@/lib/format";
import { BarChart } from "@/components/charts";
import { Badge, Card, Empty, ErrorBox, NeedOperator, PageHeader, Spinner, Stat, Tabs } from "@/components/ui";

interface Agent {
  key: string;
  name: string;
  isBot: boolean;
  memberId: string | null;
  loads: { count: number; amount: string };
  debits: { count: number; amount: string };
  receipts: { count: number; amount: string };
  withdrawals: { approved: number; rejected: number; amount: string };
  messages: number;
  firstResponses: number;
  avgResponseSeconds: number | null;
  workedMinutes: number;
}
interface Report {
  currency: string;
  agents: Agent[];
  totals: { loads: number; loaded: string; debited: string; receipts: number; withdrawalsApproved: number; withdrawn: string; messages: number; avgResponseSeconds: number | null };
  hourly: Array<{ hour: number; count: number; amount: string }>;
  players: { registered: number; loaders: number; firstTimeLoaders: number; returningLoaders: number };
}

type Range = "today" | "yesterday" | "7d" | "30d";
const RANGES: Array<{ id: Range; label: string }> = [{ id: "today", label: "Hoy" }, { id: "yesterday", label: "Ayer" }, { id: "7d", label: "7 días" }, { id: "30d", label: "30 días" }];

function rangeOf(r: Range): { from: string; to: string } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const end = new Date(start.getTime() + day);
  if (r === "today") return { from: start.toISOString(), to: end.toISOString() };
  if (r === "yesterday") return { from: new Date(start.getTime() - day).toISOString(), to: start.toISOString() };
  return { from: new Date(end.getTime() - (r === "7d" ? 7 : 30) * day).toISOString(), to: end.toISOString() };
}

const secs = (s: number | null) => (s == null ? "—" : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`);
const hours = (m: number) => (m ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : "—");
const speedTone = (s: number | null) => (s == null ? "neutral" : s <= 120 ? "good" : s <= 600 ? "warn" : "bad");

/** Métricas del equipo (como el /team y el /panel de Magik): quién cargó, cuánto, qué tan rápido respondió y a qué hora se mueve la caja. */
export default function MetricsPage() {
  const { operatorId } = useApiClient();
  const [range, setRange] = useState<Range>("today");
  const q = useMemo(() => ({ ...rangeOf(range), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }), [range]);
  const r = useApi<Report>(operatorId ? "/crew/v1/admin/metrics" : null, q);

  if (!operatorId) return <><PageHeader title="Métricas del equipo" /><NeedOperator /></>;
  const d = r.data;
  const cur = d?.currency;
  const peak = d ? d.hourly.reduce((best, h) => (h.count > best.count ? h : best), d.hourly[0]) : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Métricas del equipo"
        subtitle="Cargas, descargas, comprobantes, retiros, mensajes y tiempo de respuesta por persona y por turno. El bot aparece aparte."
        actions={<Tabs tabs={RANGES} value={range} onChange={setRange} />}
      />
      {r.error && <ErrorBox message={r.error} onRetry={r.reload} />}
      {r.loading && !d && <Spinner />}
      {d && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Cargado" value={money(d.totals.loaded, cur)} sub={`${d.totals.loads} cargas · ${d.totals.receipts} por comprobante`} icon={<HandCoins className="h-4 w-4" />} accent="green" />
            <Stat label="Descontado y retirado" value={money((BigInt(d.totals.debited) + BigInt(d.totals.withdrawn)).toString(), cur)} sub={`${d.totals.withdrawalsApproved} retiros aprobados`} icon={<Wallet className="h-4 w-4" />} accent="red" />
            <Stat label="Respuesta promedio" value={secs(d.totals.avgResponseSeconds)} sub={`${d.totals.messages} mensajes enviados`} icon={<Clock3 className="h-4 w-4" />} accent="cyan" />
            <Stat label="Jugadores que cargaron" value={String(d.players.loaders)} sub={`${d.players.firstTimeLoaders} primera vez · ${d.players.returningLoaders} recurrentes · ${d.players.registered} registros`} icon={<UserPlus className="h-4 w-4" />} accent="gold" />
          </div>

          <Card title="Cargas por hora" actions={peak && peak.count > 0 ? <Badge tone="warn">Pico: {String(peak.hour).padStart(2, "0")}:00 · {peak.count} cargas</Badge> : undefined}>
            {d.hourly.every((h) => h.count === 0) ? <Empty>Sin cargas en este período.</Empty> : (
              <BarChart title="Cargas por hora" labels={d.hourly.map((h) => `${String(h.hour).padStart(2, "0")}`)} series={[{ label: "Cargas", color: "#34d399", values: d.hourly.map((h) => h.count) }]} />
            )}
          </Card>

          <Card title="Por persona">
            {d.agents.length === 0 ? <Empty>Todavía no hay actividad ni personas en Crew.</Empty> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[56rem] text-sm">
                  <thead className="text-left text-xs uppercase tracking-wider text-white/45">
                    <tr>
                      <th className="py-2 pr-3">Persona</th>
                      <th className="py-2 pr-3 text-right">Cargas</th>
                      <th className="py-2 pr-3 text-right">Comprobantes</th>
                      <th className="py-2 pr-3 text-right">Descargas</th>
                      <th className="py-2 pr-3 text-right">Retiros</th>
                      <th className="py-2 pr-3 text-right">Mensajes</th>
                      <th className="py-2 pr-3 text-right">1ª respuesta</th>
                      <th className="py-2 text-right">Horas</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {d.agents.map((a) => (
                      <tr key={a.key} className={a.isBot ? "bg-[var(--color-brand2)]/5" : undefined}>
                        <td className="py-2 pr-3">
                          <span className="inline-flex items-center gap-2 font-medium">
                            {a.isBot ? <Bot className="h-4 w-4 text-[var(--color-brand2)]" aria-hidden /> : <Users className="h-4 w-4 text-white/40" aria-hidden />}
                            {a.name}
                          </span>
                          {!a.isBot && !a.memberId && <div className="text-[11px] text-white/35">Agrégalo en Crew para ver sus turnos y tiempos</div>}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">{a.loads.count ? <>{a.loads.count}<div className="text-xs text-emerald-300">{money(a.loads.amount, cur)}</div></> : "—"}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{a.receipts.count ? <>{a.receipts.count}<div className="text-xs text-emerald-300">{money(a.receipts.amount, cur)}</div></> : "—"}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{a.debits.count ? <>{a.debits.count}<div className="text-xs text-red-300">{money(a.debits.amount, cur)}</div></> : "—"}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{a.withdrawals.approved || a.withdrawals.rejected ? <>{a.withdrawals.approved}<span className="text-white/35"> / {a.withdrawals.rejected} rech.</span><div className="text-xs text-red-300">{money(a.withdrawals.amount, cur)}</div></> : "—"}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{a.messages || "—"}</td>
                        <td className="py-2 pr-3 text-right">{a.isBot ? "—" : <Badge tone={speedTone(a.avgResponseSeconds)}>{secs(a.avgResponseSeconds)}</Badge>}{a.firstResponses > 0 && <div className="text-[11px] text-white/35">{a.firstResponses} chats</div>}</td>
                        <td className="py-2 text-right tabular-nums">{a.isBot ? "24/7" : hours(a.workedMinutes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 flex items-center gap-1 text-xs text-white/40"><Receipt className="h-3.5 w-3.5" aria-hidden />Comprobantes = cargas acreditadas desde Pearl (las del bot son automáticas). Respuesta = tiempo hasta el primer mensaje de la persona en cada chat. <MessageSquare className="ml-1 h-3.5 w-3.5" aria-hidden /></p>
          </Card>
        </>
      )}
    </div>
  );
}
