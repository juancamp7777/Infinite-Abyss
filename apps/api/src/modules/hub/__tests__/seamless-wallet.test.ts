import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DomainEvents } from '../../shared/events/EventBus';
import { HubHarness, launchMock, OP, PLAYER, startHub, walletCall } from './helpers';

describe('Hub · seamless wallet', () => {
  let h: HubHarness;
  let token: string;

  beforeEach(async () => {
    h = await startHub();
    h.wallet.seed(OP, PLAYER, 'USD', 10_000n);
    token = (await launchMock(h.base)).token;
  });
  afterEach(async () => h.close());

  const bet = (txId: string, amount: string, roundId = 'r-1') =>
    walletCall(h.base, 'bet', { sessionToken: token, transactionId: txId, roundId, amount });

  it('acepta una firma válida y devuelve el saldo', async () => {
    const r = await walletCall(h.base, 'balance', { sessionToken: token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'OK', balance: '10000', cash: '10000', bonus: '0', currency: 'USD' });
  });

  it('rechaza firmas inválidas, ausentes o de otro secreto', async () => {
    expect((await walletCall(h.base, 'balance', { sessionToken: token }, { secret: 'otro' })).body.error.code).toBe('INVALID_SIGNATURE');
    const r = await walletCall(h.base, 'balance', { sessionToken: token }, { signature: 'zz' });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('INVALID_SIGNATURE');
    expect((await walletCall(h.base, 'balance', { sessionToken: token }, { provider: 'desconocido' })).body.error.code).toBe('UNKNOWN_PROVIDER');
  });

  it('rechaza sesiones desconocidas', async () => {
    const r = await walletCall(h.base, 'bet', { sessionToken: 'no-existe-123', transactionId: 't', roundId: 'r', amount: '1' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('UNKNOWN_SESSION');
  });

  it('bet idempotente: el reintento devuelve la misma respuesta y no cobra dos veces', async () => {
    const a = await bet('tx-1', '300');
    const b = await bet('tx-1', '300');
    expect(a.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(a.body.balance).toBe('9700');
    expect((await h.wallet.getBalance(OP, PLAYER, 'USD')).cash).toBe(9700n);
    expect(h.wallet.getHistory({ type: 'DEBIT' })).toHaveLength(1);
    expect(h.wallet.findTransaction(OP, 'hub:mock-provider:tx-1')).toBeDefined();
  });

  it('mismo transactionId con otro monto → DUPLICATE', async () => {
    await bet('tx-1', '300');
    const r = await bet('tx-1', '500');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DUPLICATE');
    expect((await h.wallet.getBalance(OP, PLAYER, 'USD')).cash).toBe(9700n);
  });

  it('reintentos concurrentes de la misma bet cobran una sola vez', async () => {
    const rs = await Promise.all([bet('tx-c', '100'), bet('tx-c', '100'), bet('tx-c', '100')]);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(new Set(rs.map((r) => r.body.transactionId)).size).toBe(1);
    expect((await h.wallet.getBalance(OP, PLAYER, 'USD')).cash).toBe(9900n);
  });

  it('fondos insuficientes → INSUFFICIENT_FUNDS sin registrar la ronda', async () => {
    const r = await bet('tx-big', '20000');
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('INSUFFICIENT_FUNDS');
    const report = await h.services.hubReports.providers({});
    expect(report.totals.rounds).toBe(0);
  });

  it('win liquida la ronda, es idempotente y win sin bet previa falla', async () => {
    await bet('tx-1', '1000');
    const w1 = await walletCall(h.base, 'win', { sessionToken: token, transactionId: 'w-1', roundId: 'r-1', amount: '2500' });
    const w2 = await walletCall(h.base, 'win', { sessionToken: token, transactionId: 'w-1', roundId: 'r-1', amount: '2500' });
    expect(w1.status).toBe(200);
    expect(w2.body).toEqual(w1.body);
    expect(w1.body.balance).toBe('11500');

    const late = await walletCall(h.base, 'win', { sessionToken: token, transactionId: 'w-2', roundId: 'r-1', amount: '1' });
    expect(late.body.error.code).toBe('ROUND_CLOSED');

    const orphan = await walletCall(h.base, 'win', { sessionToken: token, transactionId: 'w-3', roundId: 'r-x', amount: '100' });
    expect(orphan.status).toBe(404);
    expect(orphan.body.error.code).toBe('ROUND_NOT_FOUND');

    // El MockProvider permite premios de giros gratis sin apuesta.
    const fr = await walletCall(h.base, 'win', {
      sessionToken: token,
      transactionId: 'w-4',
      roundId: 'r-fr',
      amount: '100',
      bonus: { type: 'free_rounds', id: 'fr-1' },
    });
    expect(fr.status).toBe(200);
    expect(fr.body.balance).toBe('11600');
  });

  it('rollback de una bet devuelve el dinero y cierra la ronda; repetido es idempotente', async () => {
    await bet('tx-1', '1000');
    const rb = await walletCall(h.base, 'rollback', { sessionToken: token, transactionId: 'rb-1', referenceTransactionId: 'tx-1' });
    expect(rb.status).toBe(200);
    expect(rb.body.balance).toBe('10000');
    const again = await walletCall(h.base, 'rollback', { sessionToken: token, transactionId: 'rb-1', referenceTransactionId: 'tx-1' });
    expect(again.body).toEqual(rb.body);
    // Otro rollback (otro transactionId) sobre la misma apuesta: OK sin mover dinero.
    const other = await walletCall(h.base, 'rollback', { sessionToken: token, transactionId: 'rb-2', referenceTransactionId: 'tx-1' });
    expect(other.status).toBe(200);
    expect(other.body.balance).toBe('10000');
    expect(h.wallet.getHistory({ type: 'ROLLBACK' })).toHaveLength(1);
    // La ronda anulada no admite premios.
    const w = await walletCall(h.base, 'win', { sessionToken: token, transactionId: 'w-1', roundId: 'r-1', amount: '5' });
    expect(w.body.error.code).toBe('ROUND_CLOSED');
    const report = await h.services.hubReports.providers({});
    expect(report.totals).toMatchObject({ bets: 0n, wins: 0n, rounds: 1, openRounds: 0 });
  });

  it('rollback de apuesta desconocida → tombstone OK y la bet tardía se rechaza', async () => {
    const rb = await walletCall(h.base, 'rollback', { sessionToken: token, transactionId: 'rb-9', referenceTransactionId: 'tx-9', roundId: 'r-9' });
    expect(rb.status).toBe(200);
    expect(rb.body.balance).toBe('10000');
    const lateBet = await bet('tx-9', '500', 'r-9');
    expect(lateBet.status).toBe(409);
    expect(lateBet.body.error.code).toBe('BET_ROLLED_BACK');
    expect((await h.wallet.getBalance(OP, PLAYER, 'USD')).cash).toBe(10000n);
    expect(h.wallet.getHistory()).toHaveLength(0);
    // Reintento del mismo rollback: misma respuesta.
    const again = await walletCall(h.base, 'rollback', { sessionToken: token, transactionId: 'rb-9', referenceTransactionId: 'tx-9', roundId: 'r-9' });
    expect(again.body).toEqual(rb.body);
  });

  it('valida el cuerpo (montos decimales o negativos)', async () => {
    const r = await walletCall(h.base, 'bet', { sessionToken: token, transactionId: 't', roundId: 'r', amount: '1.5' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('publica bet.placed y bet.settled con categoría y multiplicador', async () => {
    const placed: DomainEvents['bet.placed'][] = [];
    const settled: DomainEvents['bet.settled'][] = [];
    h.bus.subscribe('bet.placed', (e) => {
      placed.push(e);
    });
    h.bus.subscribe('bet.settled', (e) => {
      settled.push(e);
    });
    await bet('tx-1', '200');
    await walletCall(h.base, 'win', { sessionToken: token, transactionId: 'w-1', roundId: 'r-1', amount: '500' });
    await h.bus.drain();
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ operatorId: OP, playerId: PLAYER, amount: 200n, provider: 'mock-provider', category: 'slots', roundId: 'r-1', gameId: 'mock-provider-mp-golden-oasis' });
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ amount: 200n, win: 500n, multiplier: 2.5 });
  });

  it('reporta apuestas, ganancias, GGR y rondas abiertas por proveedor y juego', async () => {
    await bet('tx-1', '1000', 'r-1');
    await walletCall(h.base, 'win', { sessionToken: token, transactionId: 'w-1', roundId: 'r-1', amount: '400' });
    await bet('tx-2', '300', 'r-2');
    const rep = await h.services.hubReports.providers({ from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000) });
    expect(rep.providers).toHaveLength(1);
    expect(rep.providers[0]).toMatchObject({ providerId: 'mock-provider', bets: 1300n, wins: 400n, ggr: 900n, rounds: 2, openRounds: 1 });
    expect(rep.games[0].title).toBe('Golden Oasis');
    const empty = await h.services.hubReports.providers({ from: new Date(Date.now() + 3600_000) });
    expect(empty.totals.rounds).toBe(0);
  });
});

describe('Hub · guardia de apuestas', () => {
  it('rechaza la bet si deps.betGuard la bloquea, sin mover dinero', async () => {
    const h = await startHub({ betGuard: { checkBet: async (r) => ({ allowed: r.amount <= 100n, reason: 'LIMIT' }) } });
    try {
      h.wallet.seed(OP, PLAYER, 'USD', 1000n);
      const { token } = await launchMock(h.base);
      const r = await walletCall(h.base, 'bet', { sessionToken: token, transactionId: 't', roundId: 'r', amount: '500' });
      expect(r.status).toBe(403);
      expect(r.body.error).toMatchObject({ code: 'BET_REJECTED', message: 'LIMIT' });
      const ok = await walletCall(h.base, 'bet', { sessionToken: token, transactionId: 't2', roundId: 'r', amount: '100' });
      expect(ok.body.balance).toBe('900');
    } finally {
      await h.close();
    }
  });
});

describe('Hub · servidor de juego mock (E2E)', () => {
  it('la página del juego hace bet y win firmadas contra nuestra billetera', async () => {
    const h = await startHub({ env: { HUB_MOCK_PROVIDER: '1' } });
    try {
      h.wallet.seed(OP, PLAYER, 'USD', 5000n);
      const { url, token } = await launchMock(h.base, 'mock-provider-mp-sugar-comet');
      expect(url.startsWith(`${h.base}/hub/mock-provider/game/mp-sugar-comet?`)).toBe(true);
      const page = await fetch(url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('Sugar Comet');

      const spin = await fetch(`${h.base}/hub/mock-provider/game/mp-sugar-comet/spin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: token, bet: '100' }),
      });
      const j = (await spin.json()) as any;
      expect(spin.status).toBe(200);
      expect(BigInt(j.balance)).toBe(5000n - 100n + BigInt(j.win));
      const rep = await h.services.hubReports.providers({});
      expect(rep.totals).toMatchObject({ bets: 100n, rounds: 1, openRounds: 0 });
    } finally {
      await h.close();
    }
  });
});
