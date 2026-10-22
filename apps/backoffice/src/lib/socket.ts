import { io, type Socket } from "socket.io-client";
import { API_URL, authClient } from "./auth";

/** Conecta a un namespace de socket.io del API (mismo origen vía /api-proxy o API absoluta). */
export function connectSocket(namespace: string, query?: Record<string, string>): Socket {
  const absolute = /^https?:\/\//i.test(API_URL);
  const url = absolute ? new URL(API_URL).origin : window.location.origin;
  // Con proxy relativo el API sirve socket.io bajo el prefijo (Next reescribe /api-proxy/socket.io → /socket.io).
  const path = absolute ? `${new URL(API_URL).pathname.replace(/\/$/, "")}/socket.io` : `${API_URL}/socket.io`;
  return io(`${url}${namespace}`, {
    path,
    addTrailingSlash: false,
    auth: { token: authClient.token() },
    query,
    transports: ["websocket", "polling"],
    reconnectionDelayMax: 8000,
  });
}
