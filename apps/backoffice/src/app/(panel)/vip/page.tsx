"use client";

import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { useApi, useApiClient, useCurrency } from "@/lib/hooks";
import { money, sampleMinor } from "@/lib/format";
import { ResourceManager } from "@/components/ResourceManager";
import { Button, Card, ErrorBox, inputCls, NeedOperator, Notice, PageHeader, Spinner, Tabs } from "@/components/ui";

const G = "/gamification/v1/admin";

type TabId = "levels" | "missions" | "achievements" | "wheel" | "settings";

interface Level { id?: string; name: string; order: number; pointsRequired: string; rakebackBps: number; levelUpBonus?: string }
interface Mission { id?: string; name: string; period: string; type: string; target: string; active?: boolean }
interface Achievement { id?: string; name: string; criteria?: { metric: string; value: string | number }; active?: boolean }

/** Editor JSON de un documento único (ajustes del programa, rueda). */
function SingletonEditor({ path, method = "PUT" }: { path: string; method?: "PUT" }) {
  const { call } = useApiClient();
  const cur = useApi<unknown>(path);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (cur.data !== undefined) setText(JSON.stringify(cur.data, null, 2));
  }, [cur.data]);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await call(path, { method, body: JSON.parse(text) });
      setMsg({ tone: "ok", text: "Guardado." });
      cur.reload();
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof ApiError ? `${e.message}${e.details ? ` — ${JSON.stringify(e.details).slice(0, 300)}` : ""}` : e instanceof SyntaxError ? `JSON inválido: ${e.message}` : "Error inesperado" });
    } finally {
      setBusy(false);
    }
  }

  if (cur.loading && cur.data === undefined) return <Spinner />;
  if (cur.error) return <ErrorBox message={cur.error} onRetry={cur.reload} />;
  return (
    <Card>
      <label htmlFor="singleton" className="mb-1 block text-xs text-white/60">Configuración (JSON)</label>
      <textarea id="singleton" spellCheck={false} className={`${inputCls} h-96 font-mono text-xs`} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="mt-3 flex items-center gap-3">
        <Button onClick={save} disabled={busy}>{busy ? "Guardando…" : "Guardar"}</Button>
        {msg && (msg.tone === "ok" ? <Notice tone="ok">{msg.text}</Notice> : <ErrorBox message={msg.text} />)}
      </div>
    </Card>
  );
}

export default function VipPage() {
  const { operatorId, call } = useApiClient();
  const cur = useCurrency();
  const [tab, setTab] = useState<TabId>("levels");
  const [key, setKey] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  if (!operatorId) return <><PageHeader title="VIP y misiones" /><NeedOperator /></>;

  return (
    <>
      <PageHeader title="VIP y misiones" subtitle="Niveles con puntos por apuesta y rakeback, misiones diarias/semanales, logros y rueda de la fortuna." />
      <Tabs
        tabs={[{ id: "levels", label: "Niveles VIP" }, { id: "missions", label: "Misiones" }, { id: "achievements", label: "Logros" }, { id: "wheel", label: "Rueda diaria" }, { id: "settings", label: "Ajustes" }]}
        value={tab}
        onChange={setTab}
      />
      {tab === "levels" && (
        <div className="space-y-4">
          <div>
            <Button variant="ghost" onClick={async () => { if (!window.confirm("Esto reemplaza los niveles por los predeterminados. ¿Continuar?")) return; setErr(null); try { await call(`${G}/vip/levels-reset-defaults`, { method: "POST", body: {} }); setKey((k) => k + 1); } catch (e) { setErr(e instanceof ApiError ? e.message : "Error"); } }}>Restaurar niveles predeterminados</Button>
          </div>
          {err && <ErrorBox message={err} />}
          <ResourceManager<Level>
            key={key}
            noun="nivel"
            listPath={`${G}/vip/levels`}
            template={{ name: "Platinum", order: 3, pointsRequired: "500000", rakebackBps: 800, levelUpBonus: sampleMinor(50, cur), benefits: { support: "prioritario" } }}
            updateMethod="PUT"
            allowDelete
            columns={[
              { key: "order", label: "#" },
              { key: "name", label: "Nivel" },
              { key: "pointsRequired", label: "Puntos requeridos", render: (l) => l.pointsRequired },
              { key: "rakebackBps", label: "Rakeback", render: (l) => `${(l.rakebackBps / 100).toFixed(2)}%` },
              { key: "levelUpBonus", label: "Bono al subir", render: (l) => money(l.levelUpBonus ?? "0", cur) },
            ]}
          />
        </div>
      )}
      {tab === "missions" && (
        <ResourceManager<Mission>
          noun="misión"
          listPath={`${G}/missions`}
          template={{ name: "Apuesta 100 hoy", period: "daily", type: "wager", target: "10000", reward: { type: "points", points: "500" }, active: true }}
          updateMethod="PUT"
          allowDelete
          columns={[{ key: "name", label: "Misión" }, { key: "period", label: "Periodo" }, { key: "type", label: "Tipo" }, { key: "target", label: "Meta" }, { key: "active", label: "Activa", render: (m) => (m.active === false ? "No" : "Sí") }]}
        />
      )}
      {tab === "achievements" && (
        <ResourceManager<Achievement>
          noun="logro"
          listPath={`${G}/achievements`}
          template={{ name: "Primer millar", description: "Apuesta 1.000 en total", criteria: { metric: "total_wagered", value: "100000" }, reward: { type: "points", points: "1000" }, active: true }}
          updateMethod="PUT"
          allowDelete
          columns={[{ key: "name", label: "Logro" }, { key: "criteria", label: "Criterio", render: (a) => (a.criteria ? `${a.criteria.metric} ≥ ${a.criteria.value}` : "—") }, { key: "active", label: "Activo", render: (a) => (a.active === false ? "No" : "Sí") }]}
        />
      )}
      {tab === "wheel" && <SingletonEditor path={`${G}/wheel`} />}
      {tab === "settings" && <SingletonEditor path={`${G}/settings`} />}
    </>
  );
}
