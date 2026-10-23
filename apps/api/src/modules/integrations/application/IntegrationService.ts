import type { PrismaClient } from '@prisma/client';
import { HttpError } from '../../shared/http/errors';
import type { ModuleLogger } from '../../shared/module';
import type { HubProvidersControl, IntegrationsPort } from '../../shared/ports/IntegrationsPort';
import type { SecretBox } from '../../inbox/domain/secretBox';
import { INTEGRATIONS, integrationDef, maskSecret, mergeValues, scopeAllowed, type IntegrationDef } from '../domain/catalog';
import { testHttpIntegration, type TestResult } from '../infrastructure/testers';

export const PLATFORM = 'platform';
export type Scope = { kind: 'platform' } | { kind: 'operator'; operatorId: string };
const scopeId = (s: Scope) => (s.kind === 'platform' ? PLATFORM : s.operatorId);

export interface IntegrationView {
  key: string;
  connected: boolean;
  /** Campos públicos en claro y secretos enmascarados (••••abcd). */
  fields: Record<string, string>;
  status: 'none' | 'saved' | 'ok' | 'error';
  message: string | null;
  lastTestAt: string | null;
  updatedAt: string | null;
  /** En alcance de casino: hereda la conexión de la plataforma. */
  inherited: boolean;
}

interface Stored {
  values: Record<string, string>;
  status: string;
  lastError: string | null;
  lastTestAt: Date | null;
  updatedAt: Date;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Integraciones de Abyss Command: guarda credenciales cifradas (AES-256-GCM) por plataforma o por casino, las prueba
 * contra el servicio real y avisa al Hub para encender o apagar proveedores de juegos sin reiniciar.
 */
export class IntegrationService implements IntegrationsPort {
  constructor(
    private readonly db: PrismaClient,
    private readonly box: SecretBox,
    private readonly opts: { logger: ModuleLogger; services: Record<string, unknown>; fetch?: FetchLike },
  ) {}

  catalog(): IntegrationDef[] {
    return INTEGRATIONS;
  }

  private hub(): HubProvidersControl | undefined {
    return this.opts.services['hub.providers'] as HubProvidersControl | undefined;
  }

  private async load(scope: string, key: string): Promise<Stored | null> {
    const row = await this.db.integrationCredential.findUnique({ where: { scope_key: { scope, key } } });
    if (!row) return null;
    const secrets = row.secretsEnc ? this.box.open<Record<string, string>>(row.secretsEnc) : {};
    return { values: { ...(row.publicFields as Record<string, string>), ...secrets }, status: row.status, lastError: row.lastError, lastTestAt: row.lastTestAt, updatedAt: row.updatedAt };
  }

  private view(def: IntegrationDef, s: Stored | null, inherited = false): IntegrationView {
    const fields: Record<string, string> = {};
    if (s) for (const f of def.fields) if (s.values[f.name] !== undefined) fields[f.name] = f.secret ? maskSecret(s.values[f.name]) : s.values[f.name];
    return {
      key: def.key,
      connected: !!s,
      fields,
      status: s ? (s.status as IntegrationView['status']) : 'none',
      message: s?.lastError ?? null,
      lastTestAt: s?.lastTestAt?.toISOString() ?? null,
      updatedAt: s?.updatedAt.toISOString() ?? null,
      inherited,
    };
  }

  private def(key: string, scope: Scope): IntegrationDef {
    const def = integrationDef(key);
    if (!def) throw new HttpError(404, 'NOT_FOUND', 'Integración desconocida');
    if (!scopeAllowed(def, scope.kind)) throw new HttpError(422, 'WRONG_SCOPE', def.scope === 'platform' ? 'Esta integración es de toda la plataforma' : 'Esta integración es de cada casino');
    return def;
  }

  /** Estado de todas las integraciones del alcance (las de casino muestran si heredan la de la plataforma). */
  async list(scope: Scope): Promise<IntegrationView[]> {
    const rows = await this.db.integrationCredential.findMany({ where: { scope: { in: scope.kind === 'platform' ? [PLATFORM] : [scope.operatorId, PLATFORM] } }, select: { scope: true, key: true } });
    const out: IntegrationView[] = [];
    for (const def of INTEGRATIONS) {
      if (!scopeAllowed(def, scope.kind)) continue;
      const own = rows.some((r) => r.scope === scopeId(scope) && r.key === def.key);
      if (own) out.push(this.view(def, await this.load(scopeId(scope), def.key)));
      else if (scope.kind === 'operator' && def.scope === 'both' && rows.some((r) => r.scope === PLATFORM && r.key === def.key)) {
        const p = await this.load(PLATFORM, def.key);
        out.push({ ...this.view(def, p, true), fields: {} });
      } else out.push(this.view(def, null));
    }
    return out;
  }

  async save(scope: Scope, key: string, input: Record<string, unknown>, by: string): Promise<IntegrationView> {
    const def = this.def(key, scope);
    const cur = await this.load(scopeId(scope), key);
    const { values, errors } = mergeValues(def, cur?.values ?? {}, input);
    if (errors.length) throw new HttpError(422, 'INVALID_INTEGRATION', errors.join(' · '), errors);
    const secrets: Record<string, string> = {};
    const pub: Record<string, string> = {};
    for (const f of def.fields) if (values[f.name] !== undefined) (f.secret ? secrets : pub)[f.name] = values[f.name];
    const data = { secretsEnc: Object.keys(secrets).length ? this.box.seal(secrets) : null, publicFields: pub, status: 'saved', lastError: null, lastTestAt: null, updatedBy: by };
    await this.db.integrationCredential.upsert({ where: { scope_key: { scope: scopeId(scope), key } }, create: { scope: scopeId(scope), key, ...data }, update: data });
    if (def.category === 'games') await this.reloadGames();
    return this.view(def, await this.load(scopeId(scope), key));
  }

  async remove(scope: Scope, key: string): Promise<void> {
    const def = this.def(key, scope);
    await this.db.integrationCredential.deleteMany({ where: { scope: scopeId(scope), key } });
    if (def.category === 'games') await this.reloadGames();
  }

  /** Prueba la conexión con el servicio real y guarda el resultado (verde/rojo) para el panel. */
  async test(scope: Scope, key: string): Promise<TestResult & { view: IntegrationView }> {
    const def = this.def(key, scope);
    const s = await this.load(scopeId(scope), key);
    if (!s) throw new HttpError(409, 'NOT_CONNECTED', 'Primero guarda las credenciales');
    let r: TestResult;
    if (def.test === 'http') r = await testHttpIntegration(key, s.values, this.opts.fetch);
    else if (def.test === 'catalog') {
      const hub = this.hub();
      r = hub ? await hub.test(key, this.overlayFor(def, s.values)) : { ok: false, message: 'El Hub de juegos no está activo en este servidor' };
    } else r = { ok: false, message: 'Guardado. La prueba automática llega con el conector de este servicio.' };
    const status = def.test === 'none' ? 'saved' : r.ok ? 'ok' : 'error';
    await this.db.integrationCredential.update({ where: { scope_key: { scope: scopeId(scope), key } }, data: { status, lastError: r.message.slice(0, 500), lastTestAt: new Date() } });
    return { ...r, view: this.view(def, await this.load(scopeId(scope), key)) };
  }

  // ───── IntegrationsPort (para los demás módulos) ─────

  async value(operatorId: string | null, key: string, field: string): Promise<string | undefined> {
    if (operatorId) {
      const own = await this.load(operatorId, key).catch(() => null);
      if (own?.values[field]) return own.values[field];
    }
    return (await this.load(PLATFORM, key).catch(() => null))?.values[field];
  }

  private overlayFor(def: IntegrationDef, values: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const f of def.fields) if (f.env && values[f.name] !== undefined) env[f.env] = values[f.name];
    return env;
  }

  async envOverlay(): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const def of INTEGRATIONS.filter((d) => d.category === 'games')) {
      const s = await this.load(PLATFORM, def.key).catch((e) => {
        this.opts.logger.error('[integrations] no se pudo leer una credencial', { key: def.key, error: e instanceof Error ? e.message : String(e) });
        return null;
      });
      if (s) Object.assign(env, this.overlayFor(def, s.values));
    }
    return env;
  }

  private async reloadGames(): Promise<void> {
    const hub = this.hub();
    if (!hub) return;
    const r = await hub.reload(await this.envOverlay());
    if (r.errors.length) this.opts.logger.warn('[integrations] proveedores con configuración inválida', { errors: r.errors });
  }
}
