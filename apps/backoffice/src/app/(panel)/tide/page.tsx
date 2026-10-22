"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { GitBranch, Plus, Power, Sparkles, Trash2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useApi, useApiClient } from "@/lib/hooks";
import { Badge, Button, Card, Empty, ErrorBox, inputCls, NeedOperator, Notice, PageHeader, Spinner } from "@/components/ui";

interface FlowItem {
  id: string;
  name: string;
  enabled: boolean;
  publishedVersion?: number;
  nodes: number;
  updatedAt: string;
}

export default function TideFlowsPage() {
  const { call, operatorId } = useApiClient();
  const router = useRouter();
  const list = useApi<{ items: FlowItem[] }>(operatorId ? "/tide/v1/admin/flows" : null);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (!operatorId) return <><PageHeader title="Tide" /><NeedOperator /></>;

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      list.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Error inesperado");
    }
  };
  const create = (template: "welcome" | "blank") => run(async () => {
    const f = await call<{ id: string }>("/tide/v1/admin/flows", { method: "POST", body: { name, template } });
    setName("");
    router.push(`/tide/editor?id=${f.id}`);
  });

  return (
    <>
      <PageHeader title="Tide · Flujos y bots" subtitle="Diseña bots que atienden el webchat, WhatsApp y Telegram: bienvenida, menús, preguntas frecuentes y paso a un agente." />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-3">
          {err && <Notice tone="warn">{err}</Notice>}
          {list.loading ? <Spinner /> : list.error ? <ErrorBox message={list.error} onRetry={list.reload} /> : !list.data?.items.length ? (
            <Card><Empty>Aún no hay flujos. Empieza con la plantilla de bienvenida.</Empty></Card>
          ) : list.data.items.map((f) => (
            <Card key={f.id}>
              <div className="flex flex-wrap items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-[var(--color-brand2)] to-sky-600 text-slate-950"><GitBranch aria-hidden className="h-5 w-5" /></span>
                <div className="min-w-0">
                  <Link href={`/tide/editor?id=${f.id}`} className="font-semibold hover:text-[var(--color-brand)]">{f.name}</Link>
                  <div className="text-xs text-white/45">{f.nodes} pasos · {f.publishedVersion ? `versión ${f.publishedVersion} publicada` : "borrador sin publicar"}</div>
                </div>
                <Badge tone={f.enabled ? "good" : "neutral"}>{f.enabled ? "Activo" : "Inactivo"}</Badge>
                <div className="ml-auto flex gap-1.5">
                  <Link href={`/tide/editor?id=${f.id}`} className="inline-flex items-center rounded-lg border border-white/10 px-3 py-1.5 text-sm font-semibold hover:bg-white/5">Editar</Link>
                  {f.publishedVersion && (
                    <Button variant="ghost" onClick={() => void run(() => call(`/tide/v1/admin/flows/${f.id}`, { method: "PATCH", body: { enabled: !f.enabled } }))}>
                      <Power aria-hidden className="h-4 w-4" /> {f.enabled ? "Pausar" : "Activar"}
                    </Button>
                  )}
                  <Button variant="danger" aria-label={`Borrar ${f.name}`} onClick={() => window.confirm(`¿Borrar el flujo "${f.name}"?`) && void run(() => call(`/tide/v1/admin/flows/${f.id}`, { method: "DELETE" }))}>
                    <Trash2 aria-hidden className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
        <Card title="Nuevo flujo">
          <div className="space-y-3">
            <input className={`${inputCls} w-full`} placeholder="Nombre (p. ej. Bienvenida)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Nombre del flujo" />
            <Button className="w-full" onClick={() => void create("welcome")}><Sparkles aria-hidden className="h-4 w-4" /> Desde plantilla de bienvenida</Button>
            <Button variant="ghost" className="w-full" onClick={() => void create("blank")}><Plus aria-hidden className="h-4 w-4" /> En blanco</Button>
            <p className="text-xs text-white/40">El bot solo atiende conversaciones sin agente asignado. Cuando un agente responde, el bot se retira.</p>
          </div>
        </Card>
      </div>
    </>
  );
}
