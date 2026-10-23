"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, Check, Eye, RefreshCw, Send, Sparkles } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useApi, useApiClient } from "@/lib/hooks";
import { Badge, Button, Card, Empty, ErrorBox, NeedOperator, Notice, PageHeader, Spinner, inputCls } from "@/components/ui";

interface Finding { id: string; kind: string; severity: "info" | "warn" | "high"; title: string; detail: string; status: string; firstSeenAt: string; lastSeenAt: string }
interface Briefing { headline: string; summary: string; risks: Array<{ title: string; detail: string; severity: string }>; recommendations: Array<{ action: string; why: string }> }
interface Report { id: string; day: string; content: Briefing; createdAt: string }

const SEVERITY = { high: { label: "Urgente", tone: "bad" }, warn: { label: "Atención", tone: "warn" }, info: { label: "Info", tone: "neutral" } } as const;
const SUGGESTIONS = ["¿Cómo nos fue ayer comparado con la semana?", "¿Qué retiros están pendientes y desde cuándo?", "¿Hay algo raro hoy que deba revisar?", "¿Cómo está la cola de comprobantes de Pearl?"];
const since = (iso: string) => {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return min < 60 ? `hace ${Math.max(min, 1)} min` : min < 1440 ? `hace ${Math.round(min / 60)} h` : `hace ${Math.round(min / 1440)} d`;
};

export default function NautilusPage() {
  const { operatorId, call } = useApiClient();
  const findings = useApi<{ items: Finding[] }>(operatorId ? "/nautilus/v1/admin/findings" : null);
  const reports = useApi<{ items: Report[] }>(operatorId ? "/nautilus/v1/admin/reports" : null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ q: string; a: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; needKey?: boolean } | null>(null);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setMsg(null);
    try { await fn(); } catch (e) {
      const needKey = e instanceof ApiError && e.code === "AI_NOT_CONNECTED";
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : "Error inesperado", needKey });
    } finally { setBusy(null); }
  }
  const ask = (q: string) => run("ask", async () => {
    const r = await call<{ answer: string }>("/nautilus/v1/admin/ask", { method: "POST", body: { question: q } });
    setAnswer({ q, a: r.answer });
  });

  if (!operatorId) return <div className="space-y-4"><PageHeader title="Nautilus · Operador IA" /><NeedOperator /></div>;
  const open = findings.data?.items ?? [];
  const latest = reports.data?.items[0];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Nautilus · Operador IA"
        subtitle="Vigila tu casino cada 5 minutos, te avisa por Telegram lo urgente, te escribe el resumen del día y responde tus preguntas con datos reales. Nunca mueve dinero: lo decides tú."
        actions={<Button type="button" variant="ghost" disabled={!!busy} onClick={() => void run("scan", async () => { await call("/nautilus/v1/admin/scan", { method: "POST" }); findings.reload(); setMsg({ ok: true, text: "Escaneo completo" }); })}><RefreshCw aria-hidden className="mr-1 inline h-4 w-4" />{busy === "scan" ? "Escaneando…" : "Escanear ahora"}</Button>}
      />
      {msg && (
        <div role={msg.ok ? "status" : "alert"}>
          <Notice tone={msg.ok ? "ok" : "warn"}>{msg.text}{msg.needKey && <> · <Link href="/integrations" className="font-semibold underline">Conectar Claude en Integraciones</Link></>}</Notice>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <Card title={`Alertas abiertas (${open.length})`}>
          {findings.error && <ErrorBox message={findings.error} onRetry={findings.reload} />}
          {findings.loading && !findings.data && <Spinner />}
          {findings.data && open.length === 0 && <Empty>Todo en orden: ningún vigilante encontró problemas.</Empty>}
          <ul className="space-y-2">
            {open.map((f) => (
              <li key={f.id} className={`rounded-lg border p-3 ${f.severity === "high" ? "border-red-400/40 bg-red-400/5" : "border-white/10"}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-semibold">{f.severity === "high" && <AlertTriangle aria-hidden className="mr-1 inline h-4 w-4 text-red-400" />}{f.title}</p>
                  <div className="flex gap-1"><Badge tone={SEVERITY[f.severity].tone}>{SEVERITY[f.severity].label}</Badge>{f.status === "acknowledged" && <Badge>Visto</Badge>}</div>
                </div>
                <p className="mt-1 text-sm text-white/70">{f.detail}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-white/50">
                  <span>Desde {since(f.firstSeenAt)}</span>
                  {f.status !== "acknowledged" && <Button type="button" variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => void run("ack", async () => { await call(`/nautilus/v1/admin/findings/${f.id}/ack`, { method: "POST" }); findings.reload(); })}><Eye aria-hidden className="mr-1 inline h-3.5 w-3.5" />Lo vi</Button>}
                  <Button type="button" variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => void run("resolve", async () => { await call(`/nautilus/v1/admin/findings/${f.id}/resolve`, { method: "POST" }); findings.reload(); })}><Check aria-hidden className="mr-1 inline h-3.5 w-3.5" />Resuelto</Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Pregúntale a Nautilus">
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (question.trim().length >= 3) void ask(question.trim()); }}>
            <textarea aria-label="Tu pregunta" rows={3} maxLength={1000} className={inputCls} placeholder="Ej.: ¿qué jugadores depositaron más esta semana?" value={question} onChange={(e) => setQuestion(e.target.value)} />
            <div className="flex flex-wrap gap-1">
              {SUGGESTIONS.map((s) => <button key={s} type="button" className="rounded-full border border-white/15 px-2.5 py-1 text-xs text-white/70 hover:border-amber-300 hover:text-white" onClick={() => { setQuestion(s); void ask(s); }}>{s}</button>)}
            </div>
            <Button type="submit" disabled={!!busy || question.trim().length < 3}><Send aria-hidden className="mr-1 inline h-4 w-4" />{busy === "ask" ? "Pensando…" : "Preguntar"}</Button>
          </form>
          {answer && (
            <div className="mt-3 rounded-lg border border-emerald-300/20 bg-emerald-300/5 p-3" aria-live="polite">
              <p className="text-xs text-white/50">{answer.q}</p>
              <p className="mt-1 whitespace-pre-line text-sm leading-relaxed">{answer.a}</p>
            </div>
          )}
        </Card>
      </div>

      <Card title="Resumen del día" actions={<Button type="button" variant="ghost" disabled={!!busy} onClick={() => void run("report", async () => { await call("/nautilus/v1/admin/reports/generate", { method: "POST" }); reports.reload(); setMsg({ ok: true, text: "Resumen generado (y enviado a Telegram si está conectado)" }); })}><Sparkles aria-hidden className="mr-1 inline h-4 w-4" />{busy === "report" ? "Redactando…" : "Generar ahora"}</Button>}>
        {reports.loading && !reports.data && <Spinner />}
        {reports.data && !latest && <Empty>Todavía no hay resúmenes. Nautilus redacta el de ayer cada mañana a las 8:00 (hora del casino).</Empty>}
        {latest && (
          <article className="space-y-3">
            <p className="text-xs text-white/50">Día {latest.day}</p>
            <h3 className="text-lg font-semibold">{latest.content.headline}</h3>
            <p className="whitespace-pre-line text-sm text-white/80">{latest.content.summary}</p>
            {latest.content.risks.length > 0 && (
              <div><p className="mb-1 text-sm font-semibold">Riesgos</p><ul className="space-y-1 text-sm">{latest.content.risks.map((r, i) => <li key={i}><Badge tone={r.severity === "high" ? "bad" : r.severity === "warn" ? "warn" : "neutral"}>{r.title}</Badge> <span className="text-white/70">{r.detail}</span></li>)}</ul></div>
            )}
            {latest.content.recommendations.length > 0 && (
              <div><p className="mb-1 text-sm font-semibold">Qué hacer</p><ol className="list-decimal space-y-1 pl-5 text-sm">{latest.content.recommendations.map((r, i) => <li key={i}><strong>{r.action}</strong> <span className="text-white/60">— {r.why}</span></li>)}</ol></div>
            )}
          </article>
        )}
        {(reports.data?.items.length ?? 0) > 1 && (
          <p className="mt-3 text-xs text-white/50">Anteriores: {reports.data!.items.slice(1, 8).map((r) => r.day).join(" · ")}</p>
        )}
      </Card>
    </div>
  );
}
