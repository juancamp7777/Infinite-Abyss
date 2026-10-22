"use client";

import { useState } from "react";
import { ApiError, asList } from "@/lib/api";
import { useApi, useApiClient } from "@/lib/hooks";
import { dateTime } from "@/lib/format";
import { Badge, Button, Card, DataTable, Empty, ErrorBox, Field, inputCls, NeedOperator, PageHeader, Spinner, type Column } from "@/components/ui";

interface Ticket {
  id: string;
  playerId: string;
  subject: string;
  status: "open" | "pending" | "closed";
  priority: string;
  updatedAt: string;
  messages?: Array<{ id: string; authorType: string; authorId: string; text: string; at: string }>;
}

const TONE = { open: "warn", pending: "neutral", closed: "good" } as const;

export default function TicketsPage() {
  const { operatorId } = useApiClient();
  const [status, setStatus] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const list = useApi<{ items: Ticket[] }>(operatorId ? "/crm/v1/admin/tickets" : null, { status });
  if (!operatorId) return <><PageHeader title="Tickets" /><NeedOperator /></>;

  const cols: Column<Ticket>[] = [
    { key: "subject", label: "Asunto" },
    { key: "playerId", label: "Jugador", render: (t) => <span className="font-mono text-xs">{t.playerId.slice(0, 10)}</span> },
    { key: "status", label: "Estado", render: (t) => <Badge tone={TONE[t.status]}>{t.status}</Badge> },
    { key: "priority", label: "Prioridad" },
    { key: "updatedAt", label: "Actualizado", render: (t) => dateTime(t.updatedAt) },
  ];

  return (
    <>
      <PageHeader title="Tickets de soporte" actions={
        <Field label="Estado" htmlFor="st">
          <select id="st" className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos</option><option value="open">Abiertos</option><option value="pending">Pendientes</option><option value="closed">Cerrados</option>
          </select>
        </Field>
      } />
      <div className="grid gap-4 xl:grid-cols-[1fr_28rem]">
        <div>
          {list.loading && !list.data && <Spinner />}
          {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
          {list.data && <DataTable rows={asList<Ticket>(list.data)} columns={cols} rowKey={(t) => t.id} onRowClick={(t) => setSel(t.id)} empty="No hay tickets." />}
        </div>
        {sel ? <TicketDetail id={sel} onChanged={list.reload} /> : <Empty>Selecciona un ticket.</Empty>}
      </div>
    </>
  );
}

function TicketDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { call } = useApiClient();
  const t = useApi<Ticket>(`/crm/v1/admin/tickets/${encodeURIComponent(id)}`);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setErr(null);
    try {
      await fn();
      t.reload();
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Error inesperado");
    }
  }

  return (
    <Card title="Ticket">
      {t.loading && !t.data && <Spinner />}
      {t.error && <ErrorBox message={t.error} onRetry={t.reload} />}
      {err && <ErrorBox message={err} />}
      {t.data && (
        <div className="space-y-3 text-sm">
          <h3 className="font-medium">{t.data.subject}</h3>
          <div className="flex flex-wrap gap-2">
            <select aria-label="Estado del ticket" className={`${inputCls} w-36`} value={t.data.status} onChange={(e) => void act(() => call(`/crm/v1/admin/tickets/${id}`, { method: "PATCH", body: { status: e.target.value } }))}>
              <option value="open">Abierto</option><option value="pending">Pendiente</option><option value="closed">Cerrado</option>
            </select>
            <select aria-label="Prioridad" className={`${inputCls} w-36`} value={t.data.priority} onChange={(e) => void act(() => call(`/crm/v1/admin/tickets/${id}`, { method: "PATCH", body: { priority: e.target.value } }))}>
              <option value="low">Baja</option><option value="normal">Normal</option><option value="high">Alta</option><option value="urgent">Urgente</option>
            </select>
          </div>
          <ul className="max-h-80 space-y-2 overflow-auto">
            {(t.data.messages ?? []).map((m) => (
              <li key={m.id} className={`rounded p-2 ${m.authorType === "agent" ? "bg-violet-500/15" : "bg-black/20"}`}>
                <div className="text-xs text-white/40">{m.authorType} · {dateTime(m.at)}</div>
                <p className="whitespace-pre-wrap">{m.text}</p>
              </li>
            ))}
          </ul>
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); const v = text.trim(); if (!v) return; setText(""); void act(() => call(`/crm/v1/admin/tickets/${id}/messages`, { method: "POST", body: { text: v } })); }}>
            <textarea aria-label="Respuesta" className={`${inputCls} h-20`} value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} />
            <Button type="submit" disabled={!text.trim()}>Responder</Button>
          </form>
        </div>
      )}
    </Card>
  );
}
