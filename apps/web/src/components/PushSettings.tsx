"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, CheckCircle2 } from "lucide-react";
import { useT } from "@/lib/i18n";
import { isIOS, isStandalone, pushSupported, subscribe } from "./PushPrompt";

type State = "loading" | "unsupported" | "ios-install" | "default" | "granted" | "denied";

/**
 * Notificaciones en "Mi cuenta": muestra el estado real del permiso y permite activarlas sin depender del aviso
 * automático. Si el navegador las bloqueó, explica cómo permitirlas (la web no puede desbloquearlas sola).
 */
export function PushSettings() {
  const { t } = useT();
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (isIOS() && !isStandalone()) return setState("ios-install");
    if (!pushSupported()) return setState("unsupported");
    setState(Notification.permission as State);
    // Con permiso ya dado, se re-registra este dispositivo (renueva suscripciones vencidas).
    if (Notification.permission === "granted") void subscribe().catch(() => undefined);
  }, []);

  async function enable() {
    setBusy(true);
    setMsg(null);
    try {
      const p = await Notification.requestPermission();
      setState(p as State);
      if (p !== "granted") return;
      const ok = await subscribe();
      setMsg(ok ? { ok: true, text: t("Listo: este dispositivo recibirá tus avisos.") } : { ok: false, text: t("Las notificaciones no están disponibles en este momento.") });
    } catch {
      setMsg({ ok: false, text: t("No se pudo activar. Intenta de nuevo.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="push-title" className="bg-surface border border-gold-900/50 rounded-2xl p-6 flex flex-col gap-3">
      <h2 id="push-title" className="font-serif text-xl uppercase tracking-widest text-gold-300">{t("Notificaciones")}</h2>
      {state === "granted" && <p className="flex items-center gap-2 text-emerald-300"><CheckCircle2 aria-hidden className="h-5 w-5" />{t("Activadas en este dispositivo.")}</p>}
      {state === "default" && (
        <>
          <p className="text-gray-300">{t("Te avisamos de cargas acreditadas, retiros, bonos y torneos al instante.")}</p>
          <button type="button" disabled={busy} onClick={() => void enable()} className="self-start inline-flex items-center gap-2 rounded-xl bg-gold-400 px-5 py-2.5 font-bold text-black disabled:opacity-60">
            <Bell aria-hidden className="h-4 w-4" />{busy ? t("Activando…") : t("Activar notificaciones")}
          </button>
        </>
      )}
      {state === "denied" && (
        <div className="text-gray-300">
          <p className="flex items-center gap-2 text-amber-300"><BellOff aria-hidden className="h-5 w-5" />{t("Están bloqueadas en este navegador.")}</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
            <li>{t("Toca el ícono a la izquierda de la dirección de la página.")}</li>
            <li>{t("Entra a Permisos (o Configuración del sitio) → Notificaciones.")}</li>
            <li>{t("Elige Permitir y recarga la página.")}</li>
          </ol>
        </div>
      )}
      {state === "ios-install" && <p className="text-gray-300">{t("En iPhone: toca Compartir → «Agregar a inicio», abre la app desde el ícono y vuelve aquí para activarlas.")}</p>}
      {state === "unsupported" && <p className="text-gray-400">{t("Este navegador no admite notificaciones.")}</p>}
      {msg && <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-emerald-300 text-sm" : "text-red-300 text-sm"}>{msg.text}</p>}
    </section>
  );
}
