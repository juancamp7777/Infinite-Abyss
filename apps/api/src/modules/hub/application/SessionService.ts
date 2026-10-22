import { randomBytes, randomUUID } from 'crypto';
import type { EventBus } from '../../shared/events/EventBus';
import type { ModuleLogger } from '../../shared/module';
import type { WalletPort } from '../../shared/ports/WalletPort';
import { hubError } from '../domain/errors';
import type { ProviderAdapter } from '../domain/ProviderAdapter';
import type { RemoteOperatorRepository, SessionRepository } from '../domain/repositories';
import type { Game, HubSession, RemoteOperator, SessionMode, WalletKind } from '../domain/types';
import type { CatalogService } from './CatalogService';

export interface ResolvedSession {
  sessionId: string;
  operatorId: string;
  playerId: string;
  currency: string;
  gameId: string;
  providerId: string;
  mode: SessionMode;
  walletKind: WalletKind;
  remoteOperatorId?: string;
  expiresAt: Date;
}

export interface SessionServiceConfig {
  webUrl: string;
  publicApiUrl: string;
  ttlMs: number;
}

export interface AdapterLookup {
  get(id: string): ProviderAdapter | undefined;
}

export type RemoteWalletFactory = (remote: RemoteOperator, session: HubSession) => WalletPort | null;

/** Billetera demo: InMemoryWallet que siembra saldo ficticio la primera vez que ve a un jugador. */
export interface DemoWallet extends WalletPort {
  ensure(operatorId: string, playerId: string, currency: string): void;
}

export interface LaunchInput {
  gameId: string;
  mode: SessionMode;
  currency: string;
  returnUrl?: string;
  language?: string;
  market?: string;
  /** Operador del lobby (en demo sin login) o del token. */
  operatorId: string;
  /** Requerido en mode=real. */
  playerId?: string;
  device?: string;
}

/**
 * Sesiones de juego del Hub: launch (local y saliente), resolución del token y billetera por sesión.
 */
export class SessionService {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly remoteOperators: RemoteOperatorRepository,
    private readonly catalog: CatalogService,
    private readonly adapters: AdapterLookup,
    private readonly localWallet: WalletPort,
    private readonly demoWallet: DemoWallet,
    private readonly remoteWalletFactory: RemoteWalletFactory,
    private readonly bus: EventBus,
    private readonly cfg: SessionServiceConfig,
    private readonly logger: ModuleLogger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async launch(input: LaunchInput): Promise<{ url: string; sessionId: string; token: string; expiresAt: Date }> {
    const { game } = await this.catalog.assertPlayable(input.gameId, input.operatorId, input.market);
    const adapter = this.adapters.get(game.providerId);
    if (!adapter) throw hubError('GAME_UNAVAILABLE', 'Proveedor sin integración activa');
    if (input.mode === 'demo' && !game.hasDemo) throw hubError('GAME_UNAVAILABLE', 'El juego no tiene modo demo');
    if (input.mode === 'real' && !input.playerId) throw hubError('UNKNOWN_SESSION', 'Se requiere jugador autenticado');

    const session = await this.createSession({
      operatorId: input.operatorId,
      playerId: input.mode === 'real' ? input.playerId! : `demo-${randomUUID()}`,
      providerId: game.providerId,
      gameId: game.id,
      currency: input.currency,
      mode: input.mode,
      walletKind: input.mode === 'real' ? 'local' : 'demo',
    });

    const base = { returnUrl: input.returnUrl, language: input.language, publicApiUrl: this.cfg.publicApiUrl, webUrl: this.cfg.webUrl };
    // Studios (interno) siempre necesita sesión, también en demo; los externos tienen su propio demo.
    const { url } =
      input.mode === 'demo' && adapter.id !== 'nymfo-studios'
        ? await adapter.launchDemo({ ...base, game, currency: input.currency })
        : await adapter.launchGame({ ...base, game, session });

    if (input.mode === 'real') {
      await this.safePublish(() =>
        this.bus.publish('session.started', {
          operatorId: session.operatorId,
          playerId: session.playerId,
          at: this.now().toISOString(),
          sessionId: session.id,
          ...(input.device ? { device: input.device } : {}),
        }),
      );
    }
    return { url, sessionId: session.id, token: session.token, expiresAt: session.expiresAt };
  }

  /** Lado saliente: un casino remoto lanza un juego de Studios para su jugador. */
  async launchForRemote(
    remote: RemoteOperator,
    input: { playerId: string; gameId: string; currency: string; mode: SessionMode; returnUrl?: string },
  ): Promise<{ url: string; sessionId: string; token: string; expiresAt: Date }> {
    if (remote.status !== 'active') throw hubError('UNKNOWN_OPERATOR', 'Operador remoto desactivado');
    if (remote.currencies.length > 0 && !remote.currencies.includes(input.currency)) {
      throw hubError('CURRENCY_MISMATCH', 'Moneda no habilitada para el operador remoto');
    }
    const game: Game | null = await this.catalog.findGame(input.gameId);
    if (!game || game.providerId !== 'nymfo-studios' || game.status !== 'active') {
      throw hubError('GAME_NOT_FOUND', 'Solo se distribuyen juegos activos de Nymfo Studios');
    }
    const adapter = this.adapters.get('nymfo-studios');
    if (!adapter) throw hubError('GAME_UNAVAILABLE', 'Studios no disponible');
    const session = await this.createSession({
      operatorId: remote.id,
      playerId: input.playerId,
      providerId: game.providerId,
      gameId: game.id,
      currency: input.currency,
      mode: input.mode,
      walletKind: input.mode === 'real' ? 'remote' : 'demo',
      remoteOperatorId: remote.id,
    });
    const { url } = await adapter.launchGame({
      session,
      game,
      returnUrl: input.returnUrl,
      publicApiUrl: this.cfg.publicApiUrl,
      webUrl: this.cfg.webUrl,
    });
    return { url, sessionId: session.id, token: session.token, expiresAt: session.expiresAt };
  }

  /** Sesión por token, o null si no existe o expiró. */
  async resolveSession(token: string): Promise<ResolvedSession | null> {
    const s = await this.sessions.findByToken(token);
    if (!s || s.expiresAt.getTime() <= this.now().getTime()) return null;
    return toResolved(s);
  }

  /**
   * Busca una sesión por token o id. allowExpired permite liquidar (win/rollback) rondas
   * cuya sesión expiró mientras se jugaban.
   */
  async findSession(tokenOrId: string, opts: { allowExpired?: boolean } = {}): Promise<HubSession> {
    const s = (await this.sessions.findByToken(tokenOrId)) ?? (isUuid(tokenOrId) ? await this.sessions.findById(tokenOrId) : null);
    if (!s) throw hubError('UNKNOWN_SESSION', 'Sesión desconocida');
    if (!opts.allowExpired && s.expiresAt.getTime() <= this.now().getTime()) throw hubError('SESSION_EXPIRED', 'Sesión expirada');
    return s;
  }

  /** Extiende la sesión (deslizante) tras actividad del jugador. */
  async touch(s: HubSession): Promise<void> {
    await this.sessions.touch(s.id, new Date(this.now().getTime() + this.cfg.ttlMs));
  }

  /** Billetera correcta para una sesión ya cargada. */
  async walletFor(s: HubSession): Promise<WalletPort> {
    if (s.walletKind === 'local') return this.localWallet;
    if (s.walletKind === 'demo') {
      this.demoWallet.ensure(s.operatorId, s.playerId, s.currency);
      return this.demoWallet;
    }
    const remote = s.remoteOperatorId ? await this.remoteOperators.get(s.remoteOperatorId) : null;
    if (!remote) throw hubError('UNKNOWN_OPERATOR', 'Operador remoto desconocido');
    const w = this.remoteWalletFactory(remote, s);
    if (!w) throw hubError('UNKNOWN_OPERATOR', 'Operador remoto sin secreto configurado');
    return w;
  }

  /**
   * WalletPort síncrono para una sesión (token, id o el objeto resuelto). Cada operación resuelve la sesión
   * y delega en la billetera local, demo o remota. Lanza UNKNOWN_SESSION si la sesión no existe.
   */
  walletForSession(ref: string | { sessionId: string }): WalletPort {
    const key = typeof ref === 'string' ? ref : ref.sessionId;
    const target = async (): Promise<WalletPort> => this.walletFor(await this.findSession(key, { allowExpired: true }));
    return {
      getBalance: async (o, p, c) => (await target()).getBalance(o, p, c),
      debit: async (r) => (await target()).debit(r),
      credit: async (r) => (await target()).credit(r),
      rollback: async (r) => (await target()).rollback(r),
    };
  }

  private async createSession(data: Omit<HubSession, 'id' | 'token' | 'expiresAt' | 'createdAt'>): Promise<HubSession> {
    const now = this.now();
    return this.sessions.create({
      ...data,
      id: randomUUID(),
      token: randomBytes(24).toString('base64url'),
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.cfg.ttlMs),
    });
  }

  private async safePublish(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.logger.error('hub: fallo al publicar evento', { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export function toResolved(s: HubSession): ResolvedSession {
  return {
    sessionId: s.id,
    operatorId: s.operatorId,
    playerId: s.playerId,
    currency: s.currency,
    gameId: s.gameId,
    providerId: s.providerId,
    mode: s.mode,
    walletKind: s.walletKind,
    ...(s.remoteOperatorId ? { remoteOperatorId: s.remoteOperatorId } : {}),
    expiresAt: s.expiresAt,
  };
}
