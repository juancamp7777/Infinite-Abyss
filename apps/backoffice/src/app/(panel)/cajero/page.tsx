"use client";

import { useEffect, useMemo, useState } from "react";
import { History, RotateCcw, Save, Send, Sparkles, Undo2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useApi, useApiClient } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { Badge, Button, Card, ErrorBox, Field, inputCls, NeedOperator, Notice, PageHeader, Spinner, Tabs } from "@/components/ui";
import { ChatPreview, MoneyInput, PctInput, Toggle, WindowsEditor, type TimeWindow } from "./editors";
import { PromosEditor, type Promo } from "./promos";

type Stage = "new_lead" | "client" | "vip" | "deposit_review" | "withdraw" | "support";
export interface BotConfig {
  enabled: boolean;
  persona: { name: string; tone: "cercano" | "formal"; emojis: boolean };
  messages: { welcome: string; afterLoad: string; existingClient: string; handoff: string; noCharge: string; askReferral: boolean };
  amounts: { minDeposit: string; minWithdraw: string; vipFrom: string; referralBonus: string; autoCreditMax: string; accumulateMinutes: number };
  hours: { timezone: string; noCharge: "off" | "always" | "schedule"; windows: TimeWindow[] };
  automation: { autoCredit: boolean; createUsers: boolean; giveBankData: "never" | "on_request" | "new_leads"; takeWithdrawals: boolean; handoffOnPassword: boolean; handoffOnUnmatchedReceipt: boolean; naturalHandoff: boolean; replyDelaySeconds: number };
  routing: { support: Stage; pendingCredit: Stage; vip: Stage; withdraw: Stage };
  bonuses: { housePct: number; houseMin: string | null; houseMax: string | null; welcomePct: number; happyHourPct: number; happyHours: TimeWindow[]; promos: Promo[] };
}
interface View {
  currency: string;
  draft: BotConfig;
  published: BotConfig | null;
  publishedVersion: number | null;
  dirty: boolean;
  check: { errors: string[]; warnings: string[] };
  versions: Array<{ version: number; publishedBy: string; note: string; createdAt: string }>;
  updatedAt: string | null;
}

type Tab = "mensajes" | "montos" | "horarios" | "auto" | "bonos" | "salas" | "historial";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "mensajes", label: "Personalidad y mensajes" }, { id: "montos", label: "Montos" }, { id: "horarios", label: "Horarios" },
  { id: "auto", label: "Qué hace solo" }, { id: "bonos", label: "Bonos y promos" }, { id: "salas", label: "Salas" }, { id: "historial", label: "Historial" },
];
const STAGES: Array<{ id: Stage; label: string }> = [
  { id: "new_lead", label: "Lead nuevo" }, { id: "client", label: "Cliente" }, { id: "vip", label: "VIP" }, { id: "deposit_review", label: "Revisión de depósito" }, { id: "withdraw", label: "Retiro" }, { id: "support", label: "Soporte" },
];
const TIMEZONES = ["America/Bogota", "America/Mexico_City", "America/Argentina/Buenos_Aires", "America/New_York", "Europe/London", "UTC"];

/** Cajero IA (sucesor de RoboBeast): todo en una pantalla, tipado, con borrador, publicación, historial y vuelta atrás. */
export default function CajeroPage() {
  const { operatorId, call } = useApiClient();
  const v = useApi<View>(operatorId ? "/pearl/v1/admin/bot" : null);
  const [tab, setTab] = useState<Tab>("mensajes");
  const [cfg, setCfg] = useState<BotConfig | null>(null);
  const [local, setLocal] = useState<View | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => { if (v.data) { setLocal(v.data); setCfg(v.data.draft); } }, [v.data]);
  const view = local ?? v.data;
  const unsaved = useMemo(() => !!cfg && !!view && JSON.stringify(cfg) !== JSON.stringify(view.draft), [cfg, view]);

  if (!operatorId) return <><PageHeader title="Pearl · Cajero IA" /><NeedOperator /></>;
  if (v.error) return <><PageHeader title="Pearl · Cajero IA" /><ErrorBox message={v.error} onRetry={v.reload} /></>;
  if (!view || !cfg) return <><PageHeader title="Pearl · Cajero IA" /><Spinner /></>;
  const cur = view.currency;

  const set = <K extends keyof BotConfig>(k: K, patch: Partial<BotConfig[K]>) => setCfg((c) => (c ? { ...c, [k]: { ...(c[k] as object), ...patch } } : c));
  async function run(label: string, fn: () => Promise<View>, ok: string) {
    setBusy(label);
    setMsg(null);
    try {
      const next = await fn();
      setLocal(next);
      setCfg(next.draft);
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : "Error inesperado" });
    } finally {
      setBusy(null);
    }
  }
  const save = () => run("save", () => call<View>("/pearl/v1/admin/bot/draft", { method: "PUT", body: cfg }), "Borrador guardado. Aún no está en vivo.");
  const publish = () => run("publish", async () => {
    if (unsaved) await call<View>("/pearl/v1/admin/bot/draft", { method: "PUT", body: cfg });
    return call<View>("/pearl/v1/admin/bot/publish", { method: "POST", body: { note } });
  }, "Publicado: el bot ya usa esta configuración.");

  const status = view.publishedVersion
    ? <Badge tone={view.dirty || unsaved ? "warn" : "good"}>{view.dirty || unsaved ? `Cambios sin publicar · en vivo v${view.publishedVersion}` : `En vivo · versión ${view.publishedVersion}`}</Badge>
    : <Badge tone="warn">Nunca publicado</Badge>;

  return (
    <div className="space-y-4 pb-24">
      <PageHeader
        title="Pearl · Cajero IA"
        subtitle="Todo lo del bot cajero en un solo lugar: mensajes, montos, horarios, qué hace solo, bonos y promos. Editas un borrador; nada cambia en vivo hasta que publicas."
        actions={<div className="flex flex-wrap items-center gap-2">{status}
          <select aria-label="Cargar plantilla por país" className={`${inputCls} w-auto`} value="" disabled={!!busy} onChange={(e) => { const c = e.target.value; if (c && confirm("¿Reemplazar el borrador con la plantilla? Lo publicado no cambia.")) void run("preset", () => call<View>("/pearl/v1/admin/bot/preset", { method: "POST", body: { country: c } }), "Plantilla cargada en el borrador."); }}>
            <option value="">Plantilla por país…</option><option value="CO">Colombia</option><option value="MX">México</option><option value="AR">Argentina</option>
          </select>
        </div>}
      />

      {msg && <div role={msg.ok ? "status" : "alert"}><Notice tone={msg.ok ? "ok" : "warn"}>{msg.text}</Notice></div>}
      {view.check.errors.length > 0 && <Notice tone="warn"><b>Para publicar, corrige:</b> {view.check.errors.join(" · ")}</Notice>}
      {view.check.warnings.length > 0 && <Notice tone="info">{view.check.warnings.join(" · ")}</Notice>}

      <Toggle label="Cajero IA encendido" hint="Apagado, Pearl sigue leyendo comprobantes pero no aplica estas reglas (todo va a revisión según la configuración de Pearl)." checked={cfg.enabled} onChange={(enabled) => setCfg({ ...cfg, enabled })} />

      <div className="overflow-x-auto"><Tabs tabs={TABS} value={tab} onChange={setTab} /></div>

      {tab === "mensajes" && (
        <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
          <Card title="Personalidad y mensajes">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Nombre del bot" htmlFor="b-name"><input id="b-name" className={inputCls} maxLength={30} value={cfg.persona.name} onChange={(e) => set("persona", { name: e.target.value })} /></Field>
              <Field label="Tono" htmlFor="b-tone"><select id="b-tone" className={inputCls} value={cfg.persona.tone} onChange={(e) => set("persona", { tone: e.target.value as "cercano" | "formal" })}><option value="cercano">Cercano (tutea)</option><option value="formal">Formal (usted)</option></select></Field>
              <div className="flex items-end"><Toggle label="Usa emojis" checked={cfg.persona.emojis} onChange={(emojis) => set("persona", { emojis })} /></div>
            </div>
            <p className="mt-2 flex items-center gap-1 text-xs text-white/45"><Sparkles className="h-3.5 w-3.5" aria-hidden />Responde en el idioma en que le escriban (español, inglés, portugués…).</p>
            <div className="mt-4 space-y-3">
              {([
                ["welcome", "Bienvenida (primer mensaje de un lead nuevo)", "Sale tal cual. Vacío = saludo automático según el tono."],
                ["existingClient", "Saludo a quien ya tiene cuenta", ""],
                ["afterLoad", "Después de acreditar una carga", ""],
                ["handoff", "Al pasar el chat a una persona", "Suena natural: sin «asesor», «soporte» ni «te derivo»."],
                ["noCharge", "Cuando está en modo sin cargas", ""],
              ] as const).map(([k, label, hint]) => (
                <Field key={k} label={label} hint={hint || undefined} htmlFor={`m-${k}`}>
                  <textarea id={`m-${k}`} rows={2} maxLength={k === "handoff" ? 300 : 1000} className={inputCls} value={cfg.messages[k]} onChange={(e) => set("messages", { [k]: e.target.value } as Partial<BotConfig["messages"]>)} />
                </Field>
              ))}
              <Toggle label="Preguntar si viene referido" hint="Tras la bienvenida pregunta quién lo invitó (para el bono por referido)." checked={cfg.messages.askReferral} onChange={(askReferral) => set("messages", { askReferral })} />
            </div>
          </Card>
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wider text-white/45">Vista previa</p>
            <ChatPreview botName={cfg.persona.name} lines={[{ from: "player", text: "Hola, quiero cargar" }, { from: "bot", text: cfg.messages.welcome }, { from: "player", text: "📷 Comprobante" }, { from: "bot", text: cfg.messages.afterLoad }, { from: "player", text: "Me olvidé la clave" }, { from: "bot", text: cfg.messages.handoff }]} />
          </div>
        </div>
      )}

      {tab === "montos" && (
        <Card title="Montos">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Carga mínima" htmlFor="a-min"><MoneyInput id="a-min" currency={cur} value={cfg.amounts.minDeposit} onChange={(x) => set("amounts", { minDeposit: x ?? "0" })} /></Field>
            <Field label="Sumar cargas chicas dentro de (minutos)" hint="Ej.: 5.000 + 5.000 en menos de 10 minutos cuentan como una carga de 10.000. Pasado ese tiempo, la carga nueva debe cumplir el mínimo sola. 0 = no se suman." htmlFor="a-acc">
              <input id="a-acc" type="number" min={0} max={120} className={`${inputCls} w-28`} value={cfg.amounts.accumulateMinutes} onChange={(e) => set("amounts", { accumulateMinutes: Math.max(0, Math.min(120, Math.round(Number(e.target.value) || 0))) })} />
            </Field>
            <Field label="Retiro mínimo" htmlFor="a-wmin"><MoneyInput id="a-wmin" currency={cur} value={cfg.amounts.minWithdraw} onChange={(x) => set("amounts", { minWithdraw: x ?? "0" })} /></Field>
            <Field label="Pasa a VIP con una carga desde" htmlFor="a-vip"><MoneyInput id="a-vip" currency={cur} value={cfg.amounts.vipFrom} onChange={(x) => set("amounts", { vipFrom: x ?? "0" })} /></Field>
            <Field label="Bono por referido (cuando el referido carga)" htmlFor="a-ref"><MoneyInput id="a-ref" currency={cur} value={cfg.amounts.referralBonus} onChange={(x) => set("amounts", { referralBonus: x ?? "0" })} /></Field>
            <Field label="Tope de acreditación automática" hint="Por encima de este monto, el comprobante lo aprueba una persona. Vacío = sin tope." htmlFor="a-cap"><MoneyInput id="a-cap" currency={cur} value={cfg.amounts.autoCreditMax} onChange={(x) => set("amounts", { autoCreditMax: x ?? "0" })} /></Field>
          </div>
        </Card>
      )}

      {tab === "horarios" && (
        <Card title="Horarios">
          <Field label="Zona horaria de la agencia" htmlFor="h-tz"><select id="h-tz" className={`${inputCls} max-w-sm`} value={cfg.hours.timezone} onChange={(e) => set("hours", { timezone: e.target.value })}>{[...new Set([cfg.hours.timezone, ...TIMEZONES])].map((z) => <option key={z} value={z}>{z}</option>)}</select></Field>
          <div className="mt-4">
            <p className="text-sm font-semibold">Modo sin cargas</p>
            <p className="text-xs text-white/50">Los comprobantes no se acreditan solos: los revisa una persona y el bot avisa con el mensaje de «modo sin cargas».</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {([["off", "Apagado"], ["always", "Siempre"], ["schedule", "Por horario"]] as const).map(([id, label]) => (
                <button key={id} type="button" aria-pressed={cfg.hours.noCharge === id} onClick={() => set("hours", { noCharge: id })} className={`rounded-full px-4 py-1.5 text-sm font-semibold ${cfg.hours.noCharge === id ? "bg-amber-400 text-black" : "bg-white/5 text-white/70 hover:bg-white/10"}`}>{label}</button>
              ))}
            </div>
            {cfg.hours.noCharge === "schedule" && <div className="mt-3"><WindowsEditor value={cfg.hours.windows} onChange={(windows) => set("hours", { windows })} empty="Agrega las franjas en las que no se acredita solo." /></div>}
          </div>
        </Card>
      )}

      {tab === "auto" && (
        <Card title="Qué hace solo y qué pasa a una persona">
          <div className="grid gap-2 md:grid-cols-2">
            <Toggle label="Acreditar comprobantes solo" hint="Siempre verificados contra el pago real del banco (no hay forma de acreditar a ciegas)." checked={cfg.automation.autoCredit} onChange={(autoCredit) => set("automation", { autoCredit })} />
            <Toggle label="Crear usuario a quien no tiene" hint="Contraseña única y aleatoria para cada jugador." checked={cfg.automation.createUsers} onChange={(createUsers) => set("automation", { createUsers })} />
            <Toggle label="Tomar pedidos de retiro" hint="Pide monto, cuenta y titular, y lo deja en la cola de retiros para aprobar." checked={cfg.automation.takeWithdrawals} onChange={(takeWithdrawals) => set("automation", { takeWithdrawals })} />
            <Toggle label="Si piden su contraseña, pasar a una persona" checked={cfg.automation.handoffOnPassword} onChange={(handoffOnPassword) => set("automation", { handoffOnPassword })} />
            <Toggle label="Si el comprobante no cuadra, pasar a una persona" checked={cfg.automation.handoffOnUnmatchedReceipt} onChange={(handoffOnUnmatchedReceipt) => set("automation", { handoffOnUnmatchedReceipt })} />
            <Toggle label="Pase a persona natural" hint="El cliente no nota el cambio: la persona sigue la conversación." checked={cfg.automation.naturalHandoff} onChange={(naturalHandoff) => set("automation", { naturalHandoff })} />
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Datos bancarios para cargar" htmlFor="x-bank"><select id="x-bank" className={inputCls} value={cfg.automation.giveBankData} onChange={(e) => set("automation", { giveBankData: e.target.value as BotConfig["automation"]["giveBankData"] })}><option value="on_request">Solo si los pide</option><option value="new_leads">A los nuevos sin que los pidan</option><option value="never">Nunca (los da una persona)</option></select></Field>
            <Field label="Espera antes de responder (segundos)" hint="Junta mensajes seguidos del cliente en una sola respuesta." htmlFor="x-delay"><input id="x-delay" type="number" min={0} max={120} className={`${inputCls} w-28`} value={cfg.automation.replyDelaySeconds} onChange={(e) => set("automation", { replyDelaySeconds: Math.max(0, Math.min(120, Math.round(Number(e.target.value) || 0))) })} /></Field>
          </div>
        </Card>
      )}

      {tab === "bonos" && (
        <div className="space-y-4">
          <Card title="Bono de la casa y bienvenida">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Field label="Bono en cada carga" htmlFor="bo-house"><PctInput id="bo-house" value={cfg.bonuses.housePct} onChange={(housePct) => set("bonuses", { housePct })} /></Field>
              <Field label="Desde (opcional)" htmlFor="bo-min"><MoneyInput id="bo-min" currency={cur} value={cfg.bonuses.houseMin} onChange={(houseMin) => set("bonuses", { houseMin })} placeholder="Sin mínimo" /></Field>
              <Field label="Hasta (opcional)" htmlFor="bo-max"><MoneyInput id="bo-max" currency={cur} value={cfg.bonuses.houseMax} onChange={(houseMax) => set("bonuses", { houseMax })} placeholder="Sin máximo" /></Field>
              <Field label="Bono de bienvenida (1ª carga)" htmlFor="bo-wel"><PctInput id="bo-wel" value={cfg.bonuses.welcomePct} onChange={(welcomePct) => set("bonuses", { welcomePct })} /></Field>
            </div>
          </Card>
          <Card title="Happy hour">
            <div className="grid gap-4 md:grid-cols-[12rem_1fr]">
              <Field label="Bono en happy hour" hint="Gana el mayor entre este y el de la casa." htmlFor="bo-hh"><PctInput id="bo-hh" value={cfg.bonuses.happyHourPct} onChange={(happyHourPct) => set("bonuses", { happyHourPct })} /></Field>
              <WindowsEditor value={cfg.bonuses.happyHours} onChange={(happyHours) => set("bonuses", { happyHours })} empty="Sin franjas de happy hour." />
            </div>
          </Card>
          <PromosEditor value={cfg.bonuses.promos} currency={cur} onChange={(promos) => set("bonuses", { promos })} />
        </div>
      )}

      {tab === "salas" && (
        <Card title="A qué sala de Sonar mueve el chat">
          <div className="grid gap-4 sm:grid-cols-2">
            {([["support", "Cuando pasa a una persona"], ["pendingCredit", "Carga pendiente de revisar"], ["vip", "Cliente VIP"], ["withdraw", "Pedido de retiro"]] as const).map(([k, label]) => (
              <Field key={k} label={label} htmlFor={`r-${k}`}><select id={`r-${k}`} className={inputCls} value={cfg.routing[k]} onChange={(e) => set("routing", { [k]: e.target.value } as Partial<BotConfig["routing"]>)}>{STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
            ))}
          </div>
        </Card>
      )}

      {tab === "historial" && (
        <Card title="Versiones publicadas">
          {view.versions.length === 0 ? <p className="text-sm text-white/50">Todavía no publicaste ninguna versión.</p> : (
            <ul className="divide-y divide-white/5">
              {view.versions.map((x) => (
                <li key={x.version} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="flex items-center gap-2"><History className="h-4 w-4 text-white/40" aria-hidden /><b>v{x.version}</b>{x.version === view.publishedVersion && <Badge tone="good">En vivo</Badge>}<span className="text-white/60">{x.note || "Sin nota"}</span></span>
                  <span className="flex items-center gap-3 text-xs text-white/45">{dateTime(x.createdAt)}
                    {x.version !== view.publishedVersion && <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={!!busy} onClick={() => { if (confirm(`¿Volver a la versión ${x.version}? Se publica ya.`)) void run("rollback", () => call<View>("/pearl/v1/admin/bot/rollback", { method: "POST", body: { version: x.version } }), `Volviste a la versión ${x.version}.`); }}><RotateCcw className="mr-1 inline h-3.5 w-3.5" aria-hidden />Volver a esta</Button>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-white/10 bg-[#050d1c]/95 px-4 py-3 backdrop-blur lg:left-64">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2">
          <span className="text-xs text-white/50">{unsaved ? "Tienes cambios sin guardar." : view.dirty ? "El borrador tiene cambios sin publicar." : "Todo publicado."}</span>
          <input aria-label="Nota de la publicación" className={`${inputCls} ml-auto hidden w-56 sm:block`} placeholder="Nota (ej.: happy hour viernes)" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
          <Button variant="ghost" disabled={!!busy || (!unsaved && !view.dirty)} onClick={() => { if (confirm("¿Descartar el borrador y volver a lo publicado?")) void run("discard", () => call<View>("/pearl/v1/admin/bot/discard", { method: "POST" }), "Borrador descartado."); }}><Undo2 className="mr-1 inline h-4 w-4" aria-hidden />Descartar</Button>
          <Button variant="ghost" disabled={!!busy || !unsaved} onClick={() => void save()}><Save className="mr-1 inline h-4 w-4" aria-hidden />{busy === "save" ? "Guardando…" : "Guardar borrador"}</Button>
          <Button disabled={!!busy || (!unsaved && !view.dirty && !!view.publishedVersion)} onClick={() => void publish()}><Send className="mr-1 inline h-4 w-4" aria-hidden />{busy === "publish" ? "Publicando…" : "Publicar"}</Button>
        </div>
      </div>
    </div>
  );
}
