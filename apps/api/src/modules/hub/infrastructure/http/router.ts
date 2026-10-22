import express, { Request, Response, Router } from 'express';
import type { IncomingMessage } from 'http';
import { z } from 'zod';
import { verifyHmac } from '../../../shared/crypto/hmac';
import { asyncHandler, HttpError, moduleErrorHandler, sendJson, toErrorResponse } from '../../../shared/http/errors';
import { optionalAuth, requireAuth, requirePlayer, requireRole, scopeOperator, scopeOperatorOptional } from '../../../shared/http/auth';
import { parse } from '../../../shared/http/validate';
import type { ModuleLogger } from '../../../shared/module';
import type { AuthPort } from '../../../shared/ports/AuthPort';
import { resolveOperatorCurrency, type OperatorCurrencyPort } from '../../../shared/ports/OperatorCurrencyPort';
import type { CatalogService } from '../../application/CatalogService';
import type { ReportService } from '../../application/ReportService';
import type { SeamlessWalletService } from '../../application/SeamlessWalletService';
import type { SessionService } from '../../application/SessionService';
import { hubError } from '../../domain/errors';
import type { RemoteOperatorRepository } from '../../domain/repositories';
import { envKey, GAME_CATEGORIES } from '../../domain/types';
import { WALLET_SCHEMAS, WalletAction } from '../../domain/walletProtocol';
import type { ProviderAdapterRegistry } from '../adapters/registry';
import { gameArtSvg } from './assets';

declare module 'http' {
  interface IncomingMessage {
    /** Cuerpo crudo capturado por captureRawBody (necesario para verificar firmas HMAC). */
    rawBody?: Buffer;
  }
}

/**
 * `verify` para express.json que guarda el cuerpo crudo en req.rawBody.
 * Si el servidor ya aplica express.json() global antes de montar los módulos, debe usar
 * `express.json({ verify: captureRawBody })` para que las firmas se verifiquen sobre los bytes exactos.
 */
export function captureRawBody(req: IncomingMessage, _res: unknown, buf: Buffer): void {
  req.rawBody = Buffer.from(buf);
}

export interface HubRouterContext {
  auth: AuthPort;
  catalog: CatalogService;
  sessions: SessionService;
  wallet: SeamlessWalletService;
  reports: ReportService;
  adapters: ProviderAdapterRegistry;
  remoteOperators: RemoteOperatorRepository;
  env: NodeJS.ProcessEnv;
  /** Moneda del operador cuando el launch no indica currency. */
  operators?: OperatorCurrencyPort;
  logger: ModuleLogger;
}

const zCategory = z.enum(GAME_CATEGORIES as unknown as [string, ...string[]]);
const zMarket = z.string().regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase());
const zCurrency = z.string().regex(/^[A-Za-z0-9]{3,10}$/).transform((s) => s.toUpperCase());

const gamesQuery = z.object({
  operatorId: z.string().min(1).max(64).optional(),
  category: zCategory.optional(),
  provider: z.string().min(1).max(64).optional(),
  q: z.string().max(80).optional(),
  tag: z.string().max(40).optional(),
  market: zMarket.optional(),
  sort: z.enum(['new', 'popular', 'az', 'default']).optional(),
  page: z.coerce.number().int().min(1).max(10000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

const launchBody = z.object({
  mode: z.enum(['real', 'demo']),
  /** Opcional: por defecto la moneda del jugador (User.currency) o la del operador (Operator.defaultCurrency). */
  currency: zCurrency.optional(),
  returnUrl: z.string().url().max(500).optional(),
  language: z.string().max(10).optional(),
  market: zMarket.optional(),
  /** Solo demo sin login: operador del lobby. */
  operatorId: z.string().min(1).max(64).optional(),
  device: z.string().max(40).optional(),
});

const providerBody = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().min(1).max(80),
  type: z.enum(['internal', 'external', 'aggregator']),
  status: z.enum(['active', 'disabled']).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const gameBody = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,120}$/).optional(),
  providerId: z.string().min(1).max(64),
  externalId: z.string().min(1).max(120).optional(),
  title: z.string().min(1).max(120),
  category: zCategory,
  mechanic: z.string().max(60).optional(),
  rtp: z.number().min(50).max(100).optional(),
  volatility: z.enum(['low', 'medium', 'high', 'very_high']).optional(),
  images: z.object({ thumb: z.string().max(500).optional(), banner: z.string().max(500).optional() }).optional(),
  tags: z.array(z.string().max(40)).max(30).optional(),
  allowedMarkets: z.array(zMarket).max(250).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  hasDemo: z.boolean().optional(),
  releasedAt: z.coerce.date().optional(),
  popularity: z.number().int().min(0).optional(),
});

const remoteOperatorBody = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().min(1).max(80),
  walletCallbackUrl: z.string().url().max(500),
  status: z.enum(['active', 'disabled']).optional(),
  currencies: z.array(zCurrency).max(50).optional(),
});

const outboundLaunchBody = z.object({
  playerId: z.string().min(1).max(128),
  gameId: z.string().min(1).max(128),
  currency: zCurrency,
  mode: z.enum(['real', 'demo']).default('real'),
  returnUrl: z.string().url().max(500).optional(),
});

const reportQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  operatorId: z.string().min(1).max(64).optional(),
  providerId: z.string().min(1).max(64).optional(),
  format: z.enum(['json', 'csv']).optional(),
});

const header = (req: Request, name: string): string | undefined => {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/** Raw body exacto; si un parser global ya consumió el stream, se usa JSON.stringify(body) (mismas reglas de firma). */
function rawBodyOf(req: Request, logger: ModuleLogger): Buffer {
  if (req.rawBody) return req.rawBody;
  logger.warn('hub: raw body no capturado; usa express.json({ verify: captureRawBody }) en el parser global');
  return Buffer.from(req.body === undefined ? '' : JSON.stringify(req.body));
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function createHubRouter(ctx: HubRouterContext): Router {
  const r = Router();
  r.use(express.json({ limit: '256kb', verify: captureRawBody }));
  const auth = requireAuth(ctx.auth);

  // ---------------- Catálogo público ----------------
  r.get(
    '/games',
    asyncHandler(async (req, res) => {
      const q = parse(gamesQuery, req.query);
      sendJson(res, await ctx.catalog.listGames({ ...q, category: q.category as never }));
    }),
  );

  r.get(
    '/games/:id',
    asyncHandler(async (req, res) => {
      const q = parse(z.object({ operatorId: z.string().max(64).optional(), market: zMarket.optional() }), req.query);
      sendJson(res, await ctx.catalog.getGameView(String(req.params.id), q.operatorId, q.market));
    }),
  );

  r.get(
    '/providers',
    asyncHandler(async (_req, res) => {
      const list = await ctx.catalog.listProviders();
      sendJson(res, { items: list.map(({ id, name, type, config }) => ({ id, name, type, config })) });
    }),
  );

  r.post(
    '/games/:id/launch',
    optionalAuth(ctx.auth),
    asyncHandler(async (req, res) => {
      const body = parse(launchBody, req.body);
      const gameId = String(req.params.id);
      if (body.mode === 'real') {
        if (!req.principal) throw new HttpError(401, 'UNAUTHORIZED', 'Inicia sesión para jugar con dinero real');
        const { operatorId, playerId } = requirePlayer(req);
        const currency = body.currency ?? req.principal.currency ?? (await resolveOperatorCurrency(ctx.operators, operatorId, ctx.env.HUB_DEFAULT_CURRENCY, ctx.logger));
        const out = await ctx.sessions.launch({ ...body, currency, gameId, operatorId, playerId });
        return sendJson(res, { url: out.url, sessionId: out.sessionId, expiresAt: out.expiresAt }, 201);
      }
      const operatorId = req.principal?.operatorId ?? body.operatorId ?? ctx.env.HUB_DEFAULT_OPERATOR_ID ?? 'default';
      const currency = body.currency ?? req.principal?.currency ?? (await resolveOperatorCurrency(ctx.operators, operatorId, ctx.env.HUB_DEFAULT_CURRENCY, ctx.logger));
      const out = await ctx.sessions.launch({ ...body, currency, gameId, operatorId, playerId: undefined });
      sendJson(res, { url: out.url, sessionId: out.sessionId, expiresAt: out.expiresAt }, 201);
    }),
  );

  r.get(
    '/assets/games/:id/:file',
    asyncHandler(async (req, res) => {
      const file = String(req.params.file);
      if (file !== 'thumb.svg' && file !== 'banner.svg') throw new HttpError(404, 'NOT_FOUND', 'Recurso no encontrado');
      const game = await ctx.catalog.findGame(String(req.params.id));
      if (!game) throw hubError('GAME_NOT_FOUND', 'Juego no encontrado');
      const provider = (await ctx.catalog.listProviders(true)).find((p) => p.id === game.providerId);
      res
        .status(200)
        .type('image/svg+xml')
        .set('Cache-Control', 'public, max-age=86400')
        .send(gameArtSvg({ ...game, providerName: provider?.name }, file === 'thumb.svg' ? 'thumb' : 'banner'));
    }),
  );

  // ---------------- Seamless wallet entrante ----------------
  r.post('/wallet/:action', async (req: Request, res: Response) => {
    const action = String(req.params.action) as WalletAction;
    const providerId = header(req, 'x-provider-id');
    const adapter = providerId ? ctx.adapters.get(providerId) : undefined;
    const fail = (err: unknown) => {
      const { status, body } = toErrorResponse(err);
      if (status >= 500) ctx.logger.error('hub: error en seamless wallet', { action, providerId, error: err instanceof Error ? err.message : String(err) });
      const mapped = adapter && action in WALLET_SCHEMAS
        ? adapter.mapError(action, { status, code: body.error.code, message: body.error.message })
        : { status, body: { status: 'ERROR', error: body.error } };
      res.status(mapped.status).json(mapped.body);
    };
    try {
      if (!(action in WALLET_SCHEMAS)) throw new HttpError(404, 'NOT_FOUND', 'Acción de billetera desconocida');
      if (!adapter || adapter.id === 'nymfo-studios') throw hubError('UNKNOWN_PROVIDER', 'Proveedor desconocido');
      if (!adapter.verifySignature({ rawBody: rawBodyOf(req, ctx.logger), headers: req.headers })) {
        throw hubError('INVALID_SIGNATURE', 'Firma inválida');
      }
      const provider = (await ctx.catalog.listProviders(true)).find((p) => p.id === adapter.id);
      if (provider && provider.status !== 'active') throw hubError('PROVIDER_DISABLED', 'Proveedor desactivado');
      const input = adapter.mapRequest(action, req.body);
      let out;
      switch (action) {
        case 'balance':
          out = await ctx.wallet.balance(adapter, parse(WALLET_SCHEMAS.balance, input));
          break;
        case 'bet':
          out = await ctx.wallet.bet(adapter, parse(WALLET_SCHEMAS.bet, input));
          break;
        case 'win':
          out = await ctx.wallet.win(adapter, parse(WALLET_SCHEMAS.win, input));
          break;
        case 'rollback':
          out = await ctx.wallet.rollback(adapter, parse(WALLET_SCHEMAS.rollback, input));
          break;
      }
      sendJson(res, adapter.mapResponse(action, out));
    } catch (e) {
      fail(e);
    }
  });

  // ---------------- Lado saliente (Nymfo como proveedor) ----------------
  r.get(
    '/outbound/games',
    asyncHandler(async (_req, res) => {
      const page = await ctx.catalog.listGames({ provider: 'nymfo-studios', pageSize: 100 });
      sendJson(res, {
        items: page.items.map((g) => ({ id: g.id, title: g.title, category: g.category, mechanic: g.mechanic, rtp: g.rtp, volatility: g.volatility, images: g.images, tags: g.tags })),
      });
    }),
  );

  r.post(
    '/outbound/launch',
    asyncHandler(async (req, res) => {
      const operatorId = header(req, 'x-operator-id');
      const remote = operatorId ? await ctx.remoteOperators.get(operatorId) : null;
      const secret = remote ? ctx.env[`HUB_REMOTE_${envKey(remote.id)}_SECRET`] : undefined;
      if (!remote || !secret) throw hubError('UNKNOWN_OPERATOR', 'Operador remoto desconocido');
      if (!verifyHmac(secret, rawBodyOf(req, ctx.logger), header(req, 'x-signature'))) throw hubError('INVALID_SIGNATURE', 'Firma inválida');
      const body = parse(outboundLaunchBody, req.body);
      const out = await ctx.sessions.launchForRemote(remote, body);
      sendJson(res, { url: out.url, sessionId: out.sessionId, sessionToken: out.token, expiresAt: out.expiresAt }, 201);
    }),
  );

  // ---------------- Administración ----------------
  const platform = [auth, requireRole('PLATFORM_ADMIN')];
  const staff = [auth, requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN')];

  r.get(
    '/admin/providers',
    ...staff,
    asyncHandler(async (_req, res) => {
      const list = await ctx.catalog.listProviders(true);
      sendJson(res, { items: list.map((p) => ({ ...p, integrated: Boolean(ctx.adapters.get(p.id)) })) });
    }),
  );
  r.post(
    '/admin/providers',
    ...platform,
    asyncHandler(async (req, res) => sendJson(res, await ctx.catalog.upsertProvider(parse(providerBody, req.body)), 201)),
  );
  r.patch(
    '/admin/providers/:id',
    ...platform,
    asyncHandler(async (req, res) =>
      sendJson(res, await ctx.catalog.patchProvider(String(req.params.id), parse(providerBody.omit({ id: true }).partial(), req.body))),
    ),
  );
  r.delete(
    '/admin/providers/:id',
    ...platform,
    asyncHandler(async (req, res) => {
      if (!(await ctx.catalog.deleteProvider(String(req.params.id)))) throw hubError('UNKNOWN_PROVIDER', 'Proveedor no encontrado');
      res.status(204).end();
    }),
  );
  r.post(
    '/admin/providers/:id/sync',
    ...platform,
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const adapter = ctx.adapters.get(id);
      if (!adapter) throw hubError('UNKNOWN_PROVIDER', 'Proveedor sin adaptador activo (revisa sus variables de entorno)');
      const dtos = await adapter.syncCatalog();
      sendJson(res, await ctx.catalog.syncProvider(id, dtos));
    }),
  );

  r.get(
    '/admin/games',
    ...staff,
    asyncHandler(async (req, res) => {
      const q = parse(gamesQuery, req.query);
      sendJson(res, await ctx.catalog.listGames({ ...q, category: q.category as never, includeDisabled: true }));
    }),
  );
  r.post(
    '/admin/games',
    ...platform,
    asyncHandler(async (req, res) => {
      const b = parse(gameBody, req.body);
      sendJson(res, await ctx.catalog.upsertGame({ ...b, category: b.category as never }), 201);
    }),
  );
  r.patch(
    '/admin/games/:id',
    ...platform,
    asyncHandler(async (req, res) => {
      const b = parse(gameBody.omit({ id: true, providerId: true }).partial(), req.body);
      sendJson(res, await ctx.catalog.patchGame(String(req.params.id), { ...b, category: b.category as never }));
    }),
  );
  r.delete(
    '/admin/games/:id',
    ...platform,
    asyncHandler(async (req, res) => {
      if (!(await ctx.catalog.deleteGame(String(req.params.id)))) throw hubError('GAME_NOT_FOUND', 'Juego no encontrado');
      res.status(204).end();
    }),
  );

  r.get(
    '/admin/operators/:operatorId/games',
    ...staff,
    asyncHandler(async (req, res) => {
      const op = scopeOperator(req, String(req.params.operatorId));
      sendJson(res, { items: await ctx.catalog.listOperatorGames(op) });
    }),
  );
  r.put(
    '/admin/operators/:operatorId/games/:gameId',
    ...staff,
    asyncHandler(async (req, res) => {
      const op = scopeOperator(req, String(req.params.operatorId));
      const b = parse(z.object({ enabled: z.boolean().optional(), sortOrder: z.number().int().min(0).max(100000).optional() }), req.body);
      sendJson(res, await ctx.catalog.setOperatorGame(op, String(req.params.gameId), b));
    }),
  );
  r.put(
    '/admin/operators/:operatorId/order',
    ...staff,
    asyncHandler(async (req, res) => {
      const op = scopeOperator(req, String(req.params.operatorId));
      const b = parse(z.object({ gameIds: z.array(z.string().min(1).max(128)).min(1).max(2000) }), req.body);
      sendJson(res, { items: await ctx.catalog.setOperatorOrder(op, b.gameIds) });
    }),
  );

  r.get(
    '/admin/reports/providers',
    ...staff,
    asyncHandler(async (req, res) => {
      const q = parse(reportQuery, req.query);
      const operatorId = scopeOperatorOptional(req, q.operatorId);
      const report = await ctx.reports.providers({ from: q.from, to: q.to, providerId: q.providerId, operatorId });
      if (q.format === 'csv') {
        const lines = ['providerId,gameId,title,bets,wins,ggr,rounds,openRounds'];
        for (const g of report.games) {
          lines.push([g.providerId, g.gameId, g.title, g.bets, g.wins, g.ggr, g.rounds, g.openRounds].map(csvCell).join(','));
        }
        res.status(200).type('text/csv').set('Content-Disposition', 'attachment; filename="hub-report.csv"').send(lines.join('\n') + '\n');
        return;
      }
      sendJson(res, report);
    }),
  );

  r.get(
    '/admin/remote-operators',
    ...platform,
    asyncHandler(async (_req, res) => {
      const list = await ctx.remoteOperators.list();
      sendJson(res, { items: list.map((o) => ({ ...o, hasSecret: Boolean(ctx.env[`HUB_REMOTE_${envKey(o.id)}_SECRET`]) })) });
    }),
  );
  r.post(
    '/admin/remote-operators',
    ...platform,
    asyncHandler(async (req, res) => {
      const b = parse(remoteOperatorBody, req.body);
      const prev = await ctx.remoteOperators.get(b.id);
      const saved = await ctx.remoteOperators.save({
        id: b.id,
        name: b.name,
        walletCallbackUrl: b.walletCallbackUrl,
        status: b.status ?? prev?.status ?? 'active',
        currencies: b.currencies ?? prev?.currencies ?? [],
        createdAt: prev?.createdAt ?? new Date(),
      });
      sendJson(res, { ...saved, hasSecret: Boolean(ctx.env[`HUB_REMOTE_${envKey(saved.id)}_SECRET`]) }, prev ? 200 : 201);
    }),
  );

  r.use(moduleErrorHandler(ctx.logger));
  return r;
}
