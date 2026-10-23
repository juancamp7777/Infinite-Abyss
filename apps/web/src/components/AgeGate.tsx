"use client";

import { useT } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

const KEY = "abyss.age.confirmed";
/** Páginas que se ven sin el aviso: el chat embebido en webs de terceros y las páginas legales. */
const EXEMPT = ["/webchat", "/terms", "/privacy", "/responsible-gaming"];

/**
 * Aviso de mayoría de edad (+18) en la primera visita. "Soy mayor" lo recuerda en este navegador;
 * "Soy menor" bloquea el sitio y muestra ayuda de juego responsable.
 */
export function AgeGate() {
  const { t } = useT();
  const pathname = usePathname();
  const [state, setState] = useState<"unknown" | "ask" | "ok" | "minor">("unknown");

  useEffect(() => {
    let ok = false;
    try {
      ok = window.localStorage.getItem(KEY) === "yes";
    } catch {
      /* sin almacenamiento: se pregunta en cada visita */
    }
    setState(ok ? "ok" : "ask");
  }, []);

  if (EXEMPT.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;
  if (state === "unknown" || state === "ok") return null;

  const confirm = () => {
    try {
      window.localStorage.setItem(KEY, "yes");
    } catch {
      /* ignorar */
    }
    setState("ok");
  };

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-[#050d1c]/95 p-4 backdrop-blur" role="dialog" aria-modal="true" aria-labelledby="age-title">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0b1830] p-6 text-center text-white shadow-2xl">
        <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-full border-2 border-[#f4b73f] text-lg font-black text-[#f4b73f]">+18</div>
        {state === "ask" ? (
          <>
            <h2 id="age-title" className="text-lg font-bold">{t("Solo para mayores de 18 años")}</h2>
            <p className="mt-2 text-sm text-white/60">{t("Este sitio ofrece juegos de azar con dinero real. Para continuar confirma que tienes 18 años o más y que el juego online es legal donde estás.")}</p>
            <div className="mt-5 grid gap-2">
              <button type="button" onClick={confirm} className="rounded-xl bg-[#f4b73f] py-3 font-bold text-black">{t("Soy mayor de 18 años")}</button>
              <button type="button" onClick={() => setState("minor")} className="rounded-xl border border-white/15 py-3 text-white/70 hover:text-white">{t("Soy menor de edad")}</button>
            </div>
            <p className="mt-4 text-xs text-white/40">{t("Juega con responsabilidad. El juego puede generar adicción.")}</p>
          </>
        ) : (
          <>
            <h2 id="age-title" className="text-lg font-bold">{t("No puedes acceder")}</h2>
            <p className="mt-2 text-sm text-white/60">{t("Este sitio es exclusivo para mayores de edad. Si tú o alguien cercano necesita ayuda con el juego, busca apoyo profesional en tu país.")}</p>
          </>
        )}
      </div>
    </div>
  );
}
