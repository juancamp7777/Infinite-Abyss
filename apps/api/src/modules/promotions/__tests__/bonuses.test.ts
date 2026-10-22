import { describe, expect, it } from 'vitest';
import { assertTransition, BonusStatus, canTransition, sourcesFor } from '../domain/bonus';
import { bet, bonusEnv, CUR, OP, T0 } from './helpers';

const ALL: BonusStatus[] = ['PENDING', 'ACTIVE', 'COMPLETED', 'FORFEITED', 'CANCELLED'];

describe('máquina de estados del bono', () => {
  it('solo permite las transiciones del ciclo de vida', () => {
    const allowed = new Set(['PENDING>ACTIVE', 'PENDING>FORFEITED', 'PENDING>CANCELLED', 'ACTIVE>COMPLETED', 'ACTIVE>FORFEITED', 'ACTIVE>CANCELLED']);
    for (const from of ALL) {
      for (const to of ALL) {
        const key = `${from}>${to}`;
        expect(canTransition(from, to), key).toBe(allowed.has(key));
        if (!allowed.has(key)) expect(() => assertTransition(from, to)).toThrow(/Transición de bono inválida/);
      }
    }
    expect(sourcesFor('COMPLETED')).toEqual(['ACTIVE']);
  });
});

describe('ciclo de vida de bonos', () => {
  it('PENDING → ACTIVE (depósito) → COMPLETED con contribución por categoría exacta y conversión', async () => {
    const { service, wallet, catalog } = bonusEnv();
    await service.createTemplate({
      operatorId: OP, name: 'Match 100%', type: 'deposit_match', currency: CUR, code: 'welcome', matchBps: 10000, maxBonusAmount: 500n,
      minDeposit: 100n, wageringMultiplier: 10, wageringBase: 'BONUS', contributionBps: { slots: 10000, originals: 5000, live: 1000, table: 1000 },
    });
    const pending = await service.claim(OP, 'p1', 'WELCOME');
    expect(pending.status).toBe('PENDING');
    expect(wallet.getHistory()).toHaveLength(0);

    // Depósito menor que el mínimo: sigue PENDING.
    await service.onDeposit({ operatorId: OP, playerId: 'p1', at: T0.toISOString(), amount: 50n, currency: CUR, isFirst: true, txId: 'd0' });
    expect((await service.getBonus(pending.id))!.status).toBe('PENDING');

    await service.onDeposit({ operatorId: OP, playerId: 'p1', at: T0.toISOString(), amount: 300n, currency: CUR, isFirst: false, txId: 'd1' });
    let b = (await service.getBonus(pending.id))!;
    expect(b.status).toBe('ACTIVE');
    expect(b.amount).toBe(300n);
    expect(b.wageringRequired).toBe(3000n);
    expect((await wallet.getBalance(OP, 'p1', CUR)).bonus).toBe(300n);
    // Reprocesar el depósito no duplica.
    await service.onDeposit({ operatorId: OP, playerId: 'p1', at: T0.toISOString(), amount: 300n, currency: CUR, isFirst: false, txId: 'd1' });
    expect(wallet.getHistory({ reason: 'BONUS_GRANT' })).toHaveLength(1);

    // La categoría sale del catálogo, no del evento: 'crash' es originals (50 %) aunque el evento diga slots.
    await service.onBetPlaced(bet('p1', 1000n, { gameId: 'crash', category: 'slots' })); // +500
    await service.onBetPlaced(bet('p1', 1000n, { gameId: 'roulette-live', category: 'live' })); // +100
    const r = bet('p1', 2000n, { gameId: 'starfall' }); // +2000
    await service.onBetPlaced(r);
    await service.onBetPlaced(r); // dedupe por roundId
    b = (await service.getBonus(pending.id))!;
    expect(b.wageringProgress).toBe(2600n);
    expect(b.status).toBe('ACTIVE');
    // Juego desconocido en el catálogo: usa la categoría del evento (table 10 %).
    catalog.upsert({ id: 'bj', provider: 'nymfo', category: 'table', title: 'BJ' });
    await service.onBetPlaced(bet('p1', 4000n, { gameId: 'bj', category: 'table' })); // +400 → 3000 exacto
    b = (await service.getBonus(pending.id))!;
    expect(b.wageringProgress).toBe(3000n);
    expect(b.status).toBe('COMPLETED');
    expect(b.settlementAmount).toBe(300n);
    const conv = wallet.findTransaction(OP, `promo:bonus:${b.id}:convert`);
    expect(conv).toMatchObject({ type: 'CREDIT', reason: 'BONUS_GRANT', amount: 300n, ref: { gameId: 'bonus-convert', roundId: b.id } });
    expect(b.settlementTxId).toBe(conv!.txId);
    // Más apuestas ya no cambian nada y COMPLETED no se puede cancelar.
    await service.onBetPlaced(bet('p1', 1000n));
    await expect(service.cancelByPlayer(OP, 'p1', b.id)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('wagering sobre bono+depósito', async () => {
    const { service } = bonusEnv();
    const t = await service.createTemplate({ operatorId: OP, name: 'Auto', type: 'deposit_match', currency: CUR, autoOnDeposit: true, matchBps: 5000, wageringMultiplier: 5, wageringBase: 'BONUS_PLUS_DEPOSIT' });
    await service.onDeposit({ operatorId: OP, playerId: 'p1', at: T0.toISOString(), amount: 1000n, currency: CUR, isFirst: true, txId: 'd1' });
    const [b] = (await service.listPlayerBonuses(OP, 'p1')).active;
    expect(b.templateId).toBe(t.id);
    expect(b.amount).toBe(500n);
    expect(b.wageringRequired).toBe(7500n);
  });

  it('ACTIVE → CANCELLED por el jugador retira el saldo de bono; repetir es transición inválida', async () => {
    const { service, wallet } = bonusEnv();
    await service.createTemplate({ operatorId: OP, name: 'Code', type: 'promo_code', currency: CUR, code: 'FREE50', fixedAmount: 50n, wageringMultiplier: 20 });
    const b = await service.claim(OP, 'p1', 'free50');
    expect(b.status).toBe('ACTIVE');
    const c = await service.cancelByPlayer(OP, 'p1', b.id);
    expect(c.status).toBe('CANCELLED');
    expect(c.settlementAmount).toBe(50n);
    expect(wallet.findTransaction(OP, `promo:bonus:${b.id}:forfeit`)).toMatchObject({ type: 'DEBIT', reason: 'OTHER', amount: 50n });
    await expect(service.cancelByPlayer(OP, 'p1', b.id)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(service.cancelByPlayer(OP, 'otro', b.id)).rejects.toMatchObject({ status: 404 });
  });

  it('PENDING → CANCELLED por admin sin movimientos y PENDING → FORFEITED al vencer la ventana', async () => {
    const { service, wallet, clock } = bonusEnv();
    await service.createTemplate({ operatorId: OP, name: 'M', type: 'deposit_match', currency: CUR, code: 'DEP', matchBps: 10000, claimWindowHours: 2, stackable: true, maxUsesPerPlayer: 5 });
    const a = await service.claim(OP, 'p1', 'DEP');
    const c = await service.cancelByAdmin(OP, a.id, 'fraude');
    expect(c).toMatchObject({ status: 'CANCELLED', statusReason: 'fraude', settlementAmount: 0n });
    const b = await service.claim(OP, 'p1', 'DEP');
    clock.advanceHours(3);
    expect(await service.tick()).toMatchObject({ expired: 1 });
    expect((await service.getBonus(b.id))!.status).toBe('FORFEITED');
    expect(wallet.getHistory()).toHaveLength(0);
  });

  it('expiración del bono activo → FORFEITED con retirada del saldo de bono', async () => {
    const { service, wallet, clock } = bonusEnv();
    await service.createTemplate({ operatorId: OP, name: 'Code', type: 'promo_code', currency: CUR, code: 'EXP', fixedAmount: 80n, wageringMultiplier: 30, validityHours: 48 });
    const b = await service.claim(OP, 'p1', 'EXP');
    clock.advanceHours(47);
    expect((await service.tick()).expired).toBe(0);
    clock.advanceHours(1);
    expect((await service.tick()).expired).toBe(1);
    const f = (await service.getBonus(b.id))!;
    expect(f).toMatchObject({ status: 'FORFEITED', statusReason: 'EXPIRED', settlementAmount: 80n });
    expect(wallet.findTransaction(OP, `promo:bonus:${b.id}:forfeit`)?.amount).toBe(80n);
    expect((await service.tick()).expired).toBe(0);
  });

  it('solo un bono activo por jugador salvo plantillas stackable', async () => {
    const { service } = bonusEnv();
    await service.createTemplate({ operatorId: OP, name: 'A', type: 'promo_code', currency: CUR, code: 'AAA', fixedAmount: 10n, wageringMultiplier: 1 });
    await service.createTemplate({ operatorId: OP, name: 'B', type: 'promo_code', currency: CUR, code: 'BBB', fixedAmount: 10n, wageringMultiplier: 1 });
    await service.claim(OP, 'p1', 'AAA');
    await expect(service.claim(OP, 'p1', 'BBB')).rejects.toMatchObject({ code: 'BONUS_ALREADY_ACTIVE' });
  });

  it('autoexcluidos no reciben bonos', async () => {
    const { service, compliance } = bonusEnv();
    await service.createTemplate({ operatorId: OP, name: 'A', type: 'promo_code', currency: CUR, code: 'AAA', fixedAmount: 10n });
    compliance.set(OP, 'px', { selfExcluded: true });
    await expect(service.claim(OP, 'px', 'AAA')).rejects.toMatchObject({ code: 'PLAYER_EXCLUDED' });
    await expect(service.grantCashback(OP, 'px', 10n, 'x')).rejects.toMatchObject({ code: 'PLAYER_EXCLUDED' });
  });
});

describe('apuesta máxima con bono (BetGuardPort)', () => {
  it('bloquea apuestas por encima de maxBet y fuerza FORFEITED si llega una apuesta que la viola', async () => {
    const { service } = bonusEnv();
    await service.createTemplate({ operatorId: OP, name: 'MB', type: 'promo_code', currency: CUR, code: 'MAXB', fixedAmount: 100n, wageringMultiplier: 10, maxBet: 50n });
    const b = await service.claim(OP, 'p1', 'MAXB');
    const req = { operatorId: OP, playerId: 'p1', gameId: 'starfall', category: 'slots', currency: CUR };
    expect(await service.checkBet({ ...req, amount: 50n })).toEqual({ allowed: true });
    const blocked = await service.checkBet({ ...req, amount: 51n });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/BONUS_MAX_BET/);
    expect(await service.checkBet({ ...req, amount: 51n, playerId: 'p2' })).toEqual({ allowed: true });
    expect(await service.checkBet({ ...req, amount: 51n, currency: 'EUR' })).toEqual({ allowed: true });

    await service.onBetPlaced(bet('p1', 60n));
    const f = (await service.getBonus(b.id))!;
    expect(f).toMatchObject({ status: 'FORFEITED', statusReason: 'MAX_BET_VIOLATION', wageringProgress: 0n });
    expect(await service.checkBet({ ...req, amount: 1000n })).toEqual({ allowed: true });
  });
});

describe('códigos promocionales', () => {
  it('respeta usos totales, usos por jugador y ventana de fechas', async () => {
    const { service, clock } = bonusEnv();
    const start = new Date(T0.getTime() + 3_600_000);
    await service.createTemplate({
      operatorId: OP, name: 'Lim', type: 'promo_code', currency: CUR, code: 'LIMIT', fixedAmount: 20n, stackable: true,
      maxUsesTotal: 3, maxUsesPerPlayer: 2, validFrom: start, validTo: new Date(start.getTime() + 24 * 3_600_000),
    });
    await expect(service.claim(OP, 'p1', 'LIMIT')).rejects.toMatchObject({ code: 'CODE_NOT_ACTIVE' });
    clock.advanceHours(2);
    await service.claim(OP, 'p1', 'LIMIT');
    await service.claim(OP, 'p1', 'limit');
    await expect(service.claim(OP, 'p1', 'LIMIT')).rejects.toMatchObject({ code: 'PLAYER_CODE_LIMIT' });
    await service.claim(OP, 'p2', 'LIMIT');
    await expect(service.claim(OP, 'p3', 'LIMIT')).rejects.toMatchObject({ code: 'CODE_LIMIT_REACHED' });
    await expect(service.claim(OP, 'p1', 'NOPE')).rejects.toMatchObject({ code: 'CODE_NOT_FOUND' });
    await expect(service.claim('op-2', 'p9', 'LIMIT')).rejects.toMatchObject({ code: 'CODE_NOT_FOUND' });
    clock.advanceHours(30);
    await expect(service.claim(OP, 'p4', 'LIMIT')).rejects.toMatchObject({ code: 'CODE_NOT_ACTIVE' });
  });

  it('reclamos concurrentes no superan maxUsesTotal', async () => {
    const { service } = bonusEnv();
    const t = await service.createTemplate({ operatorId: OP, name: 'C', type: 'promo_code', currency: CUR, code: 'RACE', fixedAmount: 5n, maxUsesTotal: 2 });
    const res = await Promise.allSettled(['a', 'b', 'c', 'd', 'e'].map((p) => service.claim(OP, p, 'RACE')));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect((await service.getTemplateScoped(OP, t.id)).usesCount).toBe(2);
  });

  it('rechaza plantillas inválidas y códigos duplicados', async () => {
    const { service } = bonusEnv();
    await expect(service.createTemplate({ operatorId: OP, name: 'x', type: 'promo_code', currency: CUR })).rejects.toMatchObject({ status: 400 });
    await expect(service.createTemplate({ operatorId: OP, name: 'x', type: 'deposit_match', currency: CUR, matchBps: 100 })).rejects.toMatchObject({ status: 400 });
    await service.createTemplate({ operatorId: OP, name: 'x', type: 'promo_code', currency: CUR, code: 'DUP', fixedAmount: 1n });
    await expect(service.createTemplate({ operatorId: OP, name: 'y', type: 'promo_code', currency: CUR, code: 'dup', fixedAmount: 1n })).rejects.toMatchObject({ code: 'CODE_TAKEN' });
  });
});

describe('cashback', () => {
  it('grantCashback es idempotente por motivo (cash directo sin wagering)', async () => {
    const { service, wallet } = bonusEnv();
    const a = await service.grantCashback(OP, 'p1', 250n, 'bigloss:2026-W40');
    const b = await service.grantCashback(OP, 'p1', 250n, 'bigloss:2026-W40');
    await Promise.all([service.grantCashback(OP, 'p1', 250n, 'bigloss:2026-W40'), service.grantCashback(OP, 'p1', 250n, 'bigloss:2026-W40')]);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.bonus.id).toBe(a.bonus.id);
    expect(a.bonus.status).toBe('COMPLETED');
    const credits = wallet.getHistory({ reason: 'CASHBACK' });
    expect(credits).toHaveLength(1);
    expect(credits[0].amount).toBe(250n);
    expect((await wallet.getBalance(OP, 'p1', CUR)).cash).toBe(250n);
    await service.grantCashback(OP, 'p1', 100n, 'bigloss:2026-W41');
    expect(wallet.getHistory({ reason: 'CASHBACK' })).toHaveLength(2);
  });

  it('cashback con wagering queda ACTIVE como bono', async () => {
    const { service, wallet } = bonusEnv();
    const { bonus } = await service.grantCashback(OP, 'p1', 100n, 'promo-x', { wageringMultiplier: 3 });
    expect(bonus).toMatchObject({ status: 'ACTIVE', wageringRequired: 300n });
    expect((await wallet.getBalance(OP, 'p1', CUR)).bonus).toBe(100n);
  });

  it('runCashback paga % de la pérdida neta del periodo una sola vez', async () => {
    const { service, wallet } = bonusEnv();
    const t = await service.createTemplate({ operatorId: OP, name: 'CB 10%', type: 'cashback', currency: CUR, cashbackBps: 1000, maxBonusAmount: 1000n, stackable: true });
    const at = T0.toISOString();
    const settle = (playerId: string, roundId: string, amount: bigint, win: bigint) =>
      service.onBetSettled({ operatorId: OP, playerId, at, amount, win, currency: CUR, gameId: 'starfall', provider: 'nymfo', category: 'slots', roundId, multiplier: 0 });
    await settle('p1', 'a', 1000n, 0n);
    await settle('p1', 'a', 1000n, 0n); // duplicado
    await settle('p1', 'b', 500n, 200n);
    await settle('p2', 'c', 100n, 500n); // ganó: sin cashback
    const from = new Date(T0.getTime() - 3_600_000);
    const to = new Date(T0.getTime() + 3_600_000);
    const r1 = await service.runCashback(OP, t.id, from, to);
    expect(r1).toMatchObject({ granted: 1, total: 130n });
    await service.runCashback(OP, t.id, from, to);
    expect(wallet.getHistory({ reason: 'CASHBACK' }).map((x) => x.amount)).toEqual([130n]);
  });
});

describe('giros gratis', () => {
  it('las ganancias de los giros pasan a bono con wagering', async () => {
    const { service, wallet } = bonusEnv();
    await service.createTemplate({ operatorId: OP, name: 'FS', type: 'free_spins', currency: CUR, code: 'SPIN', freeSpinGameId: 'starfall', freeSpinCount: 2, freeSpinValue: 10n, wageringMultiplier: 5 });
    const b = await service.claim(OP, 'p1', 'SPIN');
    expect(b).toMatchObject({ status: 'ACTIVE', phase: 'SPINS' });
    expect(await service.consumeFreeSpin(OP, 'p1', 'otro-juego', 'x')).toBeNull();
    const s1 = await service.consumeFreeSpin(OP, 'p1', 'starfall', 'fs1');
    expect(s1).toMatchObject({ spinValue: 10n, remaining: 1 });
    await service.recordFreeSpinWin(b.id, 'fs1', 30n);
    await service.recordFreeSpinWin(b.id, 'fs1', 30n); // duplicado
    await service.consumeFreeSpin(OP, 'p1', 'starfall', 'fs2');
    expect(await service.consumeFreeSpin(OP, 'p1', 'starfall', 'fs3')).toBeNull();
    const done = (await service.recordFreeSpinWin(b.id, 'fs2', 12n))!;
    expect(done).toMatchObject({ phase: 'WAGERING', status: 'ACTIVE', amount: 42n, wageringRequired: 210n });
    expect((await wallet.getBalance(OP, 'p1', CUR)).bonus).toBe(42n);
  });
});
