"use client";

import { useState } from "react";
import { Activity, ArrowDownLeft, ArrowUpRight, Banknote, CalendarRange, Percent, Sparkles, TrendingUp, UserPlus, Users, Wallet } from "lucide-react";
import type { Dashboard } from "@/lib/api";
import { useApi, useCurrency, useOperator, useSession } from "@/lib/hooks";
import { daysAgo, int, isNonNegative, isoDay, money, pct, toNum } from "@/lib/format";
import { BarChart, LineChart } from "@/components/charts";
import { ACCENT, Button, Card, DataTable, Empty, ErrorBox, Field, inputCls, NeedOperator, Notice, PageHeader, Spinner, Stat, type Accent } from "@/components/ui";

/** Apuesta del feed en vivo (módulo feed de la API): jugador con alias, montos en unidades mínimas. */
interface FeedBet { id: string; gameTitle: string; player: string; currency: string; amount: string; win: string; multiplier: number; at: string }

export default function DashboardPage() {
  const { operatorId } = useOperator();
  const session = useSession();
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(isoDay(new Date()));
  const { data, error, loading, reload } = useApi<Dashboard>("/backoffice/v1/dashboard", { from, to });
  const name = session?.email?.split("@")[0];

  return (
    <>
      <PageHeader
        title="Resumen"
        subtitle={`${name ? `Hola, ${name}. ` : ""}${operatorId ? "Indicadores de tu operador." : "Consolidado de todos los operadores."}`}
        actions={
          <>
            <Field label="Desde" htmlFor="from">
              <input id="from" type="date" className={inputCls} value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Hasta" htmlFor="to">
              <input id="to" type="date" className={inputCls} value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Button variant="ghost" onClick={reload} className="self-end">
              Actualizar
            </Button>
          </>
        }
      />
      {loading && !data && <Spinner />}
      {error && <ErrorBox message={error} onRetry={reload} />}
      {data && <Body d={data} />}
    </>
  );
}

function FlowCard({ title, caption, icon, accent, children }: { title: string; caption: string; icon: React.ReactNode; accent: Accent; children: React.ReactNode }) {
  return (
    <section className="kpi rounded-xl border border-white/10 bg-panel/80 p-5 pl-6" style={{ ["--kpi" as string]: ACCENT[accent] } as React.CSSProperties}>
      <div className="mb-4 flex items-center gap-3">
        <span aria-hidden className="grid h-10 w-10 place-items-center rounded-lg" style={{ background: `color-mix(in srgb, ${ACCENT[accent]} 16%, transparent)`, color: ACCENT[accent] }}>{icon}</span>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-white/45">{caption}</div>
          <h2 className="text-base font-bold text-white">{title}</h2>
        </div>
      </div>
      {children}
    </section>
  );
}

function Body({ d }: { d: Dashboard }) {
  const cur = useCurrency();
  const { operatorId } = useOperator();
  const m = (v: string) => money(v, cur);
  const t = d.totals;
  const labels = d.days.map((x) => x.day);
  const today = d.days[d.days.length - 1];
  const empty = t.betCount === 0 && t.depositsAmount === "0" && t.registrations === 0;
  const icon = (I: typeof Users) => <I className="h-5 w-5" />;

  return (
    <div className="space-y-6">
      {d.warnings.map((w) => (
        <Notice key={w} tone="warn">{w}</Notice>
      ))}
      {empty && <Empty>Aún no hay actividad en este rango.</Empty>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="GGR" value={m(t.ggr)} tone={isNonNegative(t.ggr) ? "good" : "bad"} sub={t.hold !== null ? `Hold ${pct(t.hold)}` : "Apuestas − ganancias"} icon={icon(TrendingUp)} accent="gold" />
        <Stat label="NGR" value={m(t.ngr)} tone={isNonNegative(t.ngr) ? "good" : "bad"} sub={`Bonos ${m(t.bonusCost)} · Jackpots ${m(t.jackpotFunding)}`} icon={icon(Percent)} accent="green" />
        <Stat label="Jugadores activos" value={int(t.activePlayers)} sub={`${int(t.bettors)} apostaron`} icon={icon(Users)} accent="cyan" />
        <Stat label="Registros" value={int(t.registrations)} sub={`${int(t.ftdCount)} primeros depósitos (FTD)`} icon={icon(UserPlus)} accent="violet" />
      </div>

      <div>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white/85"><Banknote aria-hidden className="h-4 w-4 text-brand" />Resumen financiero</h2>
        <div className="grid gap-3 lg:grid-cols-3">
          <FlowCard title="Actividad del día" caption={today ? today.day : "Hoy"} icon={<CalendarRange className="h-5 w-5" />} accent="cyan">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-xs text-white/45">Depósitos</dt><dd className="font-bold tabular-nums text-emerald-300">+{m(today?.depositsAmount ?? "0")}</dd></div>
              <div><dt className="text-xs text-white/45">Retiros</dt><dd className="font-bold tabular-nums text-red-300">−{m(today?.withdrawalsAmount ?? "0")}</dd></div>
            </dl>
          </FlowCard>
          <FlowCard title="Flujo del rango" caption={`${d.from} → ${d.to}`} icon={<Activity className="h-5 w-5" />} accent="violet">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-xs text-white/45">Depósitos · {int(t.depositsCount)}</dt><dd className="font-bold tabular-nums text-emerald-300">+{m(t.depositsAmount)}</dd></div>
              <div><dt className="text-xs text-white/45">Retiros · {int(t.withdrawalsCount)}</dt><dd className="font-bold tabular-nums text-red-300">−{m(t.withdrawalsAmount)}</dd></div>
            </dl>
          </FlowCard>
          <FlowCard title="Depósitos netos" caption="Quedan en el sistema" icon={<Wallet className="h-5 w-5" />} accent={isNonNegative(t.netDeposits) ? "green" : "red"}>
            <p className={`text-3xl font-extrabold tabular-nums ${isNonNegative(t.netDeposits) ? "text-emerald-300" : "text-red-300"}`}>
              {isNonNegative(t.netDeposits) ? "+" : ""}{m(t.netDeposits)}
            </p>
            <p className="mt-1 text-xs text-white/45">{int(t.depositors)} depositantes únicos · FTD {m(t.ftdAmount)}</p>
          </FlowCard>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="GGR y NGR diarios">
          <LineChart title="GGR y NGR por día" labels={labels} series={[{ label: "GGR", color: ACCENT.gold, values: d.days.map((x) => toNum(x.ggr)) }, { label: "NGR", color: ACCENT.green, values: d.days.map((x) => toNum(x.ngr)) }]} />
        </Card>
        <Card title="Depósitos vs. retiros">
          <BarChart title="Depósitos y retiros por día" labels={labels} series={[{ label: "Depósitos", color: ACCENT.cyan, values: d.days.map((x) => toNum(x.depositsAmount)) }, { label: "Retiros", color: ACCENT.pink, values: d.days.map((x) => toNum(x.withdrawalsAmount)) }]} />
        </Card>
        <Card title="Registros y FTD">
          <BarChart title="Registros y primeros depósitos por día" labels={labels} series={[{ label: "Registros", color: ACCENT.violet, values: d.days.map((x) => x.registrations) }, { label: "FTD", color: ACCENT.green, values: d.days.map((x) => x.ftdCount) }]} />
        </Card>
        <Card title="Jugadores activos">
          <LineChart title="Jugadores activos por día" labels={labels} series={[{ label: "Activos", color: ACCENT.cyan, values: d.days.map((x) => x.activePlayers) }, { label: "Depositantes", color: ACCENT.orange, values: d.days.map((x) => x.depositors) }]} />
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title="Apuestas recientes" actions={<span className="flex items-center gap-1.5 text-xs text-white/50"><Sparkles aria-hidden className="h-3.5 w-3.5 text-brand2" />Feed en vivo</span>}>
          {operatorId ? <RecentBets operatorId={operatorId} /> : <NeedOperator />}
        </Card>
        <Card title="Retención por cohorte de registro">
          <div className="space-y-3">
            {(["d1", "d7", "d30"] as const).map((k) => {
              const r = d.retention[k];
              return (
                <div key={k} className="rounded-lg bg-black/20 p-3">
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs font-semibold uppercase text-white/50">{k.toUpperCase()}</span>
                    <span className="text-lg font-bold tabular-nums">{pct(r.rate)}</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded bg-white/10" role="progressbar" aria-label={`Retención ${k.toUpperCase()}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r.rate ?? 0)}>
                    <div className="h-full bg-gradient-to-r from-brand2 to-brand" style={{ width: `${r.rate ?? 0}%` }} />
                  </div>
                  <div className="mt-1 text-xs text-white/40">{r.retained} de {r.eligible} jugadores elegibles</div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      <details className="rounded-xl border border-white/10 bg-panel/60 p-4 text-xs text-white/60">
        <summary className="cursor-pointer text-sm font-semibold text-white/80">Cómo se calculan las métricas</summary>
        <ul className="mt-3 space-y-1">
          {Object.values(d.formulas).map((f) => <li key={f}>{f}</li>)}
        </ul>
      </details>
    </div>
  );
}

function RecentBets({ operatorId }: { operatorId: string }) {
  const { data, error, loading, reload } = useApi<{ bets: FeedBet[] }>("/feed/v1/bets", { operatorId, kind: "all", limit: 20 });
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  const zero = BigInt(0);
  const profit = (b: FeedBet) => {
    try { return BigInt(b.win) - BigInt(b.amount); } catch { return zero; }
  };
  return (
    <DataTable
      rows={data?.bets ?? []}
      rowKey={(b) => b.id}
      pageSize={8}
      empty="Todavía no hay apuestas liquidadas. Aparecen aquí en cuanto los jugadores juegan."
      columns={[
        { key: "gameTitle", label: "Juego", render: (b) => <span className="font-semibold">{b.gameTitle}</span> },
        { key: "player", label: "Jugador", render: (b) => <span className="text-white/70">{b.player}</span> },
        { key: "amount", label: "Apuesta", className: "text-right tabular-nums", render: (b) => money(b.amount, b.currency) },
        { key: "multiplier", label: "Mult.", className: "text-right tabular-nums", render: (b) => `${(b.multiplier || 0).toFixed(2)}x` },
        {
          key: "profit", label: "Resultado", className: "text-right tabular-nums",
          render: (b) => {
            const p = profit(b);
            return <span className={p > zero ? "text-emerald-300" : "text-white/50"}>{p > zero ? <ArrowUpRight aria-hidden className="mr-1 inline h-3.5 w-3.5" /> : <ArrowDownLeft aria-hidden className="mr-1 inline h-3.5 w-3.5" />}{money((p < zero ? -p : p).toString(), b.currency)}</span>;
          },
        },
        { key: "at", label: "Hora", className: "text-right text-white/50", render: (b) => new Date(b.at).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }) },
      ]}
    />
  );
}

