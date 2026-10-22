import { describe, expect, it } from "vitest";
import { mergeMessages, type ChatMessage } from "../webchat";

const msg = (p: Partial<ChatMessage>): ChatMessage => ({ id: "x", direction: "in", authorType: "contact", body: "b", createdAt: "2026-10-22T10:00:00.000Z", ...p });

describe("webchat · mergeMessages", () => {
  it("sustituye el mensaje optimista por el del servidor (mismo clientMsgId)", () => {
    const local = msg({ id: "local-1", clientMsgId: "c1", state: "sending", createdAt: "2026-10-22T10:00:05.000Z" });
    const out = mergeMessages([local], [msg({ id: "srv-1", clientMsgId: "c1", createdAt: "2026-10-22T10:00:04.000Z" })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "srv-1", state: undefined });
  });

  it("no duplica por id (socket + respuesta HTTP) y ordena cronológicamente con los pendientes al final", () => {
    const a = msg({ id: "a", createdAt: "2026-10-22T10:00:02.000Z" });
    const b = msg({ id: "b", direction: "out", authorType: "agent", createdAt: "2026-10-22T10:00:01.000Z" });
    const pending = msg({ id: "local-2", clientMsgId: "c2", state: "sending", createdAt: "2026-10-22T09:00:00.000Z" });
    const out = mergeMessages([pending, a], [b, a]);
    expect(out.map((m) => m.id)).toEqual(["b", "a", "local-2"]);
  });
});
