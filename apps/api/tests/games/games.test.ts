import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GameStatus } from '@prisma/client';
import { FakeWalletService, InMemoryGameSessionRepository, makeAuth, SequenceRng } from './fakes';
import { PlaySlotsUseCase } from '../../src/application/use-cases/PlaySlotsUseCase';
import { ProcessBetUseCase } from '../../src/application/use-cases/ProcessBetUseCase';
import { PlayPlinkoUseCase } from '../../src/application/use-cases/plinko/PlayPlinkoUseCase';
import { StartMinesUseCase } from '../../src/application/use-cases/mines/StartMinesUseCase';
import { RevealMinesUseCase } from '../../src/application/use-cases/mines/RevealMinesUseCase';
import { CashoutMinesUseCase } from '../../src/application/use-cases/mines/CashoutMinesUseCase';
import { StartBlackjackHandUseCase } from '../../src/application/use-cases/blackjack/StartBlackjackHandUseCase';
import { HitBlackjackUseCase } from '../../src/application/use-cases/blackjack/HitBlackjackUseCase';
import { StandBlackjackUseCase } from '../../src/application/use-cases/blackjack/StandBlackjackUseCase';
import { PlaceCrashBetUseCase } from '../../src/application/use-cases/crash/PlaceCrashBetUseCase';
import { CashoutCrashUseCase } from '../../src/application/use-cases/crash/CashoutCrashUseCase';
import { Bet } from '../../src/domain/entities/Bet';
import { MinesGame } from '../../src/domain/entities/MinesGame';
import { CrashGameEngine } from '../../src/domain/entities/CrashGame';
import { RouletteResult } from '../../src/domain/entities/RouletteResult';
import { applyMultiplier } from '../../src/domain/money';

const auth = makeAuth();
const BET = 1_000n;

let wallet: FakeWalletService;
let repo: InMemoryGameSessionRepository;

beforeEach(() => {
  wallet = new FakeWalletService({ 'user-1': 100_000n, 'user-2': 100_000n });
  repo = new InMemoryGameSessionRepository();
});

describe('slots', () => {
  it('betAndSettle atómico con payout = applyMultiplier y claves idempotentes', async () => {
    const uc = new PlaySlotsUseCase(wallet, new SequenceRng([0, 5, 9, 14]));
    const requestId = '11111111-1111-4111-8111-111111111111';
    const res = await uc.execute(auth, BET, requestId);
    const [call] = wallet.callsOf('betAndSettle');
    expect(call.betAmount).toBe(BET);
    expect(call.winAmount).toBe(applyMultiplier(BET, res.result.payoutMultiplier));
    expect(res.payout).toBe(call.winAmount);
    expect(call.idempotencyKey).toBe(`bet:slots:user-1:${requestId}`);
    expect(call.operatorId).toBe('op-1');
    expect(typeof res.newBalance).toBe('bigint');
    expect(res.newBalance).toBe(100_000n - BET + res.payout);
  });

  it('un reintento con el mismo requestId no vuelve a jugar (409)', async () => {
    const uc = new PlaySlotsUseCase(wallet, new SequenceRng([1]));
    const requestId = '22222222-2222-4222-8222-222222222222';
    await uc.execute(auth, BET, requestId);
    const before = wallet.balances.get('user-1');
    await expect(uc.execute(auth, BET, requestId)).rejects.toMatchObject({ statusCode: 409 });
    expect(wallet.balances.get('user-1')).toBe(before);
  });

  it('saldo insuficiente propaga INSUFFICIENT_FUNDS', async () => {
    const uc = new PlaySlotsUseCase(wallet, new SequenceRng([1]));
    await expect(uc.execute(auth, 10n ** 9n)).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  });
});

describe('ruleta', () => {
  it('pleno ganador paga 36x y color ganador 2x (bigint)', async () => {
    const rng = new SequenceRng([17]);
    const uc = new ProcessBetUseCase(wallet, rng);
    const win = await uc.execute(auth, new Bet('pleno', 17, 250n));
    expect(win.payout).toBe(9_000n);
    const color = RouletteResult.getColorForNumber(17);
    const win2 = await uc.execute(auth, new Bet('color', color as 'red' | 'black', 250n));
    expect(win2.payout).toBe(500n);
    const lose = await uc.execute(auth, new Bet('pleno', 3, 250n));
    expect(lose.payout).toBe(0n);
    const calls = wallet.callsOf('betAndSettle');
    expect(calls.map((c) => c.winAmount)).toEqual([9_000n, 500n, 0n]);
    expect(calls.every((c) => c.betAmount === 250n && c.gameType === 'ROULETTE')).toBe(true);
  });
});

describe('plinko', () => {
  it('paga applyMultiplier (redondeo hacia abajo) y guarda sesión FINISHED', async () => {
    const drop = () => ({ path: ['L', 'R'] as ('L' | 'R')[], bin: 3, multiplier: 1.5 });
    const uc = new PlayPlinkoUseCase(wallet, repo, drop as any);
    const res = await uc.execute(auth, 333n, 8, 'LOW');
    expect(res.payout).toBe(499n); // 333 * 1.5 = 499.5 → 499
    const [call] = wallet.callsOf('betAndSettle');
    expect(call.winAmount).toBe(499n);
    expect(call.referenceId).toBe(res.session.id);
    expect(repo.sessions.get(res.session.id)!.status).toBe(GameStatus.FINISHED);
    expect(repo.sessions.get(res.session.id)!.state.payout).toBe('499');
  });
});

describe('mines', () => {
  const grid = (n: number) => Array.from({ length: 25 }, (_, i) => i < n);

  async function start() {
    const uc = new StartMinesUseCase(wallet, repo, grid);
    return uc.execute(auth, BET, 3);
  }

  it('start cobra con placeBet referenciando la sesión y guarda operatorId/currency', async () => {
    const res = await start();
    const [call] = wallet.callsOf('placeBet');
    expect(call.amount).toBe(BET);
    expect(call.referenceId).toBe(res.session.id);
    expect(call.idempotencyKey).toMatch(/^bet:mines:user-1:/);
    const s = repo.sessions.get(res.session.id)!;
    expect(s.operatorId).toBe('op-1');
    expect(s.currency).toBe('COP');
    expect(s.betAmount).toBe(BET);
    expect(res.newBalance).toBe(99_000n);
  });

  it('reveal de mina cierra sin pagar; cashout paga applyMultiplier una sola vez', async () => {
    const { session } = await start();
    const reveal = new RevealMinesUseCase(wallet, repo);
    const cash = new CashoutMinesUseCase(wallet, repo);
    const r = await reveal.execute(auth, session.id, 10);
    expect(r.isMine).toBe(false);
    const multiplier = MinesGame.calculateMultiplier(3, 1);
    const out = await cash.execute(auth, session.id);
    expect(out.payout).toBe(applyMultiplier(BET, multiplier));
    const [win] = wallet.callsOf('settleWin');
    expect(win.idempotencyKey).toBe(`win:${session.id}`);
    expect(win.amount).toBe(out.payout);
    await expect(cash.execute(auth, session.id)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('mina: sesión terminada sin settleWin', async () => {
    const { session } = await start();
    const r = await new RevealMinesUseCase(wallet, repo).execute(auth, session.id, 0);
    expect(r.isMine).toBe(true);
    expect(r.payout).toBe(0n);
    expect(wallet.callsOf('settleWin')).toHaveLength(0);
  });

  it('doble cashout concurrente: un solo settleWin y un 409', async () => {
    const { session } = await start();
    await new RevealMinesUseCase(wallet, repo).execute(auth, session.id, 10);
    const cash = new CashoutMinesUseCase(wallet, repo);
    const results = await Promise.allSettled([cash.execute(auth, session.id), cash.execute(auth, session.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.statusCode).toBe(409);
    expect(wallet.callsOf('settleWin')).toHaveLength(1);
  });

  it('sesión de otro usuario u otro operador → error', async () => {
    const { session } = await start();
    const cash = new CashoutMinesUseCase(wallet, repo);
    await expect(cash.execute(makeAuth({ userId: 'user-2' }), session.id)).rejects.toThrow();
    await expect(cash.execute(makeAuth({ operatorId: 'op-2' }), session.id)).rejects.toThrow();
    await expect(new RevealMinesUseCase(wallet, repo).execute(makeAuth({ userId: 'user-2' }), session.id, 5)).rejects.toThrow();
    expect(wallet.callsOf('settleWin')).toHaveLength(0);
  });

  it('si falla crear la sesión se anula la apuesta', async () => {
    repo.createSession = async () => { throw new Error('db down'); };
    await expect(new StartMinesUseCase(wallet, repo, grid).execute(auth, BET, 3)).rejects.toThrow('db down');
    expect(wallet.callsOf('rollback')).toHaveLength(1);
  });
});

describe('blackjack', () => {
  it('start: placeBet con sesión de referencia; si termina al instante paga win:<sessionId>', async () => {
    const uc = new StartBlackjackHandUseCase(wallet, repo);
    let checkedFinished = false;
    for (let i = 0; i < 200 && !checkedFinished; i++) {
      wallet.calls = [];
      const res = await uc.execute(auth, BET);
      const [bet] = wallet.callsOf('placeBet');
      expect(bet.amount).toBe(BET);
      expect(bet.referenceId).toBe(res.session.id);
      const wins = wallet.callsOf('settleWin');
      if (res.session.status === GameStatus.FINISHED) {
        checkedFinished = true;
        expect(wins).toHaveLength(res.payout > 0n ? 1 : 0);
        if (wins.length) {
          expect(wins[0].idempotencyKey).toBe(`win:${res.session.id}`);
          expect(wins[0].amount).toBe(res.payout);
        }
      } else {
        expect(wins).toHaveLength(0);
        expect(res.payout).toBe(0n);
      }
    }
  });

  it('stand: paga 0, 1x o 2x la apuesta, una sola vez, y una segunda llamada da 409/400', async () => {
    const start = new StartBlackjackHandUseCase(wallet, repo);
    const stand = new StandBlackjackUseCase(wallet, repo);
    let done = false;
    for (let i = 0; i < 200 && !done; i++) {
      const res = await start.execute(auth, BET);
      if (res.session.status !== GameStatus.ACTIVE) continue;
      wallet.calls = [];
      const out = await stand.execute(auth, res.session.id);
      expect([0n, BET, 2n * BET]).toContain(out.payout);
      expect(wallet.callsOf('settleWin')).toHaveLength(out.payout > 0n ? 1 : 0);
      await expect(stand.execute(auth, res.session.id)).rejects.toBeTruthy();
      done = true;
    }
    expect(done).toBe(true);
  });

  it('stand concurrente: un solo pago', async () => {
    const start = new StartBlackjackHandUseCase(wallet, repo);
    const stand = new StandBlackjackUseCase(wallet, repo);
    for (let i = 0; i < 200; i++) {
      const res = await start.execute(auth, BET);
      if (res.session.status !== GameStatus.ACTIVE) continue;
      wallet.calls = [];
      const rs = await Promise.allSettled([stand.execute(auth, res.session.id), stand.execute(auth, res.session.id)]);
      expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(wallet.callsOf('settleWin').length).toBeLessThanOrEqual(1);
      return;
    }
  });

  it('hit de otro operador → error', async () => {
    const start = new StartBlackjackHandUseCase(wallet, repo);
    for (let i = 0; i < 200; i++) {
      const res = await start.execute(auth, BET);
      if (res.session.status !== GameStatus.ACTIVE) continue;
      await expect(new HitBlackjackUseCase(wallet, repo).execute(makeAuth({ operatorId: 'op-9' }), res.session.id)).rejects.toThrow();
      return;
    }
  });
});

describe('crash', () => {
  const engine = CrashGameEngine.getInstance();
  const saved = { state: engine.state, m: engine.currentMultiplier, id: engine.currentRoundId };
  afterEach(() => {
    engine.state = saved.state;
    engine.currentMultiplier = saved.m;
    engine.currentRoundId = saved.id;
  });

  it('place en WAITING y cashout en CRASHING pagan applyMultiplier una vez', async () => {
    engine.state = 'WAITING';
    engine.currentRoundId = 'round-1';
    const place = new PlaceCrashBetUseCase(wallet, repo, engine);
    const cashout = new CashoutCrashUseCase(wallet, repo, engine);
    const placed = await place.execute(auth, BET);
    expect(wallet.callsOf('placeBet')[0]).toMatchObject({ amount: BET, referenceId: placed.session.id, gameType: 'CRASH' });
    engine.state = 'CRASHING';
    engine.currentMultiplier = 2.37;
    const out = await cashout.execute(auth, placed.session.id);
    expect(out.payout).toBe(applyMultiplier(BET, 2.37));
    expect(wallet.callsOf('settleWin')[0].idempotencyKey).toBe(`win:${placed.session.id}`);
    const again = await Promise.allSettled([cashout.execute(auth, placed.session.id)]);
    expect(again[0].status).toBe('rejected');
    expect(wallet.callsOf('settleWin')).toHaveLength(1);
  });

  it('cashout concurrente → un pago y un 409', async () => {
    engine.state = 'WAITING';
    engine.currentRoundId = 'round-2';
    const placed = await new PlaceCrashBetUseCase(wallet, repo, engine).execute(auth, BET);
    engine.state = 'CRASHING';
    engine.currentMultiplier = 1.5;
    const cashout = new CashoutCrashUseCase(wallet, repo, engine);
    const rs = await Promise.allSettled([cashout.execute(auth, placed.session.id), cashout.execute(auth, placed.session.id)]);
    const rejected = rs.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.statusCode).toBe(409);
    expect(wallet.callsOf('settleWin')).toHaveLength(1);
  });

  it('no se puede apostar fuera de WAITING ni cobrar sesión ajena', async () => {
    engine.state = 'CRASHING';
    await expect(new PlaceCrashBetUseCase(wallet, repo, engine).execute(auth, BET)).rejects.toMatchObject({ statusCode: 400 });
    engine.state = 'WAITING';
    engine.currentRoundId = 'round-3';
    const placed = await new PlaceCrashBetUseCase(wallet, repo, engine).execute(auth, BET);
    engine.state = 'CRASHING';
    await expect(new CashoutCrashUseCase(wallet, repo, engine).execute(makeAuth({ userId: 'user-2' }), placed.session.id)).rejects.toThrow();
  });
});
