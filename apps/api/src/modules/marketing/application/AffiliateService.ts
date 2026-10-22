import type { DomainEvents } from '../../shared/events/EventBus';
import type { ModuleLogger } from '../../shared/module';
import { assertResolvesPublic, defaultResolver, type HostResolver, validatePostbackTemplate } from '../domain/urlSafety';
import type { Affiliate, Attribution, PostbackLog } from '../domain/types';
import type { FetchLike } from '../infrastructure/channels';
import type { MarketingRepos } from '../infrastructure/stores';

const RETRY_MINUTES = [1, 5, 30];

export interface AffiliateServiceOptions {
  production: boolean;
  fetchFn?: FetchLike;
  resolver?: HostResolver;
  /** Reintentos máximos (intentos totales). */
  maxAttempts?: number;
}

export class AffiliateService {
  private readonly fetchFn: FetchLike;
  private readonly maxAttempts: number;
  constructor(
    private readonly repos: MarketingRepos,
    private readonly clock: () => Date,
    private readonly logger: ModuleLogger,
    private readonly opts: AffiliateServiceOptions,
  ) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.maxAttempts = opts.maxAttempts ?? RETRY_MINUTES.length + 1;
  }

  /** Valida (anti-SSRF) la plantilla de postback; lanza UnsafeUrlError. */
  validateTemplate(template: string): void {
    validatePostbackTemplate(template, this.opts.production);
  }

  async findByCode(operatorId: string, code: string): Promise<Affiliate | null> {
    const all = await this.repos.affiliates.list({ operatorId });
    return all.find((a) => a.active && a.code.toLowerCase() === code.toLowerCase()) ?? null;
  }

  /** Captura utm/affiliateCode y dispara el postback de registro. */
  async onRegistered(e: DomainEvents['player.registered']): Promise<void> {
    if (!e.affiliateCode && !e.utm) return;
    const clickId = (e as { clickId?: unknown }).clickId;
    const attr: Attribution = {
      id: `${e.operatorId}:${e.playerId}`, operatorId: e.operatorId, playerId: e.playerId, affiliateCode: e.affiliateCode,
      clickId: typeof clickId === 'string' ? clickId : e.utm?.content, utm: e.utm, createdAt: e.at,
    };
    await this.repos.attributions.put(attr);
    await this.enqueuePostback(attr, 'registration', 0n);
  }

  /** Postback de FTD. */
  async onDeposit(e: DomainEvents['deposit.completed']): Promise<void> {
    if (!e.isFirst) return;
    const attr = await this.repos.attributions.get(`${e.operatorId}:${e.playerId}`);
    if (attr) await this.enqueuePostback(attr, 'ftd', e.amount);
  }

  private buildUrl(template: string, attr: Attribution, event: string, amount: bigint): string {
    const vals: Record<string, string> = {
      click_id: attr.clickId ?? '', player_id: attr.playerId, event, amount: amount.toString(),
    };
    return template.replace(/\{(click_id|player_id|event|amount)\}/g, (_m, k: string) => encodeURIComponent(vals[k]));
  }

  private async enqueuePostback(attr: Attribution, event: 'registration' | 'ftd', amount: bigint): Promise<void> {
    if (!attr.affiliateCode) return;
    const aff = await this.findByCode(attr.operatorId, attr.affiliateCode);
    if (!aff?.postbackUrl) return;
    const now = this.clock().toISOString();
    const log: PostbackLog = {
      id: `${attr.operatorId}:${attr.playerId}:${event}`, operatorId: attr.operatorId, playerId: attr.playerId, affiliateId: aff.id, event,
      url: this.buildUrl(aff.postbackUrl, attr, event, amount), status: 'pending', attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now,
    };
    if (!(await this.repos.postbacks.putIfAbsent(log))) return; // idempotente
    await this.attempt(log);
  }

  private async attempt(log: PostbackLog): Promise<void> {
    log.attempts += 1;
    try {
      const url = validatePostbackTemplate(log.url, this.opts.production);
      if (this.opts.production) await assertResolvesPublic(url, this.opts.resolver ?? defaultResolver);
      const res = await this.fetchFn(url.toString(), { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000) });
      log.httpStatus = res.status;
      if (res.status >= 200 && res.status < 300) {
        log.status = 'ok';
        log.nextAttemptAt = undefined;
        log.lastError = undefined;
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (e) {
      log.lastError = e instanceof Error ? e.message : String(e);
      const unsafe = (e as Error).name === 'UnsafeUrlError';
      if (unsafe || log.attempts >= this.maxAttempts) {
        log.status = 'failed';
        log.nextAttemptAt = undefined;
      } else {
        const mins = RETRY_MINUTES[Math.min(log.attempts - 1, RETRY_MINUTES.length - 1)];
        log.nextAttemptAt = new Date(this.clock().getTime() + mins * 60_000).toISOString();
      }
      this.logger.warn('[marketing] postback fallido', { id: log.id, attempts: log.attempts, error: log.lastError });
    }
    log.updatedAt = this.clock().toISOString();
    await this.repos.postbacks.put(log);
  }

  async tick(now: Date): Promise<void> {
    const due = await this.repos.postbacks.list({ status: 'pending', dueBefore: new Date(now.getTime() + 1).toISOString() });
    for (const log of due) await this.attempt(log);
  }

  /** Snippets de píxel de cliente para el lobby. */
  async pixels(operatorId: string, affiliateCode?: string): Promise<Array<{ affiliateCode: string; event: string; html: string }>> {
    const affs = await this.repos.affiliates.list({ operatorId });
    return affs
      .filter((a) => a.active && (!affiliateCode || a.code.toLowerCase() === affiliateCode.toLowerCase()))
      .flatMap((a) => a.pixels.map((p) => ({ affiliateCode: a.code, event: p.event, html: p.html })));
  }
}
