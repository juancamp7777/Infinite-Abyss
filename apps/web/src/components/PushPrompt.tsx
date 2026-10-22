"use client";

import { useEffect, useState } from "react";
import { Bell, Download, Share, SquarePlus, X } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const DISMISS_KEY = "abyss.push.dismissed";

type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

const pushSupported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
/** iPhone/iPad (incluye iPadOS que se presenta como Mac). */
const isIOS = () =>
  typeof navigator !== "undefined" && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
const isStandalone = () =>
  typeof window !== "undefined" && (window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Suscribe este dispositivo y guarda la suscripción del jugador en el CRM (reemplaza la anterior si cambió). */
async function subscribe(): Promise<boolean> {
  const { publicKey } = await api.get<{ publicKey: string | null }>("/marketing/v1/push/public-key", { scope: "none" });
  if (!publicKey) return false;
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;
  await api.post("/marketing/v1/push/subscribe", { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
  return true;
}

/**
 * Notificaciones en Android, escritorio y iPhone:
 * - Android/escritorio: botón Activar (pide permiso con un gesto del jugador) y, si el navegador lo ofrece, Instalar app.
 * - iPhone: Apple solo entrega push a la app instalada en la pantalla de inicio (iOS 16.4+); en Safari se muestran
 *   los pasos para instalarla y, abierta desde el ícono, aparece el botón Activar.
 * Con permiso ya concedido, la suscripción se re-sincroniza en silencio.
 */
export function PushPrompt() {
  const { status } = useAuth();
  const [mode, setMode] = useState<"hidden" | "enable" | "ios-install">("hidden");
  const [installEvt, setInstallEvt] = useState<InstallEvent | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as InstallEvent);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, []);

  useEffect(() => {
    if (status !== "authenticated") return;
    let dismissed = false;
    try {
      dismissed = !!window.localStorage.getItem(DISMISS_KEY);
    } catch {
      /* almacenamiento bloqueado */
    }
    if (isIOS() && !isStandalone()) {
      if (dismissed) return;
      const t = setTimeout(() => setMode("ios-install"), 4000);
      return () => clearTimeout(t);
    }
    if (!pushSupported()) return;
    if (Notification.permission === "granted") {
      void subscribe().catch(() => undefined);
      return;
    }
    if (Notification.permission === "default" && !dismissed) {
      const t = setTimeout(() => setMode("enable"), 4000);
      return () => clearTimeout(t);
    }
  }, [status]);

  const close = () => {
    setMode("hidden");
    try {
      window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* ignorar */
    }
  };

  const enable = async () => {
    setBusy(true);
    try {
      // requestPermission debe ir directo en el gesto (requisito de iOS).
      if ((await Notification.requestPermission()) === "granted") await subscribe();
    } catch {
      /* el navegador lo rechazó */
    } finally {
      setBusy(false);
      close();
    }
  };

  const install = async () => {
    if (!installEvt) return;
    await installEvt.prompt();
    await installEvt.userChoice.catch(() => undefined);
    setInstallEvt(null);
  };

  if (mode === "hidden") return null;
  return (
    <div role="dialog" aria-label="Activar notificaciones" className="fixed inset-x-3 bottom-24 z-50 mx-auto max-w-sm rounded-2xl border border-white/10 bg-[#0b1830]/95 p-4 text-sm text-white shadow-2xl backdrop-blur lg:bottom-6 lg:left-6 lg:right-auto">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#f4b73f]/15 text-[#f4b73f]"><Bell aria-hidden className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          {mode === "ios-install" ? (
            <>
              <p className="font-semibold">Instala la app para recibir avisos</p>
              <ol className="mt-1 space-y-1 text-white/70">
                <li className="flex items-center gap-1.5">1. Toca <Share aria-label="Compartir" className="inline h-4 w-4 text-[#3cc8f0]" /> en Safari.</li>
                <li className="flex items-center gap-1.5">2. Elige <SquarePlus aria-hidden className="inline h-4 w-4 text-[#3cc8f0]" /> «Agregar a inicio».</li>
                <li>3. Abre la app desde el ícono y activa las notificaciones.</li>
              </ol>
              <button type="button" onClick={close} className="mt-3 rounded-lg bg-white/10 px-3 py-1.5 font-semibold">Entendido</button>
            </>
          ) : (
            <>
              <p className="font-semibold">¿Activamos las notificaciones?</p>
              <p className="mt-0.5 text-white/60">Te avisamos de cargas acreditadas, retiros, bonos y torneos al instante.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={() => void enable()} disabled={busy} className="rounded-lg bg-[#f4b73f] px-3 py-1.5 font-bold text-black disabled:opacity-60">Activar</button>
                {installEvt && <button type="button" onClick={() => void install()} className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-3 py-1.5 font-semibold"><Download aria-hidden className="h-4 w-4" /> Instalar app</button>}
                <button type="button" onClick={close} className="rounded-lg px-3 py-1.5 text-white/60 hover:text-white">Ahora no</button>
              </div>
            </>
          )}
        </div>
        <button type="button" onClick={close} aria-label="Cerrar" className="text-white/40 hover:text-white"><X aria-hidden className="h-4 w-4" /></button>
      </div>
    </div>
  );
}
