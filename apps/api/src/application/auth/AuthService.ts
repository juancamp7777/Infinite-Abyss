import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma, type PrismaClient, type User } from '@prisma/client';
import type { BackofficeRoleName, TenantContext } from '../../domain/contracts';
import { AppError } from '../../domain/errors/AppError';
import { normalizeEmail } from '../../domain/accounts/passwordPolicy';
import type { JwtService } from '../../infrastructure/auth/JwtService';
import { publishSafe, type DomainEventSink, type ErrorLogger } from '../../infrastructure/modules/events/publishSafe';

export interface AuthServiceOptions {
  /** Coste de bcrypt (12 en producción; bajo solo en tests). */
  bcryptCost?: number;
  refreshTtlDays: number;
  /** Inactividad tras la cual el login abre una PlayerSession nueva. */
  sessionIdleMinutes?: number;
  now?: () => Date;
  /** Bus de eventos de dominio (player.registered, login, session.started). Se publica tras el commit. */
  events?: DomainEventSink;
  logger?: ErrorLogger;
}

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface PublicUser {
  id: string;
  email: string;
  username: string | null;
  currency: string;
  kycStatus: string;
  status: string;
  isDemo: boolean;
  operatorId: string;
}

export interface PlayerAuthResult {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

export interface BackofficeAuthResult {
  accessToken: string;
  user: { id: string; email: string; role: BackofficeRoleName; operatorId: string | null };
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
const GENERIC_LOGIN_ERROR = 'Correo o contraseña incorrectos';

export function toPublicUser(u: User): PublicUser {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    currency: u.currency,
    kycStatus: u.kycStatus,
    status: u.status,
    isDemo: u.isDemo,
    operatorId: u.operatorId,
  };
}

export class AuthService {
  private readonly cost: number;
  private readonly now: () => Date;
  private dummyHash?: Promise<string>;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly jwt: JwtService,
    private readonly opts: AuthServiceOptions,
  ) {
    this.cost = opts.bcryptCost ?? 12;
    this.now = opts.now ?? (() => new Date());
  }

  /** Hash falso para igualar el tiempo de login cuando el usuario no existe. */
  private getDummyHash(): Promise<string> {
    this.dummyHash ??= bcrypt.hash(randomBytes(16).toString('hex'), this.cost);
    return this.dummyHash;
  }

  async register(
    tenant: TenantContext,
    input: { email: string; password: string; username?: string },
    meta: RequestMeta = {},
  ): Promise<PlayerAuthResult> {
    const passwordHash = await bcrypt.hash(input.password, this.cost);
    let user: User;
    try {
      user = await this.prisma.user.create({
        data: {
          operatorId: tenant.operatorId,
          email: input.email.trim(),
          emailNormalized: normalizeEmail(input.email),
          username: input.username ?? null,
          passwordHash,
          currency: tenant.defaultCurrency,
          rgSettings: { create: { operatorId: tenant.operatorId } },
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw AppError.conflict('El correo o el usuario ya están registrados');
      }
      throw e;
    }
    return this.startPlayerSession(user, meta, 'register');
  }

  async login(
    tenant: TenantContext,
    input: { email: string; password: string },
    meta: RequestMeta = {},
  ): Promise<PlayerAuthResult> {
    const user = await this.prisma.user.findUnique({
      where: {
        operatorId_emailNormalized: { operatorId: tenant.operatorId, emailNormalized: normalizeEmail(input.email) },
      },
    });
    // Siempre se ejecuta una comparación bcrypt, exista o no el usuario.
    const ok = await bcrypt.compare(input.password, user ? user.passwordHash : await this.getDummyHash());
    if (!user || !ok || user.status !== 'ACTIVE') throw AppError.unauthorized(GENERIC_LOGIN_ERROR);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: this.now() } });
    return this.startPlayerSession(user, meta, 'login');
  }

  async refresh(tenant: TenantContext, refreshToken: string, meta: RequestMeta = {}): Promise<PlayerAuthResult> {
    const tokenHash = hashToken(refreshToken);
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!row || !row.userId) throw AppError.unauthorized('Token de renovación inválido');
    if (row.operatorId !== tenant.operatorId) throw AppError.forbidden('El token no pertenece a este operador');

    const now = this.now();
    // Reutilización de un token ya rotado/revocado → posible robo: se revoca toda la cadena del jugador.
    if (row.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: now },
      });
      throw AppError.unauthorized('Se detectó reutilización del token de renovación. Inicia sesión de nuevo');
    }
    if (row.expiresAt <= now) throw AppError.unauthorized('El token de renovación venció');

    const newId = randomUUID();
    // Reclamo atómico: solo una petición concurrente puede rotar este token.
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: now, replacedById: newId },
    });
    if (claimed.count === 0) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: now },
      });
      throw AppError.unauthorized('Se detectó reutilización del token de renovación. Inicia sesión de nuevo');
    }

    const user = await this.prisma.user.findUnique({ where: { id: row.userId } });
    if (!user || user.status !== 'ACTIVE' || user.operatorId !== tenant.operatorId) {
      throw AppError.unauthorized('Token de renovación inválido');
    }
    const fresh = await this.issueRefresh(user, meta, newId);
    return { accessToken: this.accessFor(user), refreshToken: fresh, user: toPublicUser(user) };
  }

  /** Revoca el refresh token (idempotente; no revela si existía). */
  async logout(tenant: TenantContext, refreshToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(refreshToken), operatorId: tenant.operatorId, revokedAt: null },
      data: { revokedAt: this.now() },
    });
  }

  async loginBackoffice(input: { email: string; password: string }): Promise<BackofficeAuthResult> {
    const u = await this.prisma.backofficeUser.findUnique({ where: { email: normalizeEmail(input.email) } });
    const ok = await bcrypt.compare(input.password, u ? u.passwordHash : await this.getDummyHash());
    if (!u || !ok || u.status !== 'ACTIVE') throw AppError.unauthorized(GENERIC_LOGIN_ERROR);
    const accessToken = this.jwt.signAccess({ sub: u.id, op: u.operatorId ?? '', typ: 'backoffice', role: u.role });
    return { accessToken, user: { id: u.id, email: u.email, role: u.role, operatorId: u.operatorId } };
  }

  // ───────────── internos ─────────────

  private accessFor(user: User): string {
    return this.jwt.signAccess({ sub: user.id, op: user.operatorId, typ: 'player' });
  }

  private async issueRefresh(user: User, meta: RequestMeta, id: string = randomUUID()): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        id,
        tokenHash: hashToken(token),
        userId: user.id,
        operatorId: user.operatorId,
        expiresAt: new Date(this.now().getTime() + this.opts.refreshTtlDays * 86_400_000),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 255) ?? null,
      },
    });
    return token;
  }

  private async startPlayerSession(
    user: User,
    meta: RequestMeta,
    origin: 'register' | 'login',
  ): Promise<PlayerAuthResult> {
    const newSessionId = await this.touchPlayerSession(user);
    const refreshToken = await this.issueRefresh(user, meta);
    await this.emitAuthEvents(user, meta, origin, newSessionId);
    return { accessToken: this.accessFor(user), refreshToken, user: toPublicUser(user) };
  }

  /** Eventos de dominio tras el commit; un fallo de los listeners nunca invalida el registro/login. */
  private async emitAuthEvents(
    user: User,
    meta: RequestMeta,
    origin: 'register' | 'login',
    newSessionId: string | null,
  ): Promise<void> {
    const bus = this.opts.events;
    if (!bus) return;
    const base = { operatorId: user.operatorId, playerId: user.id, at: this.now().toISOString() };
    const log = this.opts.logger;
    if (origin === 'register') {
      await publishSafe(bus, 'player.registered', { ...base, currency: user.currency, email: user.email }, log);
    }
    await publishSafe(bus, 'login', { ...base, ...(meta.ip ? { ip: meta.ip } : {}) }, log);
    if (newSessionId) await publishSafe(bus, 'session.started', { ...base, sessionId: newSessionId }, log);
  }

  /**
   * Reutiliza la sesión abierta si hubo actividad reciente; si no, la cierra y abre otra.
   * Devuelve el id de la sesión nueva o null si se reutilizó una existente.
   */
  private async touchPlayerSession(user: User): Promise<string | null> {
    const now = this.now();
    const idleMs = (this.opts.sessionIdleMinutes ?? 30) * 60_000;
    const open = await this.prisma.playerSession.findFirst({
      where: { userId: user.id, endedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    if (open && now.getTime() - open.lastSeenAt.getTime() <= idleMs) {
      await this.prisma.playerSession.update({ where: { id: open.id }, data: { lastSeenAt: now } });
      return null;
    }
    if (open) {
      await this.prisma.playerSession.updateMany({
        where: { userId: user.id, endedAt: null },
        data: { endedAt: open.lastSeenAt },
      });
    }
    const created = await this.prisma.playerSession.create({
      data: { userId: user.id, operatorId: user.operatorId, startedAt: now, lastSeenAt: now },
    });
    return created.id;
  }
}
