"use client";

import { useState } from "react";
import { ApiError } from "@/lib/api";
import { useApi, useApiClient, useSession } from "@/lib/hooks";
import { dateTime, int, money, toMinor } from "@/lib/format";
import { Badge, Button, Card, DataTable, Empty, ErrorBox, Field, inputCls, NeedOperator, PageHeader, Spinner, Tabs, type Column } from "@/components/ui";

interface PlayerRow {
  playerId: string;
  email?: string;
  country?: string;
  currency?: string;
  ltv?: string;
  ggr?: string;
  depositsTotal?: string;
  lastLoginAt?: string | null;
  churnRisk?: string;
  vipScore?: number;
  tags?: string[];
}
interface Profile extends PlayerRow {
  registeredAt?: string;
  depositsCount?: number;
  withdrawalsTotal?: string;
  totalWagered?: string;
  totalWon?: string;
  betCount?: number;
  sessionCount?: number;
  daysSinceLastActivity?: number | null;
  favoriteGames?: Array<{ id: string }>;
  rfm?: { r: number; f: number; m: number };
  compliance?: Record<string, unknown>;
}
interface Detail {
  profile: Profile;
  timeline: Array<{ id: string; type: string; title: string; at: string }>;
  notes: Array<{ id: string; authorId: string; text: string; createdAt: string }>;
  tickets: Array<{ id: string; subject: string; status: string; priority: string; updatedAt: string }>;
}

/** Roles que pueden mover saldo a mano (lo mismo que exige el API). */
const CAN_ADJUST = new Set(["PLATFORM_ADMIN", "OPERATOR_ADMIN", "OPERATOR_FINANCE"]);

/** Cargar o descontar saldo a mano: queda en el ledger con motivo y autor, y no se duplica si se reintenta. */
function AdjustBalance({ playerId, currency, onDone }: { playerId: string; currency?: string; onDone(): void }) {
  const { call } = useApiClient();
  const [dir, setDir] = useState<"credit" | "debit">("credit");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const minor = toMinor(amount);

  async function submit() {
    if (!minor || !reason.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      await call(`/api/backoffice/players/${encodeURIComponent(playerId)}/adjustments`, {
        method: "POST",
        body: { amount: dir === "debit" ? `-${minor}` : minor, reason: reason.trim(), currency },
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      setMsg({ ok: true, text: `${dir === "credit" ? "Cargado" : "Descontado"}: ${money(minor, currency)}` });
      setAmount("");
      setReason("");
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : "Error inesperado" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-2 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="text-sm font-semibold">Ajustar saldo a mano</div>
      <div className="flex gap-2">
        <Button type="button" variant={dir === "credit" ? "primary" : "ghost"} onClick={() => setDir("credit")}>Cargar</Button>
        <Button type="button" variant={dir === "debit" ? "primary" : "ghost"} onClick={() => setDir("debit")}>Descontar</Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label={`Monto${currency ? ` (${currency})` : ""}`} htmlFor="adj-amount"><input id="adj-amount" inputMode="decimal" className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="50.000" /></Field>
        <Field label="Motivo (queda registrado)" htmlFor="adj-reason"><input id="adj-reason" className={inputCls} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Recarga por Nequi, cortesía…" /></Field>
      </div>
      {amount && !minor && <p className="text-xs text-red-300">Monto inválido. Escribe por ejemplo 50.000 o 50.000,50</p>}
      <Button type="submit" disabled={busy || !minor || !reason.trim()}>{busy ? "Guardando…" : `${dir === "credit" ? "Cargar" : "Descontar"} ${minor ? money(minor, currency) : ""}`}</Button>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-emerald-300" : "text-red-300"}`}>{msg.text}</p>}
    </form>
  );
}

const RISK_TONE ={ low: "good", medium: "warn", high: "bad" } as const;

export default function PlayersPage() {
  const { operatorId } = useApiClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [country, setCountry] = useState("");
  const [churnRisk, setChurnRisk] = useState("");
  const [tag, setTag] = useState("");
  const [sort, setSort] = useState("ltv");
  const [offset, setOffset] = useState(0);
  const limit = 25;
  const list = useApi<{ items: PlayerRow[]; total: number }>(operatorId ? "/crm/v1/admin/players" : null, { q, country, churnRisk, tag, sort, order: "desc", limit, offset });

  if (!operatorId) return <><PageHeader title="Jugadores" /><NeedOperator /></>;

  const cols: Column<PlayerRow>[] = [
    { key: "playerId", label: "Jugador", render: (r) => (r.email ? <span className="text-xs">{r.email}</span> : <span className="font-mono text-xs">{r.playerId.slice(0, 12)}</span>) },
    { key: "country", label: "País" },
    { key: "ltv", label: "LTV", render: (r) => money(r.ltv, r.currency) },
    { key: "ggr", label: "GGR", render: (r) => money(r.ggr, r.currency) },
    { key: "lastLoginAt", label: "Últ. login", render: (r) => dateTime(r.lastLoginAt) },
    { key: "churnRisk", label: "Abandono", render: (r) => (r.churnRisk ? <Badge tone={RISK_TONE[r.churnRisk as keyof typeof RISK_TONE] ?? "neutral"}>{r.churnRisk}</Badge> : "—") },
    { key: "tags", label: "Etiquetas", render: (r) => (r.tags ?? []).join(", ") || "—" },
  ];

  return (
    <>
      <PageHeader title="Jugadores" subtitle="Perfil 360 desde el CRM" />
      <form className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5" onSubmit={(e) => { e.preventDefault(); setOffset(0); }}>
        <Field label="Buscar" htmlFor="q"><input id="q" className={inputCls} value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} placeholder="id, email…" /></Field>
        <Field label="País" htmlFor="c"><input id="c" className={inputCls} value={country} maxLength={2} onChange={(e) => { setCountry(e.target.value.toUpperCase()); setOffset(0); }} placeholder="CO" /></Field>
        <Field label="Riesgo de abandono" htmlFor="r">
          <select id="r" className={inputCls} value={churnRisk} onChange={(e) => { setChurnRisk(e.target.value); setOffset(0); }}>
            <option value="">Todos</option><option value="low">Bajo</option><option value="medium">Medio</option><option value="high">Alto</option>
          </select>
        </Field>
        <Field label="Etiqueta" htmlFor="t"><input id="t" className={inputCls} value={tag} onChange={(e) => { setTag(e.target.value); setOffset(0); }} /></Field>
        <Field label="Ordenar por" htmlFor="s">
          <select id="s" className={inputCls} value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="ltv">LTV</option><option value="ggr">GGR</option><option value="lastLoginAt">Último login</option><option value="registeredAt">Registro</option>
          </select>
        </Field>
      </form>
      <div className="grid gap-4 xl:grid-cols-[1fr_28rem] [&>*]:min-w-0">
        <div>
          {list.loading && !list.data && <Spinner />}
          {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
          {list.data && (
            <>
              <DataTable rows={list.data.items} columns={cols} pageSize={limit} rowKey={(r) => r.playerId} onRowClick={(r) => setSelected(r.playerId)} empty="Ningún jugador coincide con los filtros." />
              <div className="mt-3 flex items-center justify-between text-xs text-white/60">
                <span>{int(list.data.total)} jugadores</span>
                <div className="flex gap-2">
                  <Button variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>← Anterior</Button>
                  <Button variant="ghost" disabled={offset + limit >= list.data.total} onClick={() => setOffset(offset + limit)}>Siguiente →</Button>
                </div>
              </div>
            </>
          )}
        </div>
        {selected ? <PlayerDetail playerId={selected} onClose={() => setSelected(null)} /> : <Empty>Selecciona un jugador para ver su perfil 360.</Empty>}
      </div>
    </>
  );
}

/** Envío directo desde el CRM con una plantilla (push, email, SMS, WhatsApp o bandeja in-app). */
function SendMessage({ playerId }: { playerId: string }) {
  const { call } = useApiClient();
  const templates = useApi<{ items: Array<{ id: string; name: string; channel: string }> }>("/marketing/v1/admin/templates");
  const stats = useApi<{ enabled: boolean; devices: number }>("/marketing/v1/admin/push/stats");
  const [tpl, setTpl] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const send = async () => {
    setMsg(null);
    try {
      const r = await call<{ status: string; error?: string; reason?: string }>("/marketing/v1/admin/send", { method: "POST", body: { playerId, templateId: tpl } });
      setMsg(r.status === "sent" || r.status === "delivered" ? "Enviado ✓" : `Estado: ${r.status}${r.reason ? ` · ${r.reason}` : ""}${r.error ? ` · ${r.error}` : ""}`);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Error inesperado");
    }
  };
  return (
    <div className="space-y-2 rounded-lg border border-white/10 p-3">
      <div className="flex items-center justify-between text-xs text-white/50">
        <span className="font-semibold text-white/70">Enviar mensaje</span>
        {stats.data && <span>{stats.data.enabled ? `Push activo · ${stats.data.devices} dispositivos en el operador` : "Push sin claves VAPID"}</span>}
      </div>
      <div className="flex gap-2">
        <select className={`${inputCls} min-w-0 flex-1`} value={tpl} onChange={(e) => setTpl(e.target.value)} aria-label="Plantilla">
          <option value="">Elige una plantilla…</option>
          {(templates.data?.items ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} · {t.channel}</option>)}
        </select>
        <Button disabled={!tpl} onClick={() => void send()}>Enviar</Button>
      </div>
      {msg && <p className="text-xs text-white/60">{msg}</p>}
    </div>
  );
}

function PlayerDetail({ playerId, onClose }: { playerId: string; onClose: () => void }) {
  const { call } = useApiClient();
  const session = useSession();
  const d = useApi<Detail>(`/crm/v1/admin/players/${encodeURIComponent(playerId)}`);
  const [tab, setTab] = useState<"resumen" | "timeline" | "notas" | "tickets">("resumen");
  const [note, setNote] = useState("");
  const [newTag, setNewTag] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const base = `/crm/v1/admin/players/${encodeURIComponent(playerId)}`;

  async function act(fn: () => Promise<unknown>) {
    setErr(null);
    try {
      await fn();
      d.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Error inesperado");
    }
  }

  return (
    <Card title="Perfil 360" actions={<Button variant="ghost" onClick={onClose} aria-label="Cerrar perfil">✕</Button>}>
      {d.loading && !d.data && <Spinner />}
      {d.error && <ErrorBox message={d.error} onRetry={d.reload} />}
      {err && <ErrorBox message={err} />}
      {d.data && (
        <>
          <div className="mb-2 break-all text-xs text-white/60">{d.data.profile.email && <span className="mr-2 text-sm text-white">{d.data.profile.email}</span>}<span className="font-mono">{playerId}</span></div>
          <Tabs tabs={[{ id: "resumen", label: "Resumen" }, { id: "timeline", label: "Timeline" }, { id: "notas", label: "Notas" }, { id: "tickets", label: `Tickets (${d.data.tickets.length})` }]} value={tab} onChange={setTab} />
          {tab === "resumen" && (
            <div className="space-y-3 text-sm">
              {session && CAN_ADJUST.has(session.role) && <AdjustBalance playerId={playerId} currency={d.data.profile.currency} onDone={d.reload} />}
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 p-3">
                <span className="mr-auto text-sm"><b>Identidad (KYC)</b><span className="block text-xs text-white/50">Necesaria para retirar y para recibir publicidad.</span></span>
                <Button variant="ghost" onClick={() => void act(() => call(`/api/backoffice/players/${encodeURIComponent(playerId)}/kyc`, { method: "PUT", body: { status: "VERIFIED", reason: "Verificado desde Jugadores" } }))}>Verificar identidad</Button>
                <Button variant="danger" onClick={() => void act(() => call(`/api/backoffice/players/${encodeURIComponent(playerId)}/kyc`, { method: "PUT", body: { status: "REJECTED", reason: "Rechazado desde Jugadores" } }))}>Rechazar</Button>
              </div>
              <SendMessage playerId={playerId} />
              <dl className="grid grid-cols-2 gap-2">
                {([
                  ["LTV", money(d.data.profile.ltv, d.data.profile.currency)], ["GGR", money(d.data.profile.ggr, d.data.profile.currency)], ["Depósitos", money(d.data.profile.depositsTotal, d.data.profile.currency)], ["Retiros", money(d.data.profile.withdrawalsTotal, d.data.profile.currency)],
                  ["Apostado", money(d.data.profile.totalWagered, d.data.profile.currency)], ["Ganado", money(d.data.profile.totalWon, d.data.profile.currency)], ["Apuestas", int(d.data.profile.betCount)], ["Sesiones", int(d.data.profile.sessionCount)],
                  ["VIP score", String(d.data.profile.vipScore ?? "—")], ["RFM", d.data.profile.rfm ? `${d.data.profile.rfm.r}-${d.data.profile.rfm.f}-${d.data.profile.rfm.m}` : "—"],
                  ["Registro", dateTime(d.data.profile.registeredAt)], ["Últ. login", dateTime(d.data.profile.lastLoginAt)],
                ] as const).map(([k, v]) => (
                  <div key={k} className="rounded bg-black/20 p-2"><dt className="text-xs text-white/50">{k}</dt><dd>{v}</dd></div>
                ))}
              </dl>
              <div>
                <div className="mb-1 text-xs text-white/50">Etiquetas</div>
                <div className="flex flex-wrap gap-2">
                  {(d.data.profile.tags ?? []).map((t) => (
                    <span key={t} className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-xs">
                      {t}
                      <button type="button" aria-label={`Quitar etiqueta ${t}`} className="text-white/60 hover:text-white" onClick={() => act(() => call(`${base}/tags/${encodeURIComponent(t)}`, { method: "DELETE" }))}>×</button>
                    </span>
                  ))}
                  {(d.data.profile.tags ?? []).length === 0 && <span className="text-xs text-white/40">Sin etiquetas</span>}
                </div>
                <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!newTag.trim()) return; const t = newTag.trim(); setNewTag(""); void act(() => call(`${base}/tags`, { method: "POST", body: { tag: t } })); }}>
                  <input aria-label="Nueva etiqueta" className={inputCls} value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="vip, riesgo…" />
                  <Button type="submit" variant="ghost">Añadir</Button>
                </form>
              </div>
              {d.data.profile.compliance && <pre className="max-h-32 overflow-auto rounded bg-black/30 p-2 text-xs text-white/60">{JSON.stringify(d.data.profile.compliance, null, 2)}</pre>}
            </div>
          )}
          {tab === "timeline" && (d.data.timeline.length === 0 ? <Empty>Sin interacciones.</Empty> : (
            <ol className="max-h-96 space-y-2 overflow-auto border-l border-white/10 pl-3 text-sm">
              {d.data.timeline.map((t) => (
                <li key={t.id}><div className="text-xs text-white/40">{dateTime(t.at)} · {t.type}</div><div>{t.title}</div></li>
              ))}
            </ol>
          ))}
          {tab === "notas" && (
            <div className="space-y-3">
              <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (!note.trim()) return; const text = note.trim(); setNote(""); void act(() => call(`${base}/notes`, { method: "POST", body: { text } })); }}>
                <textarea aria-label="Nueva nota" className={`${inputCls} h-20`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={5000} />
                <Button type="submit" disabled={!note.trim()}>Guardar nota</Button>
              </form>
              {d.data.notes.length === 0 ? <Empty>Sin notas.</Empty> : d.data.notes.map((n) => (
                <div key={n.id} className="rounded bg-black/20 p-2 text-sm"><div className="text-xs text-white/40">{n.authorId} · {dateTime(n.createdAt)}</div><p className="whitespace-pre-wrap">{n.text}</p></div>
              ))}
            </div>
          )}
          {tab === "tickets" && (d.data.tickets.length === 0 ? <Empty>Sin tickets.</Empty> : (
            <ul className="space-y-2 text-sm">{d.data.tickets.map((t) => <li key={t.id} className="rounded bg-black/20 p-2"><div>{t.subject}</div><div className="mt-1 flex gap-2 text-xs text-white/50"><Badge>{t.status}</Badge><Badge>{t.priority}</Badge>{dateTime(t.updatedAt)}</div></li>)}</ul>
          ))}
        </>
      )}
    </Card>
  );
}

