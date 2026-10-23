import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { HttpError } from '../../shared/http/errors';
import { botConfigSchema, checkBotConfig, defaultBotConfig, inWindows, presetFor, type BotConfig } from '../domain/botConfig';

export interface BotConfigView {
  currency: string;
  draft: BotConfig;
  publishedVersion: number | null;
  published: BotConfig | null;
  /** El borrador difiere de lo publicado. */
  dirty: boolean;
  check: { errors: string[]; warnings: string[] };
  versions: Array<{ version: number; publishedBy: string; note: string; createdAt: Date }>;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/**
 * Cajero IA: el borrador se edita sin efecto; publicar valida y congela una versión inmutable que es la que usa el bot.
 * Volver atrás publica una versión nueva con el contenido de una anterior (el historial nunca se reescribe).
 */
export class BotConfigService {
  private cache = new Map<string, { at: number; config: BotConfig | null }>();

  constructor(private readonly db: PrismaClient, private readonly opts: { now?: () => Date; cacheMs?: number } = {}) {}

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  async view(operatorId: string): Promise<BotConfigView> {
    const [row, versions, operator] = await Promise.all([
      this.db.pearlBotConfig.findUnique({ where: { operatorId } }),
      this.db.pearlBotConfigVersion.findMany({ where: { operatorId }, orderBy: { version: 'desc' }, take: 30, select: { version: true, publishedBy: true, note: true, createdAt: true, config: true } }),
      this.db.operator.findUnique({ where: { id: operatorId }, select: { defaultCurrency: true } }),
    ]);
    const published = row?.publishedVersion ? versions.find((v) => v.version === row.publishedVersion) : undefined;
    const pub = published ? botConfigSchema.parse(published.config) : null;
    const draft = row ? botConfigSchema.parse(row.draft) : pub ?? defaultBotConfig();
    return {
      currency: operator?.defaultCurrency ?? '',
      draft,
      publishedVersion: row?.publishedVersion ?? null,
      published: pub,
      dirty: JSON.stringify(draft) !== JSON.stringify(pub),
      check: checkBotConfig(draft),
      versions: versions.map(({ config: _c, ...v }) => v),
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  }

  async saveDraft(operatorId: string, raw: unknown, userId: string): Promise<BotConfigView> {
    const parsed = botConfigSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, 'BAD_REQUEST', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 5).join('; '));
    const draft = parsed.data as object;
    await this.db.pearlBotConfig.upsert({
      where: { operatorId },
      create: { operatorId, draft, updatedBy: userId, updatedAt: this.now() },
      update: { draft, updatedBy: userId, updatedAt: this.now() },
    });
    return this.view(operatorId);
  }

  async applyPreset(operatorId: string, country: 'CO' | 'MX' | 'AR', userId: string): Promise<BotConfigView> {
    return this.saveDraft(operatorId, presetFor(country), userId);
  }

  async publish(operatorId: string, userId: string, note = ''): Promise<BotConfigView> {
    const v = await this.view(operatorId);
    if (v.check.errors.length) throw new HttpError(422, 'INVALID_CONFIG', v.check.errors.join(' · '));
    if (!v.dirty && v.publishedVersion) throw new HttpError(409, 'NOTHING_TO_PUBLISH', 'No hay cambios para publicar');
    await this.freeze(operatorId, v.draft, userId, note);
    return this.view(operatorId);
  }

  async rollback(operatorId: string, version: number, userId: string): Promise<BotConfigView> {
    const old = await this.db.pearlBotConfigVersion.findUnique({ where: { operatorId_version: { operatorId, version } } });
    if (!old) throw new HttpError(404, 'NOT_FOUND', 'Versión no encontrada');
    const config = botConfigSchema.parse(old.config);
    await this.freeze(operatorId, config, userId, `Vuelta a la versión ${version}`);
    return this.view(operatorId);
  }

  async discardDraft(operatorId: string, userId: string): Promise<BotConfigView> {
    const v = await this.view(operatorId);
    return this.saveDraft(operatorId, v.published ?? defaultBotConfig(), userId);
  }

  private async freeze(operatorId: string, config: BotConfig, userId: string, note: string) {
    await this.db.$transaction(async (tx) => {
      const last = await tx.pearlBotConfigVersion.findFirst({ where: { operatorId }, orderBy: { version: 'desc' }, select: { version: true } });
      const version = (last?.version ?? 0) + 1;
      await tx.pearlBotConfigVersion.create({ data: { id: randomUUID(), operatorId, version, config: config as object, publishedBy: userId, note: note.slice(0, 200) } });
      await tx.pearlBotConfig.upsert({
        where: { operatorId },
        create: { operatorId, draft: config as object, publishedVersion: version, updatedBy: userId, updatedAt: this.now() },
        update: { draft: config as object, publishedVersion: version, updatedBy: userId, updatedAt: this.now() },
      });
    });
    this.cache.delete(operatorId);
  }

  /** Lo que el bot usa: la versión publicada (con caché corta). null = el operador aún no publicó nada. */
  async live(operatorId: string): Promise<BotConfig | null> {
    const hit = this.cache.get(operatorId);
    const ttl = this.opts.cacheMs ?? 15_000;
    if (hit && Date.now() - hit.at < ttl) return hit.config;
    const row = await this.db.pearlBotConfig.findUnique({ where: { operatorId }, select: { publishedVersion: true } });
    let config: BotConfig | null = null;
    if (row?.publishedVersion) {
      const v = await this.db.pearlBotConfigVersion.findUnique({ where: { operatorId_version: { operatorId, version: row.publishedVersion } } });
      config = v ? botConfigSchema.parse(v.config) : null;
    }
    this.cache.set(operatorId, { at: Date.now(), config });
    return config;
  }

  /** Política de caja vigente ahora: lo que Pearl consulta antes de acreditar solo. */
  async creditPolicy(operatorId: string, at = this.now()): Promise<CreditPolicy | null> {
    const c = await this.live(operatorId);
    if (!c || !c.enabled) return null;
    const noChargeNow = c.hours.noCharge === 'always' || (c.hours.noCharge === 'schedule' && inWindows(c.hours.windows, at, c.hours.timezone));
    return {
      autoCredit: c.automation.autoCredit && !noChargeNow,
      autoCreditMax: BigInt(c.amounts.autoCreditMax),
      minDeposit: BigInt(c.amounts.minDeposit),
      accumulateMinutes: c.amounts.accumulateMinutes,
      noChargeNow,
      pendingStage: c.routing.pendingCredit,
      noChargeMessage: c.messages.noCharge,
    };
  }
}

export interface CreditPolicy {
  autoCredit: boolean;
  autoCreditMax: bigint;
  minDeposit: bigint;
  accumulateMinutes: number;
  noChargeNow: boolean;
  pendingStage: string;
  noChargeMessage: string;
}
