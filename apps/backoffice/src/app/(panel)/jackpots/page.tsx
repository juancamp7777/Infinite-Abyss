"use client";

import { useEffect, useState } from "react";
import { asList } from "@/lib/api";
import { useApi, useApiClient, useCurrency } from "@/lib/hooks";
import { dateTime, money, sampleMinor } from "@/lib/format";
import { KeyValueTable, ResourceManager } from "@/components/ResourceManager";
import { Badge, Button, Card, Empty, ErrorBox, NeedOperator, PageHeader, Spinner, Tabs } from "@/components/ui";

const P = "/promo/v1/admin";

interface Level { key: string; seedAmount: string; shareBps: number; triggerChancePpm: number; mustDropBy: string | null; currentAmount: string }
interface Jackpot { id?: string; name: string; currency: string; status?: string; contributionBps: number; minBet?: string; gameIds?: string[]; categories?: string[]; levels: Level[] }
interface Drop { id?: string; name: string; currency: string; status?: string; startsAt: string; endsAt: string; dropChancePpm: number; prizes?: Array<{ amount: string; quantity: number }> }

const LEVEL_COLOR: Record<string, string> = { mini: "text-sky-300", major: "text-amber-300", mega: "text-fuchsia-300" };

function LiveJackpots() {
  const j = useApi<unknown>(`${P}/jackpots`);
  const { reload } = j;
  useEffect(() => {
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [reload]);
  const items = asList<Jackpot>(j.data, "jackpots");
  return (
    <Card title="Valores en vivo" actions={<span className="text-xs text-white/40">se actualiza cada 5 s</span>}>
      {j.loading && !j.data && <Spinner />}
      {j.error && <ErrorBox message={j.error} onRetry={j.reload} />}
      {!!j.data && items.length === 0 && <Empty>Sin jackpots configurados.</Empty>}
      <div className="grid gap-3 md:grid-cols-2">
        {items.map((x) => (
          <div key={x.id} className="rounded-lg bg-black/20 p-3">
            <div className="mb-2 flex items-center justify-between"><strong>{x.name}</strong><Badge tone={x.status === "ACTIVE" ? "good" : "warn"}>{x.status ?? "—"}</Badge></div>
            <ul className="space-y-1 text-sm">
              {[...x.levels].sort((a, b) => ["mini", "major", "mega"].indexOf(a.key) - ["mini", "major", "mega"].indexOf(b.key)).map((l) => (
                <li key={l.key} className="flex items-center justify-between">
                  <span className={`uppercase ${LEVEL_COLOR[l.key] ?? ""}`}>{l.key}</span>
                  <span className="font-mono">{money(l.currentAmount, x.currency)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function JackpotsPage() {
  const { operatorId } = useApiClient();
  const cur = useCurrency() ?? "COP";
  const [now] = useState(() => Date.now());
  const [tab, setTab] = useState<"jackpots" | "drops">("jackpots");
  if (!operatorId) return <><PageHeader title="Jackpots" /><NeedOperator /></>;
  return (
    <>
      <PageHeader title="Jackpots y Drops & Wins" subtitle="Pozos progresivos mini/major/mega financiados por contribución por apuesta y campañas de premios aleatorios." />
      <Tabs tabs={[{ id: "jackpots", label: "Jackpots" }, { id: "drops", label: "Drops & Wins" }]} value={tab} onChange={setTab} />
      {tab === "jackpots" ? (
        <div className="space-y-4">
          <LiveJackpots />
          <ResourceManager<Jackpot>
            noun="jackpot"
            listPath={`${P}/jackpots`}
            template={{
              name: "Nymfo Progressive",
              currency: cur,
              contributionBps: 100,
              minBet: sampleMinor(0.1, cur),
              status: "ACTIVE",
              levels: [
                { key: "mini", seedAmount: sampleMinor(10, cur), shareBps: 5000, triggerChancePpm: 200, mustDropBy: sampleMinor(500, cur) },
                { key: "major", seedAmount: sampleMinor(100, cur), shareBps: 3000, triggerChancePpm: 20, mustDropBy: sampleMinor(5000, cur) },
                { key: "mega", seedAmount: sampleMinor(1000, cur), shareBps: 2000, triggerChancePpm: 2, mustDropBy: sampleMinor(50000, cur) },
              ],
            }}
            updateMethod="PATCH"
            editView={(x) => ({ name: x.name, status: x.status, contributionBps: x.contributionBps, minBet: x.minBet, gameIds: x.gameIds, categories: x.categories, levels: x.levels.map(({ key, seedAmount, shareBps, triggerChancePpm, mustDropBy }) => ({ key, seedAmount, shareBps, triggerChancePpm, mustDropBy })) })}
            columns={[
              { key: "name", label: "Jackpot" },
              { key: "contributionBps", label: "Contribución", render: (x) => `${(x.contributionBps / 100).toFixed(2)}% de la apuesta` },
              { key: "levels", label: "Niveles", render: (x) => x.levels.map((l) => l.key).join(" / ") },
              { key: "status", label: "Estado", render: (x) => <Badge tone={x.status === "ACTIVE" ? "good" : "warn"}>{x.status ?? "—"}</Badge> },
            ]}
            extra={(x, ctx) => (
              <Button variant="ghost" onClick={async () => { try { const r = await ctx.call<Record<string, unknown>>(`${P}/jackpots/${x.id}/report`); ctx.showPanel(`Reporte · ${x.name}`, <KeyValueTable data={flat(r)} />); } catch (e) { ctx.fail(e); } }}>Reporte</Button>
            )}
          />
        </div>
      ) : (
        <ResourceManager<Drop>
          noun="campaña de drops"
          listPath={`${P}/drops`}
          template={{ name: "Drops de fin de semana", currency: cur, startsAt: new Date(now).toISOString(), endsAt: new Date(now + 7 * 86400000).toISOString(), dropChancePpm: 5000, minBet: sampleMinor(0.1, cur), prizes: [{ amount: sampleMinor(5, cur), quantity: 100 }, { amount: sampleMinor(50, cur), quantity: 10 }] }}
          updateMethod="PATCH"
          editView={(d) => ({ name: d.name, status: d.status, startsAt: d.startsAt, endsAt: d.endsAt, dropChancePpm: d.dropChancePpm })}
          columns={[
            { key: "name", label: "Campaña" },
            { key: "status", label: "Estado", render: (d) => <Badge tone={d.status === "ACTIVE" ? "good" : "warn"}>{d.status ?? "—"}</Badge> },
            { key: "startsAt", label: "Inicio", render: (d) => dateTime(d.startsAt) },
            { key: "endsAt", label: "Fin", render: (d) => dateTime(d.endsAt) },
            { key: "prizes", label: "Premios", render: (d) => (d.prizes ?? []).map((p) => `${p.quantity}×${money(p.amount, cur)}`).join(", ") || "—" },
          ]}
        />
      )}
    </>
  );
}

/** Aplana un reporte anidado a pares clave→valor legibles. */
function flat(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (Array.isArray(v)) out[k] = `${v.length} registros`;
    else if (v && typeof v === "object") for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) out[`${k}.${k2}`] = v2;
    else out[k] = v;
  }
  return out;
}
