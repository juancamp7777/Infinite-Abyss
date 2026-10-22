"use client";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { MessageCircle, SendHorizontal, X } from "lucide-react";
import { useChatOperatorId, useWebchat } from "@/lib/webchat";
import "./webchat.css";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

type Chat = ReturnType<typeof useWebchat>;

/** Ventana del chat. `embedded` = página completa (iframe de /webchat); si no, flotante sobre el lobby. */
function ChatPanel({ chat, embedded = false, active = true, onClose }: { chat: Chat; embedded?: boolean; active?: boolean; onClose?: () => void }) {
  const [text, setText] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [chat.messages.length]);
  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim()) return;
    chat.send(text);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <section className={`wc wc-window ${embedded ? "wc-embedded" : ""}`} role={embedded ? undefined : "dialog"} aria-label="Chat de soporte">
      <header className="wc-head">
        <div className="wc-avatar">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/infinite-abyss-mark.svg" alt="" width={26} height={26} />
        </div>
        <div>
          <div className="font-semibold">Soporte 24/7</div>
          <div className="wc-online">Respondemos en minutos</div>
        </div>
        {onClose && (
          <button type="button" className="wc-icon-btn" onClick={onClose} aria-label="Cerrar chat">
            <X aria-hidden className="h-4 w-4" />
          </button>
        )}
      </header>

      <div ref={bodyRef} className="wc-body" aria-live="polite">
        {chat.messages.length === 0 && !chat.loading && (
          <p className="wc-empty">👋 ¡Hola! Escríbenos tu duda sobre depósitos, retiros, bonos o juegos y un agente te atiende enseguida.</p>
        )}
        {chat.messages.map((m) => (
          <div key={m.clientMsgId ?? m.id} className="contents">
            <div className={`wc-msg ${m.direction === "in" ? "wc-msg-in" : "wc-msg-out"} ${m.state ? `wc-msg-${m.state}` : ""}`}>
              {m.body}
              <time dateTime={m.createdAt}>{m.state === "sending" ? "Enviando…" : time(m.createdAt)}</time>
            </div>
            {m.state === "failed" && m.clientMsgId && (
              <button type="button" className="wc-retry" onClick={() => chat.retry(m.clientMsgId!)}>No enviado · Reintentar</button>
            )}
          </div>
        ))}
      </div>

      {chat.error && <div className="wc-error" role="alert">{chat.error}</div>}

      <form className="wc-form" onSubmit={submit}>
        <textarea
          ref={inputRef}
          className="wc-input"
          rows={1}
          maxLength={4000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder="Escribe tu mensaje…"
          aria-label="Mensaje"
        />
        <button type="submit" className="wc-send" disabled={!text.trim()} aria-label="Enviar">
          <SendHorizontal aria-hidden className="h-4 w-4" />
        </button>
      </form>
    </section>
  );
}

/** Chat a página completa para el iframe de /webchat. */
export function EmbeddedChat({ operatorId }: { operatorId?: string }) {
  const chat = useWebchat(useChatOperatorId(operatorId), { active: true });
  return <ChatPanel chat={chat} embedded />;
}

/** Burbuja flotante del lobby con contador de respuestas no leídas. */
export function ChatWidget({ operatorId }: { operatorId?: string }) {
  const [open, setOpen] = useState(false);
  const chat = useWebchat(useChatOperatorId(operatorId), { active: open });
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open]);

  return (
    <div className="wc">
      {open && <ChatPanel chat={chat} active onClose={() => setOpen(false)} />}
      <button type="button" className="wc-fab" onClick={() => setOpen((o) => !o)} aria-label={open ? "Cerrar chat" : "Abrir chat de soporte"} aria-expanded={open}>
        {open ? <X aria-hidden className="h-6 w-6" /> : <MessageCircle aria-hidden className="h-6 w-6" />}
        {!open && chat.unread > 0 && <span className="wc-badge" aria-label={`${chat.unread} mensajes nuevos`}>{chat.unread}</span>}
      </button>
    </div>
  );
}
