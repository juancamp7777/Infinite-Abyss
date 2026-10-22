import { randomBytes } from 'crypto';
import type { Server as SocketIOServer } from 'socket.io';
import type { DomainEvents, EventBus } from '../../shared/events/EventBus';
import type { ModuleDeps } from '../../shared/module';
import type { SegmentPort } from '../../shared/ports/SegmentPort';
import { buildChannels, type ChannelRegistry, type FetchLike } from '../infrastructure/channels';
import { createInMemoryRepos, createPrismaRepos, type MarketingRepos } from '../infrastructure/stores';
import { AffiliateService } from './AffiliateService';
import { CampaignService } from './CampaignService';
import { JourneyEngine, PlayerStateService } from './JourneyEngine';
import { ConsentService, MessagingService, type MessagingConfig } from './MessagingService';
import type { HostResolver } from '../domain/urlSafety';

export interface RuntimeOptions {
  clock?: () => Date;
  repos?: MarketingRepos;
  channels?: ChannelRegistry;
  fetchFn?: FetchLike;
  resolver?: HostResolver;
  io?: SocketIOServer;
}

export interface MarketingRuntime {
  repos: MarketingRepos;
  messaging: MessagingService;
  consent: ConsentService;
  campaigns: CampaignService;
  journeys: JourneyEngine;
  affiliates: AffiliateService;
  state: PlayerStateService;
  config: MessagingConfig;
  production: boolean;
  /** Procesa campañas programadas, journeys vencidos/temporales y reintentos de postbacks. */
  tick(now?: Date): Promise<void>;
  start(intervalMs?: number): void;
  stop(): void;
  subscribe(bus: EventBus): () => void;
}

const list = (v?: string): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function createRuntime(deps: ModuleDeps, opts: RuntimeOptions = {}): MarketingRuntime {
  const { env, logger } = deps;
  const clock = opts.clock ?? (() => new Date());
  const production = env.NODE_ENV === 'production';
  const repos = opts.repos ?? (deps.prisma ? createPrismaRepos(deps.prisma) : createInMemoryRepos());
  let secret = env.MKT_UNSUBSCRIBE_SECRET;
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    logger.warn('[marketing] MKT_UNSUBSCRIBE_SECRET no definido: se usa un secreto efímero (los enlaces de baja caducan al reiniciar)');
  }
  const config: MessagingConfig = {
    frequencyCapMax: Number(env.MKT_FREQUENCY_CAP_MAX ?? 1),
    frequencyCapHours: Number(env.MKT_FREQUENCY_CAP_HOURS ?? 24),
    // Base de los enlaces de baja/seguimiento. Sin MKT_PUBLIC_BASE_URL ni PUBLIC_API_URL queda relativa (sin localhost).
    publicBaseUrl: (env.MKT_PUBLIC_BASE_URL || env.PUBLIC_API_URL || '').trim().replace(/\/+$/, ''),
    unsubscribeSecret: secret,
    linkAllowlist: list(env.MKT_LINK_ALLOWLIST),
    defaultConversionWindowDays: Number(env.MKT_CONVERSION_WINDOW_DAYS ?? 7),
  };
  const channels =
    opts.channels ?? buildChannels({ env, inbox: repos.inbox, pushSubs: repos.pushSubs, io: opts.io, clock, logger, fetchFn: opts.fetchFn });
  const services = () => deps.services;
  const messaging = new MessagingService({ repos, channels, compliance: deps.compliance, clock, config, logger, services });
  const state = new PlayerStateService(repos, clock);
  const segments = (): SegmentPort | undefined => deps.segments ?? (deps.services['crm.segments'] as SegmentPort | undefined);
  const campaigns = new CampaignService(repos, messaging, segments, clock, logger);
  const journeys = new JourneyEngine(repos, messaging, state, clock, logger, services);
  const affiliates = new AffiliateService(repos, clock, logger, { production, fetchFn: opts.fetchFn, resolver: opts.resolver });
  const consent = new ConsentService(repos, clock);

  let ticking = false;
  const tick = async (now: Date = clock()): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      await campaigns.tick(now);
      await journeys.tick(now);
      await affiliates.tick(now);
    } catch (e) {
      logger.error('[marketing] error en tick', { error: e instanceof Error ? e.message : String(e) });
    } finally {
      ticking = false;
    }
  };

  let timer: NodeJS.Timeout | undefined;

  const subscribe = (bus: EventBus): (() => void) => {
    const off = [
      bus.subscribe('player.registered', async (e: DomainEvents['player.registered']) => {
        await state.onRegistered(e);
        await affiliates.onRegistered(e);
        await journeys.onEvent('player.registered', e);
        await campaigns.onEvent('player.registered', e);
      }),
      bus.subscribe('deposit.completed', async (e: DomainEvents['deposit.completed']) => {
        await state.onDeposit(e);
        await campaigns.attributeDeposit(e, config.defaultConversionWindowDays);
        await affiliates.onDeposit(e);
        await journeys.onEvent('deposit.completed', e);
        await campaigns.onEvent('deposit.completed', e);
      }),
      bus.subscribe('login', async (e: DomainEvents['login']) => {
        await state.onLogin(e);
        await journeys.onEvent('login', e);
        await campaigns.onEvent('login', e);
      }),
      bus.subscribe('bet.settled', async (e: DomainEvents['bet.settled']) => {
        // El estado de apuestas se actualiza dentro del journey de gran pérdida (si no hay ninguno activo no se acumula nada).
        await journeys.onEvent('bet.settled', e);
        await campaigns.onEvent('bet.settled', e);
      }),
    ];
    return () => off.forEach((f) => f());
  };

  return {
    repos, messaging, consent, campaigns, journeys, affiliates, state, config, production, tick, subscribe,
    start(intervalMs = Number(env.MKT_TICK_INTERVAL_MS ?? 60_000)) {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
