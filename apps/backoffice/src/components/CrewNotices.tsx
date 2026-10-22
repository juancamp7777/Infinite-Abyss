"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { request } from "@/lib/api";
import { useOperator } from "@/lib/hooks";

interface Ann { id: string; title: string; body: string; severity: string; mandatory: boolean; read: boolean }

/**
 * Avisos obligatorios del equipo: bloquean la pantalla hasta que la persona confirma que los leyó.
 * Si el usuario no está en el equipo (404), no muestra nada.
 */
export function CrewNotices() {
  const { operatorId } = useOperator();
  const pathname = usePathname();
  const [pending, setPending] = useState<Ann[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!operatorId) return;
    let cancelled = false;
    const load = () => request<{ items: Ann[] }>("/crew/v1/me/announcements", { query: { operatorId } })
      .then((r) => !cancelled && setPending(r.items.filter((a) => a.mandatory && !a.read)))
      .catch(() => undefined);
    void load();
    const t = setInterval(load, 120_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [operatorId, pathname]);

  const current = pending[0];
  if (!current) return null;
  const ack = async () => {
    setBusy(true);
    try {
      await request(`/crew/v1/me/announcements/${current.id}/ack`, { method: "POST", body: {}, query: { operatorId: operatorId ?? undefined } });
      setPending((p) => p.slice(1));
    } finally {
      setBusy(false);
    }
  };
  const color = current.severity === "critical" ? "border-red-500/60" : current.severity === "warning" ? "border-amber-400/60" : "border-[var(--color-brand2)]/60";
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-labelledby="crew-notice-title">
      <div className={`w-full max-w-lg rounded-2xl border-2 ${color} bg-[#0b1a30] p-6 shadow-2xl`}>
        <p className="text-xs font-bold uppercase tracking-wider text-white/50">Aviso del equipo · confirmación obligatoria</p>
        <h2 id="crew-notice-title" className="mt-1 text-xl font-bold">{current.title}</h2>
        <p className="mt-3 max-h-[50vh] overflow-y-auto whitespace-pre-wrap text-sm text-white/80">{current.body}</p>
        <button type="button" onClick={() => void ack()} disabled={busy} className="mt-5 w-full rounded-xl bg-[var(--color-brand)] py-3 font-bold text-black disabled:opacity-60">Leí y entendí</button>
      </div>
    </div>
  );
}
