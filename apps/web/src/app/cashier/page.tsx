"use client";
import { useT } from "@/lib/i18n";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Wallet, Copy, ExternalLink } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCasino } from "@/hooks/useCasino";
import { parseMinor } from "@/lib/money";
import { betSteps } from "@/lib/bets";
import { QuickBets } from "@/components/QuickBets";
import { minorToInput } from "@/lib/money";
import { Field } from "@/components/Field";

type Method = { provider: string; label?: string; name?: string; kind?: string; currencies?: string[]; minAmount?: string; maxAmount?: string };
type Row = { id: string; type?: string; kind?: string; status?: string; amount: string; currency?: string; createdAt?: string; provider?: string };
type DepositResult = { depositId: string; redirectUrl?: string; address?: string; network?: string; invoiceUrl?: string; amount?: string; currency?: string };

type Page<T> = { items: T[]; nextCursor: string | null };

/** Normaliza las posibles formas de lista paginada del servidor. */
function toPage<T>(raw: unknown): Page<T> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const items = (Array.isArray(raw) ? raw : (r.items ?? r.transactions ?? r.withdrawals ?? r.data ?? [])) as T[];
  const nextCursor = typeof r.nextCursor === "string" ? r.nextCursor : null;
  return { items, nextCursor };
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pendiente",
  CONFIRMED: "Confirmado",
  COMPLETED: "Completado",
  FAILED: "Fallido",
  REJECTED: "Rechazado",
  APPROVED: "Aprobado",
  PAID: "Pagado",
  REQUESTED: "Solicitado",
};

function errMsg(e: unknown) {
  return e instanceof ApiError ? e.message : "Ocurrió un error inesperado.";
}

export default function CashierPage() {
  const { t } = useT();
  const { user, balances, reloadMe } = useAuth();
  const { balance, money, tryMinor, currency: themeCurrency, decimals } = useCasino();
  // La moneda sale del saldo del jugador y, si no, del operador.
  const currency = (typeof balances?.currency === "string" && balances.currency) || themeCurrency;

  const [tab, setTab] = useState<"deposit" | "withdraw" | "history">("deposit");
  const [methods, setMethods] = useState<Method[] | null>(null);
  const [methodsError, setMethodsError] = useState<string | null>(null);

  const loadMethods = useCallback(async () => {
    setMethods(null);
    setMethodsError(null);
    try {
      const raw = await api.get<Method[] | { methods: Method[] }>("/api/cashier/methods");
      setMethods(Array.isArray(raw) ? raw : raw.methods ?? []);
    } catch (e) {
      setMethodsError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void loadMethods();
  }, [loadMethods]);

  const bonus = balances?.bonus ? parseMinor(balances.bonus) : BigInt(0);

  return (
    <div className="flex-1 flex flex-col items-center bg-jetblack text-white">
      <header className="w-full max-w-4xl p-6 flex justify-between items-center border-b border-gold-900/30">
        <Link href="/" className="flex items-center gap-2 text-gold-400 hover:text-gold-300 transition-colors">
          <ArrowLeft className="w-5 h-5" aria-hidden="true" />
          <span className="font-serif tracking-widest uppercase text-sm">{t("Lobby")}</span>
        </Link>
        <div className="flex items-center gap-4 bg-black/50 px-4 py-2 rounded-full border border-gold-500/20">
          <Wallet className="w-5 h-5 text-gold-400" aria-hidden="true" />
          <span className="font-mono text-xl font-bold text-white" aria-live="polite">
            {money(balance)}
          </span>
        </div>
      </header>

      <main className="w-full max-w-2xl flex-1 p-6 flex flex-col items-center mt-6 gap-6">
        <h1 className="font-serif text-4xl font-bold text-white text-center uppercase tracking-widest">{t("Cajero")}</h1>
        {bonus > BigInt(0) && (
          <p className="text-xs text-gray-300 bg-gold-900/20 border border-gold-900/40 rounded-lg px-3 py-2">
            Saldo de bono: {money(bonus)} — no es retirable.
          </p>
        )}

        <div role="tablist" aria-label={t("Secciones del cajero")} className="flex gap-2 w-full">
          {(
            [
              ["deposit", "Depositar"],
              ["withdraw", "Retirar"],
              ["history", "Historial"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              id={`tab-${key}`}
              aria-selected={tab === key}
              aria-controls={`panel-${key}`}
              onClick={() => setTab(key)}
              className={`flex-1 py-3 rounded-lg font-bold text-sm uppercase tracking-widest border ${tab === key ? "bg-gold-gradient text-black border-transparent" : "border-gold-900/50 text-gray-300"}`}
            >
              {t(label)}
            </button>
          ))}
        </div>

        <section role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="w-full bg-surface border border-gold-900/50 rounded-2xl p-6 shadow-2xl">
          {methods === null && !methodsError && tab !== "history" && (
            <p role="status" className="text-gray-300 text-center">{t("Cargando métodos de pago…")}</p>
          )}
          {methodsError && tab !== "history" && (
            <div role="alert" className="text-red-300 text-center">
              {methodsError}{" "}
              <button onClick={() => void loadMethods()} className="underline font-bold">
                {t("Reintentar")}
              </button>
            </div>
          )}
          {methods !== null && methods.length === 0 && tab !== "history" && (
            <p className="text-gray-300 text-center">{t("No hay métodos de pago habilitados en esta sala.")}</p>
          )}

          {tab === "deposit" && methods && methods.length > 0 && (
            <DepositForm methods={methods} currency={currency} decimals={decimals} tryMinor={tryMinor} onDone={() => void reloadMe()} />
          )}
          {tab === "withdraw" && methods && methods.length > 0 && (
            <WithdrawForm methods={methods} currency={currency} tryMinor={tryMinor} kyc={user?.kycStatus ?? "NONE"} />
          )}
          {tab === "history" && <History money={money} />}
        </section>
      </main>
    </div>
  );
}

/** Montos rápidos de depósito (unidades mínimas): 20.000 / 50.000 / 100.000 / 200.000 COP; en otras monedas, los montos del operador. */
function depositPresets(currency: string): string[] {
  if (currency === "COP") return ["2000000", "5000000", "10000000", "20000000"];
  return betSteps(currency).slice(0, 4);
}

function methodLabel(m: Method) {
  return m.label ?? m.name ?? m.provider;
}

function MethodSelect({ methods, value, onChange }: { methods: Method[]; value: string; onChange: (v: string) => void }) {
  const { t } = useT();
  return (
    <fieldset className="flex gap-3 flex-wrap">
      <legend className="text-xs font-bold text-gray-300 uppercase tracking-widest mb-2">{t("Método de pago")}</legend>
      {methods.map((m) => (
        <label
          key={m.provider}
          className={`flex-1 min-w-32 cursor-pointer text-center p-3 rounded-xl border-2 text-sm font-bold has-[:focus-visible]:outline has-[:focus-visible]:outline-2 ${value === m.provider ? "border-gold-400 bg-gold-500/10" : "border-gray-800 bg-black"}`}
        >
          <input type="radio" name="provider" value={m.provider} checked={value === m.provider} onChange={() => onChange(m.provider)} className="sr-only" />
          {t(methodLabel(m))}
        </label>
      ))}
    </fieldset>
  );
}

function DepositForm({ methods, currency, decimals, tryMinor, onDone }: { methods: Method[]; currency: string; decimals: number; tryMinor: (v: string) => bigint | null; onDone: () => void }) {
  const { t } = useT();
  const [provider, setProvider] = useState(methods[0].provider);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DepositResult | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const minor = tryMinor(amount);
    if (minor === null || minor <= BigInt(0)) {
      setError(currency === "COP" ? "Ingresa un monto válido en pesos (ej. 50.000)." : `Ingresa un monto válido (máximo ${decimals} decimales).`);
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<DepositResult>("/api/cashier/deposits", { provider, amount: minor.toString(), currency });
      const url = res.redirectUrl ?? res.invoiceUrl;
      if (url && /^https:\/\//i.test(url)) {
        window.location.assign(url);
        return;
      }
      setResult(res);
      onDone();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="flex flex-col gap-4 items-center text-center" role="status">
        <p className="text-green-300 font-bold">{t("Depósito creado. Se acreditará al confirmarse el pago.")}</p>
        {result.address && (
          <>
            <p className="text-sm text-gray-300">Envía el monto a esta dirección{result.network ? ` (${result.network})` : ""}:</p>
            <code className="bg-black border border-gray-800 px-3 py-2 rounded text-xs text-gold-300 break-all w-full select-all">{result.address}</code>
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(result.address ?? "").then(() => setCopied(true));
              }}
              className="flex items-center gap-2 bg-gold-gradient text-black font-bold py-2 px-4 rounded-lg"
            >
              <Copy className="w-4 h-4" aria-hidden="true" /> {copied ? "Copiada" : t("Copiar dirección")}
            </button>
          </>
        )}
        <p className="text-xs text-gray-400">Referencia: {result.depositId}</p>
        <button onClick={() => setResult(null)} className="underline text-gold-300 text-sm">
          {t("Nuevo depósito")}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <MethodSelect methods={methods} value={provider} onChange={setProvider} />
      <Field label={`Monto a depositar (${currency})`} value={amount} onChange={setAmount} inputMode="decimal" error={error} required placeholder={currency === "COP" ? "50000" : "0.00"} />
      <QuickBets label={t("Montos rápidos de depósito")} amounts={depositPresets(currency)} currency={currency} decimals={decimals} onPick={(v) => setAmount(minorToInput(v, decimals, currency))} disabled={busy} />
      <button type="submit" disabled={busy} className="bg-gold-gradient text-black font-bold py-3 rounded-xl disabled:opacity-60 flex items-center justify-center gap-2">
        {busy ? "Procesando…" : <>{t("Depositar")} <ExternalLink className="w-4 h-4" aria-hidden="true" /></>}
      </button>
      <p className="text-xs text-gray-400">{t("Los depósitos solo se acreditan cuando la pasarela confirma el pago. Se aplican tus límites de depósito.")}</p>
    </form>
  );
}

function WithdrawForm({ methods, currency, tryMinor, kyc }: { methods: Method[]; currency: string; tryMinor: (v: string) => bigint | null; kyc: string }) {
  const { t } = useT();
  const [provider, setProvider] = useState(methods[0].provider);
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [errors, setErrors] = useState<{ amount?: string; destination?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setOk(false);
    setFormError(null);
    const errs: typeof errors = {};
    const minor = tryMinor(amount);
    if (minor === null || minor <= BigInt(0)) errs.amount = t("Ingresa un monto válido.");
    if (destination.trim().length < 3) errs.destination = t("Indica el destino del retiro.");
    setErrors(errs);
    if (Object.keys(errs).length || minor === null) return;
    setBusy(true);
    try {
      await api.post("/api/cashier/withdrawals", { provider, amount: minor.toString(), currency, destination: destination.trim() });
      setOk(true);
      setAmount("");
      setDestination("");
    } catch (err) {
      setFormError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      {kyc !== "VERIFIED" && (
        <div role="alert" className="bg-yellow-950/50 border border-yellow-800 text-yellow-200 text-sm rounded-lg p-3">
          Para retirar necesitas verificar tu identidad (KYC). Estado actual: {kyc}.{" "}
          <Link href="/account" className="underline font-bold">
            {t("Ir a mi cuenta")}
          </Link>
        </div>
      )}
      <p className="text-xs text-gray-300">{t("El saldo de bono no se puede retirar. Los retiros pasan por aprobación manual del operador.")}</p>
      {formError && (
        <div role="alert" className="bg-red-950/60 border border-red-900 text-red-200 text-sm rounded-lg p-3">
          {formError}
        </div>
      )}
      {ok && (
        <div role="status" className="bg-green-950/50 border border-green-800 text-green-200 text-sm rounded-lg p-3">
          {t("Solicitud enviada. Queda pendiente de aprobación.")}
        </div>
      )}
      <MethodSelect methods={methods} value={provider} onChange={setProvider} />
      <Field label={`Monto a retirar (${currency})`} value={amount} onChange={setAmount} inputMode="decimal" error={errors.amount} required placeholder={currency === "COP" ? "50000" : "0.00"} />
      <Field label={t("Destino (cuenta o dirección)")} value={destination} onChange={setDestination} error={errors.destination} required autoComplete="off" />
      <button type="submit" disabled={busy} className="bg-gold-gradient text-black font-bold py-3 rounded-xl disabled:opacity-60">
        {busy ? "Enviando…" : "Solicitar retiro"}
      </button>
    </form>
  );
}

function History({ money }: { money: (v: bigint) => string }) {
  const { t } = useT();
  const [items, setItems] = useState<Row[]>([]);
  const [withdrawals, setWithdrawals] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (next?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const page = toPage<Row>(await api.get("/api/cashier/transactions", { query: { cursor: next ?? undefined } }));
      setItems((prev) => (next ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
      if (!next) setWithdrawals(toPage<Row>(await api.get("/api/cashier/withdrawals")).items);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const table = (rows: Row[], caption: string) => (
    <div className="overflow-x-auto">
      <table className="w-full text-sm text-left">
        <caption className="text-left text-xs uppercase tracking-widest text-gray-300 mb-2 font-bold">{caption}</caption>
        <thead className="text-xs text-gray-400 uppercase">
          <tr>
            <th scope="col" className="py-2 pr-3">{t("Fecha")}</th>
            <th scope="col" className="py-2 pr-3">{t("Tipo")}</th>
            <th scope="col" className="py-2 pr-3">{t("Estado")}</th>
            <th scope="col" className="py-2 text-right">{t("Monto")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-gold-900/30">
              <td className="py-2 pr-3 whitespace-nowrap">{r.createdAt ? new Date(r.createdAt).toLocaleString("es-CO") : "—"}</td>
              <td className="py-2 pr-3">{r.type ?? r.kind ?? r.provider ?? "—"}</td>
              <td className="py-2 pr-3">{r.status ? t(STATUS_LABEL[r.status] ?? r.status) : "—"}</td>
              <td className="py-2 text-right font-mono">{money(parseMinor(r.amount))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  if (error) {
    return (
      <div role="alert" className="text-red-300 text-center">
        {error}{" "}
        <button onClick={() => void load()} className="underline font-bold">{t("Reintentar")}</button>
      </div>
    );
  }
  if (loading && items.length === 0) return <p role="status" className="text-gray-300 text-center">{t("Cargando historial…")}</p>;
  if (items.length === 0 && withdrawals.length === 0) return <p className="text-gray-300 text-center">{t("Aún no tienes movimientos.")}</p>;

  return (
    <div className="flex flex-col gap-8">
      {items.length > 0 && table(items, "Movimientos")}
      {cursor && (
        <button onClick={() => void load(cursor)} disabled={loading} className="self-center border border-gold-500/40 text-gold-300 px-4 py-2 rounded-lg disabled:opacity-60">
          {loading ? "Cargando…" : "Ver más"}
        </button>
      )}
      {withdrawals.length > 0 && table(withdrawals, "Retiros")}
    </div>
  );
}
