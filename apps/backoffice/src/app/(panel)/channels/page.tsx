"use client";

import { useState } from "react";
import { Check, Copy, Power, Send, Trash2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useApi, useApiClient } from "@/lib/hooks";
import { Badge, Button, Card, Empty, ErrorBox, Field, inputCls, NeedOperator, Notice, PageHeader, Spinner, Tabs } from "@/components/ui";

type ChannelType = "whatsapp" | "telegram";
interface Channel {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  publicInfo: Record<string, string>;
  webhookUrl: string | null;
  verifyToken?: string;
  createdAt: string;
}

const LABEL: Record<ChannelType, string> = { whatsapp: "WhatsApp Business", telegram: "Telegram" };
const COLOR: Record<ChannelType, string> = { whatsapp: "#25d366", telegram: "#29a9eb" };
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : "Error inesperado");

function CopyField({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs text-white/45">{label}</div>
      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5">
        <code className="min-w-0 flex-1 truncate text-xs">{value}</code>
        <button type="button" className="text-white/50 hover:text-white" aria-label={`Copiar ${label}`}
          onClick={() => void navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}>
          {done ? <Check aria-hidden className="h-4 w-4 text-emerald-400" /> : <Copy aria-hidden className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

export default function ChannelsPage() {
  const { call, operatorId } = useApiClient();
  const list = useApi<{ items: Channel[] }>(operatorId ? "/inbox/v1/admin/channels" : null);
  const [type, setType] = useState<ChannelType>("whatsapp");
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  if (!operatorId) return <><PageHeader title="Canales" /><NeedOperator /></>;

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const create = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const { name, ...config } = form;
      const r = await call<{ channel: Channel; warning?: string }>("/inbox/v1/admin/channels", { method: "POST", body: { type, name: name ?? "", config } });
      setForm({});
      setMsg(r.warning ? { tone: "warn", text: r.warning } : { tone: "ok", text: `${LABEL[type]} conectado.` });
      list.reload();
    } catch (e) {
      setMsg({ tone: "warn", text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (c: Channel) => {
    try {
      await call(`/inbox/v1/admin/channels/${c.id}`, { method: "PATCH", body: { enabled: !c.enabled } });
      list.reload();
    } catch (e) {
      setMsg({ tone: "warn", text: errMsg(e) });
    }
  };
  const remove = async (c: Channel) => {
    if (!window.confirm(`¿Desconectar ${c.name}? Las conversaciones se conservan, pero ya no se podrá responder por este canal.`)) return;
    try {
      await call(`/inbox/v1/admin/channels/${c.id}`, { method: "DELETE" });
      list.reload();
    } catch (e) {
      setMsg({ tone: "warn", text: errMsg(e) });
    }
  };

  return (
    <>
      <PageHeader title="Sonar · Canales" subtitle="Conecta números de WhatsApp Business y bots de Telegram: los mensajes llegan al Inbox y las respuestas salen por el mismo canal." />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-3">
          {list.loading ? <Spinner /> : list.error ? <ErrorBox message={list.error} onRetry={list.reload} /> : !list.data?.items.length ? (
            <Card><Empty>Aún no hay canales. Conecta el primero desde el formulario.</Empty></Card>
          ) : list.data.items.map((c) => (
            <Card key={c.id}>
              <div className="flex flex-wrap items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl text-white" style={{ background: COLOR[c.type] }}>
                  <Send aria-hidden className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <div className="font-semibold">{c.name}</div>
                  <div className="text-xs text-white/45">{LABEL[c.type]} · {c.publicInfo.phone ?? c.publicInfo.bot}</div>
                </div>
                <Badge tone={c.enabled ? "good" : "neutral"}>{c.enabled ? "Activo" : "Pausado"}</Badge>
                <div className="ml-auto flex gap-1.5">
                  <Button variant="ghost" onClick={() => void toggle(c)}><Power aria-hidden className="h-4 w-4" /> {c.enabled ? "Pausar" : "Activar"}</Button>
                  <Button variant="danger" onClick={() => void remove(c)} aria-label={`Desconectar ${c.name}`}><Trash2 aria-hidden className="h-4 w-4" /></Button>
                </div>
              </div>
              {c.webhookUrl ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <CopyField label="URL del webhook" value={c.webhookUrl} />
                  {c.verifyToken && <CopyField label="Verify token (Meta)" value={c.verifyToken} />}
                </div>
              ) : (
                <p className="mt-3 text-xs text-amber-300">Falta INBOX_PUBLIC_URL en el API: sin URL pública no se puede recibir mensajes.</p>
              )}
              {c.type === "whatsapp" && (
                <p className="mt-2 text-xs text-white/40">En Meta → WhatsApp → Configuración: pega la URL y el verify token y suscribe el campo <code>messages</code>.</p>
              )}
            </Card>
          ))}
        </div>

        <Card title="Conectar canal">
          <div className="space-y-3">
            <Tabs tabs={[{ id: "whatsapp", label: "WhatsApp" }, { id: "telegram", label: "Telegram" }]} value={type} onChange={(t) => { setType(t); setForm({}); setMsg(null); }} />
            <Field label="Nombre interno" htmlFor="ch-name"><input id="ch-name" className={`${inputCls} w-full`} value={form.name ?? ""} onChange={set("name")} placeholder="Soporte principal" /></Field>
            {type === "whatsapp" ? (
              <>
                <Field label="Phone number ID" htmlFor="ch-pid"><input id="ch-pid" className={`${inputCls} w-full`} value={form.phoneNumberId ?? ""} onChange={set("phoneNumberId")} inputMode="numeric" /></Field>
                <Field label="Número visible" htmlFor="ch-phone" hint="Solo para mostrar, p. ej. +57 300 000 0000"><input id="ch-phone" className={`${inputCls} w-full`} value={form.displayPhone ?? ""} onChange={set("displayPhone")} /></Field>
                <Field label="Access token permanente" htmlFor="ch-token"><input id="ch-token" type="password" autoComplete="off" className={`${inputCls} w-full`} value={form.accessToken ?? ""} onChange={set("accessToken")} /></Field>
                <Field label="App secret" htmlFor="ch-secret" hint="Se usa para verificar la firma de cada webhook"><input id="ch-secret" type="password" autoComplete="off" className={`${inputCls} w-full`} value={form.appSecret ?? ""} onChange={set("appSecret")} /></Field>
              </>
            ) : (
              <>
                <Field label="Token del bot" htmlFor="ch-bot" hint="Lo entrega @BotFather"><input id="ch-bot" type="password" autoComplete="off" className={`${inputCls} w-full`} value={form.botToken ?? ""} onChange={set("botToken")} /></Field>
                <Field label="Usuario del bot" htmlFor="ch-user"><input id="ch-user" className={`${inputCls} w-full`} value={form.botUsername ?? ""} onChange={set("botUsername")} placeholder="@MiCasinoBot" /></Field>
              </>
            )}
            <p className="text-xs text-white/40">Las credenciales se guardan cifradas y nunca se vuelven a mostrar.</p>
            <Button className="w-full" disabled={busy} onClick={() => void create()}>{busy ? "Conectando…" : "Conectar"}</Button>
            {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
          </div>
        </Card>
      </div>
    </>
  );
}
