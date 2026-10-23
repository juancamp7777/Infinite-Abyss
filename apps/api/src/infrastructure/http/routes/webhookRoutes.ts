import express, { Router } from 'express';
import type { HandleWebhookUseCase } from '../../../application/cashier/HandleWebhookUseCase';

export interface WebhookRoutesDeps {
  handleWebhook: HandleWebhookUseCase;
}

const PROVIDERS: Record<string, string> = { passimpay: 'PASSIMPAY', wompi: 'WOMPI', bold: 'BOLD' };

/**
 * Webhooks de PSP. IMPORTANTE: montar este router ANTES de `express.json()` global (o excluir
 * `/api/webhooks`): aquí se usa `express.raw` para conservar el cuerpo EXACTO recibido, que es
 * sobre lo que se verifica la firma. Sin guards de usuario: la autenticidad la da la firma.
 */
export function createWebhookRouter(deps: WebhookRoutesDeps): Router {
  const router = Router();
  router.use(express.raw({ type: '*/*', limit: '256kb' }));

  router.post('/:provider', async (req, res) => {
    const provider = PROVIDERS[String(req.params.provider).toLowerCase()];
    if (!provider) return res.status(404).json({ result: 'unknown_provider' });
    const rawBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const raw = rawBuf.toString('utf8');
    req.rawBody = rawBuf;
    const out = await deps.handleWebhook.execute({
      provider,
      rawBody: raw,
      headers: req.headers,
      sourceIp: req.ip ?? req.socket.remoteAddress ?? undefined,
    });
    return res.status(out.status).json(out.body);
  });

  return router;
}
