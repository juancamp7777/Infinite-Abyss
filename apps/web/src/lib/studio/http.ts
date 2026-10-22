/**
 * Transporte común de los clientes de Studios (slots y originals) sobre el cliente unificado de módulos.
 * Montos como string bigint en unidades mínimas; el cliente nunca decide resultados.
 */
import type { StudioGameProps } from '@/components/studio/types';
import { ApiError, formatMinor, moduleRequest, playerBearer } from '@/lib/modules';

export { API_URL } from '@/lib/modules';

const DEMO_KEY = 'nymfo.studio.demoSession';

export class StudioApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export type StudioCtx = Pick<StudioGameProps, 'mode' | 'session'>;

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Token del jugador: la sesión de la app (AuthProvider); el token dev solo existe fuera de producción y si se configuró. */
export function playerToken(): string | undefined {
  return playerBearer() ?? undefined;
}

export function demoSessionId(): string | null {
  return storage()?.getItem(DEMO_KEY) ?? null;
}

export function newId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Contextos no seguros (http) sin randomUUID: UUID v4 con getRandomValues.
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function asStudioError(e: unknown, networkMsg: string): StudioApiError {
  if (e instanceof ApiError) {
    return new StudioApiError(e.code === 'NETWORK' ? 'NETWORK' : e.code, e.code === 'NETWORK' ? networkMsg : e.message, e.status);
  }
  return new StudioApiError('NETWORK', networkMsg, 0);
}

export async function studioRequest<T>(method: 'GET' | 'POST', path: string, c: StudioCtx, body?: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (c.session) headers['X-Studio-Session'] = c.session;
  else if (c.mode === 'demo') {
    const id = demoSessionId();
    if (id) headers['X-Demo-Session'] = id;
  }
  const q = c.mode === 'demo' && method === 'GET' ? `${path.includes('?') ? '&' : '?'}mode=demo` : '';
  try {
    return await moduleRequest<T>(`/studio/v1${path}${q}`, {
      method,
      headers,
      body: body ? { ...body, mode: c.mode } : undefined,
      // Con sesión de lanzamiento del Hub no se manda el token del jugador.
      auth: !c.session,
    });
  } catch (e) {
    throw asStudioError(e, 'No se pudo conectar con el servidor de juegos');
  }
}

/** Garantiza la sesión demo anónima (una vez; se guarda en localStorage). */
export async function ensureDemoSession(): Promise<void> {
  if (demoSessionId()) return;
  let data: { demoSession: string };
  try {
    data = await moduleRequest<{ demoSession: string }>('/studio/v1/demo/session', { method: 'POST', body: {}, auth: true });
  } catch (e) {
    throw asStudioError(e, 'No se pudo iniciar la sesión demo');
  }
  storage()?.setItem(DEMO_KEY, data.demoSession);
}

export async function prepare(c: StudioCtx): Promise<void> {
  if (c.mode === 'demo' && !c.session) await ensureDemoSession();
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : 'Error inesperado');

/** Formatea unidades mínimas con los decimales de la moneda del operador (bigint, sin floats). */
export function formatMoney(units: bigint | string, currency = ''): string {
  return formatMinor(units, currency || undefined);
}

/** Ganancia en unidades mínimas = floor(apuesta base × multiplicador) (mismo redondeo del servidor, a centésimas). */
export function winUnits(baseBet: bigint, multiplier: number): bigint {
  return (baseBet * BigInt(Math.round(multiplier * 10000))) / BigInt(10000);
}
