"use client";

import { useState } from "react";
import { Banknote, Check, CircleAlert, Copy, Landmark, Plus, Trash2, X } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useApi, useApiClient, useSession } from "@/lib/hooks";
import { Badge, Button, Card, Empty, ErrorBox, Field, inputCls, NeedOperator, Notice, PageHeader, Spinner, Tabs } from "@/components/ui";

type ReceiptStatus = "credited" | "pending_review" | "waiting_bank" | "needs_info" | "rejected" | "duplicate" | "error";
interface Receipt {
  id: string;
  conversationId?: string;
  playerId?: string;
  extracted: { amount: string; date?: string; time?: string; senderName: string; receiverAccount?: string; tamperSignals?: string[] };
  amount?: string;
  currency: string;
  status: ReceiptStatus;
  reason?: string;
  checks: Array<{ code: string; ok: boolean; detail?: string }>;
  bankTxId?: string;
  source: "ai" | "manual";
  reviewerId?: string;
  createdAt: string;
}
interface BankTx { id: string; externalId: string; amount: string; currency: string; senderName: string; senderTaxId?: string; occurredAt: string; status: "available" | "used" | "ignored" }
interface Settings { mode: "auto" | "review_all"; currency: string; autoMaxAmount: string; minAmount: string; maxAgeHours: number; waitBankMinutes: number; utcOffsetMinutes: number }
interface Account { id: string; holderName: string; alias?: string; accountNumber: string; bank?: string; active: boolean }
interface Feed { id: string; type: string; name: string; enabled: boolean; lastEventAt?: string }

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
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const r = list.data?.items.find((x) => x.id === sel);
  const candidates = (txs.data?.items ?? []).filter((t) => !r?.amount || t.amount === r.amount);

  const act = async (fn: () => Promise<Receipt>) => {
    setMsg(null);
    try {
      const out = await fn();
      setMsg({ tone: out.status === "credited" ? "ok" : "warn", text: `${STATUS[out.status].label}${out.reason ? ` · ${out.reason}` : ""}` });
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
          <button key={x.id} type="button" onClick={() => { setSel(x.id); setPick(x.bankTxId ?? ""); setMsg(null); }}
            className={`flex w-full flex-wrap items-center gap-3 rounded-xl border bg-panel/80 p-3 text-left transition-colors hover:border-white/25 ${sel === x.id ? "border-[var(--color-brand)]" : "border-white/10"}`}>
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--color-brand)]/15 text-[var(--color-brand)]"><Banknote aria-hidden className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{x.currency} {minor(x.amount)} <span className="font-normal text-white/50">· {x.extracted.senderName || "sin titular"}</span></div>
              <div className="truncate text-xs text-white/45">{when(x.createdAt)} · {x.source === "ai" ? "leído por IA" : "cargado a mano"}{x.reason ? ` · ${x.reason}` : ""}</div>
            </div>
            <Badge tone={STATUS[x.status].tone}>{STATUS[x.status].label}</Badge>
          </button>
        ))}
      </div>

      <Card title={r ? "Detalle del comprobante" : "Selecciona un comprobante"}>
        {!r ? <p className="text-sm text-white/45">Aquí ves los controles automáticos, el pago del banco sugerido y las acciones.</p> : (
          <div className="space-y-3 text-sm">
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
            {["pending_review", "waiting_bank", "needs_info", "error"].includes(r.status) && (
              <>
                <Field label="Pago del banco" htmlFor="tx">
                  <select id="tx" className={`${inputCls} w-full`} value={pick} onChange={(e) => setPick(e.target.value)}>
                    <option value="">Sin movimiento (bajo mi responsabilidad)</option>
                    {candidates.map((t) => <option key={t.id} value={t.id}>{t.currency} {minor(t.amount)} · {t.senderName} · {when(t.occurredAt)}</option>)}
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
                  <td>{t.senderName}</td>
                  <td className="text-right font-mono">{t.currency} {minor(t.amount)}</td>
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
  const [form, setForm] = useState<Partial<Settings>>({});
  const [acc, setAcc] = useState({ holderName: "", alias: "", accountNumber: "" });
  const [feedType, setFeedType] = useState("quikipay");
  const [newFeed, setNewFeed] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: "ok", text: ok });
      settings.reload(); accounts.reload(); feeds.reload();
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
          <Field label="Esperar al banco (minutos)" htmlFor="wait"><input id="wait" type="number" className={`${inputCls} w-full`} value={s.waitBankMinutes} onChange={(e) => setForm({ ...form, waitBankMinutes: Number(e.target.value) })} /></Field>
          <Button className="w-full" onClick={() => void run(() => call("/pearl/v1/admin/settings", { method: "PUT", body: form }), "Reglas guardadas")}>Guardar reglas</Button>
        </div>
      </Card>

      <Card title="Cuentas que reciben pagos">
        <ul className="mb-3 space-y-1.5 text-sm">
          {(accounts.data?.items ?? []).map((a) => (
            <li key={a.id} className="flex items-center gap-2 rounded-lg bg-white/[.03] px-2.5 py-1.5">
              <Landmark aria-hidden className="h-4 w-4 text-white/40" />
              <div className="min-w-0 flex-1"><div className="truncate">{a.holderName}</div><div className="truncate text-xs text-white/45">{a.alias || a.accountNumber}</div></div>
              <button type="button" className="text-white/30 hover:text-red-300" aria-label={`Quitar ${a.holderName}`} onClick={() => void run(() => call(`/pearl/v1/admin/accounts/${a.id}`, { method: "DELETE" }), "Cuenta quitada")}><Trash2 aria-hidden className="h-4 w-4" /></button>
            </li>
          ))}
          {!accounts.data?.items.length && <li className="text-xs text-white/40">Sin cuentas: Pearl no podrá verificar la cuenta destino.</li>}
        </ul>
        <div className="space-y-2">
          <input className={`${inputCls} w-full`} placeholder="Titular" value={acc.holderName} onChange={(e) => setAcc({ ...acc, holderName: e.target.value })} aria-label="Titular" />
          <input className={`${inputCls} w-full`} placeholder="CBU / CVU / número de cuenta" value={acc.accountNumber} onChange={(e) => setAcc({ ...acc, accountNumber: e.target.value })} aria-label="Número de cuenta" />
          <input className={`${inputCls} w-full`} placeholder="Alias (opcional)" value={acc.alias} onChange={(e) => setAcc({ ...acc, alias: e.target.value })} aria-label="Alias" />
          <Button variant="ghost" className="w-full" onClick={() => void run(async () => { await call("/pearl/v1/admin/accounts", { method: "POST", body: { ...acc, alias: acc.alias || undefined } }); setAcc({ holderName: "", alias: "", accountNumber: "" }); }, "Cuenta agregada")}><Plus aria-hidden className="h-4 w-4" /> Agregar cuenta</Button>
        </div>
      </Card>

      <Card title="Feeds bancarios">
        <ul className="mb-3 space-y-1.5 text-sm">
          {(feeds.data?.items ?? []).map((f) => (
            <li key={f.id} className="flex items-center gap-2 rounded-lg bg-white/[.03] px-2.5 py-1.5">
              <div className="min-w-0 flex-1"><div className="truncate">{f.name}</div><div className="text-xs text-white/45">{f.type} · {f.lastEventAt ? `último pago ${when(f.lastEventAt)}` : "sin eventos"}</div></div>
              <Badge tone={f.enabled ? "good" : "neutral"}>{f.enabled ? "Activo" : "Pausado"}</Badge>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <select className={`${inputCls} min-w-0 flex-1`} value={feedType} onChange={(e) => setFeedType(e.target.value)} aria-label="Proveedor">
            <option value="quikipay">Quikipay</option><option value="hgcash">HG Cash</option><option value="generic">Genérico (JSON)</option>
          </select>
          <Button onClick={() => void run(async () => { const r = await call<{ webhookPath: string }>("/pearl/v1/admin/feeds", { method: "POST", body: { type: feedType } }); setNewFeed(`${base}/api-proxy${r.webhookPath}`); }, "Feed creado")}>Conectar</Button>
        </div>
        {newFeed && (
          <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/5 p-2.5 text-xs">
            <p className="mb-1 font-semibold text-amber-300">Copia esta URL ahora: no se vuelve a mostrar.</p>
            <div className="flex items-center gap-2"><code className="min-w-0 flex-1 break-all">{newFeed}</code>
              <button type="button" aria-label="Copiar URL" onClick={() => void navigator.clipboard?.writeText(newFeed)}><Copy aria-hidden className="h-4 w-4" /></button></div>
          </div>
        )}
      </Card>
      {msg && <div className="xl:col-span-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
    </div>
  );
}

type Tab = "review" | "waiting" | "all" | "bank" | "config";
export default function PearlPage() {
  const { operatorId } = useApiClient();
  const session = useSession();
  const isAdmin = session?.role === "PLATFORM_ADMIN" || session?.role === "OPERATOR_ADMIN";
  const [tab, setTab] = useState<Tab>("review");
  if (!operatorId) return <><PageHeader title="Pearl" /><NeedOperator /></>;
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "review", label: "En revisión" }, { id: "waiting", label: "Esperando banco" }, { id: "all", label: "Todos" }, { id: "bank", label: "Movimientos del banco" },
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
      {tab === "config" && <Config />}
    </>
  );
}
