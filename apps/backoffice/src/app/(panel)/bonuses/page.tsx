"use client";

import { useState } from "react";
import { ApiError, asList } from "@/lib/api";
import { useApi, useApiClient, useCurrency } from "@/lib/hooks";
import { dateTime, money, sampleMinor, toMinorUnits } from "@/lib/format";
import { ResourceManager } from "@/components/ResourceManager";
import { Badge, Button, Card, DataTable, ErrorBox, Field, inputCls, NeedOperator, Notice, PageHeader, Spinner, Tabs, type Column } from "@/components/ui";

const P = "/promo/v1/admin";

interface Template { id?: string; name?: string; type?: string; status?: string; currency?: string; code?: string | null; wageringMultiplier?: number }
interface PlayerBonus { id: string; playerId: string; type?: string; status: string; currency?: string; amount?: string; wageringRequired?: string; wageringProgress?: string; expiresAt?: string; createdAt?: string }

const TONE: Record<string, "good" | "bad" | "warn" | "neutral"> = { ACTIVE: "good", COMPLETED: "good", FORFEITED: "bad", CANCELLED: "bad", PENDING: "warn" };

function PlayerBonuses() {
  const { call } = useApiClient();
  const cur = useCurrency();
  const [status, setStatus] = useState("");
  const [playerId, setPlayerId] = useState("");
  const list = useApi<unknown>(`${P}/bonuses`, { status, playerId, limit: 200 });
  const [grant, setGrant] = useState({ playerId: "", templateId: "", amount: "" });
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const tpl = useApi<unknown>(`${P}/bonus-templates`);

  async function act(fn: () => Promise<unknown>, msg: string) {
    setErr(null);
    setOk(null);
    try {
      await fn();
      setOk(msg);
      list.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Error inesperado");
    }
  }

  const cols: Column<PlayerBonus>[] = [
    { key: "playerId", label: "Jugador", render: (b) => <span className="font-mono text-xs">{b.playerId.slice(0, 10)}</span> },
    { key: "type", label: "Tipo" },
    { key: "status", label: "Estado", render: (b) => <Badge tone={TONE[b.status] ?? "neutral"}>{b.status}</Badge> },
    { key: "amount", label: "Monto", render: (b) => money(b.amount, b.currency ?? cur) },
    { key: "wagering", label: "Rollover", render: (b) => (b.wageringRequired ? `${money(b.wageringProgress ?? "0", b.currency ?? cur)} / ${money(b.wageringRequired, b.currency ?? cur)}` : "—") },
    { key: "expiresAt", label: "Vence", render: (b) => dateTime(b.expiresAt) },
    { key: "a", label: "", render: (b) => (b.status === "ACTIVE" || b.status === "PENDING" ? <Button variant="danger" onClick={() => { if (window.confirm("¿Cancelar este bono?")) void act(() => call(`${P}/bonuses/${b.id}/cancel`, { method: "POST", body: { reason: "backoffice" } }), "Bono cancelado."); }}>Cancelar</Button> : null) },
  ];

  return (
    <div className="space-y-4">
      <Card title="Otorgar bono manual">
        <form className="grid gap-3 md:grid-cols-4" onSubmit={(e) => { e.preventDefault(); const minor = grant.amount.trim() ? toMinorUnits(grant.amount, cur) : undefined; if (minor === null) { setOk(null); setErr("Monto inválido: escribe un valor numérico en la moneda del operador."); return; } void act(() => call(`${P}/bonuses/grant`, { method: "POST", body: { playerId: grant.playerId.trim(), templateId: grant.templateId, ...(minor ? { amount: minor } : {}) } }), "Bono otorgado."); }}>
          <Field label="ID de jugador" htmlFor="gp"><input id="gp" required className={inputCls} value={grant.playerId} onChange={(e) => setGrant({ ...grant, playerId: e.target.value })} /></Field>
          <Field label="Plantilla" htmlFor="gt">
            <select id="gt" required className={inputCls} value={grant.templateId} onChange={(e) => setGrant({ ...grant, templateId: e.target.value })}>
              <option value="">Elige…</option>
              {asList<Template>(tpl.data).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label={`Monto${cur ? ` en ${cur}` : ""} (opcional)`} htmlFor="ga"><input id="ga" inputMode="decimal" className={inputCls} value={grant.amount} onChange={(e) => setGrant({ ...grant, amount: e.target.value })} /></Field>
          <Button type="submit" className="self-end">Otorgar</Button>
        </form>
        {err && <div className="mt-3"><ErrorBox message={err} /></div>}
        {ok && <div className="mt-3"><Notice tone="ok">{ok}</Notice></div>}
      </Card>
      <div className="flex flex-wrap gap-3">
        <Field label="Estado" htmlFor="bs">
          <select id="bs" className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos</option>
            {["PENDING", "ACTIVE", "COMPLETED", "FORFEITED", "CANCELLED"].map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Jugador" htmlFor="bp"><input id="bp" className={inputCls} value={playerId} onChange={(e) => setPlayerId(e.target.value)} /></Field>
      </div>
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {!!list.data && <DataTable rows={asList<PlayerBonus>(list.data, "bonuses")} columns={cols} rowKey={(b) => b.id} pageSize={15} empty="No hay bonos de jugadores con estos filtros." />}
    </div>
  );
}

export default function BonusesPage() {
  const { operatorId } = useApiClient();
  const cur = useCurrency() ?? "COP";
  const [tab, setTab] = useState<"templates" | "players">("templates");
  if (!operatorId) return <><PageHeader title="Bonos" /><NeedOperator /></>;
  return (
    <>
      <PageHeader title="Bonos" subtitle="Plantillas con rollover, contribución por categoría, apuesta máxima y expiración; y ciclo de vida de los bonos de jugadores." />
      <Tabs tabs={[{ id: "templates", label: "Plantillas" }, { id: "players", label: "Bonos de jugadores" }]} value={tab} onChange={setTab} />
      {tab === "templates" ? (
        <ResourceManager<Template>
          noun="plantilla de bono"
          listPath={`${P}/bonus-templates`}
          template={{
            type: "deposit_match",
            name: "100% primer depósito",
            currency: cur,
            status: "ACTIVE",
            matchBps: 10000,
            minDeposit: sampleMinor(10, cur),
            maxBonusAmount: sampleMinor(500, cur),
            firstDepositOnly: true,
            autoOnDeposit: true,
            wageringMultiplier: 30,
            wageringBase: "BONUS",
            contributionBps: { slots: 10000, table: 1000 },
            maxBet: sampleMinor(5, cur),
            validityHours: 168,
          }}
          updateMethod="PATCH"
          allowDelete
          columns={[
            { key: "name", label: "Plantilla" },
            { key: "type", label: "Tipo" },
            { key: "status", label: "Estado", render: (t) => <Badge tone={t.status === "ACTIVE" ? "good" : "neutral"}>{t.status ?? "—"}</Badge> },
            { key: "code", label: "Código", render: (t) => t.code ?? "—" },
            { key: "wageringMultiplier", label: "Rollover", render: (t) => (t.wageringMultiplier ? `x${t.wageringMultiplier}` : "—") },
          ]}
        />
      ) : (
        <PlayerBonuses />
      )}
    </>
  );
}
