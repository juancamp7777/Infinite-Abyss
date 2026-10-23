"use client";

import { useState } from "react";
import { ApiError } from "@/lib/api";
import { dateTime, money, toMinorUnits } from "@/lib/format";
import { useApi, useApiClient } from "@/lib/hooks";
import { Badge, Button, Card, DataTable, ErrorBox, Field, inputCls, NeedOperator, Notice, PageHeader, Stat, type Column } from "@/components/ui";

interface Game {
  id: string;
  mode: "QUICK" | "FRIENDS";
  title: string;
  currency: string;
  entry: string;
  pot: string;
  rake: string | null;
  players: number;
  maxPlayers: number;
  status: "OPEN" | "RUNNING" | "SETTLING" | "SETTLED" | "CANCELLED";
  roomCode: string | null;
  entriesCloseAt: string;
  endsAt: string;
  cancelReason: string | null;
}

const STATUS: Record<Game["status"], { label: string; tone: "good" | "warn" | "bad" | "neutral" }> = {
  OPEN: { label: "Inscripciones", tone: "warn" },
  RUNNING: { label: "En juego", tone: "good" },
  SETTLING: { label: "Cerrando", tone: "warn" },
  SETTLED: { label: "Pagado", tone: "neutral" },
  CANCELLED: { label: "Cancelado", tone: "bad" },
};
const REASON: Record<string, string> = { INSUFFICIENT_PLAYERS: "faltaron jugadores", OPS_CANCEL: "cancelado por el casino" };

/** Leviathan: concursos de fichas sobre deportes. El casino crea los rápidos; los jugadores crean salas de amigos. */
export default function LeviathanAdmin() {
  const { operatorId, call } = useApiClient();
  const games = useApi<{ items: Game[] }>(operatorId ? "/leviathan/v1/admin/games" : null);
  const auto = useApi<{ autoEnabled: boolean; autoEntry: string; autoDurationMin: number; autoLeadMin: number }>(operatorId ? "/leviathan/v1/admin/settings" : null);
  const [af, setAf] = useState<{ autoEnabled?: boolean; entry?: string; durationMin?: string; leadMin?: string }>({});
  const [f, setF] = useState({ title: "Rápido", entry: "10.000", startsInMin: "15", durationMin: "120", maxPlayers: "100" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!operatorId) return <><PageHeader title="Leviathan · Concursos" /><NeedOperator /></>;
  const items = games.data?.items ?? [];
  const currency = items[0]?.currency ?? "COP";
  const settled = items.filter((g) => g.status === "SETTLED");
  const rake = settled.reduce((a, g) => a + BigInt(g.rake ?? "0"), BigInt(0));

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      games.reload();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : "No se pudo completar" });
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<Game>[] = [
    { key: "title", label: "Concurso", render: (g) => <span>{g.title}{g.roomCode && <span className="ml-1 font-mono text-xs text-white/50">· sala {g.roomCode}</span>}</span> },
    { key: "status", label: "Estado", render: (g) => <span><Badge tone={STATUS[g.status].tone}>{STATUS[g.status].label}</Badge>{g.cancelReason && <span className="block text-xs text-white/45">{REASON[g.cancelReason] ?? g.cancelReason}</span>}</span> },
    { key: "entry", label: "Entrada", render: (g) => money(g.entry, g.currency) },
    { key: "players", label: "Jugadores", render: (g) => `${g.players}/${g.maxPlayers}` },
    { key: "pot", label: "Pozo", render: (g) => money(g.pot, g.currency) },
    { key: "rake", label: "Comisión", render: (g) => (g.rake ? money(g.rake, g.currency) : "—") },
    { key: "when", label: "Horario", render: (g) => <span className="text-xs">{dateTime(g.entriesCloseAt)} → {dateTime(g.endsAt)}</span> },
    { key: "push", label: "", render: (g) => (g.status === "OPEN" && g.mode === "QUICK" ? <Button variant="ghost" disabled={busy} onClick={() => { if (confirm("¿Enviar una notificación push a todos los jugadores para que se inscriban?")) void act(() => call("/marketing/v1/admin/push/broadcast", { method: "POST", body: { title: `⚔️ ${g.title}: ¡inscríbete!`.slice(0, 80), body: `Entrada ${money(g.entry, g.currency)} · apuesta tus fichas en partidos reales y llévate el pozo. Cierra a las ${new Date(g.entriesCloseAt).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}.`.slice(0, 300), push: { image: "/brand/push/torneo.png", url: `/lobby/leviathan/${g.id}`, actions: [{ title: "⚔️ Inscribirme", url: `/lobby/leviathan/${g.id}` }] } } }), "Aviso enviado a los jugadores con notificaciones activas"); }}>Avisar por push</Button> : null) },
    { key: "act", label: "", render: (g) => (["OPEN", "RUNNING"].includes(g.status) ? <Button variant="danger" disabled={busy} onClick={() => { if (confirm("¿Cancelar y devolver la entrada a todos?")) void act(() => call(`/leviathan/v1/admin/games/${g.id}/cancel`, { method: "POST" }), "Concurso cancelado: entradas devueltas"); }}>Cancelar</Button> : null) },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Leviathan · Concursos" subtitle="Concursos de fichas sobre partidos. Pozo cerrado: los jugadores compiten entre sí y el casino retiene el 5 % sin riesgo." />
      {games.error && <ErrorBox message={games.error} onRetry={games.reload} />}
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Abiertos y en juego" value={String(items.filter((g) => g.status === "OPEN" || g.status === "RUNNING").length)} accent="cyan" />
        <Stat label="Pagados" value={String(settled.length)} accent="gold" />
        <Stat label="Comisión ganada" value={money(rake.toString(), currency)} accent="green" />
      </div>

      <Card title="Concursos automáticos">
        {auto.data && (() => {
          const a = auto.data;
          const enabled = af.autoEnabled ?? a.autoEnabled;
          const entryText = af.entry ?? (BigInt(a.autoEntry) > BigInt(0) ? (BigInt(a.autoEntry) / BigInt(100)).toLocaleString("es-CO") : "");
          return (
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input type="checkbox" checked={enabled} onChange={(e) => setAf({ ...af, autoEnabled: e.target.checked })} />
                Mantener siempre un concurso abierto con los próximos partidos
              </label>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={`Entrada (${currency})`} htmlFor="au-e"><input id="au-e" inputMode="decimal" className={inputCls} placeholder="5.000" value={entryText} onChange={(e) => setAf({ ...af, entry: e.target.value })} /></Field>
                <Field label="Dura (min)" htmlFor="au-d"><input id="au-d" inputMode="numeric" className={inputCls} value={af.durationMin ?? String(a.autoDurationMin)} onChange={(e) => setAf({ ...af, durationMin: e.target.value.replace(/\D/g, "") })} /></Field>
                <Field label="Inscripciones abiertas (min)" htmlFor="au-l"><input id="au-l" inputMode="numeric" className={inputCls} value={af.leadMin ?? String(a.autoLeadMin)} onChange={(e) => setAf({ ...af, leadMin: e.target.value.replace(/\D/g, "") })} /></Field>
              </div>
              <p className="text-xs text-white/45">Cuando no haya un concurso abierto, la plataforma crea uno solo (por ejemplo «⚔️ Gran Leviathan de la noche») con los partidos que vienen. Con fútbol real, usa 360 minutos o más.</p>
              <Button disabled={busy} onClick={() => {
                const entry = entryText.trim() ? toMinorUnits(entryText, currency) : "0";
                if (entry === null) return setMsg({ ok: false, text: "Revisa el monto de la entrada automática" });
                void act(async () => {
                  await call("/leviathan/v1/admin/settings", { method: "PUT", body: { autoEnabled: enabled, autoEntry: entry, autoDurationMin: Number(af.durationMin ?? a.autoDurationMin), autoLeadMin: Number(af.leadMin ?? a.autoLeadMin) } });
                  setAf({});
                  auto.reload();
                }, enabled ? "Concursos automáticos activados" : "Concursos automáticos apagados");
              }}>Guardar</Button>
            </div>
          );
        })()}
      </Card>

      <Card title="Crear concurso rápido">
        <div className="grid gap-3 sm:grid-cols-5">
          <Field label="Nombre" htmlFor="lv-t"><input id="lv-t" className={inputCls} maxLength={80} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label={`Entrada (${currency})`} htmlFor="lv-e"><input id="lv-e" inputMode="decimal" className={inputCls} value={f.entry} onChange={(e) => setF({ ...f, entry: e.target.value })} /></Field>
          <Field label="Empieza en (min)" htmlFor="lv-s"><input id="lv-s" inputMode="numeric" className={inputCls} value={f.startsInMin} onChange={(e) => setF({ ...f, startsInMin: e.target.value.replace(/\D/g, "") })} /></Field>
          <Field label="Dura (min)" htmlFor="lv-d"><input id="lv-d" inputMode="numeric" className={inputCls} value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: e.target.value.replace(/\D/g, "") })} /></Field>
          <Field label="Máx. jugadores" htmlFor="lv-m"><input id="lv-m" inputMode="numeric" className={inputCls} value={f.maxPlayers} onChange={(e) => setF({ ...f, maxPlayers: e.target.value.replace(/\D/g, "") })} /></Field>
        </div>
        <p className="mt-2 text-xs text-white/45">Cada jugador recibe 1.000 fichas. Para cobrar premio debe hacer entre 3 y 15 apuestas. Premios 60 % / 25 % / 15 % del pozo menos la comisión. Si no llegan 2 jugadores, se cancela y se devuelve todo. Con API-Football conectada (Integraciones → Datos deportivos) se usan partidos reales: crea concursos de 3 horas o más, porque cada partido dura unas 2 horas.</p>
        <div className="mt-3">
          <Button disabled={busy} onClick={() => {
            const entry = f.entry.trim() ? toMinorUnits(f.entry, currency) : "0";
            if (entry === null) return setMsg({ ok: false, text: "Revisa el monto de la entrada" });
            void act(() => call("/leviathan/v1/admin/games", { method: "POST", body: { title: f.title, entry, startsInMin: Number(f.startsInMin || 15), durationMin: Number(f.durationMin || 120), maxPlayers: Number(f.maxPlayers || 100) } }), "Concurso creado: ya aparece en el casino");
          }}>Crear concurso</Button>
        </div>
      </Card>
      {msg && <div role={msg.ok ? "status" : "alert"}><Notice tone={msg.ok ? "ok" : "warn"}>{msg.text}</Notice></div>}
      <Card title="Concursos">
        <DataTable columns={columns} rows={items} rowKey={(g) => g.id} empty="Aún no hay concursos. Crea el primero arriba." />
      </Card>
    </div>
  );
}
