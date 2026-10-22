"use client";

import { useState } from "react";
import { ApiError, asList } from "@/lib/api";
import { useApi, useApiClient, useCurrency, useSession } from "@/lib/hooks";
import { money } from "@/lib/format";
import { Badge, Button, Card, DataTable, ErrorBox, Notice, NeedOperator, PageHeader, Spinner, type Column } from "@/components/ui";

const H = "/hub/v1/admin";
interface Provider { id: string; name?: string; status?: string; integrated?: boolean }
interface HubGame { id: string; providerId: string; title: string; category: string; rtp: number; volatility: string; status: string }
interface OpGame { gameId: string; enabled: boolean; sortOrder: number }
interface Line { bets: string; wins: string; ggr: string; rounds: number; openRounds: number }
interface Report { totals: Line; providers: Array<Line & { providerId: string; providerName: string }>; games: Array<Line & { gameId: string; title: string }> }
const PAGE_SIZE = 20;

export default function CatalogPage() {
  const session = useSession()!;
  const cur = useCurrency();
  const { operatorId, call } = useApiClient();
  const [page, setPage] = useState(1);
  const [key, setKey] = useState(0);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const providers = useApi<{ items: Provider[] }>(`${H}/providers`);
  const games = useApi<{ items: HubGame[]; total: number }>(`${H}/games`, { page, pageSize: PAGE_SIZE });
  const opGames = useApi<{ items: OpGame[] }>(operatorId ? `${H}/operators/${encodeURIComponent(operatorId)}/games` : null, { k: key });
  const report = useApi<Report>(`${H}/reports/providers`);
  const isPlatform = session.role === "PLATFORM_ADMIN";
  const byGame = new Map(asList<OpGame>(opGames.data).map((g) => [g.gameId, g]));

  async function run(id: string, fn: () => Promise<unknown>, okText: string) {
    setBusy(id);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: okText });
      setKey((k) => k + 1);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : "Error inesperado" });
    } finally {
      setBusy(null);
    }
  }
  const setGame = (gameId: string, enabled: boolean, sortOrder: number) =>
    run(gameId, () => call(`${H}/operators/${encodeURIComponent(operatorId!)}/games/${encodeURIComponent(gameId)}`, { method: "PUT", body: { enabled, sortOrder } }), `Juego ${gameId} actualizado`);

  const pCols: Column<Provider>[] = [
    { key: "id", label: "Proveedor" },
    { key: "name", label: "Nombre" },
    { key: "status", label: "Estado", render: (p) => <Badge tone={p.status === "ACTIVE" ? "good" : "neutral"}>{p.status ?? "—"}</Badge> },
    { key: "integrated", label: "Integrado", render: (p) => (p.integrated ? "Sí" : "No") },
    ...(isPlatform
      ? [{ key: "sync", label: "Catálogo", render: (p: Provider) => <Button variant="ghost" disabled={busy === p.id} onClick={() => run(p.id, () => call(`${H}/providers/${encodeURIComponent(p.id)}/sync`, { method: "POST", body: {} }), `Sincronización de ${p.id} lista`)}>{busy === p.id ? "Sincronizando…" : "Sincronizar"}</Button> }]
      : []),
  ];
  const gCols: Column<HubGame>[] = [
    { key: "title", label: "Juego" },
    { key: "providerId", label: "Proveedor" },
    { key: "category", label: "Categoría" },
    { key: "rtp", label: "RTP", render: (g) => `${g.rtp}%` },
    { key: "volatility", label: "Volatilidad" },
    { key: "status", label: "Estado global", render: (g) => <Badge tone={g.status === "ACTIVE" ? "good" : "warn"}>{g.status}</Badge> },
    ...(operatorId
      ? [
          {
            key: "enabled",
            label: "Habilitado",
            render: (g: HubGame) => {
              const o = byGame.get(g.id);
              return <label className="flex items-center gap-2"><input type="checkbox" aria-label={`Habilitar ${g.title}`} checked={o?.enabled ?? false} disabled={busy === g.id} onChange={(e) => setGame(g.id, e.target.checked, o?.sortOrder ?? 0)} /> {o?.enabled ? "Sí" : "No"}</label>;
            },
          },
          {
            key: "sortOrder",
            label: "Orden",
            render: (g: HubGame) => {
              const o = byGame.get(g.id);
              return <input type="number" min={0} aria-label={`Orden de ${g.title}`} className="w-20 rounded-md border border-white/15 bg-black/30 px-2 py-1 text-sm" defaultValue={o?.sortOrder ?? 0} onBlur={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 0 && n !== (o?.sortOrder ?? 0)) setGame(g.id, o?.enabled ?? false, n); }} />;
            },
          },
        ]
      : []),
  ];
  const rep = report.data;
  const total = games.data?.total ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader title="Catálogo y proveedores" subtitle="Proveedores del Hub, juegos activos por operador y reporte por proveedor." />
      {msg && <div role="status"><Notice tone={msg.ok ? "ok" : "warn"}>{msg.text}</Notice></div>}
      <Card title="Proveedores">
        {providers.loading && !providers.data && <Spinner />}
        {providers.error && <ErrorBox message={providers.error} onRetry={providers.reload} />}
        {!!providers.data && <DataTable rows={asList<Provider>(providers.data)} columns={pCols} empty="No hay proveedores registrados." />}
      </Card>
      <Card title={operatorId ? `Juegos (operador ${operatorId})` : "Juegos"}>
        {!operatorId && isPlatform && <div className="mb-3"><NeedOperator /></div>}
        {opGames.error && <ErrorBox message={opGames.error} onRetry={opGames.reload} />}
        {games.loading && !games.data && <Spinner />}
        {games.error && <ErrorBox message={games.error} onRetry={games.reload} />}
        {!!games.data && <DataTable rows={asList<HubGame>(games.data)} columns={gCols} pageSize={PAGE_SIZE} empty="El catálogo está vacío." />}
        <div className="mt-3 flex items-center justify-between text-sm text-white/60">
          <span>{total} juegos · página {page}</span>
          <span className="flex gap-2">
            <Button variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Anterior</Button>
            <Button variant="ghost" disabled={page * PAGE_SIZE >= total} onClick={() => setPage((p) => p + 1)}>Siguiente</Button>
          </span>
        </div>
      </Card>
      <Card title="Reporte por proveedor">
        {report.loading && !report.data && <Spinner />}
        {report.error && <ErrorBox message={report.error} onRetry={report.reload} />}
        {rep && (
          <>
            <p className="mb-3 text-sm text-white/70">Total: apuestas {money(rep.totals.bets, cur)} · ganancias {money(rep.totals.wins, cur)} · GGR {money(rep.totals.ggr, cur)} · rondas {rep.totals.rounds} ({rep.totals.openRounds} abiertas)</p>
            <DataTable
              rows={rep.providers}
              empty="Sin actividad todavía."
              columns={[
                { key: "providerName", label: "Proveedor" },
                { key: "bets", label: "Apuestas", render: (r) => money(r.bets, cur) },
                { key: "wins", label: "Ganancias", render: (r) => money(r.wins, cur) },
                { key: "ggr", label: "GGR", render: (r) => money(r.ggr, cur) },
                { key: "rounds", label: "Rondas" },
                { key: "openRounds", label: "Abiertas" },
              ]}
            />
          </>
        )}
      </Card>
    </div>
  );
}
