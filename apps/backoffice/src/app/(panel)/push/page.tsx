"use client";

import { useState } from "react";
import { BellRing, ImageOff, Plus, Send, Smartphone, Trash2, Users } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useApi, useApiClient } from "@/lib/hooks";
import { Badge, Button, Card, ErrorBox, Field, inputCls, NeedOperator, Notice, PageHeader, Stat } from "@/components/ui";

const A = "/marketing/v1/admin";
const BANNERS = [{ id: "bono", label: "Dorado (bonos)" }, { id: "jackpot", label: "Violeta (jackpots)" }, { id: "torneo", label: "Turquesa (torneos)" }];
const PAGES = [
  { url: "/lobby", label: "Lobby" }, { url: "/cashier", label: "Caja (depositar)" }, { url: "/lobby/vip", label: "VIP" }, { url: "/lobby/tournaments", label: "Torneos" },
  { url: "/lobby/category/originals", label: "Originals" }, { url: "/lobby/category/slots", label: "Slots" }, { url: "/account", label: "Mi cuenta" },
];
const IDEAS = [
  { name: "Happy hour", title: "🔥 ¡Happy hour activo!", body: "Recarga ahora y llévate 25 % extra. Solo hasta las 22:00.", image: "bono", url: "/cashier", actions: [{ title: "💰 Recargar", url: "/cashier" }, { title: "🎰 Jugar", url: "/lobby" }] },
  { name: "Jackpot", title: "💎 El jackpot está por caer", body: "El Mega Jackpot sigue creciendo. ¿Serás quien se lo lleve hoy?", image: "jackpot", url: "/lobby", actions: [{ title: "🎰 Jugar ahora", url: "/lobby" }] },
  { name: "Torneo", title: "🏆 Arranca el torneo semanal", body: "Suma puntos con cada jugada y compite por el premio mayor.", image: "torneo", url: "/lobby/tournaments", actions: [{ title: "🏆 Ver torneo", url: "/lobby/tournaments" }] },
  { name: "Te extrañamos", title: "👋 ¡Te extrañamos!", body: "Tenemos un regalo esperándote. Entra y reclámalo hoy.", image: "bono", url: "/lobby", actions: [{ title: "🎁 Ver regalo", url: "/lobby" }] },
];

interface Action { title: string; url: string }

/** Push con imagen, página destino y botones, con vista previa de cómo la ve el jugador en Android y en iPhone. */
export default function PushPage() {
  const { operatorId, call } = useApiClient();
  const stats = useApi<{ enabled: boolean; devices: number; players: number }>(operatorId ? `${A}/push/stats` : null);
  const audiences = useApi<{ items: { key: string; label: string; hint: string; players: number | null }[]; segments: { id: string; name: string; players: number }[] }>(operatorId ? `${A}/push/audiences` : null);
  const [target, setTarget] = useState("a:all");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [image, setImage] = useState<string | null>("bono");
  const [url, setUrl] = useState("/lobby");
  const [actions, setActions] = useState<Action[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (!operatorId) return <><PageHeader title="Notificaciones push" /><NeedOperator /></>;
  const imgUrl = image ? `/brand/push/${image}.png` : null;
  const total = stats.data?.players ?? 0;
  const targets = [
    ...(audiences.data?.items ?? []).map((a) => ({ id: `a:${a.key}`, label: a.label, hint: a.hint, players: a.players })),
    ...(audiences.data?.segments ?? []).map((s) => ({ id: `s:${s.id}`, label: s.name, hint: "Segmento propio del CRM.", players: s.players })),
  ];
  const chosen = targets.find((t) => t.id === target);
  const players = target === "a:all" ? total : chosen?.players ?? 0;
  const valid = title.trim().length > 0 && body.trim().length > 0 && actions.every((a) => a.title.trim());

  async function send() {
    if (!confirm(`¿Enviar esta notificación a ${players} jugador(es) (${chosen?.label ?? "Todos"}) con push activo?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await call<{ audience: number; devices: number }>(`${A}/push/broadcast`, {
        method: "POST",
        body: { ...(target.startsWith("s:") ? { segmentId: target.slice(2) } : { audience: target.slice(2) }), title: title.trim(), body: body.trim(), push: { ...(imgUrl ? { image: imgUrl } : {}), url, actions: actions.map((a) => ({ title: a.title.trim(), url: a.url })) } },
      });
      setMsg({ ok: true, text: `Enviando a ${r.audience} jugador(es) en ${r.devices} dispositivo(s). Los que no aceptan marketing no la reciben.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : "No se pudo enviar" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Notificaciones push" subtitle="Llegan al celular y al computador de los jugadores aunque no tengan el casino abierto. En Android y computador salen con imagen grande y botones; en iPhone, con logo, título y texto." />
      {stats.error && <ErrorBox message={stats.error} onRetry={stats.reload} />}
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Jugadores con push" value={String(players)} icon={<BellRing className="h-4 w-4" />} accent="gold" />
        <Stat label="Dispositivos" value={String(stats.data?.devices ?? 0)} icon={<Smartphone className="h-4 w-4" />} accent="cyan" />
        <Stat label="Estado" value={stats.data?.enabled ? "Listo para enviar" : "Sin configurar"} accent={stats.data?.enabled ? "green" : "red"} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_24rem]">
        <div className="space-y-4">
        <Card title="¿A quién se la envías?">
          {audiences.error && <ErrorBox message={audiences.error} onRetry={audiences.reload} />}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label="Tipo de jugador">
            {targets.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={target === t.id} onClick={() => setTarget(t.id)}
                className={`rounded-xl border p-3 text-left transition ${target === t.id ? "border-amber-400 bg-amber-400/10" : "border-white/10 hover:border-white/30"}`}>
                <span className="flex items-center justify-between gap-2"><span className="font-semibold">{t.label}</span><span className="flex items-center gap-1 text-xs text-white/60"><Users className="h-3.5 w-3.5" aria-hidden />{t.players ?? "—"}</span></span>
                <span className="mt-1 block text-xs text-white/45">{t.hint}</span>
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-white/45">El número es cuántos jugadores de ese tipo tienen las notificaciones activas. Crea tipos a tu medida en Segmentos y aparecen aquí.</p>
        </Card>
        <Card title="Mensaje">
          <div className="mb-4 flex flex-wrap gap-2">
            <span className="self-center text-xs text-white/45">Ideas:</span>
            {IDEAS.map((i) => <button key={i.name} type="button" className="rounded-full border border-white/15 px-3 py-1 text-xs hover:border-amber-300" onClick={() => { setTitle(i.title); setBody(i.body); setImage(i.image); setUrl(i.url); setActions(i.actions); }}>{i.name}</button>)}
          </div>
          <div className="space-y-3">
            <Field label={`Título (${title.length}/80)`} htmlFor="p-title"><input id="p-title" className={inputCls} maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="🔥 ¡Happy hour activo!" /></Field>
            <Field label={`Mensaje (${body.length}/300)`} htmlFor="p-body"><textarea id="p-body" rows={3} className={inputCls} maxLength={300} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Recarga ahora y llévate 25 % extra." /></Field>
            <div>
              <p className="mb-2 text-sm font-semibold">Imagen grande</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {BANNERS.map((b) => (
                  <button key={b.id} type="button" aria-pressed={image === b.id} onClick={() => setImage(b.id)} className={`overflow-hidden rounded-lg border-2 ${image === b.id ? "border-amber-400" : "border-transparent opacity-70 hover:opacity-100"}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/brand/push/${b.id}.png`} alt={b.label} className="aspect-[2/1] w-full object-cover" />
                  </button>
                ))}
                <button type="button" aria-pressed={image === null} onClick={() => setImage(null)} className={`grid aspect-[2/1] place-items-center rounded-lg border-2 text-xs text-white/50 ${image === null ? "border-amber-400" : "border-white/10"}`}><span className="flex items-center gap-1"><ImageOff className="h-4 w-4" aria-hidden />Sin imagen</span></button>
              </div>
            </div>
            <Field label="Al tocarla abre" htmlFor="p-url"><select id="p-url" className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)}>{PAGES.map((p) => <option key={p.url} value={p.url}>{p.label}</option>)}</select></Field>
            <div>
              <p className="mb-2 text-sm font-semibold">Botones (hasta 2)</p>
              <div className="space-y-2">
                {actions.map((a, i) => (
                  <div key={i} className="grid gap-2 sm:grid-cols-[1fr_12rem_auto]">
                    <input aria-label={`Texto del botón ${i + 1}`} className={inputCls} maxLength={24} value={a.title} placeholder="🎰 Jugar ahora" onChange={(e) => setActions(actions.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
                    <select aria-label={`Destino del botón ${i + 1}`} className={inputCls} value={a.url} onChange={(e) => setActions(actions.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}>{PAGES.map((p) => <option key={p.url} value={p.url}>{p.label}</option>)}</select>
                    <button type="button" className="text-white/40 hover:text-red-300" aria-label={`Quitar botón ${i + 1}`} onClick={() => setActions(actions.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" aria-hidden /></button>
                  </div>
                ))}
                {actions.length < 2 && <Button variant="ghost" onClick={() => setActions([...actions, { title: "", url: "/lobby" }])}><Plus className="mr-1 inline h-4 w-4" aria-hidden />Agregar botón</Button>}
              </div>
            </div>
          </div>
          {msg && <div className="mt-4" role={msg.ok ? "status" : "alert"}><Notice tone={msg.ok ? "ok" : "warn"}>{msg.text}</Notice></div>}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button disabled={!valid || busy || !players || !stats.data?.enabled} onClick={() => void send()}><Send className="mr-1 inline h-4 w-4" aria-hidden />{busy ? "Enviando…" : `Enviar a ${players} jugador(es)`}</Button>
            {!total ? <span className="text-xs text-white/45">Aún nadie activó las notificaciones.</span> : !players && <span className="text-xs text-white/45">Nadie de este tipo tiene las notificaciones activas.</span>}
          </div>
        </Card>
        </div>

        <div className="space-y-4">
          <div>
            <p className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-white/45">Android <Badge>con imagen y botones</Badge></p>
            <div className="rounded-2xl bg-[#2a2d36] p-3 text-white shadow-xl">
              <div className="flex items-center gap-1.5 text-[11px] text-white/60">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/infinite-abyss-mark.svg" alt="" className="h-4 w-4 rounded" /> Infinite Abyss · ahora
              </div>
              <div className="mt-1.5 flex gap-3">
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{title || "Título de la notificación"}</p><p className="mt-0.5 line-clamp-3 text-[13px] text-white/75">{body || "Aquí va el mensaje para el jugador."}</p></div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/infinite-abyss-mark.svg" alt="" className="h-10 w-10 rounded-lg" />
              </div>
              {imgUrl && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={imgUrl} alt="" className="mt-3 aspect-[2/1] w-full rounded-xl object-cover" />
              )}
              {actions.length > 0 && <div className="mt-2 flex gap-4 px-1 text-[13px] font-semibold text-[#8ab4f8]">{actions.map((a, i) => <span key={i}>{a.title || "Botón"}</span>)}</div>}
            </div>
          </div>
          <div>
            <p className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-white/45">iPhone <Badge>app instalada</Badge></p>
            <div className="rounded-[22px] bg-white/80 p-3 text-black shadow-xl backdrop-blur">
              <div className="flex gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/infinite-abyss-mark.svg" alt="" className="h-9 w-9 rounded-lg" />
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between text-[13px]"><b className="truncate">{title || "Título de la notificación"}</b><span className="shrink-0 text-black/45">ahora</span></div>
                  <p className="line-clamp-4 text-[13px] text-black/80">{body || "Aquí va el mensaje para el jugador."}</p>
                </div>
              </div>
            </div>
            <p className="mt-2 text-xs text-white/40">Apple no permite imagen grande ni botones en notificaciones de webs: en iPhone sale así y abre la página elegida al tocarla.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
