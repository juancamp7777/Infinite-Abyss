import { z } from 'zod';

/** Vacío ("") se trata como no definido (típico de .env con claves sin valor). */
const optionalStr = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const intFromStr = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : Number(v)))
    .pipe(z.number().int().positive());

const strWithDefault = (def: string) =>
  z.string().optional().transform((v) => (v === undefined || v.trim() === '' ? def : v.trim()));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFromStr(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  CORS_ORIGINS: optionalStr,
  // Sin valor por defecto: si falta, la app NO arranca.
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET is required (min 32 chars)'),
  ACCESS_TOKEN_TTL: strWithDefault('15m'),
  REFRESH_TOKEN_TTL_DAYS: intFromStr(30),
  DEFAULT_OPERATOR_SLUG: optionalStr,
  /** En producción el operador por defecto solo se usa si ALLOW_DEFAULT_OPERATOR=true. */
  ALLOW_DEFAULT_OPERATOR: strWithDefault('false').pipe(z.enum(['true', 'false'])),

  // Passimpay (si falta PLATFORM_ID o API_KEY el adaptador queda deshabilitado)
  PASSIMPAY_PLATFORM_ID: optionalStr,
  PASSIMPAY_API_KEY: optionalStr,
  PASSIMPAY_BASE_URL: strWithDefault('https://api.passimpay.io'),
  PASSIMPAY_WEBHOOK_IP_ALLOWLIST: optionalStr,

  // Wompi
  WOMPI_PUBLIC_KEY: optionalStr,
  WOMPI_PRIVATE_KEY: optionalStr,
  WOMPI_EVENTS_SECRET: optionalStr,
  WOMPI_INTEGRITY_SECRET: optionalStr,
  WOMPI_BASE_URL: strWithDefault('https://production.wompi.co/v1'),

  PUBLIC_API_URL: optionalStr,
  PUBLIC_WEB_URL: optionalStr,
  /** URL pública del backoffice: su origen se agrega a los orígenes CORS permitidos. */
  BACKOFFICE_URL: optionalStr,
  RECONCILIATION_INTERVAL_MINUTES: intFromStr(60),

  // Módulos Infinite Abyss (Hub, Studios, promociones, CRM, marketing, gamificación, backoffice-api)
  MODULES_ENABLED: strWithDefault('true').pipe(z.enum(['true', 'false'])),
  /** Firma de los enlaces de baja de marketing. Obligatorio en producción. */
  MKT_UNSUBSCRIBE_SECRET: optionalStr,
  /** Semilla HMAC de las tiradas de drops de promociones. Obligatorio en producción. */
  PROMO_DROPS_SECRET: optionalStr,
  /** Clave HMAC de los alias públicos del feed de apuestas en vivo. Obligatorio en producción. */
  FEED_PSEUDONYM_SECRET: optionalStr,
  /** URL pública con la que los proveedores llaman al Hub (/hub/v1/wallet). Por defecto PUBLIC_API_URL. */
  HUB_PUBLIC_API_URL: optionalStr,
}).superRefine((e, ctx) => {
  if (e.NODE_ENV !== 'production' || e.MODULES_ENABLED !== 'true') return;
  // En producción no hay secretos efímeros ni por defecto para los módulos.
  for (const key of ['MKT_UNSUBSCRIBE_SECRET', 'PROMO_DROPS_SECRET', 'FEED_PSEUDONYM_SECRET'] as const) {
    const v = e[key];
    if (!v || v.length < 32) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required in production (min 32 chars)` });
  }
  // Los secretos HMAC de proveedores del Hub (HUB_PROVIDER_<ID>_SECRET) son por proveedor: sin secreto, el proveedor
  // queda deshabilitado; el mock-provider nunca se habilita en producción salvo HUB_MOCK_PROVIDER=1.
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  databaseUrl: string;
  /** CORS_ORIGINS + origen de PUBLIC_WEB_URL + origen de BACKOFFICE_URL (deduplicado, sin los localhost de desarrollo). */
  corsOrigins: string[];
  jwt: { accessSecret: string; accessTtl: string; refreshTtlDays: number };
  defaultOperatorSlug?: string;
  passimpay: {
    platformId?: string;
    apiKey?: string;
    baseUrl: string;
    webhookIpAllowlist: string[];
  };
  wompi: {
    publicKey?: string;
    privateKey?: string;
    eventsSecret?: string;
    integritySecret?: string;
    baseUrl: string;
  };
  publicApiUrl?: string;
  publicWebUrl?: string;
  backofficeUrl?: string;
  reconciliationIntervalMinutes: number;
  modules: {
    enabled: boolean;
    /** Entorno que reciben los módulos (deps.env): process.env con HUB_PUBLIC_API_URL resuelto. */
    env: NodeJS.ProcessEnv;
  };
}

/** Orígenes por defecto fuera de producción (web :3000 y backoffice :3001 en local). */
export const DEV_CORS_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://demo.localhost:3000', 'http://localhost:3001'];

/** Origen (esquema://host[:puerto]) de una URL absoluta; undefined si no es absoluta o es inválida. */
export function originOf(url: string | undefined): string | undefined {
  if (!url || !url.trim()) return undefined;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Orígenes permitidos: CORS_ORIGINS (separados por comas) + PUBLIC_WEB_URL + BACKOFFICE_URL; solo el origen, sin duplicados. */
export function resolveCorsOrigins(env: { CORS_ORIGINS?: string; PUBLIC_WEB_URL?: string; BACKOFFICE_URL?: string }): string[] {
  const raw = [...(env.CORS_ORIGINS ?? '').split(','), env.PUBLIC_WEB_URL, env.BACKOFFICE_URL];
  const out = new Set<string>();
  for (const v of raw) {
    const o = originOf(v);
    if (o) out.add(o);
  }
  return [...out];
}

/** Carga y valida la configuración. Lanza Error con la lista de problemas si es inválida. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;
  const list = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  return {
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    corsOrigins: resolveCorsOrigins(e),
    jwt: { accessSecret: e.JWT_ACCESS_SECRET, accessTtl: e.ACCESS_TOKEN_TTL, refreshTtlDays: e.REFRESH_TOKEN_TTL_DAYS },
    // Operador por defecto (fallback para hosts no registrados): en producción exige ALLOW_DEFAULT_OPERATOR=true.
    defaultOperatorSlug: e.NODE_ENV === 'production' && e.ALLOW_DEFAULT_OPERATOR !== 'true' ? undefined : e.DEFAULT_OPERATOR_SLUG,
    passimpay: {
      platformId: e.PASSIMPAY_PLATFORM_ID,
      apiKey: e.PASSIMPAY_API_KEY,
      baseUrl: e.PASSIMPAY_BASE_URL,
      webhookIpAllowlist: list(e.PASSIMPAY_WEBHOOK_IP_ALLOWLIST),
    },
    wompi: {
      publicKey: e.WOMPI_PUBLIC_KEY,
      privateKey: e.WOMPI_PRIVATE_KEY,
      eventsSecret: e.WOMPI_EVENTS_SECRET,
      integritySecret: e.WOMPI_INTEGRITY_SECRET,
      baseUrl: e.WOMPI_BASE_URL,
    },
    publicApiUrl: e.PUBLIC_API_URL,
    publicWebUrl: e.PUBLIC_WEB_URL,
    backofficeUrl: e.BACKOFFICE_URL,
    reconciliationIntervalMinutes: e.RECONCILIATION_INTERVAL_MINUTES,
    modules: {
      enabled: e.MODULES_ENABLED === 'true',
      env: {
        ...env,
        NODE_ENV: e.NODE_ENV,
        ...(e.HUB_PUBLIC_API_URL ?? e.PUBLIC_API_URL ? { HUB_PUBLIC_API_URL: e.HUB_PUBLIC_API_URL ?? e.PUBLIC_API_URL } : {}),
      },
    },
  };
}

let cached: AppConfig | undefined;

/** Configuración del proceso (singleton perezoso sobre process.env). */
export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Solo para tests: descarta la configuración cacheada. */
export function resetConfigCache(): void {
  cached = undefined;
}
