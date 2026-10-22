import { API_URL, authClient } from "./auth";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export function buildUrl(path: string, query?: RequestOptions["query"]): string {
  // API_URL puede ser relativa: se resuelve contra el origen actual.
  const u = new URL(`${API_URL}${path}`, typeof window !== "undefined" ? window.location.origin : "http://localhost");
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  return u.toString();
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const token = authClient.token();
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? "GET",
      headers: { ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...opts.headers },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError("No se pudo conectar con el API. Revisa tu conexión y que el servidor esté activo.", 0);
  }
  if (res.status === 401) authClient.expire();
  if (!res.ok) {
    let code: string | undefined;
    let message = `Error ${res.status}`;
    let details: unknown;
    try {
      const j = await res.json();
      code = j?.error?.code;
      message = j?.error?.message ?? j?.message ?? message;
      details = j?.error?.details ?? j?.details;
    } catch {
      /* cuerpo no JSON */
    }
    throw new ApiError(message, res.status, code, details);
  }
  return res;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(path, opts);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Descarga un CSV autenticado y dispara el guardado en el navegador. */
export async function downloadCsv(path: string, query: RequestOptions["query"], fallbackName: string): Promise<void> {
  const res = await send(path, { query });
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Extrae una lista de una respuesta {items:[...]} o un arreglo directo. */
export function asList<T = Record<string, unknown>>(r: unknown, key = "items"): T[] {
  if (Array.isArray(r)) return r as T[];
  const o = r as Record<string, unknown> | null;
  const v = o?.[key];
  if (Array.isArray(v)) return v as T[];
  // Respuestas {templates:[...]}, {bonuses:[...]}…: primera propiedad que sea un arreglo.
  const first = o && typeof o === "object" ? Object.values(o).find((x) => Array.isArray(x)) : undefined;
  return (first as T[] | undefined) ?? [];
}

// ---- Tipos de las respuestas del API que usa la UI ----
export interface DashboardDay {
  day: string;
  registrations: number;
  logins: number;
  activePlayers: number;
  depositors: number;
  ftdCount: number;
  ftdAmount: string;
  depositsAmount: string;
  withdrawalsAmount: string;
  betCount: number;
  bets: string;
  wins: string;
  ggr: string;
  bonusCost: string;
  jackpotFunding: string;
  ngr: string;
}
export interface Retention {
  eligible: number;
  retained: number;
  rate: number | null;
}
export interface Dashboard {
  operatorId: string | null;
  from: string;
  to: string;
  totals: Omit<DashboardDay, "day"> & { bettors: number; depositsCount: number; withdrawalsCount: number; netDeposits: string; hold: number | null };
  days: DashboardDay[];
  retention: { d1: Retention; d7: Retention; d30: Retention };
  formulas: Record<string, string>;
  warnings: string[];
}
export interface Skin {
  name: string;
  logoUrl: string;
  colors: { primary: string; secondary: string; background: string; surface: string; text: string; accent: string };
  banners: Array<{ title: string; subtitle: string; imageUrl?: string; href: string }>;
}
