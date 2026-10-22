"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, CheckCheck, Globe, Lock, MessageSquareText, RotateCcw, Search, Send, Trash2, UserCheck, UserMinus, Zap } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useApiClient } from "@/lib/hooks";
import { connectSocket } from "@/lib/socket";
import { Badge, Button, Empty, ErrorBox, inputCls, NeedOperator, PageHeader, Spinner, Tabs } from "@/components/ui";

type Status = "open" | "pending" | "closed";
interface Conversation {
  id: string;
  operatorId: string;
  channel: "webchat" | "whatsapp" | "telegram";
  externalId: string;
  playerId?: string;
  contactName: string;
  status: Status;
  assigneeId?: string;
  lastMessageAt: string;
  lastMessagePreview: string;
  unread: number;
}
interface Message {
  id: string;
  conversationId: string;
  direction: "in" | "out" | "note";
  authorType: string;
  authorId?: string;
  body: string;
  createdAt: string;
}
interface QuickReply {
  id: string;
  shortcut: string;
  body: string;
}

type Filter = "open" | "pending" | "closed" | "mine" | "unassigned";
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "open", label: "Abiertas" },
  { id: "pending", label: "Pendientes" },
  { id: "mine", label: "Mías" },
  { id: "unassigned", label: "Sin asignar" },
  { id: "closed", label: "Cerradas" },
];
const STATUS_LABEL: Record<Status, string> = { open: "Abierta", pending: "Pendiente", closed: "Cerrada" };
const STATUS_TONE = { open: "warn", pending: "neutral", closed: "good" } as const;
const CHANNEL_LABEL = { webchat: "Webchat", whatsapp: "WhatsApp", telegram: "Telegram" } as const;

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "ahora";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return new Date(iso).toLocaleDateString("es-CO", { day: "2-digit", month: "short" });
};
const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : "Error inesperado");

function matches(c: Conversation, f: Filter, me: string | null): boolean {
  if (f === "mine") return !!me && c.assigneeId === me && c.status !== "closed";
  if (f === "unassigned") return !c.assigneeId && c.status !== "closed";
  return c.status === f;
}

export default function InboxPage() {
  const { call, operatorId } = useApiClient();
  const [filter, setFilter] = useState<Filter>("open");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Conversation[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [thread, setThread] = useState<{ conversation: Conversation; messages: Message[] } | null>(null);
  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [live, setLive] = useState(false);
  const selRef = useRef<string | null>(null);
  useEffect(() => {
    selRef.current = sel;
  }, [sel]);

  const load = useCallback(async () => {
    if (!operatorId) return;
    setError(null);
    try {
      const query = filter === "mine" ? { assignee: "me" } : filter === "unassigned" ? { assignee: "unassigned" } : { status: filter };
      const r = await call<{ items: Conversation[]; me: string }>("/inbox/v1/admin/conversations", { query: { ...query, q: q.trim() || undefined, limit: 100 } });
      setItems(filter === "mine" || filter === "unassigned" ? r.items.filter((c) => c.status !== "closed") : r.items);
      setMe(r.me);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [call, operatorId, filter, q]);

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const loadReplies = useCallback(() => {
    if (operatorId) call<{ items: QuickReply[] }>("/inbox/v1/admin/quick-replies").then((r) => setReplies(r.items)).catch(() => {});
  }, [call, operatorId]);
  useEffect(loadReplies, [loadReplies]);

  // Hilo seleccionado (y marcar como leído).
  useEffect(() => {
    if (!sel) {
      setThread(null);
      return;
    }
    let cancelled = false;
    call<{ conversation: Conversation; messages: Message[] }>(`/inbox/v1/admin/conversations/${sel}`)
      .then((r) => {
        if (cancelled) return;
        setThread(r);
        if (r.conversation.unread > 0) void call(`/inbox/v1/admin/conversations/${sel}/read`, { method: "POST", body: {} }).catch(() => {});
      })
      .catch((e) => !cancelled && setError(errMsg(e)));
    return () => {
      cancelled = true;
    };
  }, [sel, call]);

  // Tiempo real: conversaciones y mensajes del operador.
  const filterRef = useRef({ filter, me, q });
  useEffect(() => {
    filterRef.current = { filter, me, q };
  }, [filter, me, q]);
  useEffect(() => {
    if (!operatorId) return;
    const s = connectSocket("/inbox", { operatorId });
    s.on("inbox:ready", () => setLive(true));
    s.on("disconnect", () => setLive(false));
    s.on("inbox:conversation", (c: Conversation) => {
      const { filter: f, me: m, q: query } = filterRef.current;
      const visible = matches(c, f, m) && (!query || `${c.contactName} ${c.lastMessagePreview}`.toLowerCase().includes(query.toLowerCase()));
      setItems((prev) => {
        const rest = prev.filter((x) => x.id !== c.id);
        const next = visible ? [{ ...c, unread: selRef.current === c.id ? 0 : c.unread }, ...rest] : rest;
        return next.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
      });
      setThread((t) => (t && t.conversation.id === c.id ? { ...t, conversation: c } : t));
    });
    s.on("inbox:message", (msg: Message) => {
      setThread((t) => (t && t.conversation.id === msg.conversationId && !t.messages.some((x) => x.id === msg.id) ? { ...t, messages: [...t.messages, msg] } : t));
      if (msg.direction === "in" && selRef.current === msg.conversationId) {
        void call(`/inbox/v1/admin/conversations/${msg.conversationId}/read`, { method: "POST", body: {} }).catch(() => {});
      }
    });
    return () => {
      s.close();
    };
  }, [operatorId, call]);

  const patch = async (body: { status?: Status; assigneeId?: string | null }) => {
    if (!thread) return;
    try {
      const c = await call<Conversation>(`/inbox/v1/admin/conversations/${thread.conversation.id}`, { method: "PATCH", body });
      setThread((t) => (t ? { ...t, conversation: c } : t));
    } catch (e) {
      setError(errMsg(e));
    }
  };

  if (!operatorId) return <><PageHeader title="Inbox" /><NeedOperator /></>;
  const totalUnread = items.reduce((n, c) => n + c.unread, 0);

  return (
    <>
      <PageHeader
        title="Inbox omnicanal"
        subtitle="Webchat del casino y de las webs del operador en un solo lugar. Notas internas, asignación y respuestas rápidas."
        actions={<span className={`inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1 text-xs ${live ? "text-emerald-300" : "text-white/50"}`}>
          <span className={`h-2 w-2 rounded-full ${live ? "animate-pulse bg-emerald-400" : "bg-white/30"}`} /> {live ? "En vivo" : "Conectando…"}
        </span>}
      />
      {error && <div className="mb-3"><ErrorBox message={error} onRetry={load} /></div>}

      <div className="grid min-h-[calc(100dvh-12rem)] gap-3 lg:grid-cols-[20rem_minmax(0,1fr)] xl:grid-cols-[21rem_minmax(0,1fr)_17rem]">
        {/* Lista */}
        <section className={`border border-white/10 bg-panel/80 flex min-w-0 flex-col overflow-hidden rounded-xl ${sel ? "hidden lg:flex" : "flex"}`} aria-label="Conversaciones">
          <div className="space-y-2 border-b border-white/5 p-3">
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
              <input className={`${inputCls} w-full pl-9`} placeholder="Buscar contacto o mensaje" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar" />
            </div>
            <div className="overflow-x-auto"><Tabs tabs={FILTERS} value={filter} onChange={(f) => { setFilter(f); setSel(null); }} /></div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading ? <Spinner /> : items.length === 0 ? <div className="p-4"><Empty>No hay conversaciones aquí.</Empty></div> : (
              <ul>
                {items.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => setSel(c.id)}
                      className={`flex w-full items-start gap-3 border-b border-white/5 px-3 py-3 text-left transition-colors hover:bg-white/[.04] ${sel === c.id ? "bg-white/[.06] shadow-[inset_3px_0_0_var(--color-brand)]" : ""}`}>
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[var(--color-brand2)]/30 to-[var(--color-brand)]/20 text-xs font-bold">{initials(c.contactName)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className={`truncate text-sm ${c.unread ? "font-bold" : "font-medium"}`}>{c.contactName}</span>
                          <span className="ml-auto shrink-0 text-[11px] text-white/40">{ago(c.lastMessageAt)}</span>
                        </span>
                        <span className="mt-0.5 flex items-center gap-2">
                          <span className={`truncate text-xs ${c.unread ? "text-white/80" : "text-white/45"}`}>{c.lastMessagePreview || "Sin mensajes"}</span>
                          {c.unread > 0 && <span className="ml-auto grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-[var(--color-brand)] px-1.5 text-[11px] font-bold text-black">{c.unread}</span>}
                        </span>
                        <span className="mt-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-white/35">
                          <Globe aria-hidden className="h-3 w-3" /> {CHANNEL_LABEL[c.channel]}
                          {c.playerId && <span className="rounded bg-[var(--color-brand2)]/15 px-1 text-[var(--color-brand2)]">Jugador</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {totalUnread > 0 && <div className="border-t border-white/5 px-3 py-2 text-xs text-white/50">{totalUnread} mensajes sin leer</div>}
        </section>

        {/* Hilo */}
        <section className={`border border-white/10 bg-panel/80 min-w-0 flex-col overflow-hidden rounded-xl ${sel ? "flex" : "hidden lg:flex"}`} aria-label="Conversación">
          {!sel ? (
            <div className="m-auto max-w-xs p-6 text-center text-sm text-white/45">
              <MessageSquareText aria-hidden className="mx-auto mb-3 h-10 w-10 text-[var(--color-brand)]/60" />
              Elige una conversación para responder. Las respuestas llegan al instante al chat del contacto.
            </div>
          ) : !thread ? <Spinner /> : (
            <Thread thread={thread} me={me} replies={replies} onBack={() => setSel(null)} onPatch={patch}
              onSent={(m) => setThread((t) => (t && !t.messages.some((x) => x.id === m.id) ? { ...t, messages: [...t.messages, m] } : t))}
              send={(body, kind) => call<Message>(`/inbox/v1/admin/conversations/${thread.conversation.id}/messages`, { method: "POST", body: { body, kind } })} />
          )}
        </section>

        {/* Detalles y respuestas rápidas */}
        <aside className="hidden min-w-0 flex-col gap-3 xl:flex">
          {thread && sel && <Details c={thread.conversation} me={me} />}
          <QuickReplies items={replies} reload={loadReplies} call={call} />
        </aside>
      </div>
    </>
  );
}

function Thread({ thread, me, replies, onBack, onPatch, onSent, send }: {
  thread: { conversation: Conversation; messages: Message[] };
  me: string | null;
  replies: QuickReply[];
  onBack(): void;
  onPatch(b: { status?: Status; assigneeId?: string | null }): void;
  onSent(m: Message): void;
  send(body: string, kind: "reply" | "note"): Promise<Message>;
}) {
  const c = thread.conversation;
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"reply" | "note">("reply");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [thread.messages.length]);

  // "/atajo" abre las respuestas rápidas.
  const slash = text.startsWith("/") && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  const suggestions = useMemo(() => (slash === null ? [] : replies.filter((r) => r.shortcut.startsWith(slash)).slice(0, 6)), [slash, replies]);

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setErr(null);
    try {
      onSent(await send(body, kind));
      setText("");
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPick((p) => (p + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        setText(suggestions[Math.min(pick, suggestions.length - 1)].body);
        setPick(0);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <>
      <header className="flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2.5">
        <button type="button" onClick={onBack} className="grid h-8 w-8 place-items-center rounded-lg hover:bg-white/5 lg:hidden" aria-label="Volver a la lista"><ArrowLeft aria-hidden className="h-4 w-4" /></button>
        <div className="min-w-0">
          <div className="truncate font-semibold">{c.contactName}</div>
          <div className="text-xs text-white/45">{CHANNEL_LABEL[c.channel]} · <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge></div>
        </div>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {c.assigneeId === me
            ? <Button variant="ghost" onClick={() => onPatch({ assigneeId: null })}><UserMinus aria-hidden className="h-4 w-4" /> Soltar</Button>
            : <Button variant="ghost" onClick={() => onPatch({ assigneeId: "me" })}><UserCheck aria-hidden className="h-4 w-4" /> Asignarme</Button>}
          {c.status === "closed"
            ? <Button variant="ghost" onClick={() => onPatch({ status: "open" })}><RotateCcw aria-hidden className="h-4 w-4" /> Reabrir</Button>
            : <Button onClick={() => onPatch({ status: "closed" })}><CheckCheck aria-hidden className="h-4 w-4" /> Resolver</Button>}
        </div>
      </header>

      <div ref={bodyRef} className="flex flex-1 flex-col gap-2 overflow-y-auto bg-black/20 p-4" aria-live="polite">
        {thread.messages.length === 0 && <p className="m-auto text-sm text-white/40">Sin mensajes todavía.</p>}
        {thread.messages.map((m) => (
          <div key={m.id} className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-sm ${
            m.direction === "in" ? "self-start rounded-bl-md border border-white/10 bg-white/[.05]"
            : m.direction === "note" ? "self-end rounded-br-md border border-amber-400/30 bg-amber-400/10 text-amber-100"
            : "self-end rounded-br-md bg-gradient-to-br from-[var(--color-brand2)] to-sky-500 text-slate-950"}`}>
            {m.direction === "note" && <div className="mb-0.5 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-amber-300"><Lock aria-hidden className="h-3 w-3" /> Nota interna</div>}
            <div className="whitespace-pre-wrap break-words">{m.body}</div>
            <div className={`mt-0.5 text-[10px] ${m.direction === "out" ? "text-slate-900/60" : "text-white/40"}`}>{hhmm(m.createdAt)}</div>
          </div>
        ))}
      </div>

      <div className={`relative border-t p-3 ${kind === "note" ? "border-amber-400/30 bg-amber-400/[.04]" : "border-white/5"}`}>
        {suggestions.length > 0 && (
          <ul className="border border-white/10 bg-panel/80 absolute bottom-full left-3 right-3 mb-2 overflow-hidden rounded-xl shadow-2xl" role="listbox" aria-label="Respuestas rápidas">
            {suggestions.map((r, i) => (
              <li key={r.id} role="option" aria-selected={i === pick}>
                <button type="button" onMouseDown={(e) => { e.preventDefault(); setText(r.body); }} className={`block w-full px-3 py-2 text-left text-sm ${i === pick ? "bg-white/10" : "hover:bg-white/5"}`}>
                  <span className="font-mono text-[var(--color-brand)]">/{r.shortcut}</span> <span className="text-white/60">{r.body.slice(0, 80)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mb-2 flex gap-1 text-xs">
          <button type="button" onClick={() => setKind("reply")} className={`rounded-md px-2.5 py-1 font-semibold ${kind === "reply" ? "bg-[var(--color-brand2)]/20 text-[var(--color-brand2)]" : "text-white/50 hover:text-white"}`}>Responder</button>
          <button type="button" onClick={() => setKind("note")} className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-semibold ${kind === "note" ? "bg-amber-400/15 text-amber-300" : "text-white/50 hover:text-white"}`}><Lock aria-hidden className="h-3 w-3" /> Nota interna</button>
          <span className="ml-auto self-center text-white/35"><Zap aria-hidden className="mr-1 inline h-3 w-3" />Escribe / para respuestas rápidas</span>
        </div>
        <div className="flex gap-2">
          <textarea className={`${inputCls} max-h-40 min-h-[2.75rem] flex-1 resize-y`} rows={2} maxLength={4000} value={text}
            onChange={(e) => { setText(e.target.value); setPick(0); }} onKeyDown={onKey}
            placeholder={kind === "note" ? "Solo la ve tu equipo…" : "Escribe una respuesta (Enter envía, Shift+Enter salto de línea)"} aria-label="Mensaje" />
          <Button onClick={() => void submit()} disabled={busy || !text.trim()} aria-label="Enviar" className="self-end"><Send aria-hidden className="h-4 w-4" /></Button>
        </div>
        {err && <p className="mt-1 text-xs text-red-300" role="alert">{err}</p>}
      </div>
    </>
  );
}

function Details({ c, me }: { c: Conversation; me: string | null }) {
  const rows: Array<[string, string]> = [
    ["Canal", CHANNEL_LABEL[c.channel]],
    ["Estado", STATUS_LABEL[c.status]],
    ["Asignada a", c.assigneeId ? (c.assigneeId === me ? "Ti" : c.assigneeId.slice(0, 8)) : "Nadie"],
    ["Jugador", c.playerId ? c.playerId.slice(0, 12) : "Visitante anónimo"],
    ["Último mensaje", new Date(c.lastMessageAt).toLocaleString("es-CO")],
  ];
  return (
    <div className="border border-white/10 bg-panel/80 rounded-xl p-4">
      <div className="mb-3 flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-[var(--color-brand)]/30 to-[var(--color-brand2)]/20 font-bold">{initials(c.contactName)}</span>
        <div className="min-w-0"><div className="truncate font-semibold">{c.contactName}</div><div className="text-xs text-white/45">Contacto</div></div>
      </div>
      <dl className="space-y-2 text-sm">
        {rows.map(([k, v]) => <div key={k} className="flex justify-between gap-3"><dt className="text-white/45">{k}</dt><dd className="truncate text-right">{v}</dd></div>)}
      </dl>
    </div>
  );
}

function QuickReplies({ items, reload, call }: { items: QuickReply[]; reload(): void; call: ReturnType<typeof useApiClient>["call"] }) {
  const [shortcut, setShortcut] = useState("");
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    setErr(null);
    try {
      await call("/inbox/v1/admin/quick-replies", { method: "POST", body: { shortcut, body } });
      setShortcut("");
      setBody("");
      reload();
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  const del = async (id: string) => {
    try {
      await call(`/inbox/v1/admin/quick-replies/${id}`, { method: "DELETE" });
      reload();
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  return (
    <div className="border border-white/10 bg-panel/80 flex min-h-0 flex-1 flex-col rounded-xl p-4">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Zap aria-hidden className="h-4 w-4 text-[var(--color-brand)]" /> Respuestas rápidas</h2>
      <ul className="mb-3 flex-1 space-y-1.5 overflow-y-auto text-sm">
        {items.length === 0 && <li className="text-xs text-white/40">Crea atajos para responder en un segundo.</li>}
        {items.map((r) => (
          <li key={r.id} className="group flex items-start gap-2 rounded-lg bg-white/[.03] px-2.5 py-1.5">
            <div className="min-w-0 flex-1"><span className="font-mono text-xs text-[var(--color-brand)]">/{r.shortcut}</span><p className="line-clamp-2 text-xs text-white/60">{r.body}</p></div>
            <button type="button" onClick={() => void del(r.id)} className="text-white/30 hover:text-red-300" aria-label={`Borrar /${r.shortcut}`}><Trash2 aria-hidden className="h-3.5 w-3.5" /></button>
          </li>
        ))}
      </ul>
      <div className="space-y-2">
        <input className={`${inputCls} w-full`} placeholder="atajo (p. ej. retiro)" value={shortcut} onChange={(e) => setShortcut(e.target.value)} aria-label="Atajo" />
        <textarea className={`${inputCls} w-full`} rows={2} placeholder="Texto de la respuesta" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Texto" />
        <Button className="w-full" onClick={() => void add()} disabled={!shortcut.trim() || !body.trim()}>Guardar atajo</Button>
        {err && <p className="text-xs text-red-300" role="alert">{err}</p>}
      </div>
    </div>
  );
}
