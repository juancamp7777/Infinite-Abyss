"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DICTS } from "./i18n-dicts";

export type Lang = "es" | "en" | "pt";
export const LANGS: Array<{ id: Lang; label: string; short: string }> = [
  { id: "es", label: "Español", short: "ES" },
  { id: "en", label: "English", short: "EN" },
  { id: "pt", label: "Português", short: "PT" },
];
const KEY = "abyss.lang";

/** Idioma inicial: lo que eligió el jugador o, si nunca eligió, el de su navegador (español por defecto). */
function initial(): Lang {
  try {
    const saved = window.localStorage.getItem(KEY);
    if (saved === "es" || saved === "en" || saved === "pt") return saved;
  } catch { /* almacenamiento bloqueado */ }
  const nav = (typeof navigator !== "undefined" ? navigator.language : "es").slice(0, 2);
  return nav === "en" ? "en" : nav === "pt" ? "pt" : "es";
}

/** t("texto en español", vars): la clave ES el texto en español; si falta la traducción se muestra el español. */
interface Ctx { lang: Lang; setLang(l: Lang): void; t(key: string, vars?: Record<string, string | number>): string }
const fill = (s: string, vars?: Record<string, string | number>) => {
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
};
const I18nCtx = createContext<Ctx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  // Primer render en español (igual que el HTML del servidor) y luego el idioma del jugador: sin errores de hidratación.
  const [lang, setLangState] = useState<Lang>("es");
  useEffect(() => setLangState(initial()), []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { window.localStorage.setItem(KEY, l); } catch { /* almacenamiento bloqueado */ }
  }, []);
  const value = useMemo<Ctx>(() => ({
    lang,
    setLang,
    t: (key, vars) => fill(lang === "es" ? key : DICTS[lang][key] ?? key, vars),
  }), [lang, setLang]);
  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

/** Fuera del proveedor (pruebas, páginas sueltas) cae a español. */
export function useT(): Ctx {
  return useContext(I18nCtx) ?? { lang: "es", setLang: () => undefined, t: (k, vars) => fill(k, vars) };
}

/** Selector compacto de idioma (ES · EN · PT) para cabeceras y pies. */
export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { lang, setLang, t } = useT();
  return (
    <label className={`inline-flex items-center ${className}`}>
      <span className="sr-only">{t("Idioma")}</span>
      <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t("Idioma")}
        className="cursor-pointer rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-bold text-white/85 hover:border-white/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300">
        {LANGS.map((l) => <option key={l.id} value={l.id} className="bg-[#0b0817] text-white">{`🌐 ${l.short} · ${l.label}`}</option>)}
      </select>
    </label>
  );
}
