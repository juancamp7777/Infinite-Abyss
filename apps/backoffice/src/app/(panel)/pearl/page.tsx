"use client";

import { useState } from "react";
import { Banknote, Check, CircleAlert, Copy, X } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useApi, useApiClient, useSession } from "@/lib/hooks";
import { Badge, Button, Card, Empty, ErrorBox, Field, inputCls, NeedOperator, Notice, PageHeader, Spinner, Tabs } from "@/components/ui";
import { AuthImage } from "@/components/AuthImage";
import { AccountsCard, type Account } from "./accounts";

type ReceiptStatus = "credited" | "pending_review" | "waiting_bank" | "needs_info" | "rejected" | "duplicate" | "error";
interface Receipt {
  id: string;
  conversationId?: string;
  playerId?: string;
  extracted: { amount: string; date?: string; time?: string; senderName: string; receiverAccount?: string; asset?: "USDT"; txId?: string; tamperSignals?: string[] };
  amount?: string;
  currency: string;
  status: ReceiptStatus;
  reason?: string;
  checks: Array<{ code: string; ok: boolean; detail?: string }>;
  bankTxId?: string;
  attachmentId?: string;
  source: "ai" | "manual";
  reviewerId?: string;
  createdAt: string;
}
interface BankTx { id: string; externalId: string; amount: string; currency: string; senderName: string; senderTaxId?: string; asset?: string; assetAmount?: string; occurredAt: string; status: "available" | "used" | "ignored" }

/** Monto de un movimiento: los depósitos USDT muestran lo que llegó y su valor en pesos. */
const txAmount = (t: BankTx) => (t.asset ? `${t.asset} ${t.assetAmount}${t.amount !== "0" ? ` ≈ ${t.currency} ${minor(t.amount)}` : ""}` : `${t.currency} ${minor(t.amount)}`);

/** Motivos de revisión en palabras del cajero. */
const REASONS: Record<string, string> = {
  usdt_por_red: "USDT enviado por la red TRON: confirma en Binance que el TxID es del jugador",
  usdt_sin_txid: "USDT sin TxID en la captura: pide al jugador el TxID o confirma en Binance",
  usdt_monto_distinto: "El monto USDT de la captura no coincide con lo que llegó a Binance",
  sin_tasa_usdt: "Falta la tasa USDT en Configuración",
  pago_no_encontrado: "El pago no apareció en el banco",
};
const reasonText = (r?: string) => (r ? REASONS[r] ?? r : "");
interface Settings { mode: "auto" | "review_all"; currency: string; autoMaxAmount: string; minAmount: string; maxAgeHours: number; waitBankMinutes: number; utcOffsetMinutes: number; autoRegisterLeads?: boolean; usdtRate?: string | null; fxRates?: Record<string, string> | null }
interface Feed { id: string; type: string; name: string; enabled: boolean; lastEventAt?: string }
interface AiView { enabled: boolean; provider: "anthropic" | "gemini" | "deepseek"; readerModel: string; judgeModel: string; hasKey: boolean; keyFromEnv: boolean }
const PROVIDER_LABEL = { anthropic: "Claude (Anthropic)", gemini: "Gemini (Google)", deepseek: "DeepSeek" } as const;
const FIELDS = [["amount", "Monto (12.345,67)"], ["senderName", "Titular que paga"], ["date", "Fecha AAAA-MM-DD"], ["time", "Hora HH:MM"], ["receiverAccount", "Cuenta destino"]] as const;

const STATUS: Record<ReceiptStatus, { label: string; tone: "neutral" | "good" | "bad" | "warn" }> = {
  credited: { label: "Acreditado", tone: "good" }, pending_review: { label: "En revisión", tone: "warn" }, waiting_bank: { label: "Esperando banco", tone: "neutral" },
  needs_info: { label: "Falta dato", tone: "warn" }, rejected: { label: "Rechazado", tone: "bad" }, duplicate: { label: "Duplicado", tone: "neutral" }, error: { label: "Error técnico", tone: "bad" },
};
const CHECK_LABEL: Record<string, string> = {
  es_comprobante: "Comprobante final", sin_edicion: "Sin indicios de edición", monto_legible: "Monto legible", monto_minimo: "Monto mínimo",
  titular: "Titular válido", cuenta_destino: "Cuenta destino propia", fecha_reciente: "Fecha reciente",
};
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : "Error inesperado");
const minor = (v: string | undefined, decimals = 2) => (v === undefined ? "—" : (Number(v) / 10 ** decimals).toLocaleString("es", { minimumFractionDigits: decimals }));
const when = (iso: string) => new Date(iso).toLocaleString("es", { dateStyle: "short", timeStyle: "short" });

function Review({ status }: { status: ReceiptStatus | "all" }) {
  const { call } = useApiClient();
  const list = useApi<{ items: Receipt[] }>("/pearl/v1/admin/receipts", status === "all" ? {} : { status });
  const txs = useApi<{ items: BankTx[] }>("/pearl/v1/admin/bank-txs", { status: "available" });
  const [sel, setSel] = useState<string | null>(null);
  const [pick, setPick] = useState<string>("");
  const [reason, setReason] = useState("");
  const [edit, setEdit] = useState<Receipt["extracted"] | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const r = list.data?.items.find((x) => x.id === sel);
  // USDT: los depósitos de Binance (el monto en pesos sale del depósito); pesos: los del mismo monto.
  const candidates = (txs.data?.items ?? []).filter((t) => (r?.extracted.asset === "USDT" ? !!t.asset : !t.asset && (!r?.amount || t.amount === r.amount)));

  const act = async (fn: () => Promise<Receipt>) => {
    setMsg(null);
    try {
      const out = await fn();
      setMsg({ tone: out.status === "credited" ? "ok" : "warn", text: `${STATUS[out.status].label}${out.reason ? ` · ${reasonText(out.reason)}` : ""}` });
      list.reload();
      txs.reload();
    } catch (e) {
      setMsg({ tone: "warn", text: errMsg(e) });
    }
  };

  if (list.loading) return <Spinner />;
  if (list.error) return <ErrorBox message={list.error} onRetry={list.reload} />;
  const items = list.data?.items ?? [];
  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="min-w-0 space-y-2">
        {!items.length && <Card><Empty>No hay comprobantes aquí.</Empty></Card>}
        {items.map((x) => (
          <button key={x.id} type="button" onClick={() => { setSel(x.id); setPick(x.bankTxId ?? ""); setMsg(null); setEdit(null); }}
            className={`flex w-full flex-wrap items-center gap-3 rounded-xl border bg-panel/80 p-3 text-left transition-colors hover:border-white/25 ${sel === x.id ? "border-[var(--color-brand)]" : "border-white/10"}`}>
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--color-brand)]/15 text-[var(--color-brand)]"><Banknote aria-hidden className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{x.extracted.asset === "USDT" ? `USDT ${x.extracted.amount}` : `${x.currency} ${minor(x.amount)}`} <span className="font-normal text-white/50">· {x.extracted.asset === "USDT" ? "Binance" : x.extracted.senderName || "sin titular"}</span></div>
              <div className="truncate text-xs text-white/45">{when(x.createdAt)} · {x.source === "ai" ? "leído por IA" : "cargado a mano"}{x.reason ? ` · ${reasonText(x.reason)}` : ""}</div>
            </div>
            <Badge tone={STATUS[x.status].tone}>{STATUS[x.status].label}</Badge>
          </button>
        ))}
      </div>

      <Card title={r ? "Detalle del comprobante" : "Selecciona un comprobante"}>
        {!r ? <p className="text-sm text-white/45">Aquí ves los controles automáticos, el pago del banco sugerido y las acciones.</p> : (
          <div className="space-y-3 text-sm">
            {r.attachmentId && <AuthImage path={`/pearl/v1/admin/receipts/${r.id}/image`} alt="Comprobante enviado por el jugador" className="max-h-72 w-full" />}
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
              <dt className="text-white/45">Monto</dt><dd>{r.currency} {minor(r.amount)}</dd>
              <dt className="text-white/45">Titular</dt><dd className="truncate">{r.extracted.senderName || "—"}</dd>
              <dt className="text-white/45">Fecha</dt><dd>{[r.extracted.date, r.extracted.time].filter(Boolean).join(" ") || "—"}</dd>
              <dt className="text-white/45">Cuenta destino</dt><dd className="truncate">{r.extracted.receiverAccount || "—"}</dd>
              <dt className="text-white/45">Jugador</dt><dd className="truncate">{r.playerId ? r.playerId.slice(0, 12) : "sin vincular"}</dd>
            </dl>
            <ul className="space-y-1">
              {r.checks.map((c) => (
                <li key={c.code} className="flex items-start gap-2 text-xs">
                  {c.ok ? <Check aria-hidden className="mt-0.5 h-3.5 w-3.5 text-emerald-400" /> : <CircleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 text-amber-400" />}
                  <span>{CHECK_LABEL[c.code] ?? c.code}{c.detail ? <span className="text-white/40"> · {c.detail}</span> : null}</span>
                </li>
              ))}
            </ul>
            {["pending_review", "needs_info", "error"].includes(r.status) && (edit ? (
              <div className="space-y-2 rounded-lg border border-white/10 p-2.5">
                <p className="text-xs font-semibold text-white/60">Corregir datos leídos</p>
                {FIELDS.map(([k, ph]) => (
                  <input key={k} className={`${inputCls} w-full`} aria-label={ph} placeholder={ph} value={edit[k] ?? ""} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />
                ))}
                <div className="flex gap-2">
                  <Button className="flex-1" onClick={() => void act(async () => {
                    const clean = Object.fromEntries(Object.entries(edit).filter(([, v]) => v !== "" && v !== undefined));
                    const out = await call<Receipt>(`/pearl/v1/admin/receipts/${r.id}`, { method: "PATCH", body: { extracted: { senderName: "", ...clean } } });
                    setEdit(null);
                    return out;
                  })}>Guardar y conciliar</Button>
                  <Button variant="ghost" onClick={() => setEdit(null)}>Cancelar</Button>
                </div>
              </div>
            ) : <Button variant="ghost" className="w-full" onClick={() => setEdit({ ...r.extracted })}>Corregir datos leídos</Button>)}
            {["pending_review", "waiting_bank", "needs_info", "error"].includes(r.status) && (
              <>
                <Field label="Pago del banco" htmlFor="tx">
                  <select id="tx" className={`${inputCls} w-full`} value={pick} onChange={(e) => setPick(e.target.value)}>
                    <option value="">Sin movimiento (bajo mi responsabilidad)</option>
                    {candidates.map((t) => <option key={t.id} value={t.id}>{txAmount(t)} · {t.asset ? t.externalId.slice(0, 24) : t.senderName} · {when(t.occurredAt)}</option>)}
                  </select>
                </Field>
                <Button className="w-full" onClick={() => void act(() => call(`/pearl/v1/admin/receipts/${r.id}/approve`, { method: "POST", body: pick ? { bankTxId: pick } : {} }))}>
                  <Check aria-hidden className="h-4 w-4" /> Aprobar y cargar fichas
                </Button>
                <div className="flex gap-2">
                  <input className={`${inputCls} min-w-0 flex-1`} placeholder="Motivo del rechazo" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Motivo del rechazo" />
                  <Button variant="danger" disabled={reason.trim().length < 2} onClick={() => void act(() => call(`/pearl/v1/admin/receipts/${r.id}/reject`, { method: "POST", body: { reason } }))}><X aria-hidden className="h-4 w-4" /> Rechazar</Button>
                </div>
              </>
            )}
            {r.reviewerId && <p className="text-xs text-white/40">Resuelto por {r.reviewerId.slice(0, 10)}</p>}
            {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
          </div>
        )}
      </Card>
    </div>
  );
}

function BankFeed() {
  const txs = useApi<{ items: BankTx[] }>("/pearl/v1/admin/bank-txs");
  if (txs.loading) return <Spinner />;
  if (txs.error) return <ErrorBox message={txs.error} onRetry={txs.reload} />;
  const items = txs.data?.items ?? [];
  return (
    <Card>
      {!items.length ? <Empty>Aún no llegan movimientos. Conecta un feed bancario en Configuración.</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-left text-xs text-white/45"><tr><th className="py-2">Fecha</th><th>Titular</th><th className="text-right">Monto</th><th className="pl-4">Estado</th></tr></thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id} className="border-t border-white/5">
                  <td className="py-2 text-white/60">{when(t.occurredAt)}</td>
                  <td>{t.asset ? `Binance · ${t.externalId.slice(0, 24)}` : t.senderName}</td>
                  <td className="text-right font-mono">{txAmount(t)}</td>
                  <td className="pl-4"><Badge tone={t.status === "available" ? "warn" : t.status === "used" ? "good" : "neutral"}>{t.status === "available" ? "Sin usar" : t.status === "used" ? "Conciliado" : "Ignorado"}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Config() {
  const { call } = useApiClient();
  const settings = useApi<Settings>("/pearl/v1/admin/settings");
  const accounts = useApi<{ items: Account[] }>("/pearl/v1/admin/accounts");
  const feeds = useApi<{ items: Feed[] }>("/pearl/v1/admin/feeds");
  const aiCfg = useApi<AiView>("/pearl/v1/admin/ai");
  const [aiForm, setAiForm] = useState<{ provider?: AiView["provider"]; readerModel?: string; judgeModel?: string; apiKey?: string; enabled?: boolean }>({});
  const [form, setForm] = useState<Partial<Settings>>({});
  const [feedType, setFeedType] = useState("quikipay");
  const [bnc, setBnc] = useState({ apiKey: "", apiSecret: "" });
  const [newFeed, setNewFeed] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: "ok", text: ok });
      settings.reload(); accounts.reload(); feeds.reload(); aiCfg.reload();
    } catch (e) {
      setMsg({ tone: "warn", text: errMsg(e) });
    }
  };
  if (settings.loading) return <Spinner />;
  if (settings.error) return <ErrorBox message={settings.error} onRetry={settings.reload} />;
  const s = { ...settings.data!, ...form };
  const base = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="grid gap-3 xl:grid-cols-3">
      <Card title="Reglas de la caja">
        <div className="space-y-3">
          <Field label="Modo" htmlFor="mode">
            <select id="mode" className={`${inputCls} w-full`} value={s.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as Settings["mode"] })}>
              <option value="review_all">Todo a revisión humana</option>
              <option value="auto">Automático (acredita sola si todo cuadra)</option>
            </select>
          </Field>
          <Field label="Tope automático (unidades mínimas)" htmlFor="cap"><input id="cap" className={`${inputCls} w-full`} value={s.autoMaxAmount} onChange={(e) => setForm({ ...form, autoMaxAmount: e.target.value.replace(/\D/g, "") })} /></Field>
          <Field label="Depósito mínimo (unidades mínimas)" htmlFor="min"><input id="min" className={`${inputCls} w-full`} value={s.minAmount} onChange={(e) => setForm({ ...form, minAmount: e.target.value.replace(/\D/g, "") })} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.autoRegisterLeads ?? true} onChange={(e) => setForm({ ...form, autoRegisterLeads: e.target.checked })} /> Crear la cuenta del lead con su primer comprobante</label>
          <Field label="Esperar al banco (minutos)" htmlFor="wait"><input id="wait" type="number" className={`${inputCls} w-full`} value={s.waitBankMinutes} onChange={(e) => setForm({ ...form, waitBankMinutes: Number(e.target.value) })} /></Field>
          <fieldset className="rounded-xl border border-white/10 p-3">
            <legend className="px-1 text-sm font-semibold">Tasas de cambio ({s.currency} por 1 unidad)</legend>
            <div className="grid grid-cols-3 gap-2">
              <Field label="USDT" htmlFor="rate-usdt">
                <input id="rate-usdt" inputMode="decimal" className={`${inputCls} w-full`} placeholder="3950" value={s.usdtRate ?? ""} onChange={(e) => setForm({ ...form, usdtRate: e.target.value.replace(/[^\d.]/g, "") || null })} />
              </Field>
              {["ARS", "MXN"].filter((c) => c !== s.currency).map((c) => (
                <Field key={c} label={c} htmlFor={`rate-${c}`}>
                  <input id={`rate-${c}`} inputMode="decimal" className={`${inputCls} w-full`} placeholder={c === "ARS" ? "2.1" : "215"} value={s.fxRates?.[c] ?? ""}
                    onChange={(e) => setForm({ ...form, fxRates: { ...(s.fxRates ?? {}), [c]: e.target.value.replace(/[^\d.]/g, "") } })} />
                </Field>
              ))}
            </div>
            <p className="mt-2 text-xs text-white/45">Los pagos en otra moneda (a tus cuentas de Argentina o México, o en USDT) se acreditan en {s.currency} con estas tasas. Actualízalas cuando cambie el precio; sin tasa, el pago queda en revisión.</p>
          </fieldset>
          <Button className="w-full" onClick={() => void run(() => call("/pearl/v1/admin/settings", { method: "PUT", body: form }), "Reglas guardadas")}>Guardar reglas</Button>
        </div>
      </Card>

      <AccountsCard accounts={accounts.data?.items ?? []} run={run} />

      <Card title="Feeds bancarios">
        <ul className="mb-3 space-y-1.5 text-sm">
          {(feeds.data?.items ?? []).map((f) => (
            <li key={f.id} className="flex items-center gap-2 rounded-lg bg-white/[.03] px-2.5 py-1.5">
              <div className="min-w-0 flex-1"><div className="truncate">{f.name}</div><div className="text-xs text-white/45">{f.type === "binance" ? "Binance · USDT" : f.type} · {f.lastEventAt ? `último pago ${when(f.lastEventAt)}` : "sin eventos"}</div></div>
              <Badge tone={f.enabled ? "good" : "neutral"}>{f.enabled ? "Activo" : "Pausado"}</Badge>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <select className={`${inputCls} min-w-0 flex-1`} value={feedType} onChange={(e) => setFeedType(e.target.value)} aria-label="Proveedor">
            <option value="quikipay">Quikipay</option><option value="hgcash">HG Cash</option><option value="generic">Genérico (JSON)</option><option value="binance">Binance (depósitos USDT)</option>
          </select>
          {feedType !== "binance" && <Button onClick={() => void run(async () => { const r = await call<{ webhookPath: string }>("/pearl/v1/admin/feeds", { method: "POST", body: { type: feedType } }); setNewFeed(`${base}/api-proxy${r.webhookPath}`); }, "Feed creado")}>Conectar</Button>}
        </div>
        {feedType === "binance" && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-white/55">En Binance: Perfil → Gestión de API → Crear API. Deja marcada <b>solo</b> “Habilitar lectura” (sin retiros ni trading) y pega aquí las dos llaves. Se guardan cifradas.</p>
            <input className={`${inputCls} w-full`} placeholder="API Key" autoComplete="off" value={bnc.apiKey} onChange={(e) => setBnc({ ...bnc, apiKey: e.target.value.trim() })} aria-label="API Key de Binance" />
            <input className={`${inputCls} w-full`} type="password" placeholder="Secret Key" autoComplete="off" value={bnc.apiSecret} onChange={(e) => setBnc({ ...bnc, apiSecret: e.target.value.trim() })} aria-label="Secret Key de Binance" />
            <Button className="w-full" disabled={bnc.apiKey.length < 20 || bnc.apiSecret.length < 20} onClick={() => void run(async () => { await call("/pearl/v1/admin/feeds", { method: "POST", body: { type: "binance", ...bnc } }); setBnc({ apiKey: "", apiSecret: "" }); }, "Binance conectado: Pearl revisará los depósitos USDT cada minuto")}>Conectar Binance</Button>
          </div>
        )}
        {newFeed && (
          <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/5 p-2.5 text-xs">
            <p className="mb-1 font-semibold text-amber-300">Copia esta URL ahora: no se vuelve a mostrar.</p>
            <div className="flex items-center gap-2"><code className="min-w-0 flex-1 break-all">{newFeed}</code>
              <button type="button" aria-label="Copiar URL" onClick={() => void navigator.clipboard?.writeText(newFeed)}><Copy aria-hidden className="h-4 w-4" /></button></div>
          </div>
        )}
      </Card>
      {aiCfg.data && (
        <Card title="IA de lectura y juez" className="xl:col-span-3">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <Field label="Proveedor" htmlFor="ai-p">
              <select id="ai-p" className={`${inputCls} w-full`} value={aiForm.provider ?? aiCfg.data.provider} onChange={(e) => setAiForm({ ...aiForm, provider: e.target.value as AiView["provider"], readerModel: undefined, judgeModel: undefined })}>
                {(Object.keys(PROVIDER_LABEL) as AiView["provider"][]).map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>)}
              </select>
            </Field>
            <Field label="Modelo lector" htmlFor="ai-r"><input id="ai-r" className={`${inputCls} w-full`} placeholder={aiCfg.data.readerModel} value={aiForm.readerModel ?? ""} onChange={(e) => setAiForm({ ...aiForm, readerModel: e.target.value })} /></Field>
            <Field label="Modelo juez" htmlFor="ai-j"><input id="ai-j" className={`${inputCls} w-full`} placeholder={aiCfg.data.judgeModel} value={aiForm.judgeModel ?? ""} onChange={(e) => setAiForm({ ...aiForm, judgeModel: e.target.value })} /></Field>
            <Field label={aiCfg.data.hasKey ? (aiCfg.data.keyFromEnv ? "API key (de Integraciones o del servidor)" : "API key guardada ✓") : "API key"} htmlFor="ai-k">
              <input id="ai-k" type="password" autoComplete="off" className={`${inputCls} w-full`} placeholder={aiCfg.data.hasKey ? "•••••• (vacío = mantener)" : "Pega la clave del proveedor"} value={aiForm.apiKey ?? ""} onChange={(e) => setAiForm({ ...aiForm, apiKey: e.target.value })} />
            </Field>
            <div className="flex items-end gap-2">
              <label className="mb-2 inline-flex items-center gap-1.5 text-sm"><input type="checkbox" checked={aiForm.enabled ?? aiCfg.data.enabled} onChange={(e) => setAiForm({ ...aiForm, enabled: e.target.checked })} /> Activa</label>
              <Button className="flex-1" onClick={() => void run(async () => {
                const body = Object.fromEntries(Object.entries(aiForm).filter(([, v]) => v !== "" && v !== undefined));
                await call("/pearl/v1/admin/ai", { method: "PUT", body });
                setAiForm({});
              }, "IA guardada")}>Guardar IA</Button>
            </div>
          </div>
          <p className="mt-2 text-xs text-white/40">Recomendado: Claude Haiku 5.5 lee los comprobantes y Claude Opus 5.5 juzga antes de acreditar. Sin clave, Pearl sigue funcionando y deja la lectura al cajero. La clave se guarda cifrada y nunca se vuelve a mostrar.</p>
        </Card>
      )}
      {msg && <div className="xl:col-span-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
    </div>
  );
}

interface Withdrawal { id: string; userId: string; provider: string; status: "REQUESTED" | "APPROVED" | "REJECTED" | "PROCESSING" | "PAID" | "FAILED"; amount: string; currency: string; destination: { account?: string; holderName?: string; channel?: string }; createdAt: string; rejectionReason?: string }
const W_STATUS: Record<Withdrawal["status"], { label: string; tone: "neutral" | "good" | "bad" | "warn" }> = {
  REQUESTED: { label: "Solicitado", tone: "warn" }, APPROVED: { label: "Aprobado · pagar", tone: "warn" }, PROCESSING: { label: "En proceso", tone: "neutral" },
  PAID: { label: "Pagado", tone: "good" }, REJECTED: { label: "Rechazado", tone: "bad" }, FAILED: { label: "Fallido", tone: "bad" },
};

function Withdrawals() {
  const { call } = useApiClient();
  const session = useSession();
  const [status, setStatus] = useState<"REQUESTED" | "APPROVED" | "">("REQUESTED");
  const list = useApi<{ items: Withdrawal[] }>("/api/backoffice/withdrawals", status ? { status } : {});
  const [reason, setReason] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const finance = session?.role === "PLATFORM_ADMIN" || session?.role === "OPERATOR_FINANCE";
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try { await fn(); setMsg({ tone: "ok", text: ok }); list.reload(); } catch (e) { setMsg({ tone: "warn", text: errMsg(e) }); }
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {([["REQUESTED", "Por aprobar"], ["APPROVED", "Por pagar"], ["", "Todos"]] as const).map(([v, l]) => (
          <button key={v} type="button" onClick={() => setStatus(v)} className={`rounded-full px-3 py-1 text-xs font-semibold ${status === v ? "bg-[var(--color-brand)] text-black" : "bg-white/5 text-white/60"}`}>{l}</button>
        ))}
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {list.loading ? <Spinner /> : list.error ? <ErrorBox message={list.error} onRetry={list.reload} /> : !list.data?.items.length ? <Card><Empty>No hay retiros aquí.</Empty></Card> : list.data.items.map((w) => (
        <Card key={w.id}>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{w.currency} {minor(w.amount)} <span className="font-normal text-white/50">· {w.destination.holderName ?? "—"}</span></div>
              <div className="truncate text-xs text-white/45">{when(w.createdAt)} · cuenta {w.destination.account ?? "—"} · {w.provider === "PEARL" ? "pedido por chat" : w.provider} · jugador {w.userId.slice(0, 8)}</div>
            </div>
            <Badge tone={W_STATUS[w.status].tone}>{W_STATUS[w.status].label}</Badge>
          </div>
          {w.status === "REQUESTED" && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => void act(() => call(`/api/backoffice/withdrawals/${w.id}/approve`, { method: "POST", body: {} }), "Retiro aprobado: haz la transferencia y márcalo como pagado.")}><Check aria-hidden className="h-4 w-4" /> Aprobar</Button>
              <input className={`${inputCls} min-w-0 flex-1`} placeholder="Motivo del rechazo" value={reason[w.id] ?? ""} onChange={(e) => setReason({ ...reason, [w.id]: e.target.value })} aria-label="Motivo del rechazo" />
              <Button variant="danger" disabled={(reason[w.id] ?? "").trim().length < 3} onClick={() => void act(() => call(`/api/backoffice/withdrawals/${w.id}/reject`, { method: "POST", body: { reason: reason[w.id] } }), "Retiro rechazado: el saldo volvió al jugador.")}><X aria-hidden className="h-4 w-4" /> Rechazar</Button>
            </div>
          )}
          {w.status === "APPROVED" && (
            <div className="mt-3">
              {finance
                ? <Button onClick={() => void act(() => call(`/api/backoffice/withdrawals/${w.id}/mark-paid`, { method: "POST", body: {} }), "Retiro marcado como pagado.")}><Banknote aria-hidden className="h-4 w-4" /> Ya transferí: marcar pagado</Button>
                : <p className="text-xs text-white/45">Lo marca como pagado el equipo de finanzas.</p>}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

type Tab = "review" | "waiting" | "all" | "bank" | "withdrawals" | "config";
export default function PearlPage() {
  const { operatorId } = useApiClient();
  const session = useSession();
  const isAdmin = session?.role === "PLATFORM_ADMIN" || session?.role === "OPERATOR_ADMIN";
  const [tab, setTab] = useState<Tab>("review");
  if (!operatorId) return <><PageHeader title="Pearl" /><NeedOperator /></>;
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "review", label: "En revisión" }, { id: "waiting", label: "Esperando banco" }, { id: "all", label: "Todos" }, { id: "bank", label: "Movimientos del banco" }, { id: "withdrawals", label: "Retiros" },
    ...(isAdmin ? [{ id: "config" as Tab, label: "Configuración" }] : []),
  ];
  return (
    <>
      <PageHeader title="Pearl · Caja asistida" subtitle="Comprobantes conciliados contra los pagos reales del banco. Lo que cuadra se acredita solo; lo dudoso queda aquí para un cajero." />
      <div className="mb-3 overflow-x-auto"><Tabs tabs={tabs} value={tab} onChange={setTab} /></div>
      {tab === "review" && <Review status="pending_review" />}
      {tab === "waiting" && <Review status="waiting_bank" />}
      {tab === "all" && <Review status="all" />}
      {tab === "bank" && <BankFeed />}
      {tab === "withdrawals" && <Withdrawals />}
      {tab === "config" && <Config />}
    </>
  );
}
