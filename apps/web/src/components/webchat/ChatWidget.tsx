"use client";
import { useT } from "@/lib/i18n";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ImagePlus, MessageCircle, SendHorizontal, X } from "lucide-react";
import { useChatOperatorId, useWebchat } from "@/lib/webchat";
import "./webchat.css";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

type Chat = ReturnType<typeof useWebchat>;

/** Ventana del chat. `embedded` = página completa (iframe de /webchat); si no, flotante sobre el lobby. */
function ChatPanel({ chat, embedded = false, active = true, onClose }: { chat: Chat; embedded?: boolean; active?: boolean; onClose?: () => void }) {
  const { t } = useT();
  const [text, setText] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
    <section className={`wc wc-window ${embedded ? "wc-embedded" : ""}`} role={embedded ? undefined : "dialog"} aria-label={t("Chat de soporte")}>
      <header className="wc-head">
        <div className="wc-avatar">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/infinite-abyss-mark.svg" alt="" width={26} height={26} />
        </div>
        <div>
          <div className="font-semibold">{t("Soporte 24/7")}</div>
          <div className="wc-online">{t("Respondemos en minutos")}</div>
        </div>
        {onClose && (
          <button type="button" className="wc-icon-btn" onClick={onClose} aria-label={t("Cerrar chat")}>
            <X aria-hidden className="h-4 w-4" />
          </button>
        )}
      </header>

      <div ref={bodyRef} className="wc-body" aria-live="polite">
        {chat.messages.length === 0 && !chat.loading && (
          <p className="wc-empty">{t("👋 ¡Hola! Escríbenos tu duda sobre depósitos, retiros, bonos o juegos y un agente te atiende enseguida.")}</p>
        )}
        {chat.messages.map((m) => (
          <div key={m.clientMsgId ?? m.id} className="contents">
            <div className={`wc-msg ${m.direction === "in" ? "wc-msg-in" : "wc-msg-out"} ${m.state ? `wc-msg-${m.state}` : ""}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {m.localImage ? <img src={m.localImage} alt={t("Imagen enviada")} className="wc-img" /> : m.body}
              <time dateTime={m.createdAt}>{m.state === "sending" ? t("Enviando…") : time(m.createdAt)}</time>
            </div>
            {m.state === "failed" && m.clientMsgId && (
              <button type="button" className="wc-retry" onClick={() => chat.retry(m.clientMsgId!)}>{t("No enviado · Reintentar")}</button>
            )}
          </div>
        ))}
      </div>

      {chat.error && <div className="wc-error" role="alert">{chat.error}</div>}

      <form className="wc-form" onSubmit={submit}>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void chat.sendImage(f);
          e.target.value = "";
        }} />
        <button type="button" className="wc-attach" onClick={() => fileRef.current?.click()} aria-label={t("Enviar comprobante o imagen")} title={t("Enviar comprobante")}>
          <ImagePlus aria-hidden className="h-4 w-4" />
        </button>
        <textarea
          ref={inputRef}
          className="wc-input"
          rows={1}
          maxLength={4000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={t("Escribe tu mensaje…")}
          aria-label={t("Mensaje")}
        />
        <button type="submit" className="wc-send" disabled={!text.trim()} aria-label={t("Enviar")}>
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
  const { t } = useT();
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
      <button type="button" className="wc-fab" onClick={() => setOpen((o) => !o)} aria-label={open ? t("Cerrar chat") : t("Abrir chat de soporte")} aria-expanded={open}>
        {open ? <X aria-hidden className="h-6 w-6" /> : <MessageCircle aria-hidden className="h-6 w-6" />}
        {!open && chat.unread > 0 && <span className="wc-badge" aria-label={`${chat.unread} mensajes nuevos`}>{chat.unread}</span>}
      </button>
    </div>
  );
}
