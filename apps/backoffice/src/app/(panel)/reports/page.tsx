"use client";

import { useState } from "react";
import { ApiError, downloadCsv } from "@/lib/api";
import { useApiClient } from "@/lib/hooks";
import { daysAgo, isoDay } from "@/lib/format";
import { Button, Card, Field, Notice, PageHeader, inputCls } from "@/components/ui";

const TYPES = [
  ["kpis-daily", "KPIs diarios"],
  ["players", "Jugadores"],
  ["providers", "Proveedores"],
  ["bonuses", "Bonos"],
  ["campaigns", "Campañas"],
  ["jackpots", "Jackpots"],
] as const;

export default function ReportsPage() {
  const { operatorId } = useApiClient();
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(isoDay(new Date()));
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function get(type: string) {
    setBusy(type);
    setMsg(null);
    try {
      await downloadCsv(`/backoffice/v1/admin/reports/${type}.csv`, { from, to, operatorId: operatorId ?? undefined }, `${type}.csv`);
      setMsg({ ok: true, text: `Descarga de ${type}.csv lista` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : "No se pudo descargar" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Reportes" subtitle={`CSV exportables${operatorId ? ` del operador ${operatorId}` : " de todos los operadores"}.`} />
      <Card title="Rango">
        <div className="flex flex-wrap gap-3">
          <Field label="Desde" htmlFor="rf"><input id="rf" type="date" className={inputCls} value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Hasta" htmlFor="rt"><input id="rt" type="date" className={inputCls} value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
      </Card>
      <Card title="Descargas">
        <div className="flex flex-wrap gap-2">
          {TYPES.map(([id, label]) => (
            <Button key={id} variant="ghost" disabled={busy !== null} onClick={() => get(id)}>{busy === id ? "Generando…" : `${label} (CSV)`}</Button>
          ))}
        </div>
        {msg && <div role={msg.ok ? "status" : "alert"} className="mt-3"><Notice tone={msg.ok ? "ok" : "warn"}>{msg.text}</Notice></div>}
      </Card>
    </div>
  );
}
