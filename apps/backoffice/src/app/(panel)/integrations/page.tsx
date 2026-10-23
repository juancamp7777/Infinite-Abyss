"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Bot, CreditCard, Gamepad2, MessageCircle, Plug, Siren, Trophy, type LucideIcon } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useApi, useApiClient, useOperator, useSession } from "@/lib/hooks";
import { Badge, Button, Card, ErrorBox, Field, NeedOperator, Notice, PageHeader, Spinner, Tabs, inputCls } from "@/components/ui";

type Category = "ai" | "games" | "payments" | "sports" | "alerts";
interface FieldDef { name: string; label: string; secret?: boolean; required?: boolean; url?: boolean; placeholder?: string }
interface Def { key: string; category: Category; name: string; description: string; scope: "platform" | "operator" | "both"; readiness: "live" | "contract" | "soon"; test: "http" | "catalog" | "none"; fields: FieldDef[] }
interface View { key: string; connected: boolean; fields: Record<string, string>; status: "none" | "saved" | "ok" | "error"; message: string | null; lastTestAt: string | null; inherited: boolean }
interface Channel { id: string; type: string; name: string; enabled: boolean }

const SECTIONS: Array<{ id: Category; title: string; icon: LucideIcon; hint: string }> = [
  { id: "ai", title: "Inteligencia artificial", icon: Bot, hint: "La usan Pearl para leer comprobantes y Nautilus, el operador IA." },
  { id: "games", title: "Proveedores de juegos", icon: Gamepad2, hint: "Al guardar, el proveedor se enciende en vivo en el catálogo, sin reiniciar." },
  { id: "payments", title: "Pagos", icon: CreditCard, hint: "Cada casino con su propia cuenta." },
  { id: "sports", title: "Datos deportivos", icon: Trophy, hint: "Partidos reales para Leviathan. Sin conectar, se usan partidos simulados." },
  { id: "alerts", title: "Alertas", icon: Siren, hint: "Avisos de caídas, saldos bajos y el resumen diario." },
];
const READINESS: Record<Def["readiness"], { label: string; tone: "good" | "warn" | "neutral" }> = {
  live: { label: "Listo", tone: "good" },
  contract: { label: "Pendiente de contrato", tone: "warn" },
  soon: { label: "Conector en camino", tone: "neutral" },
};
const STATUS: Record<View["status"], { label: string; tone: "good" | "bad" | "warn" | "neutral" }> = {
  ok: { label: "Conectado", tone: "good" },
  error: { label: "Con error", tone: "bad" },
  saved: { label: "Guardado sin probar", tone: "warn" },
  none: { label: "Sin conectar", tone: "neutral" },
};
const errText = (e: unknown) => (e instanceof ApiError ? e.message : "Error inesperado");

function IntegrationCard({ def, view, scope, onChange }: { def: Def; view: View; scope: "platform" | "operator"; onChange: (v: View) => void }) {
  const { call } = useApiClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(view.message ? { ok: view.status === "ok", text: view.message } : null);
  const q = { scope };
  const status = view.inherited ? { label: "Usa la de la plataforma", tone: "good" as const } : STATUS[view.status];

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setMsg(null);
    try { await fn(); } catch (e) { setMsg({ ok: false, text: errText(e) }); } finally { setBusy(null); }
  }
  const save = () => run("save", async () => {
    const v = await call<View>(`/integrations/v1/admin/${def.key}`, { method: "PUT", query: q, body: { values } });
    setValues({});
    onChange(v);
    setMsg({ ok: true, text: def.category === "games" ? "Guardado: el proveedor ya está activo. Prueba la conexión." : "Guardado. Prueba la conexión." });
  });
  const test = () => run("test", async () => {
    const r = await call<{ ok: boolean; message: string; view: View }>(`/integrations/v1/admin/${def.key}/test`, { method: "POST", query: q });
    onChange(r.view);
    setMsg({ ok: r.ok, text: r.message });
  });
  const remove = () => {
    if (!window.confirm(`¿Desconectar ${def.name}? Se borran las credenciales guardadas.`)) return;
    void run("remove", async () => {
      await call(`/integrations/v1/admin/${def.key}`, { method: "DELETE", query: q });
      onChange({ ...view, connected: false, fields: {}, status: "none", message: null, lastTestAt: null, inherited: false });
      setMsg({ ok: true, text: "Desconectado" });
    });
  };
  const own = view.connected && !view.inherited;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{def.name}</p>
          <p className="text-xs text-white/60">{def.description}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          {def.readiness !== "live" && <Badge tone={READINESS[def.readiness].tone}>{READINESS[def.readiness].label}</Badge>}
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
      </div>
      <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {def.fields.map((f) => {
          const current = own ? view.fields[f.name] : undefined;
          return (
            <Field key={f.name} label={`${f.label}${f.required ? "" : " (opcional)"}`} htmlFor={`${def.key}-${f.name}`}>
              <input
                id={`${def.key}-${f.name}`} className={inputCls} type={f.secret ? "password" : "text"} autoComplete="off" spellCheck={false}
                placeholder={f.secret && current ? `${current} · vacío = mantener` : current || f.placeholder || ""}
                value={values[f.name] ?? (f.secret ? "" : (current ?? ""))}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              />
            </Field>
          );
        })}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="submit" disabled={!!busy}>{busy === "save" ? "Guardando…" : own ? "Actualizar" : "Conectar"}</Button>
          {own && <Button type="button" variant="ghost" disabled={!!busy} onClick={test}>{busy === "test" ? "Probando…" : "Probar conexión"}</Button>}
          {own && <Button type="button" variant="danger" disabled={!!busy} onClick={remove}>Desconectar</Button>}
        </div>
      </form>
      {msg && <div role={msg.ok ? "status" : "alert"}><Notice tone={msg.ok ? "ok" : "warn"}>{msg.text}</Notice></div>}
      {view.lastTestAt && <p className="text-[11px] text-white/40">Última prueba: {new Date(view.lastTestAt).toLocaleString("es")}</p>}
    </div>
  );
}

export default function IntegrationsPage() {
  const session = useSession();
  const { operatorId } = useOperator();
  const isPlatform = session?.role === "PLATFORM_ADMIN";
  const [scope, setScope] = useState<"platform" | "operator">(isPlatform ? "platform" : "operator");
  useEffect(() => { if (!isPlatform) setScope("operator"); }, [isPlatform]);
  const catalog = useApi<{ items: Def[] }>("/integrations/v1/admin/catalog");
  const list = useApi<{ items: View[] }>(scope === "operator" && !operatorId ? null : "/integrations/v1/admin/list", { scope });
  const channels = useApi<{ items: Channel[] }>(scope === "operator" && operatorId ? "/inbox/v1/admin/channels" : null);
  const [views, setViews] = useState<Record<string, View>>({});
  useEffect(() => { setViews(Object.fromEntries((list.data?.items ?? []).map((v) => [v.key, v]))); }, [list.data]);

  const defs = useMemo(() => (catalog.data?.items ?? []).filter((d) => d.scope === "both" || d.scope === scope), [catalog.data, scope]);
  const connected = Object.values(views).filter((v) => v.connected).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Integraciones"
        subtitle="Conecta en un solo lugar la IA, los proveedores de juegos, los pagos y las alertas. Las llaves se guardan cifradas y nunca se vuelven a mostrar completas."
        actions={<Badge tone={connected ? "good" : "neutral"}><Plug aria-hidden className="mr-1 inline h-3.5 w-3.5" />{connected} conectadas</Badge>}
      />
      {isPlatform && (
        <Tabs tabs={[{ id: "platform", label: "Toda la plataforma" }, { id: "operator", label: "Este casino" }]} value={scope} onChange={setScope} />
      )}
      {scope === "operator" && !operatorId && <NeedOperator />}
      {(catalog.error || list.error) && <ErrorBox message={(catalog.error || list.error)!} onRetry={() => { catalog.reload(); list.reload(); }} />}
      {(catalog.loading || list.loading) && !list.data && !(scope === "operator" && !operatorId) && <Spinner />}
      {list.data && SECTIONS.map((s) => {
        const items = defs.filter((d) => d.category === s.id);
        if (!items.length) return null;
        return (
          <Card key={s.id} title={s.title}>
            <p className="mb-3 flex items-center gap-2 text-sm text-white/60"><s.icon aria-hidden className="h-4 w-4" />{s.hint}</p>
            <div className="grid gap-3 lg:grid-cols-2">
              {items.map((d) => views[d.key] && (
                <IntegrationCard key={`${scope}-${d.key}`} def={d} view={views[d.key]} scope={scope} onChange={(v) => setViews((cur) => ({ ...cur, [d.key]: v }))} />
              ))}
            </div>
          </Card>
        );
      })}
      {scope === "operator" && operatorId && (
        <Card title="Canales de mensajería">
          <p className="mb-3 flex items-center gap-2 text-sm text-white/60"><MessageCircle aria-hidden className="h-4 w-4" />WhatsApp, Telegram y el webchat del casino llegan a Sonar · Inbox.</p>
          {channels.loading && <Spinner />}
          {channels.data && (channels.data.items.length === 0
            ? <p className="text-sm text-white/60">Todavía no hay canales conectados.</p>
            : <ul className="space-y-1 text-sm">{channels.data.items.map((c) => (
              <li key={c.id} className="flex items-center gap-2"><Badge tone={c.enabled ? "good" : "neutral"}>{c.enabled ? "Activo" : "Pausado"}</Badge><span className="capitalize">{c.type}</span><span className="text-white/60">· {c.name}</span></li>
            ))}</ul>)}
          <Link href="/channels" className="mt-3 inline-block text-sm font-semibold text-amber-300 underline">Conectar o editar canales en Sonar · Canales</Link>
        </Card>
      )}
    </div>
  );
}
