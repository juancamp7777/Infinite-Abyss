"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { api, ApiError, socketTarget, tokens } from "./api";
import { moduleOperatorId } from "./modules";
import { useTheme } from "./theme";

/** Mensaje tal como lo ve el contacto (las notas internas nunca llegan). */
export type ChatMessage = {
  id: string;
  direction: "in" | "out";
  authorType: "contact" | "agent" | "bot" | "system";
  body: string;
  clientMsgId?: string;
  createdAt: string;
  /** Solo en cliente: enviando o fallido. */
  state?: "sending" | "failed";
};

type ConversationResponse = { conversation: { id: string; status: string } | null; messages: ChatMessage[] };

const BASE = "/inbox/v1/webchat";
const visitorKey = (op: string) => `abyss.webchat.visitor.${op}`;

const store = {
  get(op: string): string | null {
    try {
      return window.localStorage.getItem(visitorKey(op));
    } catch {
      return null;
    }
  },
  set(op: string, token: string) {
    try {
      window.localStorage.setItem(visitorKey(op), token);
    } catch {
      /* modo privado: la sesión vive solo en memoria */
    }
  },
  clear(op: string) {
    try {
      window.localStorage.removeItem(visitorKey(op));
    } catch {
      /* ignorar */
    }
  },
};

/** Fusiona mensajes por id y sustituye los optimistas por su versión del servidor (mismo clientMsgId). */
export function mergeMessages(list: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const out = [...list];
  for (const m of incoming) {
    const i = out.findIndex((x) => x.id === m.id || (!!m.clientMsgId && x.clientMsgId === m.clientMsgId));
    if (i >= 0) out[i] = { ...m, state: undefined };
    else out.push(m);
  }
  return out.sort((a, b) => (a.state === "sending" ? 1 : 0) - (b.state === "sending" ? 1 : 0) || a.createdAt.localeCompare(b.createdAt));
}

/** Operador del chat: el indicado (iframe ?op=) o el del tenant cuando /api/operator/brand ya lo resolvió. */
export function useChatOperatorId(explicit?: string): string {
  const { operator } = useTheme();
  if (explicit) return explicit;
  return operator.id ? moduleOperatorId() : process.env.NEXT_PUBLIC_OPERATOR_ID || "";
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * Estado del webchat: jugador logueado (su token) o visitante anónimo (token propio en localStorage, que se crea
 * al enviar el primer mensaje). Historial por HTTP y mensajes en vivo por socket.io (/webchat).
 */
export function useWebchat(operatorId: string, opts: { active: boolean; visitorName?: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [identity, setIdentity] = useState<{ player: string | null; visitor: string | null }>({ player: null, visitor: null });
  const activeRef = useRef(opts.active);
  useEffect(() => {
    activeRef.current = opts.active;
  }, [opts.active]);

  // Identidad: el token del jugador manda; si no, el del visitante guardado.
  useEffect(() => {
    const sync = () => setIdentity({ player: tokens.getAccess(), visitor: operatorId ? store.get(operatorId) : null });
    sync();
    return tokens.onAccessChange(sync);
  }, [operatorId]);

  const request = useCallback(
    <T,>(method: "get" | "post", path: string, body?: unknown): Promise<T> => {
      if (identity.player) return method === "get" ? api.get<T>(`${BASE}${path}`) : api.post<T>(`${BASE}${path}`, body);
      const headers = identity.visitor ? { "X-Visitor-Token": identity.visitor } : undefined;
      return method === "get" ? api.get<T>(`${BASE}${path}`, { scope: "none", headers }) : api.post<T>(`${BASE}${path}`, body, { scope: "none", headers });
    },
    [identity],
  );

  // Historial al abrir (o al cambiar de identidad).
  useEffect(() => {
    if (!opts.active || (!identity.player && !identity.visitor)) return;
    let cancelled = false;
    setLoading(true);
    request<ConversationResponse>("get", "/conversation")
      .then((r) => !cancelled && setMessages((prev) => mergeMessages(prev.filter((m) => m.state), r.messages)))
      .catch((e) => {
        if (cancelled) return;
        // Token de visitante caducado o de otra base: se descarta y se creará otro al escribir.
        if (e instanceof ApiError && e.status === 401 && !identity.player) {
          store.clear(operatorId);
          setIdentity((i) => ({ ...i, visitor: null }));
        } else setError("No se pudo cargar la conversación");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [opts.active, identity, operatorId, request]);

  // Mensajes en vivo.
  useEffect(() => {
    if (!identity.player && !identity.visitor) return;
    const t = socketTarget("/webchat");
    const s: Socket = io(t.url, {
      path: t.path,
      addTrailingSlash: t.addTrailingSlash,
      auth: identity.player ? { token: identity.player } : { visitorToken: identity.visitor },
      transports: ["websocket", "polling"],
      reconnectionDelayMax: 8000,
    });
    s.on("webchat:message", (m: ChatMessage) => {
      setMessages((prev) => mergeMessages(prev, [m]));
      if (m.direction === "out" && !activeRef.current) setUnread((u) => u + 1);
    });
    return () => {
      s.close();
    };
  }, [identity]);

  useEffect(() => {
    if (opts.active) setUnread(0);
  }, [opts.active]);

  const ensureIdentity = useCallback(async (): Promise<typeof identity> => {
    if (identity.player || identity.visitor) return identity;
    const r = await api.post<{ token: string }>(`${BASE}/session`, { operatorId, name: opts.visitorName || undefined }, { scope: "none" });
    store.set(operatorId, r.token);
    const next = { player: null, visitor: r.token };
    setIdentity(next);
    return next;
  }, [identity, operatorId, opts.visitorName]);

  const deliver = useCallback(
    async (msg: ChatMessage) => {
      try {
        const id = await ensureIdentity();
        const headers = id.visitor && !id.player ? { "X-Visitor-Token": id.visitor } : undefined;
        const saved = await api.post<ChatMessage>(`${BASE}/messages`, { body: msg.body, clientMsgId: msg.clientMsgId }, id.player ? {} : { scope: "none", headers });
        setMessages((prev) => mergeMessages(prev, [saved]));
        setError(null);
      } catch (e) {
        setMessages((prev) => prev.map((m) => (m.clientMsgId === msg.clientMsgId ? { ...m, state: "failed" } : m)));
        setError(e instanceof ApiError && e.status === 429 ? "Vas muy rápido; espera un momento" : "No se pudo enviar el mensaje");
      }
    },
    [ensureIdentity],
  );

  const send = useCallback(
    (text: string) => {
      const body = text.trim();
      if (!body || !operatorId) return;
      const clientMsgId = newId();
      const msg: ChatMessage = { id: `local-${clientMsgId}`, direction: "in", authorType: "contact", body, clientMsgId, createdAt: new Date().toISOString(), state: "sending" };
      setMessages((prev) => [...prev, msg]);
      void deliver(msg);
    },
    [deliver, operatorId],
  );

  const retry = useCallback(
    (clientMsgId: string) => {
      const msg = messages.find((m) => m.clientMsgId === clientMsgId);
      if (!msg) return;
      setMessages((prev) => prev.map((m) => (m.clientMsgId === clientMsgId ? { ...m, state: "sending" } : m)));
      void deliver(msg);
    },
    [deliver, messages],
  );

  return { messages, loading, error, unread, send, retry, isPlayer: !!identity.player };
}
