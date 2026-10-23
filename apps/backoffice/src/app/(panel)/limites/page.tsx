"use client";

import { useState } from "react";
import { ApiError } from "@/lib/api";
import { money, toMinorUnits } from "@/lib/format";
import { useApi, useApiClient } from "@/lib/hooks";
import { Button, Card, ErrorBox, Field, inputCls, NeedOperator, Notice, PageHeader, Spinner } from "@/components/ui";

type Key = "minBet" | "maxBet" | "minDeposit" | "maxDeposit" | "minWithdrawal" | "maxWithdrawal" | "maxDailyWithdrawal";
type Limits = Record<Key, string>;

const GROUPS: Array<{ title: string; hint: string; fields: Array<{ key: Key; label: string }> }> = [
  { title: "Apuestas", hint: "Por jugada, en los juegos propios del casino.", fields: [{ key: "minBet", label: "Apuesta mínima" }, { key: "maxBet", label: "Apuesta máxima" }] },
  { title: "Depósitos", hint: "Caja web (Bold y transferencia) y comprobantes de Pearl.", fields: [{ key: "minDeposit", label: "Depósito mínimo" }, { key: "maxDeposit", label: "Depósito máximo" }] },
  { title: "Retiros", hint: "Lo que el jugador puede pedir por retiro y por día.", fields: [{ key: "minWithdrawal", label: "Retiro mínimo" }, { key: "maxWithdrawal", label: "Retiro máximo" }, { key: "maxDailyWithdrawal", label: "Máximo por día" }] },
];

/** Valores recomendados para Colombia (pesos), según lo que usan los casinos con licencia de Coljuegos. */
const SUGGESTED_COP: Partial<Record<Key, string>> = { minBet: "500", maxBet: "1.000.000", minDeposit: "10.000", minWithdrawal: "20.000", maxWithdrawal: "10.000.000", maxDailyWithdrawal: "20.000.000" };

/** Unidades mínimas → texto en pesos para el campo (COP sin decimales). */
const toInput = (minor: string, currency: string) => {
  if (!minor) return "";
  const v = BigInt(minor);
  return currency === "COP" ? (v / 100n).toLocaleString("es-CO") : `${v / 100n}${v % 100n ? `,${String(v % 100n).padStart(2, "0")}` : ""}`;
};

export default function LimitsPage() {
  const { operatorId, call } = useApiClient();
  const data = useApi<{ currency: string; limits: Limits }>(operatorId ? `/backoffice/v1/admin/limits/${encodeURIComponent(operatorId)}` : null);
  const [form, setForm] = useState<Partial<Record<Key, string>>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (!operatorId) return <><PageHeader title="Límites del casino" /><NeedOperator /></>;
  if (data.error) return <ErrorBox message={data.error} onRetry={data.reload} />;
  if (!data.data) return <Spinner />;
  const currency = data.data!.currency;
  const value = (k: Key) => form[k] ?? toInput(data.data!.limits[k], currency);

  async function save() {
    setMsg(null);
    const body: Partial<Record<Key, string>> = {};
    for (const [k, v] of Object.entries(form) as Array<[Key, string]>) {
      if (!v.trim()) { body[k] = ""; continue; }
      const minor = toMinorUnits(v, currency);
      if (!minor) return setMsg({ ok: false, text: `Revisa el monto de "${GROUPS.flatMap((g) => g.fields).find((f) => f.key === k)?.label}".` });
      body[k] = minor;
    }
    setBusy(true);
    try {
      await call(`/backoffice/v1/admin/limits/${encodeURIComponent(operatorId!)}`, { method: "PUT", body });
      setForm({});
      data.reload();
      setMsg({ ok: true, text: "Límites guardados. Se aplican de inmediato." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : "No se pudo guardar" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Límites del casino" subtitle={`Montos mínimos y máximos en ${currency}. Vacío = sin límite.`} />
      <div className="grid gap-4 lg:grid-cols-3">
        {GROUPS.map((g) => (
          <Card key={g.title} title={g.title}>
            <p className="mb-3 text-xs text-white/50">{g.hint}</p>
            <div className="space-y-3">
              {g.fields.map((f) => (
                <Field key={f.key} label={f.label} htmlFor={`lim-${f.key}`}>
                  <input id={`lim-${f.key}`} inputMode="decimal" className={`${inputCls} w-full`} placeholder={currency === "COP" ? SUGGESTED_COP[f.key] ? `Sugerido: ${SUGGESTED_COP[f.key]}` : "Sin límite" : "Sin límite"}
                    value={value(f.key)} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
                  {data.data!.limits[f.key] && <span className="mt-1 block text-xs text-white/45">Actual: {money(data.data!.limits[f.key], currency)}</span>}
                </Field>
              ))}
            </div>
          </Card>
        ))}
      </div>
      {msg && <div role={msg.ok ? "status" : "alert"}><Notice tone={msg.ok ? "ok" : "warn"}>{msg.text}</Notice></div>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !Object.keys(form).length} onClick={() => void save()}>{busy ? "Guardando…" : "Guardar límites"}</Button>
        {currency === "COP" && <Button variant="ghost" onClick={() => setForm({ ...SUGGESTED_COP })}>Usar valores recomendados</Button>}
      </div>
      <p className="text-xs text-white/45">El depósito mínimo también se aplica a los comprobantes de Pearl. El Cajero IA del chat mantiene su propia regla de cargas pequeñas que se suman en 10 minutos.</p>
    </div>
  );
}
