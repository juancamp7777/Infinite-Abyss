import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AuthPort } from '../../shared/ports/AuthPort';
import { getPrincipal, requireAuth, requirePlayer, requireRole, scopeOperator } from '../../shared/http/auth';
import { HttpError, asyncHandler, badRequest, moduleErrorHandler, sendJson } from '../../shared/http/errors';
import { ACCOUNT_COUNTRIES, ACCOUNT_METHODS, accountMethod, checkAccount, cleanAccountNumber } from '../domain/accountMethods';
import { parse } from '../../shared/http/validate';
import type { ModuleLogger } from '../../shared/module';
import type { Attachment } from '../../inbox/domain/types';
import type { BotConfigService } from '../application/BotConfigService';
import type { PearlAi } from '../application/PearlAi';
import type { PearlService } from '../application/PearlService';

const opQuery = z.object({ operatorId: z.string().min(1).max(100).optional() });
const idParams = z.object({ id: z.string().uuid() });
const money = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform((v) => BigInt(v));
const extracted = z.object({
  amount: z.string().trim().min(1).max(30),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  senderName: z.string().trim().max(120).default(''),
  senderTaxId: z.string().trim().max(30).optional(),
  receiverAccount: z.string().trim().max(60).optional(),
  notAReceipt: z.boolean().optional(),
  tamperSignals: z.array(z.string().max(200)).max(10).optional(),
});
const RECEIPT_STATUS = ['credited', 'pending_review', 'waiting_bank', 'needs_info', 'rejected', 'duplicate', 'error'] as const;

/** Montado en /pearl/v1. Revisión de comprobantes: todo el backoffice; configuración: administradores. */
const COUNTRY_BY_CURRENCY: Record<string, string> = { COP: 'CO', MXN: 'MX', ARS: 'AR' };
const CURRENCY_BY_COUNTRY: Record<string, string> = { CO: 'COP', MX: 'MXN', AR: 'ARS' };

export function buildPearlRouter(d: { auth: AuthPort; pearl: PearlService; ai?: PearlAi; bot?: BotConfigService; attachment?: (operatorId: string, id: string) => Promise<Attachment>; logger?: ModuleLogger; sealSecret?: (v: unknown) => string }): Router {
  const r = Router();
  const staff = [requireAuth(d.auth), requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_AGENT')];
  const admin = [requireAuth(d.auth), requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN')];
  const op = (req: Request) => scopeOperator(req, parse(opQuery, req.query).operatorId);

  /* Webhook del feed bancario: el token va en la URL (los proveedores no siempre permiten cabeceras). */
  r.post('/feeds/:id/:token', asyncHandler(async (req, res) => {
    const p = parse(z.object({ id: z.string().uuid(), token: z.string().min(20).max(100) }), req.params);
    sendJson(res, { ok: true, ...(await d.pearl.ingest(p.id, p.token, req.body)) });
  }));

  /* ─── Jugador: recarga por transferencia desde la caja web ─── */
  const player = requireAuth(d.auth);
  /** Cuentas activas a las que puede transferir (las de su país y las que sirven en todos, como Binance). */
  r.get('/player/accounts', player, asyncHandler(async (req, res) => {
    const { operatorId } = requirePlayer(req);
    const currency = (await d.pearl.settings(operatorId)).currency;
    const country = COUNTRY_BY_CURRENCY[currency];
    const items = (await d.pearl.listAccounts(operatorId))
      .filter((a) => a.active && (!a.country || !country || a.country === country || accountMethod(a.bank)?.country === '*'))
      .map((a) => {
        const m = accountMethod(a.bank);
        return {
          id: a.id, method: m?.label ?? a.bank ?? 'Transferencia', numberLabel: m?.numberLabel ?? 'Cuenta', number: a.accountNumber, holderName: m?.walletOnly ? undefined : a.holderName,
          alias: m?.keyLike ? undefined : a.alias, bankName: a.bankName, accountType: a.accountType, network: m?.walletOnly ? 'USDT · TRON (TRC20)' : undefined,
          // Binance recibe USDT; el resto, la moneda local del país de la cuenta.
          currency: m?.key.startsWith('binance') ? 'USDT' : (a.country && CURRENCY_BY_COUNTRY[a.country]) || currency,
        };
      });
    sendJson(res, { items });
  }));
  /** Estado del último comprobante del jugador (la caja web lo muestra en vivo). */
  r.get('/player/receipts/latest', player, asyncHandler(async (req, res) => {
    const { operatorId, playerId } = requirePlayer(req);
    const x = await d.pearl.latestReceiptForPlayer(operatorId, playerId);
    sendJson(res, { receipt: x ? { id: x.id, status: x.status, amount: x.amount?.toString() ?? null, currency: x.currency, createdAt: x.createdAt } : null });
  }));

  /* ─── Configuración ─── */
  r.get('/admin/settings', ...admin, asyncHandler(async (req, res) => sendJson(res, await d.pearl.settings(op(req)))));
  r.put('/admin/settings', ...admin, asyncHandler(async (req, res) => {
    const b = parse(z.object({
      mode: z.enum(['auto', 'review_all']).optional(), currency: z.string().regex(/^[A-Z]{3,5}$/).optional(), autoMaxAmount: money.optional(), minAmount: money.optional(),
      maxAgeHours: z.number().int().min(1).max(720).optional(), waitBankMinutes: z.number().int().min(1).max(1440).optional(), utcOffsetMinutes: z.number().int().min(-720).max(840).optional(), autoRegisterLeads: z.boolean().optional(),
      usdtRate: z.string().trim().regex(/^\d{1,9}(\.\d{1,6})?$/, 'Tasa USDT inválida: pesos por 1 USDT, p. ej. 3950').nullable().optional(),
    }), req.body);
    sendJson(res, await d.pearl.updateSettings(op(req), b));
  }));

  const account = z.object({ holderName: z.string().trim().max(120).default(''), alias: z.string().trim().max(60).optional(), accountNumber: z.string().trim().min(4).max(60), bank: z.string().trim().max(60).optional(), holderDocument: z.string().trim().max(30).optional(), country: z.enum(['CO', 'MX', 'AR']).optional(), bankName: z.string().trim().max(60).optional(), accountType: z.string().trim().max(30).optional(), active: z.boolean().optional() });
  /** Con un método conocido (Nequi, CLABE, CVU…) se limpia y valida el número y el documento según el país. */
  const parseAccount = (body: unknown) => {
    const a = parse(account, body);
    const m = accountMethod(a.bank);
    // Billetera USDT: solo la dirección; el nombre identifica la red.
    if (m?.walletOnly) Object.assign(a, { holderName: a.holderName || m.label, holderDocument: undefined });
    if (a.holderName.length < 2) throw badRequest('Escribe el titular de la cuenta');
    if (!m) {
      if (a.accountNumber.length < 6) throw badRequest('El número de cuenta debe tener al menos 6 caracteres');
      return a;
    }
    const accountNumber = cleanAccountNumber(m, a.accountNumber);
    const holderDocument = a.holderDocument?.replace(/[\s.-]/g, '').toUpperCase() || undefined;
    const country = m.country === '*' ? a.country : m.country;
    const bankName = m.banks ? a.bankName : undefined;
    const accountType = m.accountTypes ? a.accountType : undefined;
    const err = checkAccount(m, accountNumber, holderDocument, country, bankName, accountType);
    if (err) throw badRequest(err);
    // Una llave (Bre-B, billetera) se reconoce en el comprobante por su texto: queda también como alias.
    return { ...a, accountNumber, holderDocument, country, bankName, accountType, alias: a.alias || (m.keyLike ? accountNumber : undefined) };
  };
  r.get('/admin/account-methods', ...admin, (_req, res) => sendJson(res, { countries: ACCOUNT_COUNTRIES, methods: ACCOUNT_METHODS }));
  r.get('/admin/accounts', ...admin, asyncHandler(async (req, res) => sendJson(res, { items: await d.pearl.listAccounts(op(req)) })));
  r.post('/admin/accounts', ...admin, asyncHandler(async (req, res) => sendJson(res, await d.pearl.saveAccount(op(req), parseAccount(req.body)), 201)));
  r.put('/admin/accounts/:id', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    sendJson(res, await d.pearl.saveAccount(op(req), { ...parseAccount(req.body), id }));
  }));
  r.delete('/admin/accounts/:id', ...admin, asyncHandler(async (req, res) => {
    await d.pearl.deleteAccount(op(req), parse(idParams, req.params).id);
    sendJson(res, { ok: true });
  }));

  r.get('/admin/feeds', ...admin, asyncHandler(async (req, res) => {
    sendJson(res, { items: (await d.pearl.listFeeds(op(req))).map(({ tokenHash: _t, secretEnc: _s, ...f }) => f) });
  }));
  r.post('/admin/feeds', ...admin, asyncHandler(async (req, res) => {
    const b = parse(z.object({
      type: z.enum(['quikipay', 'hgcash', 'generic', 'binance']), name: z.string().max(80).default(''),
      apiKey: z.string().trim().min(20).max(200).optional(), apiSecret: z.string().trim().min(20).max(200).optional(),
    }), req.body);
    if (b.type === 'binance') {
      // Binance no manda webhooks: Pearl consulta los depósitos con la llave de SOLO LECTURA, guardada cifrada.
      if (!b.apiKey || !b.apiSecret) throw badRequest('Pega la API Key y la Secret Key de Binance (solo lectura)');
      if (!d.sealSecret) throw new HttpError(503, 'NO_VAULT', 'El cifrado de llaves no está disponible');
      const { feed } = await d.pearl.createFeed(op(req), 'binance', b.name || 'Binance USDT', d.sealSecret({ apiKey: b.apiKey, apiSecret: b.apiSecret }));
      const { tokenHash: _t, secretEnc: _s, ...pub } = feed;
      return sendJson(res, { feed: pub }, 201);
    }
    const { feed, token } = await d.pearl.createFeed(op(req), b.type, b.name);
    const { tokenHash: _t, ...pub } = feed;
    sendJson(res, { feed: pub, token, webhookPath: `/pearl/v1/feeds/${feed.id}/${token}` }, 201);
  }));
  r.patch('/admin/feeds/:id', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    const { tokenHash: _t, secretEnc: _s, ...f } = await d.pearl.setFeedEnabled(op(req), id, parse(z.object({ enabled: z.boolean() }), req.body).enabled);
    sendJson(res, f);
  }));
  r.delete('/admin/feeds/:id', ...admin, asyncHandler(async (req, res) => {
    await d.pearl.deleteFeed(op(req), parse(idParams, req.params).id);
    sendJson(res, { ok: true });
  }));

  /* ─── Cajero IA: borrador → publicar, historial y plantillas ─── */
  const bot = () => {
    if (!d.bot) throw new HttpError(503, 'UNAVAILABLE', 'Cajero IA no disponible');
    return d.bot;
  };
  r.get('/admin/bot', ...admin, asyncHandler(async (req, res) => sendJson(res, await bot().view(op(req)))));
  r.put('/admin/bot/draft', ...admin, asyncHandler(async (req, res) => sendJson(res, await bot().saveDraft(op(req), req.body, getPrincipal(req).userId))));
  r.post('/admin/bot/preset', ...admin, asyncHandler(async (req, res) => {
    const b = parse(z.object({ country: z.enum(['CO', 'MX', 'AR']) }), req.body);
    sendJson(res, await bot().applyPreset(op(req), b.country, getPrincipal(req).userId));
  }));
  r.post('/admin/bot/publish', ...admin, asyncHandler(async (req, res) => {
    const b = parse(z.object({ note: z.string().max(200).default('') }), req.body ?? {});
    sendJson(res, await bot().publish(op(req), getPrincipal(req).userId, b.note));
  }));
  r.post('/admin/bot/rollback', ...admin, asyncHandler(async (req, res) => {
    const b = parse(z.object({ version: z.number().int().min(1) }), req.body);
    sendJson(res, await bot().rollback(op(req), b.version, getPrincipal(req).userId));
  }));
  r.post('/admin/bot/discard', ...admin, asyncHandler(async (req, res) => sendJson(res, await bot().discardDraft(op(req), getPrincipal(req).userId))));

  /* ─── IA (la clave nunca se devuelve) ─── */
  r.get('/admin/ai', ...admin, asyncHandler(async (req, res) => {
    if (!d.ai) throw new HttpError(503, 'AI_UNAVAILABLE', 'IA no disponible');
    sendJson(res, await d.ai.config(op(req)));
  }));
  r.put('/admin/ai', ...admin, asyncHandler(async (req, res) => {
    if (!d.ai) throw new HttpError(503, 'AI_UNAVAILABLE', 'IA no disponible');
    const b = parse(z.object({
      enabled: z.boolean().optional(), provider: z.enum(['anthropic', 'gemini', 'deepseek']).optional(),
      readerModel: z.string().trim().regex(/^[A-Za-z0-9_.:/-]{2,80}$/).optional(), judgeModel: z.string().trim().regex(/^[A-Za-z0-9_.:/-]{2,80}$/).optional(),
      apiKey: z.string().trim().min(10).max(400).nullable().optional(),
    }), req.body);
    sendJson(res, await d.ai.saveConfig(op(req), b));
  }));

  /* ─── Operación diaria (cajeros) ─── */
  r.get('/admin/bank-txs', ...staff, asyncHandler(async (req, res) => {
    const q = parse(z.object({ status: z.enum(['available', 'used', 'ignored']).optional() }), req.query);
    sendJson(res, { items: await d.pearl.listBankTxs(op(req), q.status) });
  }));
  r.get('/admin/receipts', ...staff, asyncHandler(async (req, res) => {
    const q = parse(z.object({ status: z.enum(RECEIPT_STATUS).optional() }), req.query);
    sendJson(res, { items: await d.pearl.listReceipts(op(req), q.status) });
  }));
  r.get('/admin/receipts/:id', ...staff, asyncHandler(async (req, res) => sendJson(res, await d.pearl.getReceipt(op(req), parse(idParams, req.params).id))));
  r.post('/admin/receipts', ...staff, asyncHandler(async (req, res) => {
    const b = parse(z.object({ conversationId: z.string().uuid().optional(), playerId: z.string().min(1).max(100).optional(), extracted }), req.body);
    sendJson(res, await d.pearl.submit({ operatorId: op(req), conversationId: b.conversationId, playerId: b.playerId, extracted: b.extracted, source: 'manual' }), 201);
  }));
  r.patch('/admin/receipts/:id', ...staff, asyncHandler(async (req, res) => {
    const b = parse(z.object({ extracted }), req.body);
    sendJson(res, await d.pearl.updateExtracted(op(req), parse(idParams, req.params).id, b.extracted));
  }));
  r.get('/admin/receipts/:id/image', ...staff, asyncHandler(async (req, res) => {
    const operatorId = op(req);
    const rec = await d.pearl.getReceipt(operatorId, parse(idParams, req.params).id);
    if (!rec.attachmentId || !d.attachment) throw new HttpError(404, 'NOT_FOUND', 'El comprobante no tiene imagen');
    const a = await d.attachment(operatorId, rec.attachmentId);
    res.set({ 'Content-Type': a.mime, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' }).send(a.data);
  }));
  r.post('/admin/receipts/:id/approve', ...staff, asyncHandler(async (req, res) => {
    const b = parse(z.object({ bankTxId: z.string().uuid().optional() }), req.body);
    sendJson(res, await d.pearl.approve(op(req), parse(idParams, req.params).id, getPrincipal(req).userId, b.bankTxId));
  }));
  r.post('/admin/receipts/:id/reject', ...staff, asyncHandler(async (req, res) => {
    const b = parse(z.object({ reason: z.string().trim().min(2).max(300) }), req.body);
    sendJson(res, await d.pearl.reject(op(req), parse(idParams, req.params).id, getPrincipal(req).userId, b.reason));
  }));

  r.use(moduleErrorHandler(d.logger));
  return r;
}
