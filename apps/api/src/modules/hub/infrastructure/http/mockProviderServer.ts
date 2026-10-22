import express, { Router } from 'express';
import { randomInt, randomUUID } from 'crypto';
import { z } from 'zod';
import { signHmacSha256 } from '../../../shared/crypto/hmac';
import { asyncHandler, HttpError, moduleErrorHandler, sendJson } from '../../../shared/http/errors';
import { bigintReplacer } from '../../../shared/money';
import { zAmount, parse } from '../../../shared/http/validate';
import type { ModuleLogger } from '../../../shared/module';
import { MOCK_GAMES, MOCK_PROVIDER_ID } from '../adapters/MockProviderAdapter';

/** Tabla de pagos del juego simulado: [multiplicador, peso]. Solo para pruebas E2E (RTP ≈ 95 %). */
const OUTCOMES: Array<[number, number]> = [
  [0, 640],
  [0.5, 120],
  [1, 110],
  [2, 80],
  [5, 35],
  [10, 12],
  [50, 3],
];
const TOTAL_WEIGHT = OUTCOMES.reduce((a, [, w]) => a + w, 0);

function drawMultiplier(): number {
  let x = randomInt(TOTAL_WEIGHT);
  for (const [m, w] of OUTCOMES) {
    if (x < w) return m;
    x -= w;
  }
  return 0;
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface MockProviderServerOptions {
  secret: string;
  /** URL base INTERNA de nuestra API (servidor a servidor, donde vive /hub/v1/wallet). */
  internalApiUrl: () => string;
  logger: ModuleLogger;
  fetch?: typeof fetch;
}

/**
 * Mini servidor de juego del proveedor simulado (solo con HUB_MOCK_PROVIDER=1), montado en /hub/mock-provider.
 * - GET  /game/:gameId?session=&currency=&mode=  página HTML simple con botón de giro.
 * - POST /game/:gameId/spin   {session, bet}  → desde el servidor: bet firmada → resultado → win firmada.
 * - POST /game/:gameId/balance {session}
 * Los fetch del navegador son relativos a la propia URL de la página (location.pathname), así funciona detrás de cualquier
 * prefijo público (/api-proxy, /_svc/api…). Las llamadas a nuestra billetera van por HTTP con firma HMAC, igual que lo haría un proveedor real.
 */
export function createMockProviderServer(opts: MockProviderServerOptions): Router {
  const r = Router();
  r.use(express.json({ limit: '16kb' }));
  const doFetch = opts.fetch ?? fetch;

  const callWallet = async (action: string, payload: Record<string, unknown>) => {
    const body = JSON.stringify(payload, bigintReplacer);
    const res = await doFetch(`${opts.internalApiUrl()}/hub/v1/wallet/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Provider-Id': MOCK_PROVIDER_ID, 'X-Signature': signHmacSha256(opts.secret, body) },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (res.status >= 400) {
      throw new HttpError(res.status, json?.error?.code ?? 'WALLET_ERROR', json?.error?.message ?? `wallet ${action} falló`);
    }
    return json;
  };

  r.get('/game/:gameId', (req, res) => {
    const gameId = String(req.params.gameId);
    const game = MOCK_GAMES.find((g) => g.externalId === gameId);
    if (!game) {
      res.status(404).type('text/plain').send('Juego no encontrado');
      return;
    }
    const cfg = {
      gameId,
      session: typeof req.query.session === 'string' ? req.query.session : '',
      // La moneda llega en la URL de launch (moneda de la sesión); en modo real se confirma con la respuesta de balance.
      currency: typeof req.query.currency === 'string' && /^[A-Z]{3}$/.test(req.query.currency) ? req.query.currency : '',
      mode: req.query.mode === 'real' ? 'real' : 'demo',
    };
    // Conserva el frame-ancestors que fijó el middleware de cabeceras de la API ('self' + orígenes de la web).
    const frameAncestors = /frame-ancestors [^;]+/.exec(String(res.getHeader('Content-Security-Policy') ?? ''))?.[0] ?? "frame-ancestors 'self'";
    res
      .status(200)
      .type('text/html')
      .set('Content-Security-Policy', `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; ${frameAncestors}`)
      .send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(game.title)} · Mock Play</title>
<style>body{font-family:system-ui,sans-serif;background:#140f24;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0}
.reel{font-size:48px;letter-spacing:12px;margin:16px}button{font-size:18px;padding:12px 28px;border-radius:12px;border:0;background:#f59e0b;color:#140f24;font-weight:700;cursor:pointer}
#msg{min-height:24px;margin-top:12px}</style></head><body>
<h1 data-testid="title">${escHtml(game.title)}</h1><div>Modo: <b data-testid="mode">${cfg.mode}</b> · Saldo: <b data-testid="balance" id="balance">…</b> <span data-testid="currency" id="cur">${escHtml(cfg.currency)}</span></div>
<div class="reel" id="reel">◆ ◆ ◆</div>
<label>Apuesta <input id="bet" type="number" min="1" step="1" value="100"></label>
<p><button id="spin" data-testid="spin">Girar</button></p><div id="msg" data-testid="msg"></div>
<script>
const CFG=${JSON.stringify(cfg).replace(/</g, '\\u003c')};
const base=location.pathname;let demo=100000;
const $=(id)=>document.getElementById(id);
async function post(path,body){const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error&&j.error.code||'ERROR');return j;}
async function refresh(){if(CFG.mode!=='real'){$('balance').textContent=demo;return;}try{const j=await post('/balance',{session:CFG.session});$('balance').textContent=j.balance;if(j.currency)$('cur').textContent=j.currency;}catch(e){$('msg').textContent=e.message;}}
$('spin').onclick=async()=>{const bet=$('bet').value;$('msg').textContent='';const sym=['◆','★','♣','☀','♥'];
try{const j=await post('/spin',{session:CFG.session,bet:String(bet),mode:CFG.mode});
$('reel').textContent=[0,1,2].map(()=>sym[Math.floor(Math.random()*5)]).join(' ');
if(CFG.mode!=='real'){demo=demo-Number(bet)+Number(j.win);$('balance').textContent=demo;}else{$('balance').textContent=j.balance;}
$('msg').textContent=Number(j.win)>0?('¡Ganaste '+j.win+' (x'+j.multiplier+')!'):'Sin premio';}catch(e){$('msg').textContent=e.message;}};
refresh();
</script></body></html>`);
  });

  r.post(
    '/game/:gameId/balance',
    asyncHandler(async (req, res) => {
      const b = parse(z.object({ session: z.string().min(8) }), req.body);
      const j = await callWallet('balance', { sessionToken: b.session });
      sendJson(res, { balance: j.balance, currency: j.currency });
    }),
  );

  r.post(
    '/game/:gameId/spin',
    asyncHandler(async (req, res) => {
      const gameId = String(req.params.gameId);
      if (!MOCK_GAMES.some((g) => g.externalId === gameId)) throw new HttpError(404, 'NOT_FOUND', 'Juego no encontrado');
      const b = parse(z.object({ session: z.string().default(''), bet: zAmount, mode: z.enum(['real', 'demo']).default('real') }), req.body);
      const multiplier = drawMultiplier();
      const win = (b.bet * BigInt(Math.round(multiplier * 100))) / 100n;
      if (b.mode === 'demo') return sendJson(res, { multiplier, win });
      const roundId = randomUUID();
      await callWallet('bet', { sessionToken: b.session, transactionId: `bet-${roundId}`, roundId, gameId, amount: b.bet });
      const j = await callWallet('win', { sessionToken: b.session, transactionId: `win-${roundId}`, roundId, gameId, amount: win, roundClosed: true });
      sendJson(res, { roundId, multiplier, win, balance: j.balance });
    }),
  );

  r.use(moduleErrorHandler(opts.logger));
  return r;
}
