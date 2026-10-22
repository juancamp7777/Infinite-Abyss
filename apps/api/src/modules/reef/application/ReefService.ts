import { createHmac, timingSafeEqual } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { HttpError } from '../../shared/http/errors';
import { contrastIssues, defaultConfig, siteConfigSchema, switchTemplate, TEMPLATES, type SiteConfig } from '../domain/site';

const IMAGE_SIGNATURES: Array<[string, (b: Buffer) => boolean]> = [
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
  ['image/x-icon', (b) => b.length > 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0],
];
export const MAX_ASSET = 1024 * 1024;
const CACHE_MS = 30_000;

/** Errores de validación legibles (todos juntos para el editor). */
function validate(input: unknown): SiteConfig {
  const r = siteConfigSchema.safeParse(input);
  if (!r.success) throw new HttpError(422, 'INVALID_SITE', 'La configuración tiene errores', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  const issues = contrastIssues(r.data.colors);
  if (issues.length) throw new HttpError(422, 'LOW_CONTRAST', 'Hay colores con poco contraste', issues);
  return r.data;
}

/**
 * Reef: borrador editable → vista previa firmada → publicación versionada (la anterior se archiva) → vuelta atrás
 * re-publicando una versión vieja. El sitio público se resuelve por dominio (o id de operador) con caché corta que se
 * invalida al publicar.
 */
export class ReefService {
  private readonly cache = new Map<string, { at: number; value: { version: number; config: SiteConfig } | null }>();

  constructor(private readonly db: PrismaClient, private readonly opts: { previewSecret: string; now?: () => Date }) {}

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  private async operatorName(operatorId: string) {
    return (await this.db.operator.findUnique({ where: { id: operatorId }, select: { name: true } }))?.name ?? 'Mi Casino';
  }

  private async published(operatorId: string) {
    const hit = this.cache.get(operatorId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const row = await this.db.reefSiteVersion.findFirst({ where: { operatorId, status: 'published' }, orderBy: { version: 'desc' } });
    const value = row ? { version: row.version, config: row.config as unknown as SiteConfig } : null;
    this.cache.set(operatorId, { at: Date.now(), value });
    return value;
  }

  templates() {
    return Object.entries(TEMPLATES).map(([key, t]) => ({ key, name: t.name, description: t.description, defaults: t.defaults }));
  }

  /** Estado del editor: borrador (o el publicado, o los valores de la plantilla) + historial. */
  async editor(operatorId: string) {
    const [draft, pub, versions] = await Promise.all([
      this.db.reefSiteDraft.findUnique({ where: { operatorId } }),
      this.published(operatorId),
      this.db.reefSiteVersion.findMany({ where: { operatorId }, orderBy: { version: 'desc' }, take: 30, select: { version: true, status: true, publishedAt: true, publishedBy: true } }),
    ]);
    const config = (draft?.config as unknown as SiteConfig) ?? pub?.config ?? defaultConfig('abyss', await this.operatorName(operatorId));
    return { config, hasDraft: !!draft, publishedVersion: pub?.version ?? null, versions };
  }

  async saveDraft(operatorId: string, input: unknown, by: string) {
    const config = validate(input);
    await this.db.reefSiteDraft.upsert({ where: { operatorId }, create: { operatorId, config: config as object, updatedBy: by }, update: { config: config as object, updatedBy: by } });
    return config;
  }

  /** Cambio de plantilla en el borrador: conserva marca, banners, SEO y footer. */
  async applyTemplate(operatorId: string, template: SiteConfig['template'], by: string) {
    const { config } = await this.editor(operatorId);
    return this.saveDraft(operatorId, switchTemplate(config, template), by);
  }

  private async newVersion(operatorId: string, config: SiteConfig, by: string) {
    const v = await this.db.$transaction(async (tx) => {
      const last = await tx.reefSiteVersion.findFirst({ where: { operatorId }, orderBy: { version: 'desc' }, select: { version: true } });
      await tx.reefSiteVersion.updateMany({ where: { operatorId, status: 'published' }, data: { status: 'archived' } });
      return tx.reefSiteVersion.create({ data: { operatorId, version: (last?.version ?? 0) + 1, status: 'published', config: config as object, publishedBy: by } });
    });
    this.cache.delete(operatorId);
    return { version: v.version };
  }

  async publish(operatorId: string, by: string) {
    const draft = await this.db.reefSiteDraft.findUnique({ where: { operatorId } });
    if (!draft) throw new HttpError(409, 'NO_DRAFT', 'No hay cambios en borrador para publicar');
    const out = await this.newVersion(operatorId, validate(draft.config), by);
    await this.db.reefSiteDraft.delete({ where: { operatorId } });
    return out;
  }

  /** Vuelve a una versión anterior publicándola como nueva (el historial nunca se reescribe). */
  async rollback(operatorId: string, version: number, by: string) {
    const v = await this.db.reefSiteVersion.findUnique({ where: { operatorId_version: { operatorId, version } } });
    if (!v) throw new HttpError(404, 'NOT_FOUND', 'Versión no encontrada');
    await this.db.reefSiteDraft.deleteMany({ where: { operatorId } });
    return this.newVersion(operatorId, validate(v.config), by);
  }

  // ───────────── vista previa firmada ─────────────

  previewToken(operatorId: string, ttlMinutes = 60) {
    const exp = Math.floor(this.now().getTime() / 1000) + ttlMinutes * 60;
    const sig = createHmac('sha256', this.opts.previewSecret).update(`${operatorId}.${exp}`).digest('base64url');
    return { token: `${operatorId}.${exp}.${sig}`, expiresAt: new Date(exp * 1000) };
  }

  private verifyPreview(token: string | undefined, operatorId: string): boolean {
    if (!token) return false;
    const [op, exp, sig] = token.split('.');
    if (op !== operatorId || !exp || !sig || Number(exp) * 1000 < this.now().getTime()) return false;
    const want = createHmac('sha256', this.opts.previewSecret).update(`${op}.${exp}`).digest('base64url');
    return sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  }

  // ───────────── sitio público ─────────────

  async resolveOperator(q: { operatorId?: string; host?: string }): Promise<string | null> {
    if (q.operatorId) return q.operatorId;
    if (!q.host) return null;
    const host = q.host.toLowerCase().replace(/:\d+$/, '');
    return (await this.db.operatorDomain.findUnique({ where: { host }, select: { operatorId: true } }))?.operatorId ?? null;
  }

  /** Configuración pública (publicada, o el borrador con un token de vista previa válido). null = sin Reef publicado. */
  async publicSite(q: { operatorId?: string; host?: string; preview?: string }) {
    const operatorId = await this.resolveOperator(q);
    if (!operatorId) return null;
    if (this.verifyPreview(q.preview, operatorId)) {
      const { config } = await this.editor(operatorId);
      return { operatorId, version: null, preview: true, config };
    }
    const pub = await this.published(operatorId);
    return pub ? { operatorId, version: pub.version, preview: false, config: pub.config } : null;
  }

  // ───────────── imágenes (logo, favicon, banners) ─────────────

  async uploadAsset(operatorId: string, data: Buffer) {
    if (data.length > MAX_ASSET) throw new HttpError(413, 'TOO_LARGE', 'La imagen supera 1 MB');
    const mime = data.length >= 12 ? IMAGE_SIGNATURES.find(([, ok]) => ok(data))?.[0] : undefined;
    if (!mime) throw new HttpError(415, 'UNSUPPORTED_MEDIA', 'Solo PNG, JPG, WEBP o ICO');
    const a = await this.db.reefAsset.create({ data: { operatorId, mime, size: data.length, data } });
    return { id: a.id, url: `/reef/v1/assets/${a.id}`, mime, size: a.size };
  }

  async asset(id: string) {
    const a = await this.db.reefAsset.findUnique({ where: { id } });
    if (!a) throw new HttpError(404, 'NOT_FOUND', 'Imagen no encontrada');
    return a;
  }
}
