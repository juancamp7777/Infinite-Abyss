import { randomUUID } from 'crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { getPrincipal, requireAuth, requirePlayer, requireRole, scopeOperator } from '../../shared/http/auth';
import { asyncHandler, badRequest, HttpError, moduleErrorHandler, notFound, sendJson } from '../../shared/http/errors';
import { parse } from '../../shared/http/validate';
import type { ModuleDeps } from '../../shared/module';
import { isAllowedRedirect, UnsafeUrlError } from '../domain/urlSafety';
import { verifyUnsubscribeToken } from '../domain/unsubscribe';
import { JOURNEY_PRESETS, presetDraft } from '../domain/presets';
import { CHANNEL_KINDS, type Affiliate, type Campaign, type Journey, type Template } from '../domain/types';
import { endpointId } from '../infrastructure/channels';
import type { MarketingRuntime } from '../application/MarketingRuntime';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const channelEnum = z.enum(['email', 'sms', 'whatsapp', 'push', 'inapp']);
const eventEnum = z.enum(['player.registered', 'deposit.completed', 'login', 'bet.settled']);
const minorsString = z.string().regex(/^\d{1,30}$/);

/** Solo rutas internas del casino o imágenes https/propias: una push nunca abre un dominio externo. */
const internal = z.string().max(300).regex(/^\/(?!\/)/, 'Debe ser una ruta del casino (empieza con /)');
const pushDesign = z.object({
  image: z.string().max(500).regex(/^(https:\/\/|\/(?!\/))/, 'Imagen https o propia').optional(),
  url: internal.optional(),
  actions: z.array(z.object({ title: z.string().trim().min(1).max(24), url: internal })).max(2).optional(),
});

const templateSchema = z.object({
  name: z.string().min(1).max(120),
  channel: channelEnum,
  kind: z.enum(['marketing', 'transactional', 'regulatory']).default('marketing'),
  subject: z.string().max(300).optional(),
  body: z.string().min(1).max(100_000),
  push: pushDesign.optional(),
});

const campaignSchema = z.object({
  name: z.string().min(1).max(120),
  segmentId: z.string().min(1).optional(),
  scheduledAt: z.string().datetime().optional(),
  triggerEvent: eventEnum.optional(),
  variants: z.array(z.object({ key: z.string().min(1).max(20), templateId: z.string().min(1), weight: z.number().positive().max(1000) })).min(1).max(5),
  conversionWindowDays: z.number().int().min(1).max(60).default(7),
  status: z.enum(['draft', 'scheduled', 'active', 'paused']).default('draft'),
});

const stepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('wait'), minutes: z.number().int().min(1).max(60 * 24 * 90) }),
  z.object({ type: z.literal('condition'), check: z.enum(['no_deposit', 'has_deposited', 'inactive_since_deposit_days']), value: z.number().int().min(1).optional() }),
  z.object({ type: z.literal('send'), templateId: z.string().min(1) }),
  z.object({ type: z.literal('action'), action: z.literal('grantCashback'), percentBps: z.number().int().min(1).max(10_000) }),
]);
const cancelOn = z.array(z.enum(['deposit.completed', 'login'])).optional();
const triggerSchema = z.union([
  z.object({ type: z.literal('event'), event: eventEnum, cancelOn, lossThreshold: minorsString.optional(), windowHours: z.number().int().min(1).max(168).optional() }),
  z.object({ type: z.literal('time'), condition: z.literal('depositor_inactive'), days: z.number().int().min(1).max(365), cancelOn }),
  z.object({ type: z.literal('time'), condition: z.literal('birthday') }),
]);
const journeySchema = z.object({
  name: z.string().min(1).max(120),
  status: z.enum(['active', 'paused']).default('paused'),
  trigger: triggerSchema,
  steps: z.array(stepSchema).min(1).max(30),
});

const affiliateSchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{2,40}$/),
  name: z.string().min(1).max(120),
  postbackUrl: z.string().max(2000).optional(),
  pixels: z.array(z.object({ event: z.enum(['registration', 'ftd', 'page']), html: z.string().max(5000) })).max(10).default([]),
  active: z.boolean().default(true),
});

const brandSchema = z.object({
  name: z.string().min(1).max(120),
  logoUrl: z.string().url().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional(),
  supportEmail: z.string().email().optional(),
  linkDomains: z.array(z.string().min(3).max(200)).max(50).default([]),
});

const consentPut = z.union([
  z.object({ channel: channelEnum, optIn: z.boolean() }),
  z.object({ channels: z.record(channelEnum, z.boolean()) }),
]);

const pushSchema = z.object({ endpoint: z.string().url().max(2000), keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }) });

const html = (title: string, msg: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font-family:Arial;text-align:center;padding:48px"><h2>${title}</h2><p>${msg}</p></body>`;

export function createMarketingRouter(rt: MarketingRuntime, deps: ModuleDeps): Router {
  const r = Router();
  const now = () => new Date().toISOString();
  const op = (req: Request): string => scopeOperator(req, typeof req.query.operatorId === 'string' ? req.query.operatorId : undefined);

  const owned = <T extends { operatorId: string }>(item: T | null, operatorId: string): T => {
    if (!item || item.operatorId !== operatorId) throw notFound();
    return item;
  };

  // ---------- Públicas: tracking, baja, píxeles ----------
  r.get('/t/o/:file', asyncHandler(async (req, res) => {
    await rt.campaigns.markOpened(String(req.params.file).replace(/\.gif$/i, ''));
    res.set({ 'content-type': 'image/gif', 'cache-control': 'no-store, max-age=0' }).send(GIF);
  }));

  r.get('/t/c/:sendId', asyncHandler(async (req, res) => {
    const log = await rt.repos.sends.get(String(req.params.sendId));
    const target = typeof req.query.u === 'string' ? req.query.u : '';
    if (!log) throw notFound('Envío desconocido');
    const brand = await rt.messaging.getBrand(log.operatorId);
    const url = isAllowedRedirect(target, [...rt.config.linkAllowlist, ...brand.linkDomains]);
    if (!url) throw badRequest('Destino no permitido');
    await rt.campaigns.markClicked(log.id);
    res.redirect(302, url.toString());
  }));

  const unsubscribe = asyncHandler(async (req, res) => {
    const token = typeof req.query.t === 'string' ? req.query.t : '';
    const v = verifyUnsubscribeToken(rt.config.unsubscribeSecret, token);
    if (!v) {
      res.status(400).type('html').send(html('Enlace inválido', 'El enlace de baja no es válido o ha caducado.'));
      return;
    }
    await rt.consent.set(v.operatorId, v.playerId, v.channel, false, 'unsubscribe_link');
    res.type('html').send(html('Baja confirmada', 'No recibirás más mensajes de marketing por este canal.'));
  });
  r.get('/unsubscribe', unsubscribe);
  r.post('/unsubscribe', unsubscribe);

  r.get('/pixels', asyncHandler(async (req, res) => {
    const q = parse(z.object({ operatorId: z.string().min(1), affiliateCode: z.string().optional() }), req.query);
    res.set('cache-control', 'public, max-age=60');
    sendJson(res, { pixels: await rt.affiliates.pixels(q.operatorId, q.affiliateCode), requiresConsent: true });
  }));

  // ---------- Jugador ----------
  const auth = requireAuth(deps.auth);

  r.get('/inbox', auth, asyncHandler(async (req, res) => {
    const { operatorId, playerId } = requirePlayer(req);
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), unreadOnly: z.coerce.boolean().default(false) }), req.query);
    let items = await rt.repos.inbox.list({ operatorId, playerId, limit: q.limit, ...(q.unreadOnly ? { status: 'unread' } : {}) });
    items = items.map((m) => ({ ...m }));
    const unread = (await rt.repos.inbox.list({ operatorId, playerId, status: 'unread' })).length;
    sendJson(res, { items, unread });
  }));

  r.post('/inbox/read-all', auth, asyncHandler(async (req, res) => {
    const { operatorId, playerId } = requirePlayer(req);
    const unread = await rt.repos.inbox.list({ operatorId, playerId, status: 'unread' });
    for (const m of unread) await rt.repos.inbox.put({ ...m, readAt: now() });
    sendJson(res, { updated: unread.length });
  }));

  r.post('/inbox/:id/read', auth, asyncHandler(async (req, res) => {
    const { operatorId, playerId } = requirePlayer(req);
    const m = await rt.repos.inbox.get(String(req.params.id));
    if (!m || m.operatorId !== operatorId || m.playerId !== playerId) throw notFound();
    if (!m.readAt) m.readAt = now();
    sendJson(res, await rt.repos.inbox.put(m));
  }));

  r.get('/consent', auth, asyncHandler(async (req, res) => {
    const { operatorId, playerId } = requirePlayer(req);
    const rows = await rt.consent.list(operatorId, playerId);
    const channels = Object.fromEntries(
      CHANNEL_KINDS.map((c) => {
        const row = rows.find((x) => x.channel === c);
        return [c, { optIn: row?.optIn ?? false, source: row?.source ?? null, at: row?.at ?? null }];
      }),
    );
    sendJson(res, { channels });
  }));

  r.put('/consent', auth, asyncHandler(async (req, res) => {
    const { operatorId, playerId } = requirePlayer(req);
    const body = parse(consentPut, req.body);
    const entries: Array<[string, boolean]> = 'channel' in body ? [[body.channel, body.optIn]] : Object.entries(body.channels);
    for (const [channel, optIn] of entries) await rt.consent.set(operatorId, playerId, channel as (typeof CHANNEL_KINDS)[number], optIn, 'player_settings');
    const rows = await rt.consent.list(operatorId, playerId);
    sendJson(res, { channels: Object.fromEntries(rows.map((c) => [c.channel, { optIn: c.optIn, source: c.source, at: c.at }])) });
  }));

  /** Clave pública VAPID (pública por diseño) para que el navegador se suscriba. */
  r.get('/push/public-key', (_req, res) => sendJson(res, { publicKey: rt.vapidPublicKey }));

  r.post('/push/subscribe', auth, asyncHandler(async (req, res) => {
    const { operatorId, playerId } = requirePlayer(req);
    const b = parse(pushSchema, req.body);
    // Si ese navegador re-envía una suscripción que el servicio de push ya dio por vencida, se le pide una nueva.
    if ((await rt.repos.pushSubs.get(endpointId(b.endpoint)))?.dead) return sendJson(res, { stale: true }, 409);
    const sub = await rt.repos.pushSubs.put({ id: endpointId(b.endpoint), operatorId, playerId, endpoint: b.endpoint, keys: b.keys, createdAt: now() });
    // El permiso del navegador queda registrado como consentimiento del canal push (con historial).
    const cur = await rt.consent.get(operatorId, playerId, 'push');
    if (!cur) await rt.consent.set(operatorId, playerId, 'push', true, 'push_permission');
    sendJson(res, { id: sub.id }, 201);
  }));

  r.delete('/push/subscribe', auth, asyncHandler(async (req, res) => {
    const { operatorId, playerId } = requirePlayer(req);
    const b = parse(z.object({ endpoint: z.string().url() }), req.body);
    const sub = await rt.repos.pushSubs.get(endpointId(b.endpoint));
    if (sub && sub.operatorId === operatorId && sub.playerId === playerId) await rt.repos.pushSubs.delete(sub.id);
    sendJson(res, { ok: true });
  }));

  // ---------- Admin ----------
  const admin = Router();
  admin.use(auth, requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN'));

  const ownedTemplates = async (operatorId: string, ids: string[]) => {
    for (const id of ids) owned(await rt.repos.templates.get(id), operatorId);
  };

  /** Envío directo a un jugador desde el CRM (respeta consentimiento, autoexclusión y frecuencia en marketing). */
  admin.post('/send', asyncHandler(async (req, res) => {
    const operatorId = op(req);
    const b = parse(z.object({ playerId: z.string().min(1).max(100), templateId: z.string().min(1).max(100) }), req.body);
    const tpl = owned(await rt.repos.templates.get(b.templateId), operatorId);
    const sendReq = { operatorId, playerId: b.playerId, templateId: tpl.id };
    sendJson(res, tpl.kind === 'marketing' ? await rt.messaging.sendMarketing(sendReq) : await rt.messaging.sendTransactional(sendReq), 201);
  }));

  /** Dispositivos con push activo (y si el servidor tiene claves VAPID). */
  admin.get('/push/stats', asyncHandler(async (req, res) => {
    const subs = (await rt.repos.pushSubs.list({ operatorId: op(req) })).filter((s) => !s.dead);
    sendJson(res, { enabled: !!rt.vapidPublicKey, devices: subs.length, players: new Set(subs.map((s) => s.playerId)).size });
  }));

  /**
   * Push a todos los jugadores con notificaciones activas: crea la plantilla (queda en el historial y las métricas) y
   * envía en segundo plano respetando el consentimiento de marketing de cada jugador.
   */
  admin.post('/push/broadcast', asyncHandler(async (req, res) => {
    const operatorId = op(req);
    const b = parse(z.object({ title: z.string().trim().min(1).max(80), body: z.string().trim().min(1).max(300), push: pushDesign.default({}) }), req.body);
    const subs = (await rt.repos.pushSubs.list({ operatorId })).filter((s) => !s.dead);
    const players = [...new Set(subs.map((s) => s.playerId))];
    const t: Template = { id: randomUUID(), operatorId, name: `Push · ${b.title}`.slice(0, 120), channel: 'push', kind: 'marketing', subject: b.title, body: b.body, push: b.push, createdAt: now(), updatedAt: now() };
    await rt.repos.templates.put(t);
    void (async () => {
      for (const playerId of players) {
        await rt.messaging.sendMarketing({ operatorId, playerId, templateId: t.id }).catch(() => undefined);
      }
    })();
    sendJson(res, { templateId: t.id, audience: players.length, devices: subs.length }, 202);
  }));

  // plantillas
  admin.get('/templates', asyncHandler(async (req, res) => sendJson(res, { items: await rt.repos.templates.list({ operatorId: op(req) }) })));
  admin.post('/templates', asyncHandler(async (req, res) => {
    const b = parse(templateSchema, req.body);
    const t: Template = { id: randomUUID(), operatorId: op(req), ...b, createdAt: now(), updatedAt: now() };
    sendJson(res, await rt.repos.templates.put(t), 201);
  }));
  admin.put('/templates/:id', asyncHandler(async (req, res) => {
    const cur = owned(await rt.repos.templates.get(String(req.params.id)), op(req));
    sendJson(res, await rt.repos.templates.put({ ...cur, ...parse(templateSchema, req.body), updatedAt: now() }));
  }));
  admin.delete('/templates/:id', asyncHandler(async (req, res) => {
    const cur = owned(await rt.repos.templates.get(String(req.params.id)), op(req));
    await rt.repos.templates.delete(cur.id);
    sendJson(res, { ok: true });
  }));

  // campañas
  const buildCampaign = async (operatorId: string, b: z.infer<typeof campaignSchema>, id: string, prev?: Campaign): Promise<Campaign> => {
    await ownedTemplates(operatorId, b.variants.map((v) => v.templateId));
    if (b.status === 'scheduled' && (!b.scheduledAt || !b.segmentId)) throw badRequest('Una campaña programada requiere scheduledAt y segmentId');
    if (b.status === 'active' && !b.triggerEvent) throw badRequest('Una campaña activa por evento requiere triggerEvent');
    if (new Set(b.variants.map((v) => v.key)).size !== b.variants.length) throw badRequest('Claves de variante duplicadas');
    return { id, operatorId, ...b, stats: prev?.stats ?? { audience: 0, processed: 0 }, createdAt: prev?.createdAt ?? now(), updatedAt: now() };
  };
  admin.get('/campaigns', asyncHandler(async (req, res) => sendJson(res, { items: await rt.repos.campaigns.list({ operatorId: op(req) }) })));
  admin.post('/campaigns', asyncHandler(async (req, res) => {
    const operatorId = op(req);
    sendJson(res, await rt.repos.campaigns.put(await buildCampaign(operatorId, parse(campaignSchema, req.body), randomUUID())), 201);
  }));
  admin.put('/campaigns/:id', asyncHandler(async (req, res) => {
    const operatorId = op(req);
    const cur = owned(await rt.repos.campaigns.get(String(req.params.id)), operatorId);
    if (cur.status === 'running' || cur.status === 'done') throw new HttpError(409, 'CAMPAIGN_LOCKED', 'La campaña ya fue ejecutada');
    sendJson(res, await rt.repos.campaigns.put(await buildCampaign(operatorId, parse(campaignSchema, req.body), cur.id, cur)));
  }));
  admin.delete('/campaigns/:id', asyncHandler(async (req, res) => {
    const cur = owned(await rt.repos.campaigns.get(String(req.params.id)), op(req));
    await rt.repos.campaigns.delete(cur.id);
    sendJson(res, { ok: true });
  }));
  admin.post('/campaigns/:id/launch', asyncHandler(async (req, res) => {
    const cur = owned(await rt.repos.campaigns.get(String(req.params.id)), op(req));
    try {
      sendJson(res, await rt.campaigns.launch(cur));
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : 'No se pudo lanzar');
    }
  }));
  admin.get('/campaigns/:id/metrics', asyncHandler(async (req, res) => {
    const operatorId = op(req);
    owned(await rt.repos.campaigns.get(String(req.params.id)), operatorId);
    sendJson(res, await rt.campaigns.metrics(operatorId, String(req.params.id)));
  }));

  // journeys
  const checkJourney = async (operatorId: string, b: z.infer<typeof journeySchema>) => {
    await ownedTemplates(operatorId, b.steps.flatMap((s) => (s.type === 'send' ? [s.templateId] : [])));
  };
  admin.get('/journeys', asyncHandler(async (req, res) => sendJson(res, { items: await rt.repos.journeys.list({ operatorId: op(req) }) })));
  admin.get('/journeys/presets', (_req, res) => sendJson(res, { presets: JOURNEY_PRESETS }));
  admin.post('/journeys', asyncHandler(async (req, res) => {
    const operatorId = op(req);
    const b = parse(journeySchema, req.body);
    await checkJourney(operatorId, b);
    const j: Journey = { id: randomUUID(), operatorId, ...b, createdAt: now(), updatedAt: now() } as Journey;
    sendJson(res, await rt.repos.journeys.put(j), 201);
  }));
  admin.post('/journeys/presets/:preset', asyncHandler(async (req, res) => {
    const operatorId = op(req);
    const preset = parse(z.enum(JOURNEY_PRESETS), req.params.preset);
    const params = parse(
      z.object({
        channel: channelEnum.default('email'), lossThreshold: minorsString.optional(), windowHours: z.number().int().min(1).max(168).optional(),
        cashbackBps: z.number().int().min(1).max(10_000).optional(), inactiveDays: z.number().int().min(1).max(365).optional(), activate: z.boolean().default(false),
      }),
      req.body ?? {},
    );
    const d = presetDraft(preset, params);
    const t: Template = { id: randomUUID(), operatorId, channel: params.channel, kind: 'marketing', ...d.template, createdAt: now(), updatedAt: now() };
    await rt.repos.templates.put(t);
    const j: Journey = {
      id: randomUUID(), operatorId, name: d.name, status: params.activate ? 'active' : 'paused', trigger: d.trigger,
      steps: d.buildSteps(t.id), createdAt: now(), updatedAt: now(),
    };
    sendJson(res, { journey: await rt.repos.journeys.put(j), template: t }, 201);
  }));
  admin.put('/journeys/:id', asyncHandler(async (req, res) => {
    const operatorId = op(req);
    const cur = owned(await rt.repos.journeys.get(String(req.params.id)), operatorId);
    const b = parse(journeySchema, req.body);
    await checkJourney(operatorId, b);
    sendJson(res, await rt.repos.journeys.put({ ...cur, ...b, updatedAt: now() } as Journey));
  }));
  admin.delete('/journeys/:id', asyncHandler(async (req, res) => {
    const cur = owned(await rt.repos.journeys.get(String(req.params.id)), op(req));
    await rt.repos.journeys.delete(cur.id);
    sendJson(res, { ok: true });
  }));
  admin.get('/journeys/:id/metrics', asyncHandler(async (req, res) => {
    const operatorId = op(req);
    owned(await rt.repos.journeys.get(String(req.params.id)), operatorId);
    sendJson(res, await rt.campaigns.metrics(operatorId, String(req.params.id)));
  }));

  // afiliados
  const buildAffiliate = async (operatorId: string, b: z.infer<typeof affiliateSchema>, id: string, createdAt?: string): Promise<Affiliate> => {
    if (b.postbackUrl) {
      try {
        rt.affiliates.validateTemplate(b.postbackUrl);
      } catch (e) {
        if (e instanceof UnsafeUrlError) throw badRequest(e.message);
        throw e;
      }
    }
    const dup = (await rt.repos.affiliates.list({ operatorId })).find((a) => a.id !== id && a.code.toLowerCase() === b.code.toLowerCase());
    if (dup) throw new HttpError(409, 'AFFILIATE_CODE_TAKEN', 'Código de afiliado ya existe');
    return { id, operatorId, ...b, createdAt: createdAt ?? now(), updatedAt: now() };
  };
  admin.get('/affiliates', asyncHandler(async (req, res) => sendJson(res, { items: await rt.repos.affiliates.list({ operatorId: op(req) }) })));
  admin.post('/affiliates', asyncHandler(async (req, res) => {
    const operatorId = op(req);
    sendJson(res, await rt.repos.affiliates.put(await buildAffiliate(operatorId, parse(affiliateSchema, req.body), randomUUID())), 201);
  }));
  admin.put('/affiliates/:id', asyncHandler(async (req, res) => {
    const operatorId = op(req);
    const cur = owned(await rt.repos.affiliates.get(String(req.params.id)), operatorId);
    sendJson(res, await rt.repos.affiliates.put(await buildAffiliate(operatorId, parse(affiliateSchema, req.body), cur.id, cur.createdAt)));
  }));
  admin.delete('/affiliates/:id', asyncHandler(async (req, res) => {
    const cur = owned(await rt.repos.affiliates.get(String(req.params.id)), op(req));
    await rt.repos.affiliates.delete(cur.id);
    sendJson(res, { ok: true });
  }));
  admin.get('/affiliates/:id/postbacks', asyncHandler(async (req, res) => {
    const operatorId = op(req);
    const a = owned(await rt.repos.affiliates.get(String(req.params.id)), operatorId);
    const logs = (await rt.repos.postbacks.list({ operatorId })).filter((p) => p.affiliateId === a.id);
    sendJson(res, { items: logs });
  }));

  // marca y registro de envíos
  admin.get('/brand', asyncHandler(async (req, res) => sendJson(res, await rt.messaging.getBrand(op(req)))));
  admin.put('/brand', asyncHandler(async (req, res) => {
    const operatorId = op(req);
    sendJson(res, await rt.repos.brands.put({ id: operatorId, operatorId, ...parse(brandSchema, req.body) }));
  }));
  admin.get('/send-log', asyncHandler(async (req, res) => {
    const q = parse(z.object({ playerId: z.string().optional(), refId: z.string().optional(), status: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    sendJson(res, { items: await rt.repos.sends.list({ operatorId: op(req), playerId: q.playerId, refId: q.refId, status: q.status, limit: q.limit }) });
  }));
  admin.get('/me', (req, res) => sendJson(res, getPrincipal(req)));

  r.use('/admin', admin);
  r.use(moduleErrorHandler(deps.logger));
  return r;
}
