import { randomBytes } from 'crypto';
import express, { Router, type Request } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { getPrincipal, requireAuth, requireRole, scopeOperator } from '../shared/http/auth';
import { asyncHandler, HttpError, moduleErrorHandler, sendJson } from '../shared/http/errors';
import { parse } from '../shared/http/validate';
import type { NymfoModule } from '../shared/module';
import { ReefService } from './application/ReefService';

export const REEF_PREFIX = '/reef/v1';

/**
 * Reef: plantillas white-label por operador (diseño + marca + home + SEO + footer), con borrador, vista previa
 * firmada, publicación versionada y vuelta atrás. Público: GET /site (por dominio u operador) y /assets/:id.
 * Requiere Postgres. Servicio: 'reef.service'.
 */
export function createReefModule(): NymfoModule {
  return {
    name: 'reef',
    async register(app, _io, deps) {
      if (!deps.prisma) {
        deps.logger.warn('[reef] sin base de datos: el módulo Reef no se monta');
        return {};
      }
      let secret = deps.env.REEF_PREVIEW_SECRET || deps.env.INBOX_SECRETS_KEY;
      if (!secret) {
        secret = randomBytes(32).toString('hex');
        deps.logger.warn('[reef] REEF_PREVIEW_SECRET no definido: los enlaces de vista previa caducan al reiniciar');
      }
      const reef = new ReefService(deps.prisma as PrismaClient, { previewSecret: secret });
      const r = Router();
      const admin = [requireAuth(deps.auth), requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN')];
      const op = (req: Request) => scopeOperator(req, parse(z.object({ operatorId: z.string().min(1).max(100).optional() }), req.query).operatorId);

      r.get('/site', asyncHandler(async (req, res) => {
        const q = parse(z.object({ operatorId: z.string().min(1).max(100).optional(), host: z.string().max(253).optional(), preview: z.string().max(300).optional() }), req.query);
        const site = await reef.publicSite(q);
        if (!site?.preview) res.set('Cache-Control', 'public, max-age=30');
        else res.set('Cache-Control', 'no-store');
        sendJson(res, { site });
      }));
      r.get('/assets/:id', asyncHandler(async (req, res) => {
        const a = await reef.asset(parse(z.object({ id: z.string().uuid() }), req.params).id);
        res.set({ 'Content-Type': a.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" }).send(Buffer.from(a.data));
      }));

      r.get('/admin/templates', ...admin, (_req, res) => sendJson(res, { items: reef.templates() }));
      r.get('/admin/site', ...admin, asyncHandler(async (req, res) => sendJson(res, await reef.editor(op(req)))));
      r.put('/admin/site/draft', ...admin, asyncHandler(async (req, res) => sendJson(res, await reef.saveDraft(op(req), req.body, getPrincipal(req).userId))));
      r.post('/admin/site/template', ...admin, asyncHandler(async (req, res) => {
        const b = parse(z.object({ template: z.enum(['abyss', 'golden', 'emerald', 'royal']) }), req.body);
        sendJson(res, await reef.applyTemplate(op(req), b.template, getPrincipal(req).userId));
      }));
      r.post('/admin/site/publish', ...admin, asyncHandler(async (req, res) => sendJson(res, await reef.publish(op(req), getPrincipal(req).userId))));
      r.post('/admin/site/rollback/:version', ...admin, asyncHandler(async (req, res) => {
        const { version } = parse(z.object({ version: z.coerce.number().int().min(1) }), req.params);
        sendJson(res, await reef.rollback(op(req), version, getPrincipal(req).userId));
      }));
      r.post('/admin/site/preview', ...admin, asyncHandler(async (req, res) => sendJson(res, reef.previewToken(op(req)))));
      r.post('/admin/assets', ...admin, express.raw({ type: () => true, limit: '2mb' }), asyncHandler(async (req, res) => {
        if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'BAD_REQUEST', 'Falta la imagen');
        sendJson(res, await reef.uploadAsset(op(req), req.body), 201);
      }));
      r.use(moduleErrorHandler(deps.logger));
      app.use(REEF_PREFIX, r);
      return { 'reef.service': reef };
    },
  };
}

export const reefModule = createReefModule();
