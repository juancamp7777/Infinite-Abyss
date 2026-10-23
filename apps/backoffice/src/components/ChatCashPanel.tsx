"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Plus, RefreshCw } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useApiClient, useSession } from "@/lib/hooks";
import { dateTime, money, toMinor } from "@/lib/format";
import { Badge, inputCls } from "@/components/ui";

interface Wallet {
  playerId: string;
  email: string;
  username: string | null;
  status: string;
  kycStatus: "NONE" | "PENDING" | "VERIFIED" | "REJECTED";
  currency: string;
  cash: string;
  bonus: string;
  pendingWithdrawals: { count: number; amount: string };
  lastLoad: { amount: string; at: string; type: string } | null;
  movements: Array<{ type: string; amount: string; at: string; reason: string | null }>;
}

const CAN_MOVE = new Set(["PLATFORM_ADMIN", "OPERATOR_ADMIN", "OPERATOR_FINANCE"]);
const KYC: Record<Wallet["kycStatus"], { label: string; tone: "good" | "warn" | "bad" | "neutral" }> = {
  VERIFIED: { label: "Verificado", tone: "good" }, PENDING: { label: "KYC pendiente", tone: "warn" }, REJECTED: { label: "KYC rechazado", tone: "bad" }, NONE: { label: "Sin KYC", tone: "neutral" },
};
const MOVE_LABEL: Record<string, string> = {
  DEPOSIT: "Depósito", MANUAL_ADJUSTMENT: "Ajuste", WITHDRAWAL_RESERVE: "Retiro", WITHDRAWAL_RELEASE: "Retiro devuelto", BET: "Apuesta", WIN: "Premio",
  BONUS_CONVERT: "Bono convertido", CASHBACK: "Cashback", ROLLBACK: "Reverso", JACKPOT_WIN: "Jackpot",
};

/**
 * Caja dentro del chat (como en Magik): saldo del jugador vinculado y carga o descarga de fichas en un solo campo.
 * Cada movimiento va al ledger con motivo, autor y clave de idempotencia; si la red falla, el reintento no duplica.
 */
export function ChatCashPanel({ playerId, contactName }: { playerId: string; contactName: string }) {
  const { call } = useApiClient();
  const session = useSession();
  const [w, setW] = useState<Wallet | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"in" | "out" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Misma clave mientras no cambie la operación: un doble clic o un reintento tras un corte no carga dos veces.
  const pendingKey = useRef<{ sig: string; key: string } | null>(null);
  const canMove = !!session && CAN_MOVE.has(session.role);
  const minor = toMinor(amount);

  const load = useCallback(async () => {
    setErr(null);
    try { setW(await call<Wallet>(`/api/backoffice/players/${encodeURIComponent(playerId)}/wallet`)); } catch (e) { setErr(e instanceof ApiError ? e.message : "No se pudo cargar el saldo"); }
  }, [call, playerId]);
  useEffect(() => { void load(); }, [load]);

  async function move(dir: "in" | "out") {
    if (!minor || !w) return;
    const sig = `${dir}:${minor}:${reason}`;
    if (pendingKey.current?.sig !== sig) pendingKey.current = { sig, key: crypto.randomUUID() };
    setBusy(dir);
    setMsg(null);
    try {
      await call(`/api/backoffice/players/${encodeURIComponent(playerId)}/adjustments`, {
        method: "POST",
        body: { amount: dir === "out" ? `-${minor}` : minor, reason: reason.trim() || (dir === "in" ? `Carga por chat (${contactName})` : `Descarga por chat (${contactName})`), currency: w.currency },
        headers: { "Idempotency-Key": pendingKey.current.key },
      });
      pendingKey.current = null;
      setMsg({ ok: true, text: `${dir === "in" ? "Cargado" : "Descontado"} ${money(minor, w.currency)}` });
      setAmount("");
      setReason("");
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : "No se pudo confirmar. Reintenta: no se duplica." });
    } finally {
      setBusy(null);
    }
  }

  if (err) return <p className="mt-3 border-t border-white/5 pt-3 text-xs text-red-300">{err}</p>;
  if (!w) return <p className="mt-3 border-t border-white/5 pt-3 text-xs text-white/40">Cargando saldo…</p>;
  return (
    <section className="mt-3 space-y-3 border-t border-white/5 pt-3" aria-label="Caja del jugador">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{w.username || w.email}</div>
          {w.username && <div className="truncate text-xs text-white/45">{w.email}</div>}
        </div>
        <button type="button" onClick={() => void load()} className="text-white/40 hover:text-white" aria-label="Actualizar saldo"><RefreshCw className="h-4 w-4" aria-hidden /></button>
      </div>
      <div className="flex flex-wrap gap-1">
        <Badge tone={KYC[w.kycStatus].tone}>{KYC[w.kycStatus].label}</Badge>
        {w.status !== "ACTIVE" && <Badge tone="bad">{w.status}</Badge>}
      </div>
      <div className="rounded-xl border border-[var(--color-brand)]/25 bg-[var(--color-brand)]/5 p-3">
        <div className="text-[11px] uppercase tracking-wider text-white/45">Saldo</div>
        <div className="text-2xl font-bold tabular-nums">{money(w.cash, w.currency)}</div>
        <dl className="mt-1 grid grid-cols-2 gap-x-2 text-xs text-white/60">
          <dt>Bonos</dt><dd className="text-right tabular-nums">{money(w.bonus, w.currency)}</dd>
          <dt>Retiros en curso</dt><dd className="text-right tabular-nums">{w.pendingWithdrawals.count ? `${w.pendingWithdrawals.count} · ${money(w.pendingWithdrawals.amount, w.currency)}` : "—"}</dd>
          <dt>Última carga</dt><dd className="text-right">{w.lastLoad ? `${money(w.lastLoad.amount, w.currency)} · ${dateTime(w.lastLoad.at)}` : "—"}</dd>
        </dl>
      </div>
      {canMove ? (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void move("in"); }}>
          <div className="flex gap-1.5">
            <input aria-label={`Monto en ${w.currency}`} inputMode="decimal" className={`${inputCls} min-w-0 flex-1 text-base font-semibold`} placeholder={`Monto ${w.currency}`} value={amount} onChange={(e) => setAmount(e.target.value)} />
            <button type="submit" disabled={!minor || !!busy} className="grid h-10 w-10 place-items-center rounded-lg bg-emerald-500 text-black disabled:opacity-40" aria-label="Cargar fichas" title="Cargar (Enter)"><Plus className="h-5 w-5" aria-hidden /></button>
            <button type="button" disabled={!minor || !!busy} onClick={() => void move("out")} className="grid h-10 w-10 place-items-center rounded-lg bg-red-500 text-white disabled:opacity-40" aria-label="Descontar fichas" title="Descontar"><Minus className="h-5 w-5" aria-hidden /></button>
          </div>
          <input aria-label="Motivo (opcional)" className={`${inputCls} w-full text-xs`} placeholder="Motivo (opcional): Nequi, cortesía…" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
          {amount && !minor && <p className="text-xs text-red-300">Monto inválido. Ej.: 50.000 o 50.000,50</p>}
          {busy && <p className="text-xs text-white/50">{busy === "in" ? "Cargando…" : "Descontando…"}</p>}
        </form>
      ) : (
        <p className="text-xs text-white/40">Solo administración o finanzas pueden cargar o descontar.</p>
      )}
      {msg && <p role={msg.ok ? "status" : "alert"} className={`text-xs ${msg.ok ? "text-emerald-300" : "text-red-300"}`}>{msg.text}</p>}
      {w.movements.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wider text-white/45">Movimientos</div>
          <ul className="max-h-48 space-y-1 overflow-auto text-xs">
            {w.movements.map((m, i) => (
              <li key={i} className="flex justify-between gap-2 rounded bg-white/[.03] px-2 py-1">
                <span className="min-w-0 truncate text-white/60" title={m.reason ?? undefined}>{MOVE_LABEL[m.type] ?? m.type} · {dateTime(m.at)}</span>
                <span className={`shrink-0 tabular-nums ${m.amount.startsWith("-") ? "text-red-300" : "text-emerald-300"}`}>{m.amount.startsWith("-") ? "" : "+"}{money(m.amount, w.currency)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex gap-2 text-xs">
        <Link href="/pearl" className="text-[var(--color-brand)] hover:underline">Comprobantes</Link>
        <span className="text-white/20">·</span>
        <Link href="/players" className="text-[var(--color-brand)] hover:underline">Jugadores</Link>
      </div>
    </section>
  );
}
