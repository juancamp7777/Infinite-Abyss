"use client";

import { useState } from "react";
import { Landmark, Plus, Trash2 } from "lucide-react";
import { useApi, useApiClient } from "@/lib/hooks";
import { Button, Card, Field, inputCls } from "@/components/ui";

export interface Account { id: string; holderName: string; alias?: string; accountNumber: string; bank?: string; country?: string; holderDocument?: string; active: boolean }
interface Country { country: string; name: string; docLabel: string; docPlaceholder: string; aliasLabel: string }
interface Method { key: string; country: string; label: string; numberLabel: string; placeholder: string; pattern: string; hint: string; keyLike?: boolean }

const EMPTY = { holderName: "", accountNumber: "", holderDocument: "", alias: "" };

/** Muestra solo los últimos 4 caracteres del número (las llaves Bre-B se ven completas: son públicas). */
const masked = (a: Account, m?: Method) => (m?.keyLike ? a.accountNumber : `•••• ${a.accountNumber.slice(-4)}`);

/**
 * Cuentas que reciben pagos, por país: el método (Nequi, CLABE, CVU…) define qué número se pide y cómo se valida.
 * Pearl compara la cuenta destino de cada comprobante con estas cuentas.
 */
export function AccountsCard({ accounts, run }: { accounts: Account[]; run: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const { call } = useApiClient();
  const cat = useApi<{ countries: Country[]; methods: Method[] }>("/pearl/v1/admin/account-methods");
  const [country, setCountry] = useState("CO");
  const [method, setMethod] = useState("nequi");
  const [f, setF] = useState(EMPTY);
  const countries = cat.data?.countries ?? [];
  const methods = (cat.data?.methods ?? []).filter((m) => m.country === country);
  const m = cat.data?.methods.find((x) => x.key === method);
  const c = countries.find((x) => x.country === country);
  const clean = m?.keyLike ? f.accountNumber.trim().replace(/\s+/g, "") : f.accountNumber.replace(/[\s.-]/g, "");
  const numberOk = !!m && new RegExp(m.pattern).test(clean);
  const showBad = clean.length > 0 && !numberOk;

  const pickCountry = (code: string) => {
    setCountry(code);
    setMethod(cat.data?.methods.find((x) => x.country === code)?.key ?? "");
  };
  const add = () => run(async () => {
    await call("/pearl/v1/admin/accounts", { method: "POST", body: { bank: method, holderName: f.holderName, accountNumber: f.accountNumber, holderDocument: f.holderDocument || undefined, alias: f.alias || undefined } });
    setF(EMPTY);
  }, "Cuenta agregada");

  return (
    <Card title="Cuentas que reciben pagos">
      <ul className="mb-3 space-y-1.5 text-sm">
        {accounts.map((a) => {
          const am = cat.data?.methods.find((x) => x.key === a.bank);
          return (
            <li key={a.id} className="flex items-center gap-2 rounded-lg bg-white/[.03] px-2.5 py-1.5">
              {a.country ? <span className="w-6 shrink-0 rounded bg-white/10 text-center text-[10px] font-bold leading-5 text-white/70">{a.country}</span> : <Landmark aria-hidden className="h-4 w-4 text-white/40" />}
              <div className="min-w-0 flex-1">
                <div className="truncate">{a.alias && !am?.keyLike ? a.alias : a.holderName}</div>
                <div className="truncate text-xs text-white/45">{am ? `${am.label} · ${masked(a, am)}` : a.alias || a.accountNumber}{a.alias && !am?.keyLike ? ` · ${a.holderName}` : ""}</div>
              </div>
              <button type="button" className="text-white/30 hover:text-red-300" aria-label={`Quitar ${a.holderName}`} onClick={() => void run(() => call(`/pearl/v1/admin/accounts/${a.id}`, { method: "DELETE" }), "Cuenta quitada")}><Trash2 aria-hidden className="h-4 w-4" /></button>
            </li>
          );
        })}
        {!accounts.length && <li className="text-xs text-white/40">Sin cuentas: Pearl no podrá verificar la cuenta destino.</li>}
      </ul>
      <div className="space-y-2">
        <div className="flex gap-1.5" role="radiogroup" aria-label="País">
          {countries.map((x) => (
            <button key={x.country} type="button" role="radio" aria-checked={country === x.country} onClick={() => pickCountry(x.country)}
              className={`flex-1 rounded-lg border px-2 py-1.5 text-sm ${country === x.country ? "border-amber-400 bg-amber-400/10" : "border-white/10 hover:border-white/30"}`}>
              {x.name}
            </button>
          ))}
        </div>
        <Field label="Método" htmlFor="acc-method">
          <select id="acc-method" className={`${inputCls} w-full`} value={method} onChange={(e) => setMethod(e.target.value)}>
            {methods.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
        </Field>
        <Field label="Titular (como sale en el comprobante)" htmlFor="acc-holder">
          <input id="acc-holder" className={`${inputCls} w-full`} placeholder="JUAN CAMPOS" value={f.holderName} onChange={(e) => setF({ ...f, holderName: e.target.value })} />
        </Field>
        {m && (
          <Field label={m.numberLabel} htmlFor="acc-number">
            <input id="acc-number" className={`${inputCls} w-full`} inputMode={m.keyLike ? "text" : "numeric"} placeholder={m.placeholder} value={f.accountNumber} onChange={(e) => setF({ ...f, accountNumber: e.target.value })} />
            <span className={`mt-1 block text-xs ${showBad ? "text-red-300" : "text-white/45"}`} role={showBad ? "alert" : undefined}>{showBad ? `Revisa el número: ${m.hint}` : m.hint}</span>
          </Field>
        )}
        {c && (
          <Field label={`${c.docLabel} (opcional)`} htmlFor="acc-doc">
            <input id="acc-doc" className={`${inputCls} w-full`} placeholder={c.docPlaceholder} value={f.holderDocument} onChange={(e) => setF({ ...f, holderDocument: e.target.value })} />
          </Field>
        )}
        {c && !m?.keyLike && (
          <Field label={`${c.aliasLabel} (opcional)`} htmlFor="acc-alias">
            <input id="acc-alias" className={`${inputCls} w-full`} value={f.alias} onChange={(e) => setF({ ...f, alias: e.target.value })} />
          </Field>
        )}
        <Button variant="ghost" className="w-full" disabled={!numberOk || f.holderName.trim().length < 2} onClick={() => void add()}><Plus aria-hidden className="h-4 w-4" /> Agregar cuenta</Button>
      </div>
    </Card>
  );
}
