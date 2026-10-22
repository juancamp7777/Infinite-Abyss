import type { TenantContext } from '../../domain/contracts';
import { AppError } from '../../domain/errors/AppError';

/** Puerto de acceso a datos de tenants (implementado en infrastructure/tenancy). */
export interface TenantRepository {
  findBySlug(slug: string): Promise<TenantContext | null>;
  findByHost(host: string): Promise<TenantContext | null>;
}

export interface TenantResolveInput {
  /** Cabecera X-Operator-Slug */
  slugHeader?: string;
  /** Cabecera X-Operator-Host (host de la web que consume la API) */
  operatorHostHeader?: string;
  /** Cabecera Host de la petición */
  requestHost?: string;
}

export interface TenantResolverOptions {
  /**
   * Slug por defecto: se usa cuando el host (X-Operator-Host o Host) no está registrado en OperatorDomain.
   * En producción solo con allowDefaultInProduction (ALLOW_DEFAULT_OPERATOR=true). Un X-Operator-Slug inválido nunca cae aquí.
   */
  defaultSlug?: string;
  isProduction?: boolean;
  allowDefaultInProduction?: boolean;
  /** TTL de la caché en ms (por defecto 5 s). 0 la desactiva. */
  cacheTtlMs?: number;
  now?: () => number;
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function normalizeHost(h: string): string {
  return h.trim().toLowerCase();
}

export class TenantResolver {
  private readonly cache = new Map<string, { ctx: TenantContext; expires: number }>();
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(
    private readonly repo: TenantRepository,
    private readonly opts: TenantResolverOptions = {},
  ) {
    this.ttl = opts.cacheTtlMs ?? 5_000;
    this.now = opts.now ?? Date.now;
  }

  invalidate(): void {
    this.cache.clear();
  }

  async resolve(input: TenantResolveInput): Promise<TenantContext> {
    let ctx: TenantContext | null;
    if (input.slugHeader && input.slugHeader.trim()) {
      ctx = await this.bySlug(input.slugHeader.trim().toLowerCase());
    } else {
      const host = input.operatorHostHeader?.trim() || input.requestHost?.trim();
      ctx = host ? await this.byHost(normalizeHost(host)) : null;
      // Host desconocido (vista previa, dominio aún sin registrar): operador por defecto si está permitido.
      if (!ctx && this.defaultAllowed()) {
        ctx = await this.bySlug(this.opts.defaultSlug!.toLowerCase());
      }
    }
    if (!ctx) throw AppError.notFound('Operador no encontrado');
    if (ctx.status !== 'ACTIVE') throw AppError.forbidden('El operador no está activo');
    return ctx;
  }

  private defaultAllowed(): boolean {
    if (!this.opts.defaultSlug) return false;
    return !this.opts.isProduction || this.opts.allowDefaultInProduction === true;
  }

  private async bySlug(slug: string): Promise<TenantContext | null> {
    if (!SLUG_RE.test(slug)) return null;
    return this.cached(`s:${slug}`, () => this.repo.findBySlug(slug));
  }

  private async byHost(host: string): Promise<TenantContext | null> {
    const lookup = async () => {
      const exact = await this.repo.findByHost(host);
      if (exact) return exact;
      // Reintenta sin puerto (localhost:3000 → localhost).
      const noPort = host.replace(/:\d+$/, '');
      return noPort !== host ? this.repo.findByHost(noPort) : null;
    };
    return this.cached(`h:${host}`, lookup);
  }

  private async cached(key: string, load: () => Promise<TenantContext | null>): Promise<TenantContext | null> {
    const hit = this.cache.get(key);
    const t = this.now();
    if (hit && hit.expires > t) return hit.ctx;
    const ctx = await load();
    if (ctx && this.ttl > 0) {
      if (this.cache.size > 1000) this.cache.clear();
      this.cache.set(key, { ctx, expires: t + this.ttl });
    } else {
      this.cache.delete(key);
    }
    return ctx;
  }
}
