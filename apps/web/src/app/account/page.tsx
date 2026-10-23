"use client";
import { useT } from "@/lib/i18n";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { minorToInput, parseMinor, toMinor } from "@/lib/money";
import { Field } from "@/components/Field";

type Limits = {
  depositLimitDaily: string | null;
  depositLimitWeekly: string | null;
  depositLimitMonthly: string | null;
  lossLimitDaily: string | null;
  lossLimitWeekly: string | null;
  lossLimitMonthly: string | null;
  sessionTimeLimitMinutes: number | null;
  selfExcludedUntil?: string | null;
  selfExclusionPermanent?: boolean;
};

type MoneyKey = "depositLimitDaily" | "depositLimitWeekly" | "depositLimitMonthly" | "lossLimitDaily" | "lossLimitWeekly" | "lossLimitMonthly";

const MONEY_FIELDS: Array<[MoneyKey, string]> = [
  ["depositLimitDaily", "Depósito diario"],
  ["depositLimitWeekly", "Depósito semanal"],
  ["depositLimitMonthly", "Depósito mensual"],
  ["lossLimitDaily", "Pérdida diaria"],
  ["lossLimitWeekly", "Pérdida semanal"],
  ["lossLimitMonthly", "Pérdida mensual"],
];

const KYC_LABEL: Record<string, string> = {
  NONE: "Sin verificar",
  PENDING: "En revisión",
  VERIFIED: "Verificada",
  REJECTED: "Rechazada",
};

type Msg = { ok: boolean; text: string } | null;

function errMsg(e: unknown) {
  return e instanceof ApiError ? e.message : "Ocurrió un error inesperado.";
}

function MsgLine({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return (
    <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-green-300 text-sm" : "text-red-300 text-sm"}>
      {msg.text}
    </p>
  );
}

export default function AccountPage() {
  const { t } = useT();
  const { user, reloadMe, logout } = useAuth();
  const { currency, decimals } = useTheme();

  const [limits, setLimits] = useState<Limits | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<Msg>(null);
  const [saving, setSaving] = useState(false);

  const [kycBusy, setKycBusy] = useState(false);
  const [kycMsg, setKycMsg] = useState<Msg>(null);

  const [excDays, setExcDays] = useState("30");
  const [excPermanent, setExcPermanent] = useState(false);
  const [excConfirm, setExcConfirm] = useState(false);
  const [excMsg, setExcMsg] = useState<Msg>(null);

  const applyLimits = useCallback(
    (l: Limits) => {
      setLimits(l);
      const f: Record<string, string> = {};
      for (const [key] of MONEY_FIELDS) {
        const v = l[key];
        f[key] = v ? minorToInput(parseMinor(v), decimals) : "";
      }
      f.sessionTimeLimitMinutes = l.sessionTimeLimitMinutes ? String(l.sessionTimeLimitMinutes) : "";
      setForm(f);
    },
    [decimals],
  );

  const loadLimits = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.get<Limits | { limits: Limits }>("/api/me/limits");
      applyLimits("limits" in res ? res.limits : res);
    } catch (e) {
      setLoadError(errMsg(e));
    }
  }, [applyLimits]);

  useEffect(() => {
    void loadLimits();
  }, [loadLimits]);

  const saveLimits = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveMsg(null);
    const body: Record<string, string | number | null> = {};
    try {
      for (const [key, label] of MONEY_FIELDS) {
        const raw = (form[key] ?? "").trim();
        if (raw === "") body[key] = null;
        else {
          const m = toMinor(raw, decimals);
          if (m <= BigInt(0)) throw new Error(`${t(label)}: debe ser mayor que 0 o estar vacío.`);
          body[key] = m.toString();
        }
      }
      const s = (form.sessionTimeLimitMinutes ?? "").trim();
      if (s === "") body.sessionTimeLimitMinutes = null;
      else if (!/^\d+$/.test(s) || Number(s) < 1) throw new Error(t("El límite de sesión debe ser un número entero de minutos."));
      else body.sessionTimeLimitMinutes = Number(s);
    } catch (err) {
      setSaveMsg({ ok: false, text: err instanceof Error ? err.message : t("Datos inválidos") });
      return;
    }
    setSaving(true);
    try {
      const res = await api.put<Limits | { limits: Limits }>("/api/me/limits", body);
      applyLimits("limits" in res ? res.limits : res);
      setSaveMsg({ ok: true, text: t("Límites guardados. Los aumentos pueden tener un periodo de enfriamiento.") });
    } catch (err) {
      setSaveMsg({ ok: false, text: errMsg(err) });
    } finally {
      setSaving(false);
    }
  };

  const submitKyc = async () => {
    setKycBusy(true);
    setKycMsg(null);
    try {
      await api.post("/api/me/kyc/submit", {});
      await reloadMe();
      setKycMsg({ ok: true, text: t("Tu verificación fue enviada a revisión.") });
    } catch (err) {
      setKycMsg({ ok: false, text: errMsg(err) });
    } finally {
      setKycBusy(false);
    }
  };

  const selfExclude = async () => {
    setExcMsg(null);
    const days = Number(excDays);
    if (!excPermanent && (!/^\d+$/.test(excDays) || days < 1)) {
      setExcMsg({ ok: false, text: t("Indica un número de días válido.") });
      return;
    }
    try {
      await api.post("/api/me/self-exclusion", excPermanent ? { permanent: true } : { days });
      setExcMsg({ ok: true, text: t("Autoexclusión activada. Se cerrará tu sesión.") });
      setTimeout(() => {
        void logout();
      }, 2000);
    } catch (err) {
      setExcMsg({ ok: false, text: errMsg(err) });
    }
  };

  const kyc = user?.kycStatus ?? "NONE";
  const excluded = Boolean(limits?.selfExclusionPermanent || (limits?.selfExcludedUntil && new Date(limits.selfExcludedUntil) > new Date()));

  return (
    <div className="flex-1 flex flex-col items-center bg-jetblack text-white">
      <header className="w-full max-w-3xl p-6 flex justify-between items-center border-b border-gold-900/30">
        <Link href="/" className="flex items-center gap-2 text-gold-400 hover:text-gold-300">
          <ArrowLeft className="w-5 h-5" aria-hidden="true" />
          <span className="font-serif tracking-widest uppercase text-sm">{t("Lobby")}</span>
        </Link>
        <span className="text-sm text-gray-300">{user?.email}</span>
      </header>

      <main className="w-full max-w-3xl p-6 flex flex-col gap-8">
        <h1 className="font-serif text-4xl font-bold text-center uppercase tracking-widest">{t("Mi cuenta")}</h1>

        <section aria-labelledby="kyc-title" className="bg-surface border border-gold-900/50 rounded-2xl p-6 flex flex-col gap-3">
          <h2 id="kyc-title" className="font-serif text-xl uppercase tracking-widest text-gold-300">{t("Verificación de identidad (KYC)")}</h2>
          <p>
            Estado: <strong>{t(KYC_LABEL[kyc] ?? kyc)}</strong>
          </p>
          {(kyc === "NONE" || kyc === "REJECTED") && (
            <button onClick={() => void submitKyc()} disabled={kycBusy} className="self-start bg-gold-gradient text-black font-bold px-5 py-2 rounded-lg disabled:opacity-60">
              {kycBusy ? t("Enviando…") : t("Enviar a revisión")}
            </button>
          )}
          <MsgLine msg={kycMsg} />
        </section>

        <section aria-labelledby="limits-title" className="bg-surface border border-gold-900/50 rounded-2xl p-6">
          <h2 id="limits-title" className="font-serif text-xl uppercase tracking-widest text-gold-300 mb-4">{t("Juego responsable: límites")}</h2>
          {loadError && (
            <div role="alert" className="text-red-300 mb-3">
              {loadError}{" "}
              <button onClick={() => void loadLimits()} className="underline font-bold">{t("Reintentar")}</button>
            </div>
          )}
          {!limits && !loadError && <p role="status" className="text-gray-300">{t("Cargando límites…")}</p>}
          {limits && (
            <form onSubmit={saveLimits} noValidate className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {MONEY_FIELDS.map(([key, label]) => (
                <Field key={key} label={`${t(label)} (${currency})`} inputMode="decimal" value={form[key] ?? ""} onChange={(v) => setForm((f) => ({ ...f, [key]: v }))} hint={t("Vacío = sin límite")} />
              ))}
              <Field label={t("Tiempo máximo de sesión (minutos)")} inputMode="numeric" value={form.sessionTimeLimitMinutes ?? ""} onChange={(v) => setForm((f) => ({ ...f, sessionTimeLimitMinutes: v }))} hint={t("Vacío = sin límite")} />
              <div className="sm:col-span-2 flex flex-col gap-2">
                <button type="submit" disabled={saving} className="self-start bg-gold-gradient text-black font-bold px-5 py-2 rounded-lg disabled:opacity-60">
                  {saving ? t("Guardando…") : t("Guardar límites")}
                </button>
                <MsgLine msg={saveMsg} />
              </div>
            </form>
          )}
        </section>

        <section aria-labelledby="exc-title" className="bg-surface border border-red-900/50 rounded-2xl p-6 flex flex-col gap-4">
          <h2 id="exc-title" className="font-serif text-xl uppercase tracking-widest text-red-300">{t("Autoexclusión")}</h2>
          {excluded && (
            <p role="status" className="text-yellow-200">
              Ya estás autoexcluido{limits?.selfExcludedUntil && !limits.selfExclusionPermanent ? ` hasta ${new Date(limits.selfExcludedUntil).toLocaleDateString("es-CO")}` : ""}.
            </p>
          )}
          <p className="text-sm text-gray-300">{t("Si necesitas una pausa, puedes bloquear tu cuenta. No podrás jugar ni depositar mientras dure, y no se puede revertir antes de tiempo.")}</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={excPermanent} onChange={(e) => setExcPermanent(e.target.checked)} className="w-4 h-4" />
            {t("Autoexclusión permanente")}
          </label>
          {!excPermanent && <Field label={t("Días de autoexclusión")} inputMode="numeric" value={excDays} onChange={setExcDays} />}
          {!excConfirm ? (
            <button onClick={() => setExcConfirm(true)} className="self-start border border-red-500 text-red-300 font-bold px-5 py-2 rounded-lg">
              Autoexcluirme…
            </button>
          ) : (
            <div role="alertdialog" aria-labelledby="exc-confirm" className="border border-red-700 rounded-lg p-4 flex flex-col gap-3">
              <p id="exc-confirm" className="font-bold">
                ¿Confirmas la autoexclusión {excPermanent ? "permanente" : `por ${excDays} día(s)`}? Esta acción no se puede deshacer.
              </p>
              <div className="flex gap-3">
                <button onClick={() => void selfExclude()} className="bg-red-600 text-white font-bold px-5 py-2 rounded-lg">{t("Sí, autoexcluirme")}</button>
                <button onClick={() => setExcConfirm(false)} className="border border-gray-600 px-5 py-2 rounded-lg">{t("Cancelar")}</button>
              </div>
            </div>
          )}
          <MsgLine msg={excMsg} />
        </section>
      </main>
    </div>
  );
}
