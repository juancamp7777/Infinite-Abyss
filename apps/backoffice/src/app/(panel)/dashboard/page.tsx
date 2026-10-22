"use client";

import { useState } from "react";
import type { Dashboard } from "@/lib/api";
import { useApi, useCurrency, useOperator } from "@/lib/hooks";
import { daysAgo, int, isNonNegative, isoDay, money, pct, toNum } from "@/lib/format";
import { BarChart, LineChart } from "@/components/charts";
import { Button, Card, Empty, ErrorBox, Field, inputCls, Notice, PageHeader, Spinner, Stat } from "@/components/ui";

export default function DashboardPage() {
  const { operatorId } = useOperator();
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(isoDay(new Date()));
  const { data, error, loading, reload } = useApi<Dashboard>("/backoffice/v1/dashboard", { from, to });

  return (
    <>
      <PageHeader
        title="Panel"
        subtitle={operatorId ? `Operador ${operatorId}` : "Consolidado de todos los operadores"}
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

function Body({ d }: { d: Dashboard }) {
  const cur = useCurrency();
  const m = (v: string) => money(v, cur);
  const t = d.totals;
  const labels = d.days.map((x) => x.day);
  const empty = t.betCount === 0 && t.depositsAmount === "0" && t.registrations === 0;
  return (
    <div className="space-y-6">
      {d.warnings.map((w) => (
        <Notice key={w} tone="warn">
          {w}
        </Notice>
      ))}
      {empty && <Empty>Aún no hay actividad en este rango.</Empty>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="GGR" value={m(t.ggr)} tone={isNonNegative(t.ggr) ? "good" : "bad"} sub={t.hold !== null ? `Hold ${pct(t.hold)}` : undefined} />
        <Stat label="NGR" value={m(t.ngr)} tone={isNonNegative(t.ngr) ? "good" : "bad"} sub={`Bonos ${m(t.bonusCost)} · Jackpots ${m(t.jackpotFunding)}`} />
        <Stat label="Depósitos" value={m(t.depositsAmount)} sub={`${int(t.depositsCount)} operaciones`} />
        <Stat label="Retiros" value={m(t.withdrawalsAmount)} sub={`Neto ${m(t.netDeposits)}`} />
        <Stat label="Depositantes únicos" value={int(t.depositors)} />
        <Stat label="FTD" value={int(t.ftdCount)} sub={`Monto ${m(t.ftdAmount)}`} />
        <Stat label="Registros" value={int(t.registrations)} />
        <Stat label="Jugadores activos" value={int(t.activePlayers)} sub={`${int(t.bettors)} apostaron`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="GGR y NGR diarios">
          <LineChart title="GGR y NGR por día" labels={labels} series={[{ label: "GGR", color: "#a78bfa", values: d.days.map((x) => toNum(x.ggr)) }, { label: "NGR", color: "#34d399", values: d.days.map((x) => toNum(x.ngr)) }]} />
        </Card>
        <Card title="Depósitos vs. retiros">
          <BarChart title="Depósitos y retiros por día" labels={labels} series={[{ label: "Depósitos", color: "#60a5fa", values: d.days.map((x) => toNum(x.depositsAmount)) }, { label: "Retiros", color: "#f472b6", values: d.days.map((x) => toNum(x.withdrawalsAmount)) }]} />
        </Card>
        <Card title="Registros y FTD">
          <BarChart title="Registros y primeros depósitos por día" labels={labels} series={[{ label: "Registros", color: "#facc15", values: d.days.map((x) => x.registrations) }, { label: "FTD", color: "#34d399", values: d.days.map((x) => x.ftdCount) }]} />
        </Card>
        <Card title="Jugadores activos">
          <LineChart title="Jugadores activos por día" labels={labels} series={[{ label: "Activos", color: "#38bdf8", values: d.days.map((x) => x.activePlayers) }, { label: "Depositantes", color: "#fb923c", values: d.days.map((x) => x.depositors) }]} />
        </Card>
      </div>

      <Card title="Retención por cohorte de registro">
        <div className="grid gap-3 sm:grid-cols-3">
          {(["d1", "d7", "d30"] as const).map((k) => {
            const r = d.retention[k];
            return (
              <div key={k} className="rounded-lg bg-black/20 p-3">
                <div className="text-xs uppercase text-white/50">{k.toUpperCase()}</div>
                <div className="mt-1 text-xl font-semibold">{pct(r.rate)}</div>
                <div className="text-xs text-white/40">
                  {r.retained} de {r.eligible} jugadores elegibles
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded bg-white/10" aria-hidden>
                  <div className="h-full bg-violet-400" style={{ width: `${r.rate ?? 0}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Fórmulas">
        <ul className="space-y-1 text-xs text-white/60">
          {Object.values(d.formulas).map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
