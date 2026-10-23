"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Check, CheckCircle2, Clock, Copy, Loader2, MessageCircle, XCircle } from "lucide-react";
import { API_URL, api, ApiError, refreshSession, tokens } from "@/lib/api";
import { useT } from "@/lib/i18n";

export type TransferAccount = {
  id: string;
  method: string;
  numberLabel: string;
  number: string;
  holderName?: string;
  alias?: string;
  bankName?: string;
  accountType?: string;
  network?: string;
  /** COP, ARS, MXN o USDT. */
  currency?: string;
};

type ReceiptView = { id: string; status: string; amount: string | null; currency: string; createdAt: string };

/** Cómo va el comprobante, en palabras del jugador. */
const STATE: Record<string, { text: string; tone: "ok" | "wait" | "warn" | "bad" }> = {
  credited: { text: "¡Listo! Ya acreditamos tu recarga.", tone: "ok" },
  waiting_bank: { text: "Recibido. Estamos esperando que el pago aparezca en la cuenta; se acredita solo.", tone: "wait" },
  pending_review: { text: "Recibido. Un cajero lo está revisando; te avisamos por el chat.", tone: "wait" },
  needs_info: { text: "Necesitamos un dato más: revisa el chat de soporte.", tone: "warn" },
  rejected: { text: "No pudimos validar el comprobante. Revisa el chat de soporte.", tone: "bad" },
  duplicate: { text: "Ese comprobante ya se había enviado antes.", tone: "warn" },
  error: { text: "Recibido. Un cajero lo revisará en breve.", tone: "wait" },
};

const POLL_MS = 4000;
const POLL_FOR_MS = 5 * 60_000;

/**
 * Recarga por transferencia: el jugador ve las cuentas del casino, transfiere y sube la foto del comprobante.
 * La foto entra por el chat de soporte, donde Pearl la lee, la cruza con los pagos reales y acredita.
 */
export function TransferDeposit({ accounts, money, onCredited, localCurrency }: { accounts: TransferAccount[]; money: (v: bigint) => string; onCredited: () => void; localCurrency: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const credited = useRef(false);
  // Pestañas por moneda: la del jugador primero, USDT al final.
  const order = (c: string) => (c === localCurrency ? 0 : c === "USDT" ? 2 : 1);
  const currencies = [...new Set(accounts.map((a) => a.currency ?? ""))].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  const [cur, setCur] = useState(currencies[0] ?? "");
  const shown = currencies.length > 1 ? accounts.filter((a) => (a.currency ?? "") === cur) : accounts;

  // Tras subir la foto, se consulta su estado hasta que se resuelva (o pasen 5 minutos).
  useEffect(() => {
    if (!sentAt) return;
    let stop = false;
    const tick = async () => {
      if (stop || Date.now() - sentAt > POLL_FOR_MS) return;
      try {
        const r = await api.get<{ receipt: ReceiptView | null }>("/pearl/v1/player/receipts/latest");
        if (r.receipt && Date.parse(r.receipt.createdAt) >= sentAt - 60_000) {
          setReceipt(r.receipt);
          if (r.receipt.status === "credited" && !credited.current) {
            credited.current = true;
            onCredited();
          }
          if (["credited", "rejected", "duplicate"].includes(r.receipt.status)) return;
        }
      } catch {
        /* se reintenta en el siguiente ciclo */
      }
      if (!stop) setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [sentAt, onCredited]);

  const copy = async (a: TransferAccount) => {
    try {
      await navigator.clipboard.writeText(a.number);
      setCopied(a.id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      /* portapapeles bloqueado: el número queda visible para copiarlo a mano */
    }
  };

  const upload = async (file: File) => {
    setError(null);
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return setError(t("Solo imágenes JPG, PNG o WEBP."));
    if (file.size > 5 * 1024 * 1024) return setError(t("La imagen supera los 5 MB."));
    setBusy(true);
    try {
      const send = (token: string | null) =>
        fetch(`${API_URL}/inbox/v1/webchat/attachments?caption=${encodeURIComponent("Comprobante de recarga")}`, {
          method: "POST",
          headers: { "Content-Type": file.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: file,
        });
      let res = await send(tokens.getAccess());
      if (res.status === 401) res = await send(await refreshSession());
      if (!res.ok) throw new ApiError(res.status, "UPLOAD", "upload");
      credited.current = false;
      setReceipt(null);
      setSentAt(Date.now());
    } catch {
      setError(t("No se pudo enviar la foto. Intenta de nuevo."));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const state = receipt ? STATE[receipt.status] ?? STATE.pending_review : null;

  return (
    <div className="flex flex-col gap-5">
      <ol className="flex flex-col gap-1 text-sm text-gray-300">
        <li><b className="text-gold-300">1.</b> {t("Transfiere el monto que quieras a una de estas cuentas.")}</li>
        <li><b className="text-gold-300">2.</b> {t("Sube aquí la foto del comprobante.")}</li>
        <li><b className="text-gold-300">3.</b> {t("Lo verificamos con el pago real y se acredita solo.")}</li>
      </ol>

      {currencies.length > 1 && (
        <div role="tablist" aria-label={t("Moneda")} className="flex gap-2">
          {currencies.map((c) => (
            <button key={c} type="button" role="tab" aria-selected={cur === c} onClick={() => setCur(c)}
              className={`flex-1 rounded-xl border-2 py-2.5 font-mono text-sm font-bold tracking-widest ${cur === c ? "border-gold-400 bg-gold-500/10 text-gold-300" : "border-gray-800 bg-black text-gray-400"}`}>
              {c || t("Otras")}
            </button>
          ))}
        </div>
      )}
      {cur && cur !== localCurrency && <p className="text-xs text-gray-400">{t("Paga en {cur} y te acreditamos el equivalente en {local} a la tasa del día.").replace("{cur}", cur).replace("{local}", localCurrency)}</p>}

      <ul className="flex flex-col gap-3">
        {shown.map((a) => (
          <li key={a.id} className="rounded-xl border border-gold-900/50 bg-black/40 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="flex items-center gap-2 font-bold text-white">{a.bankName ?? a.method}{a.currency && <span className="rounded-md border border-gold-500/40 px-1.5 py-0.5 font-mono text-[10px] tracking-widest text-gold-300">{a.currency}</span>}</span>
              <span className="text-xs uppercase tracking-widest text-gold-300">{[a.accountType, a.network].filter(Boolean).join(" · ") || a.method}</span>
            </div>
            <div className="mt-2 text-xs text-gray-400">{t(a.numberLabel)}</div>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all font-mono text-lg text-white">{a.number}</code>
              <button type="button" onClick={() => void copy(a)} aria-label={t("Copiar")} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-gold-500/40 px-3 py-1.5 text-xs font-bold text-gold-300 hover:bg-gold-500/10">
                {copied === a.id ? <Check aria-hidden className="h-4 w-4" /> : <Copy aria-hidden className="h-4 w-4" />}
                {copied === a.id ? t("Copiado") : t("Copiar")}
              </button>
            </div>
            {(a.holderName || a.alias) && (
              <div className="mt-2 text-xs text-gray-400">
                {a.holderName && <span>{t("Titular")}: <span className="text-gray-200">{a.holderName}</span></span>}
                {a.alias && <span className="ml-3">{t("Alias")}: <span className="text-gray-200">{a.alias}</span></span>}
              </div>
            )}
          </li>
        ))}
      </ul>

      <label className={`flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-gold-gradient py-4 font-bold uppercase tracking-widest text-black ${busy ? "opacity-60" : ""}`}>
        {busy ? <Loader2 aria-hidden className="h-5 w-5 animate-spin" /> : <Camera aria-hidden className="h-5 w-5" />}
        {busy ? t("Enviando…") : t("Subir comprobante")}
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={busy} onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
      </label>
      {error && <p role="alert" className="text-center text-sm text-red-300">{error}</p>}

      {sentAt && (
        <div role="status" aria-live="polite" className={`flex items-start gap-3 rounded-xl border p-4 text-sm ${state?.tone === "ok" ? "border-green-500/40 bg-green-500/10 text-green-200" : state?.tone === "bad" ? "border-red-500/40 bg-red-500/10 text-red-200" : state?.tone === "warn" ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-gold-900/50 bg-black/40 text-gray-200"}`}>
          {!state ? <Loader2 aria-hidden className="mt-0.5 h-5 w-5 shrink-0 animate-spin" /> : state.tone === "ok" ? <CheckCircle2 aria-hidden className="mt-0.5 h-5 w-5 shrink-0" /> : state.tone === "bad" ? <XCircle aria-hidden className="mt-0.5 h-5 w-5 shrink-0" /> : state.tone === "warn" ? <MessageCircle aria-hidden className="mt-0.5 h-5 w-5 shrink-0" /> : <Clock aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />}
          <div>
            <p>{state ? t(state.text) : t("Leyendo tu comprobante…")}</p>
            {receipt?.status === "credited" && receipt.amount && <p className="mt-1 font-mono text-lg font-bold">+ {money(BigInt(receipt.amount))}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
