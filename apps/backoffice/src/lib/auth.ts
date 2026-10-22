/**
 * Roles del backoffice. Los cuatro primeros son los del JWT real (Fase 1, BackofficeRole).
 * OPERATOR_AGENT solo existe en el login mock de desarrollo (dev-server de módulos).
 */
export type Role = "PLATFORM_ADMIN" | "OPERATOR_ADMIN" | "OPERATOR_SUPPORT" | "OPERATOR_FINANCE" | "OPERATOR_AGENT";
export const ROLES: Role[] = ["PLATFORM_ADMIN", "OPERATOR_ADMIN", "OPERATOR_SUPPORT", "OPERATOR_FINANCE", "OPERATOR_AGENT"];
/** Roles que ofrece el login mock (los del dev-server de módulos). */
export const MOCK_ROLES: Role[] = ["PLATFORM_ADMIN", "OPERATOR_ADMIN", "OPERATOR_AGENT"];

export const ROLE_LABEL: Record<Role, string> = {
  PLATFORM_ADMIN: "Administrador de plataforma",
  OPERATOR_ADMIN: "Administrador de operador",
  OPERATOR_SUPPORT: "Soporte de operador",
  OPERATOR_FINANCE: "Finanzas de operador",
  OPERATOR_AGENT: "Agente de operador",
};

/** Prefijo bajo el que se sirve el backoffice (vacío o "/algo"). Debe coincidir con basePath de next.config.ts. */
export const BASE_PATH = (() => {
  const b = (process.env.NEXT_PUBLIC_BASE_PATH || "").trim().replace(/\/+$/, "");
  return b && !b.startsWith("/") ? `/${b}` : b;
})();

/**
 * Base del API vista desde el navegador: absoluta (http://host:4000) o relativa (/_svc/api).
 * Por defecto `${BASE_PATH}/api-proxy`, el rewrite de Next hacia API_INTERNAL_URL (same-origin, sin CORS).
 */
const RAW_API = process.env.NEXT_PUBLIC_API_URL || `${BASE_PATH}/api-proxy`;
// El rewrite /api-proxy vive bajo el basePath: "/api-proxy" a secas (valor por defecto de docker-compose) se completa.
export const API_URL = (BASE_PATH && RAW_API.startsWith("/api-proxy") ? `${BASE_PATH}${RAW_API}` : RAW_API).replace(/\/$/, "");

/**
 * El login mock solo se activa con NEXT_PUBLIC_BACKOFFICE_MOCK_AUTH=true y NUNCA en producción:
 * `next build` fija NODE_ENV=production, por lo que el bundle de producción lo descarta siempre.
 */
export const MOCK_AUTH: boolean = process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_BACKOFFICE_MOCK_AUTH === "true";

export interface Session {
  token: string;
  role: Role;
  /** null = plataforma (ve todos los operadores). */
  operatorId: string | null;
  /** Correo del usuario (solo login real). */
  email?: string;
  /** Vencimiento del access token (ms epoch) leído del claim `exp`; solo informativo, el API es la autoridad. */
  expiresAt?: number;
}

export interface LoginInput {
  /** Login real: credenciales de backoffice. */
  email?: string;
  password?: string;
  /** Solo mock. */
  role?: Role;
  operatorId?: string;
}

/** Contrato de autenticación del backoffice: la UI solo depende de esta interfaz. */
export interface AuthClient {
  login(input: LoginInput): Promise<Session>;
  logout(): void;
  /** Cierra la sesión porque el API respondió 401 o el token venció; el login mostrará un aviso. */
  expire(): void;
  getSession(): Session | null;
  token(): string | null;
  role(): Role | null;
}

/*
 * Almacenamiento del token: sessionStorage (se borra al cerrar la pestaña y no se comparte entre pestañas).
 * Con el API en otro origen y Bearer en la cabecera no se puede usar cookie httpOnly sin un BFF; la
 * mitigación es el access token de vida corta (ACCESS_TOKEN_TTL, 15 min por defecto) y la CSP/escape de React.
 * El API del backoffice no emite refresh token: al vencer el token se vuelve al login.
 */
const KEY = "nymfo.backoffice.session";
const NOTICE_KEY = "nymfo.backoffice.notice";
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedSession: Session | null = null;

function readSession(): Session | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(KEY);
  if (raw === cachedRaw) return cachedSession;
  cachedRaw = raw;
  try {
    const s = raw ? (JSON.parse(raw) as Session) : null;
    cachedSession = s && s.token && ROLES.includes(s.role) && !(s.expiresAt && s.expiresAt <= Date.now()) ? s : null;
  } catch {
    cachedSession = null;
  }
  return cachedSession;
}

function writeSession(s: Session | null) {
  if (s) {
    window.sessionStorage.setItem(KEY, JSON.stringify(s));
    window.sessionStorage.removeItem(NOTICE_KEY);
  } else window.sessionStorage.removeItem(KEY);
  listeners.forEach((l) => l());
}

export function subscribeSession(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export const getSessionSnapshot = readSession;
export const getServerSessionSnapshot = () => null;

/** Lee (y borra) el aviso dejado por expire(), p. ej. "Tu sesión venció". */
export function takeLoginNotice(): string | null {
  if (typeof window === "undefined") return null;
  const n = window.sessionStorage.getItem(NOTICE_KEY);
  if (n) window.sessionStorage.removeItem(NOTICE_KEY);
  return n;
}

async function parseError(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return j?.error?.message ?? j?.message ?? `Error ${res.status}`;
  } catch {
    return `Error ${res.status}`;
  }
}

/** Lee `exp` (segundos) del payload del JWT solo para anticipar el vencimiento en la UI. */
function jwtExpiryMs(token: string): number | undefined {
  try {
    const part = token.split(".")[1];
    if (!part) return undefined;
    const payload = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

abstract class BaseAuthClient implements AuthClient {
  abstract login(input: LoginInput): Promise<Session>;
  logout() {
    writeSession(null);
  }
  expire() {
    if (typeof window !== "undefined" && window.sessionStorage.getItem(KEY)) window.sessionStorage.setItem(NOTICE_KEY, "Tu sesión venció o no es válida. Inicia sesión de nuevo.");
    writeSession(null);
  }
  getSession() {
    return readSession();
  }
  token() {
    return readSession()?.token ?? null;
  }
  role() {
    return readSession()?.role ?? null;
  }
}

/**
 * Login real: POST /api/backoffice/auth/login {email,password} → {accessToken, user:{id,email,role,operatorId}}.
 * El rol y el operador salen de la respuesta del API (no del navegador); PLATFORM_ADMIN llega con operatorId null.
 */
export class PasswordAuthClient extends BaseAuthClient {
  async login(input: LoginInput): Promise<Session> {
    const email = input.email?.trim();
    if (!email || !input.password) throw new Error("Escribe tu correo y contraseña");
    let res: Response;
    try {
      res = await fetch(`${API_URL}/api/backoffice/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: input.password }),
      });
    } catch {
      throw new Error("No se pudo conectar con el API. Revisa tu conexión y que el servidor esté activo.");
    }
    if (!res.ok) throw new Error(await parseError(res));
    const j = (await res.json()) as { accessToken?: string; user?: { email?: string; role?: Role; operatorId?: string | null } };
    const role = j.user?.role;
    if (!j.accessToken || !role || !ROLES.includes(role)) throw new Error("Respuesta de autenticación inesperada");
    const operatorId = j.user?.operatorId ?? null;
    if (role !== "PLATFORM_ADMIN" && !operatorId) throw new Error("La cuenta no tiene operador asignado");
    const s: Session = { token: j.accessToken, role, operatorId, email: j.user?.email ?? email, expiresAt: jwtExpiryMs(j.accessToken) };
    writeSession(s);
    return s;
  }
}

/** Solo desarrollo: pide un token dev:<ROLE>:<op>:<id> a /backoffice/v1/dev/login del dev-server de módulos. */
export class MockAuthClient extends BaseAuthClient {
  async login(input: LoginInput): Promise<Session> {
    const role = input.role ?? "OPERATOR_ADMIN";
    const res = await fetch(`${API_URL}/backoffice/v1/dev/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, ...(input.operatorId ? { operatorId: input.operatorId } : {}) }),
    });
    if (!res.ok) throw new Error(await parseError(res));
    const j = (await res.json()) as { token: string; role: Role; operatorId: string | null };
    const s: Session = { token: j.token, role: j.role, operatorId: j.operatorId };
    writeSession(s);
    return s;
  }
}

export const authClient: AuthClient = MOCK_AUTH ? new MockAuthClient() : new PasswordAuthClient();

export type NavSection = "Principal" | "Jugadores" | "Marketing" | "Juegos" | "Marca";
export const NAV_SECTIONS: NavSection[] = ["Principal", "Jugadores", "Marketing", "Juegos", "Marca"];

export interface NavItem {
  href: string;
  label: string;
  roles: Role[];
  section: NavSection;
}

const STAFF: Role[] = ["OPERATOR_SUPPORT", "OPERATOR_FINANCE", "OPERATOR_AGENT"];
const ALL: Role[] = ["PLATFORM_ADMIN", "OPERATOR_ADMIN", ...STAFF];
const ADMINS: Role[] = ["PLATFORM_ADMIN", "OPERATOR_ADMIN"];

export const NAV: NavItem[] = [
  { href: "/dashboard", label: "Panel", roles: ADMINS, section: "Principal" },
  { href: "/players", label: "Jugadores", roles: ALL, section: "Jugadores" },
  { href: "/inbox", label: "Sonar · Inbox", roles: ALL, section: "Jugadores" },
  { href: "/channels", label: "Sonar · Canales", roles: ADMINS, section: "Jugadores" },
  { href: "/tide", label: "Tide · Flujos y bots", roles: ADMINS, section: "Jugadores" },
  { href: "/tickets", label: "Tickets", roles: ALL, section: "Jugadores" },
  { href: "/segments", label: "Segmentos", roles: ADMINS, section: "Jugadores" },
  { href: "/campaigns", label: "Campañas y journeys", roles: ADMINS, section: "Marketing" },
  { href: "/bonuses", label: "Bonos", roles: ADMINS, section: "Marketing" },
  { href: "/tournaments", label: "Torneos", roles: ADMINS, section: "Marketing" },
  { href: "/jackpots", label: "Jackpots", roles: ADMINS, section: "Marketing" },
  { href: "/vip", label: "VIP y misiones", roles: ADMINS, section: "Marketing" },
  { href: "/catalog", label: "Catálogo y proveedores", roles: ADMINS, section: "Juegos" },
  { href: "/studios", label: "Juegos Studios", roles: ADMINS, section: "Juegos" },
  { href: "/skin", label: "Skin del operador", roles: ADMINS, section: "Marca" },
  { href: "/reports", label: "Reportes", roles: ADMINS, section: "Principal" },
];

export const canAccess = (role: Role | null, href: string) => !!role && NAV.some((n) => n.href === href && n.roles.includes(role));
export const homeFor = (role: Role) => (STAFF.includes(role) ? "/players" : "/dashboard");
