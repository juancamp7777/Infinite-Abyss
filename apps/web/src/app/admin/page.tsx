"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Lock } from "lucide-react";
import { api, ApiError, tokens } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { formatMoney, parseMinor, toMinor } from "@/lib/money";
import { Field } from "@/components/Field";

const WD_STATUS: Record<string, string> = { PENDING: "Pendiente", APPROVED: "Aprobado", PAID: "Pagado", REJECTED: "Rechazado" };
const bo = { scope: "backoffice" as const };
const MONEYISH = /amount|balance|liabilit|ggr|deposit|withdraw|volume|wagered|payout|bet|win|house/i;

type Withdrawal = { id: string; userId?: string; user?: { email?: string } | string; amount: string; currency?: string; status: string; destination?: string; provider?: string; createdAt?: string; kycStatus?: string };
type Discrepancy = Record<string, unknown>;
type Report = { ok?: boolean; discrepancies?: Discrepancy[]; checks?: Array<{ name?: string; check?: string; ok?: boolean; discrepancies?: Discrepancy[] }>; generatedAt?: string };

function errMsg(e: unknown) {
  return e instanceof ApiError ? e.message : "Ocurrió un error inesperado.";
}

function asList<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  const r = (raw ?? {}) as Record<string, unknown>;
  return ((r.items ?? r.withdrawals ?? r.data ?? []) as T[]);
}

export default function AdminDashboard() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setToken(tokens.getBackoffice());
    setReady(true);
  }, []);

  if (!ready) return <div role="status" className="flex-1 flex items-center justify-center text-gray-400">Cargando…</div>;
  if (!token) return <BackofficeLogin onLogin={setToken} />;
  return (
    <Dashboard
      onLogout={() => {
        tokens.setBackoffice(null);
        setToken(null);
      }}
    />
  );
}

function BackofficeLogin({ onLogin }: { onLogin: (t: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError("Ingresa correo y contraseña.");
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ accessToken: string }>("/api/backoffice/auth/login", { email: email.trim(), password }, { scope: "none" });
      tokens.setBackoffice(res.accessToken);
      onLogin(res.accessToken);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex-1 flex items-center justify-center p-6">
      <form onSubmit={submit} noValidate aria-labelledby="bo-title" className="w-full max-w-md bg-surface border border-gold-900/50 rounded-2xl p-8 flex flex-col gap-5">
        <Lock className="w-10 h-10 text-gold-400 self-center" aria-hidden="true" />
        <h1 id="bo-title" className="font-serif text-2xl text-center uppercase tracking-widest text-white">Backoffice</h1>
        {error && <div role="alert" className="bg-red-950/60 border border-red-900 text-red-200 text-sm rounded-lg p-3">{error}</div>}
        <Field label="Correo" type="email" value={email} onChange={setEmail} autoComplete="username" required />
        <Field label="Contraseña" type="password" value={password} onChange={setPassword} autoComplete="current-password" required />
        <button type="submit" disabled={busy} className="bg-gold-gradient text-black font-bold py-3 rounded-xl disabled:opacity-60">
          {busy ? "Entrando…" : "Entrar"}
        </button>
        <Link href="/" className="text-center text-sm text-gray-400 underline">Volver al lobby</Link>
      </form>
    </main>
  );
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const { currency, decimals } = useTheme();
  const money = useCallback((v: string) => formatMoney(parseMinor(v), currency, decimals), [currency, decimals]);

  // Un 401/403 del backoffice cierra la sesión local.
  const guard = useCallback(
    (e: unknown): string => {
      if (e instanceof ApiError && e.status === 401) onLogout();
      return errMsg(e);
    },
    [onLogout],
  );

  return (
    <div className="flex-1 flex flex-col items-center bg-jetblack text-white">
      <header className="w-full max-w-6xl p-6 flex justify-between items-center border-b border-gold-900/30">
        <Link href="/" className="flex items-center gap-2 text-gold-400 hover:text-gold-300">
          <ArrowLeft className="w-5 h-5" aria-hidden="true" />
          <span className="font-serif tracking-widest uppercase text-sm">Lobby</span>
        </Link>
        <h1 className="font-serif text-2xl uppercase tracking-widest">Backoffice</h1>
        <button onClick={onLogout} className="border border-gray-600 px-4 py-2 rounded-lg text-sm">Cerrar sesión</button>
      </header>
      <main className="w-full max-w-6xl p-6 flex flex-col gap-10">
        <Stats money={money} guard={guard} />
        <Withdrawals money={money} guard={guard} />
        <Reconciliation guard={guard} />
        <Adjustment guard={guard} currency={currency} decimals={decimals} />
      </main>
    </div>
  );
}

type Guard = (e: unknown) => string;

function Card({ title, id, children }: { title: string; id: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="bg-surface border border-gold-900/50 rounded-2xl p-6 flex flex-col gap-4">
      <h2 id={id} className="font-serif text-xl uppercase tracking-widest text-gold-300">{title}</h2>
      {children}
    </section>
  );
}

function Stats({ money, guard }: { money: (v: string) => string; guard: Guard }) {
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStats(await api.get<Record<string, unknown>>("/api/backoffice/stats", bo));
      setError(null);
    } catch (e) {
      setError(guard(e));
    }
  }, [guard]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 10000);
    return () => clearInterval(id);
  }, [load]);

  const scalars = stats ? Object.entries(stats).filter(([, v]) => typeof v === "string" || typeof v === "number") : [];
  return (
    <Card title="Resumen" id="stats-title">
      {error && <div role="alert" className="text-red-300">{error} <button onClick={() => void load()} className="underline font-bold">Reintentar</button></div>}
      {!stats && !error && <p role="status" className="text-gray-300">Cargando…</p>}
      {stats && scalars.length === 0 && <p className="text-gray-300">Sin datos todavía.</p>}
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {scalars.map(([k, v]) => (
          <div key={k} className="bg-black/40 rounded-xl p-4">
            <dt className="text-xs uppercase tracking-widest text-gray-400">{k}</dt>
            <dd className="font-mono text-xl mt-1">{typeof v === "string" && /^-?\d+$/.test(v) && MONEYISH.test(k) ? money(v) : String(v)}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function Withdrawals({ money, guard }: { money: (v: string) => string; guard: Guard }) {
  const [status, setStatus] = useState("PENDING");
  const [rows, setRows] = useState<Withdrawal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    try {
      setRows(asList<Withdrawal>(await api.get("/api/backoffice/withdrawals", { ...bo, query: { status } })));
      setError(null);
    } catch (e) {
      setError(guard(e));
    }
  }, [status, guard]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, action: "approve" | "reject" | "mark-paid", body: Record<string, unknown> = {}) => {
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/api/backoffice/withdrawals/${encodeURIComponent(id)}/${action}`, body, bo);
      setRejecting(null);
      setReason("");
      await load();
    } catch (e) {
      setError(guard(e));
    } finally {
      setBusyId(null);
    }
  };

  const confirmReject = (id: string) => {
    if (reason.trim().length < 3) {
      setReasonError("El motivo es obligatorio.");
      return;
    }
    setReasonError(null);
    void act(id, "reject", { reason: reason.trim() });
  };

  return (
    <Card title="Cola de retiros" id="wd-title">
      <div className="flex items-center gap-3">
        <label htmlFor="wd-status" className="text-xs uppercase tracking-widest text-gray-300 font-bold">Estado</label>
        <select id="wd-status" value={status} onChange={(e) => setStatus(e.target.value)} className="bg-black border border-gold-900/50 rounded-lg p-2">
          {["PENDING", "APPROVED", "PAID", "REJECTED"].map((s) => <option key={s} value={s}>{WD_STATUS[s]}</option>)}
        </select>
      </div>
      {error && <div role="alert" className="text-red-300">{error}</div>}
      {!rows && !error && <p role="status" className="text-gray-300">Cargando retiros…</p>}
      {rows && rows.length === 0 && <p className="text-gray-300">No hay retiros en estado {WD_STATUS[status] ?? status}.</p>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <caption className="sr-only">Retiros {WD_STATUS[status] ?? status}</caption>
            <thead className="text-xs uppercase text-gray-400">
              <tr>
                <th scope="col" className="py-2 pr-3">Fecha</th>
                <th scope="col" className="py-2 pr-3">Jugador</th>
                <th scope="col" className="py-2 pr-3">Destino</th>
                <th scope="col" className="py-2 pr-3 text-right">Monto</th>
                <th scope="col" className="py-2 pl-3">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id} className="border-t border-gold-900/30 align-top">
                  <td className="py-2 pr-3 whitespace-nowrap">{w.createdAt ? new Date(w.createdAt).toLocaleString("es-CO") : "—"}</td>
                  <td className="py-2 pr-3">{typeof w.user === "string" ? w.user : w.user?.email ?? w.userId ?? "—"}</td>
                  <td className="py-2 pr-3 break-all max-w-48">{w.destination ?? "—"}</td>
                  <td className="py-2 pr-3 text-right font-mono">{money(w.amount)}</td>
                  <td className="py-2 pl-3">
                    {rejecting === w.id ? (
                      <div className="flex flex-col gap-2 min-w-56">
                        <Field label="Motivo del rechazo" value={reason} onChange={setReason} error={reasonError} required />
                        <div className="flex gap-2">
                          <button disabled={busyId === w.id} onClick={() => confirmReject(w.id)} className="bg-red-600 px-3 py-1 rounded font-bold disabled:opacity-60">Confirmar rechazo</button>
                          <button onClick={() => { setRejecting(null); setReason(""); setReasonError(null); }} className="border border-gray-600 px-3 py-1 rounded">Cancelar</button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-2 flex-wrap">
                        {w.status === "PENDING" && (
                          <>
                            <button disabled={busyId === w.id} onClick={() => void act(w.id, "approve")} className="bg-green-600 px-3 py-1 rounded font-bold disabled:opacity-60">Aprobar</button>
                            <button disabled={busyId === w.id} onClick={() => setRejecting(w.id)} className="border border-red-500 text-red-300 px-3 py-1 rounded">Rechazar</button>
                          </>
                        )}
                        {w.status === "APPROVED" && (
                          <button disabled={busyId === w.id} onClick={() => void act(w.id, "mark-paid")} className="bg-gold-gradient text-black px-3 py-1 rounded font-bold disabled:opacity-60">Marcar pagado</button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Reconciliation({ guard }: { guard: Guard }) {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await api.get<Report>("/api/backoffice/reconciliation", bo));
    } catch (e) {
      setError(guard(e));
    } finally {
      setLoading(false);
    }
  };

  const all: Discrepancy[] = report
    ? [...(report.discrepancies ?? []), ...(report.checks ?? []).flatMap((c) => c.discrepancies ?? [])]
    : [];
  const clean = report !== null && all.length === 0 && report.ok !== false;

  return (
    <Card title="Reconciliación del ledger" id="rec-title">
      <button onClick={() => void run()} disabled={loading} className="self-start bg-gold-gradient text-black font-bold px-5 py-2 rounded-lg disabled:opacity-60">
        {loading ? "Verificando…" : "Ejecutar reconciliación"}
      </button>
      {error && <div role="alert" className="text-red-300">{error}</div>}
      {clean && <p role="status" className="bg-green-950/50 border border-green-800 text-green-200 rounded-lg p-3 font-bold">✔ Cuadre correcto: 0 discrepancias.</p>}
      {report && !clean && (
        <div role="alert" className="flex flex-col gap-3">
          <p className="bg-red-950/60 border border-red-900 text-red-200 rounded-lg p-3 font-bold">{all.length} discrepancia(s) detectadas.</p>
          {all.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <caption className="sr-only">Discrepancias</caption>
                <thead className="uppercase text-gray-400">
                  <tr>{Object.keys(all[0]).map((k) => <th key={k} scope="col" className="py-2 pr-3">{k}</th>)}</tr>
                </thead>
                <tbody>
                  {all.map((d, i) => (
                    <tr key={i} className="border-t border-gold-900/30">
                      {Object.keys(all[0]).map((k) => <td key={k} className="py-2 pr-3 font-mono break-all">{typeof d[k] === "object" ? JSON.stringify(d[k]) : String(d[k] ?? "")}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Adjustment({ guard, currency, decimals }: { guard: Guard; currency: string; decimals: number }) {
  const [playerId, setPlayerId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ playerId?: string; amount?: string; reason?: string }>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const errs: typeof errors = {};
    if (!playerId.trim()) errs.playerId = "Indica el ID del jugador.";
    let signed: bigint | null = null;
    const raw = amount.trim();
    try {
      const negative = raw.startsWith("-");
      const m = toMinor(raw.replace(/^[+-]/, ""), decimals);
      if (m === BigInt(0)) throw new Error();
      signed = negative ? -m : m;
    } catch {
      errs.amount = "Monto inválido (usa signo: +10.00 o -5.00).";
    }
    if (reason.trim().length < 5) errs.reason = "El motivo es obligatorio (mínimo 5 caracteres).";
    setErrors(errs);
    if (Object.keys(errs).length || signed === null) return;
    setBusy(true);
    try {
      await api.post(`/api/backoffice/players/${encodeURIComponent(playerId.trim())}/adjustments`, { amount: signed.toString(), reason: reason.trim(), currency, idempotencyKey: crypto.randomUUID() }, bo);
      setMsg({ ok: true, text: "Ajuste aplicado y registrado en auditoría." });
      setAmount("");
      setReason("");
    } catch (err) {
      setMsg({ ok: false, text: guard(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Ajuste manual" id="adj-title">
      <form onSubmit={submit} noValidate className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Field label="ID de jugador" value={playerId} onChange={setPlayerId} error={errors.playerId} required />
        <Field label={`Monto con signo (${currency})`} value={amount} onChange={setAmount} error={errors.amount} inputMode="decimal" required placeholder="-5.00" />
        <Field label="Motivo" value={reason} onChange={setReason} error={errors.reason} required />
        <div className="md:col-span-3 flex flex-col gap-2">
          <button type="submit" disabled={busy} className="self-start bg-gold-gradient text-black font-bold px-5 py-2 rounded-lg disabled:opacity-60">
            {busy ? "Aplicando…" : "Aplicar ajuste"}
          </button>
          {msg && <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-green-300 text-sm" : "text-red-300 text-sm"}>{msg.text}</p>}
        </div>
      </form>
    </Card>
  );
}
