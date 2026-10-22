"use client";

import { useState } from "react";
import { asList } from "@/lib/api";
import { useApi, useApiClient } from "@/lib/hooks";
import { ResourceManager, KeyValueTable } from "@/components/ResourceManager";
import { Badge, Button, Card, DataTable, ErrorBox, NeedOperator, PageHeader, Spinner, Tabs, type Column } from "@/components/ui";

const A = "/marketing/v1/admin";

interface Named { id?: string; name?: string; status?: string; channel?: string; kind?: string }
interface Preset { id?: string; key?: string; name?: string; description?: string }

const statusBadge = (s?: string) => (s ? <Badge tone={s === "active" ? "good" : s === "paused" ? "warn" : "neutral"}>{s}</Badge> : "—");

function MetricsView({ data }: { data: Record<string, unknown> }) {
  const variants = Array.isArray(data.variants) ? (data.variants as Record<string, unknown>[]) : [];
  const { variants: _v, ...rest } = data;
  void _v;
  const cols: Column<Record<string, unknown>>[] = variants[0] ? Object.keys(variants[0]).map((k) => ({ key: k, label: k, render: (r) => (typeof r[k] === "object" ? JSON.stringify(r[k]) : String(r[k] ?? "—")) })) : [];
  return (
    <div className="space-y-3">
      <KeyValueTable data={(rest.total as Record<string, unknown>) ?? rest} />
      {variants.length > 0 && (
        <>
          <h3 className="text-xs uppercase text-white/50">Variantes A/B</h3>
          <DataTable rows={variants} columns={cols} />
        </>
      )}
    </div>
  );
}

function Campaigns() {
  return (
    <ResourceManager<Named>
      noun="campaña"
      listPath={`${A}/campaigns`}
      template={{
        name: "Bienvenida A/B",
        segmentId: "ID_DEL_SEGMENTO",
        variants: [
          { key: "A", templateId: "ID_PLANTILLA_A", weight: 50 },
          { key: "B", templateId: "ID_PLANTILLA_B", weight: 50 },
        ],
        conversionWindowDays: 7,
        status: "draft",
      }}
      updateMethod="PUT"
      allowDelete
      columns={[
        { key: "name", label: "Campaña" },
        { key: "status", label: "Estado", render: (c) => statusBadge(c.status) },
        { key: "channel", label: "Canal", render: (c) => c.channel ?? "—" },
      ]}
      extra={(c, ctx) => (
        <>
          <Button variant="ghost" onClick={async () => { if (!window.confirm("¿Lanzar la campaña ahora? Respeta consentimiento y exclusiones.")) return; try { await ctx.call(`${A}/campaigns/${c.id}/launch`, { method: "POST", body: {} }); ctx.reload(); } catch (e) { ctx.fail(e); } }}>Lanzar</Button>
          <Button variant="ghost" onClick={async () => { try { const m = await ctx.call<Record<string, unknown>>(`${A}/campaigns/${c.id}/metrics`); ctx.showPanel(`Métricas · ${c.name}`, <MetricsView data={m} />); } catch (e) { ctx.fail(e); } }}>Métricas</Button>
        </>
      )}
    />
  );
}

function Presets({ onCreated }: { onCreated(): void }) {
  const { call } = useApiClient();
  const p = useApi<unknown>(`${A}/journeys/presets`);
  const [err, setErr] = useState<string | null>(null);
  const items = asList<Preset>(p.data, "presets");
  const list = items.length ? items : asList<Preset>(p.data);
  if (p.loading) return <Spinner />;
  if (p.error || list.length === 0) return null;
  return (
    <Card title="Journeys prediseñados">
      {err && <ErrorBox message={err} />}
      <div className="flex flex-wrap gap-2">
        {list.map((x) => {
          const id = x.id ?? x.key ?? x.name ?? "";
          return (
            <Button key={id} variant="ghost" title={x.description} onClick={async () => { setErr(null); try { await call(`${A}/journeys/presets/${id}`, { method: "POST", body: {} }); onCreated(); } catch (e) { setErr(e instanceof Error ? e.message : "Error"); } }}>
              + {x.name ?? id}
            </Button>
          );
        })}
      </div>
    </Card>
  );
}

function Journeys() {
  const [n, setN] = useState(0);
  return (
    <div className="space-y-4">
      <Presets onCreated={() => setN((x) => x + 1)} />
      <ResourceManager<Named>
        key={n}
        noun="journey"
        listPath={`${A}/journeys`}
        template={{
          name: "Registro sin depósito 24h",
          status: "paused",
          trigger: { type: "event", event: "player.registered", cancelOn: ["deposit.completed"] },
          steps: [{ type: "wait", minutes: 1440 }, { type: "condition", check: "no_deposit" }, { type: "send", templateId: "ID_PLANTILLA" }],
        }}
        updateMethod="PUT"
        allowDelete
        columns={[{ key: "name", label: "Journey" }, { key: "status", label: "Estado", render: (j) => statusBadge(j.status) }]}
        extra={(j, ctx) => (
          <Button variant="ghost" onClick={async () => { try { const m = await ctx.call<Record<string, unknown>>(`${A}/journeys/${j.id}/metrics`); ctx.showPanel(`Métricas · ${j.name}`, <MetricsView data={m} />); } catch (e) { ctx.fail(e); } }}>Métricas</Button>
        )}
      />
    </div>
  );
}

function Templates() {
  return (
    <ResourceManager<Named>
      noun="plantilla"
      listPath={`${A}/templates`}
      template={{ name: "Bienvenida", channel: "email", kind: "marketing", subject: "¡Hola {{player.name}}!", body: "Tu bono te espera en {{brand.name}}." }}
      updateMethod="PUT"
      allowDelete
      columns={[{ key: "name", label: "Plantilla" }, { key: "channel", label: "Canal" }, { key: "kind", label: "Tipo" }]}
    />
  );
}

export default function CampaignsPage() {
  const { operatorId } = useApiClient();
  const [tab, setTab] = useState<"campaigns" | "journeys" | "templates">("campaigns");
  if (!operatorId) return <><PageHeader title="Campañas y journeys" /><NeedOperator /></>;
  return (
    <>
      <PageHeader title="Campañas y journeys" subtitle="Remarketing con consentimiento: los autoexcluidos, con límites activos o menores no verificados se excluyen automáticamente." />
      <Tabs tabs={[{ id: "campaigns", label: "Campañas" }, { id: "journeys", label: "Journeys" }, { id: "templates", label: "Plantillas" }]} value={tab} onChange={setTab} />
      {tab === "campaigns" && <Campaigns />}
      {tab === "journeys" && <Journeys />}
      {tab === "templates" && <Templates />}
    </>
  );
}
