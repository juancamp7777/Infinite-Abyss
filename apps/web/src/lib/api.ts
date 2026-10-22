/**
 * Cliente REST de Infinite Abyss. Base NEXT_PUBLIC_API_URL, cabecera X-Operator-Host (tenant),
 * Bearer y refresh automático (una sola vez) ante 401.
 */

/**
 * Base del API: NEXT_PUBLIC_API_URL puede ser absoluta (https://api.ejemplo.com) o una ruta relativa
 * same-origin ('/api-proxy', '/_svc/api'). Por defecto '/api-proxy' (rewrite de Next hacia la API interna).
 */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "/api-proxy").replace(/\/+$/, "");

/** Origen absoluto del API si la base es absoluta; null si es relativa (same-origin). */
export function apiOrigin(): string | null {
  return /^https?:\/\//i.test(API_URL) ? new URL(API_URL).origin : null;
}

/** Pathname de la base del API ('' si la base absoluta no tiene ruta). */
function apiBasePath(): string {
  if (/^https?:\/\//i.test(API_URL)) return new URL(API_URL).pathname.replace(/\/+$/, "");
  return API_URL.startsWith("/") ? API_URL : `/${API_URL}`;
}

/**
 * Destino de Socket.io: url = NEXT_PUBLIC_SOCKET_URL o el origen actual (o el del API si es absoluto);
 * path = NEXT_PUBLIC_SOCKET_PATH o `${ruta de la base}/socket.io`. `namespace` p. ej. '/promotions'.
 * `addTrailingSlash: false` (pásalo a io()): el rewrite /api-proxy de Next redirige `/socket.io/` a `/socket.io`
 * y el polling se perdería; la API acepta ambas formas.
 */
export function socketTarget(namespace = ""): { url: string; path: string; addTrailingSlash: false } {
  const envUrl = (process.env.NEXT_PUBLIC_SOCKET_URL || "").replace(/\/+$/, "");
  const origin = envUrl || apiOrigin() || (typeof window !== "undefined" ? window.location.origin : "");
  const path = (process.env.NEXT_PUBLIC_SOCKET_PATH || `${apiBasePath()}/socket.io`).replace(/\/+$/, "");
  return { url: `${origin}${namespace}`, path, addTrailingSlash: false };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type TokenPair = { accessToken: string; refreshToken: string };

type Scope = "player" | "backoffice";

/** Almacén de tokens en memoria + refresh token del jugador en localStorage (decisión de la Fase 1). */
const REFRESH_KEY = "nymfo.refreshToken";
const BO_KEY = "nymfo.backofficeToken";

let accessToken: string | null = null;
let backofficeToken: string | null = null;
let refreshing: Promise<string | null> | null = null;
const tokenListeners = new Set<(token: string | null) => void>();

export const tokens = {
  getAccess: () => accessToken,
  setAccess(token: string | null) {
    accessToken = token;
    tokenListeners.forEach((l) => l(token));
  },
  getRefresh(): string | null {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(REFRESH_KEY);
    } catch {
      return null;
    }
  },
  setRefresh(token: string | null) {
    if (typeof window === "undefined") return;
    try {
      if (token) window.localStorage.setItem(REFRESH_KEY, token);
      else window.localStorage.removeItem(REFRESH_KEY);
    } catch {
      /* almacenamiento no disponible */
    }
  },
  /** Token de backoffice: sessionStorage (se pierde al cerrar la pestaña). */
  getBackoffice(): string | null {
    if (backofficeToken) return backofficeToken;
    if (typeof window === "undefined") return null;
    try {
      backofficeToken = window.sessionStorage.getItem(BO_KEY);
    } catch {
      /* noop */
    }
    return backofficeToken;
  },
  setBackoffice(token: string | null) {
    backofficeToken = token;
    if (typeof window === "undefined") return;
    try {
      if (token) window.sessionStorage.setItem(BO_KEY, token);
      else window.sessionStorage.removeItem(BO_KEY);
    } catch {
      /* noop */
    }
  },
  onAccessChange(listener: (token: string | null) => void) {
    tokenListeners.add(listener);
    return () => {
      tokenListeners.delete(listener);
    };
  },
};

function operatorHost(): string {
  return typeof window !== "undefined" ? window.location.host : "";
}

/** Renueva el access token con el refresh token. Devuelve el nuevo access o null. */
export function refreshSession(): Promise<string | null> {
  if (refreshing) return refreshing;
  const refreshToken = tokens.getRefresh();
  if (!refreshToken) return Promise.resolve(null);
  refreshing = (async () => {
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Operator-Host": operatorHost() },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        tokens.setRefresh(null);
        tokens.setAccess(null);
        return null;
      }
      const data = (await res.json()) as TokenPair;
      tokens.setAccess(data.accessToken);
      if (data.refreshToken) tokens.setRefresh(data.refreshToken);
      return data.accessToken;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export type RequestOptions = {
  method?: string;
  body?: unknown;
  /** player (por defecto), backoffice o none (público). */
  scope?: Scope | "none";
  query?: Record<string, string | number | undefined | null>;
  signal?: AbortSignal;
  /** Cabeceras extra (p. ej. X-Studio-Session de los juegos lanzados por el Hub). */
  headers?: Record<string, string>;
  /** Fuerza el Bearer (null = sin Authorization). Con override no se intenta refresh ante 401. */
  bearer?: string | null;
};

async function parseError(res: Response): Promise<ApiError> {
  let code = "HTTP_ERROR";
  let message = `Error ${res.status}`;
  try {
    const data = await res.json();
    if (data?.error) {
      code = data.error.code ?? code;
      message = data.error.message ?? message;
    }
  } catch {
    /* sin cuerpo JSON */
  }
  return new ApiError(res.status, code, message);
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const scope = opts.scope ?? "player";
  const search = new URLSearchParams();
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== "") search.set(k, String(v));
    }
  }
  const qs = search.toString();
  // Cadena (no new URL): la base puede ser relativa y resolverse contra el origen actual.
  const url = `${API_URL}${path}${qs ? (path.includes("?") ? "&" : "?") + qs : ""}`;

  const send = (bearer: string | null) => {
    const headers: Record<string, string> = { "X-Operator-Host": operatorHost(), ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    return fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
      cache: "no-store",
    });
  };

  const overridden = opts.bearer !== undefined;
  const bearer = overridden ? opts.bearer! : scope === "player" ? tokens.getAccess() : scope === "backoffice" ? tokens.getBackoffice() : null;
  let res: Response;
  try {
    res = await send(bearer);
  } catch {
    throw new ApiError(0, "NETWORK", "No se pudo conectar con el servidor");
  }

  if (res.status === 401 && scope === "player" && !overridden) {
    const fresh = await refreshSession();
    if (fresh) {
      try {
        res = await send(fresh);
      } catch {
        throw new ApiError(0, "NETWORK", "No se pudo conectar con el servidor");
      }
    }
  }

  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, opts: Omit<RequestOptions, "method" | "body"> = {}) => apiRequest<T>(path, { ...opts, method: "GET" }),
  post: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, "method" | "body"> = {}) =>
    apiRequest<T>(path, { ...opts, method: "POST", body: body ?? {} }),
  put: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, "method" | "body"> = {}) =>
    apiRequest<T>(path, { ...opts, method: "PUT", body: body ?? {} }),
};

/* ------------------------------ Tipos del contrato ------------------------------ */

export type OperatorInfo = {
  /** Id del tenant (lo usan los endpoints públicos de los módulos); opcional según la versión de la API. */
  id?: string;
  slug: string;
  name: string;
  currencies: string[];
  defaultCurrency: string;
  currencyDecimals: Record<string, number> | number;
  chipsEnabled: boolean;
  chipMinorUnitsPerChip: string | null;
  /** Límites y montos rápidos de apuesta (unidades mínimas) configurados por el operador. */
  betLimits?: BetLimits | null;
};

export type BetLimits = { minBet?: string; maxBet?: string; presets?: Record<string, string[]> };

export type BrandInfo = {
  displayName: string;
  logoUrl: string | null;
  colors: { primary?: string; secondary?: string; accent?: string; background?: string; surface?: string; text?: string };
  fontFamily: string | null;
  legal: { termsUrl?: string; privacyUrl?: string; text?: string; [k: string]: unknown } | string | null;
};

export type BrandResponse = { operator: OperatorInfo; brand: BrandInfo };

export type PlayerUser = {
  id: string;
  email: string;
  username?: string | null;
  kycStatus?: "NONE" | "PENDING" | "VERIFIED" | "REJECTED";
  status?: string;
  selfExcludedUntil?: string | null;
  [k: string]: unknown;
};

export type Balances = { cash?: string; bonus?: string; currency?: string; [k: string]: unknown };

/** Decimales de una moneda según la respuesta de /operator/brand (admite mapa o número). */
export function decimalsFor(op: OperatorInfo | null, currency: string): number {
  if (!op) return 2;
  const d = op.currencyDecimals;
  if (typeof d === "number") return d;
  return d?.[currency] ?? 2;
}
