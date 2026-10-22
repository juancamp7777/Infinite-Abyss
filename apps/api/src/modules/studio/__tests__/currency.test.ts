import { describe, expect, it } from 'vitest';
import { InMemoryOperators } from '../../shared/adapters/InMemoryOperators';
import { InMemoryWallet } from '../../shared/adapters/InMemoryWallet';
import { InMemoryEventBus, type DomainEvents } from '../../shared/events/EventBus';
import { silentLogger } from '../../shared/module';
import { StudioConfigService } from '../application/StudioConfigService';
import { StudioFairnessService } from '../application/StudioFairnessService';
import { StudioPlayService } from '../application/StudioPlayService';
import { InMemoryOperatorConfigRepository, InMemoryRoundRepository, InMemorySeedPairRepository } from '../infrastructure/memory';
import { registerOriginals } from '../index';

registerOriginals();

const OP = 'op-cop';
const P = 'p-cop';
const PLAYER = { userId: P, role: 'PLAYER' as const, operatorId: OP, playerId: P };
const DICE = { target: 50, over: true };

function setup(opts: { operators?: InMemoryOperators; defaultCurrency?: string; demoCurrency?: string } = {}) {
  const wallet = new InMemoryWallet();
  wallet.seed(OP, P, 'COP', 10_000_000n);
  wallet.seed(OP, P, 'USD', 100_000n);
  const bus = new InMemoryEventBus();
  const events: Array<{ name: keyof DomainEvents; payload: any }> = [];
  bus.subscribe('bet.placed', (p) => void events.push({ name: 'bet.placed', payload: p }));
  const rounds = new InMemoryRoundRepository();
  const config = new StudioConfigService(new InMemoryOperatorConfigRepository());
  const fairness = new StudioFairnessService(new InMemorySeedPairRepository(), rounds);
  const play = new StudioPlayService({
    wallet,
    bus,
    rounds,
    fairness,
    config,
    logger: silentLogger,
    operators: opts.operators,
    defaultCurrency: opts.defaultCurrency,
    demoCurrency: opts.demoCurrency,
  });
  return { wallet, events, config, play };
}

const copOperator = (limits: { minBet?: bigint; maxBet?: bigint } = {}, currencies = ['COP']) =>
  new InMemoryOperators().set(OP, { defaultCurrency: 'COP', currencies, limits });

describe('Studio: la divisa sale del jugador o del operador', () => {
  it('jugador real sin currency en el request → defaultCurrency del operador (COP)', async () => {
    const s = setup({ operators: copOperator() });
    const out = await s.play.play('nymfo-dice', { principal: PLAYER, amount: 100_000n, params: DICE });
    expect(out.round.currency).toBe('COP');
    expect(s.events.find((e) => e.name === 'bet.placed')?.payload.currency).toBe('COP');
    expect((await s.wallet.getBalance(OP, P, 'USD')).cash).toBe(100_000n);
    const b = await s.wallet.getBalance(OP, P, 'COP');
    expect(b.cash).toBe(10_000_000n - 100_000n + out.round.win);
  });

  it('la moneda del jugador (User.currency) gana sobre la del operador', async () => {
    const s = setup({ operators: new InMemoryOperators().set(OP, { defaultCurrency: 'USD', currencies: ['USD', 'COP'] }) });
    const bal = await s.play.balance({ principal: { ...PLAYER, currency: 'COP' } });
    expect(bal).toMatchObject({ currency: 'COP', balance: 10_000_000n, mode: 'real' });
  });

  it('rechaza una divisa pedida que el operador no tiene habilitada', async () => {
    const s = setup({ operators: copOperator() });
    await expect(s.play.play('nymfo-dice', { principal: PLAYER, amount: 100n, currency: 'USD', params: DICE })).rejects.toMatchObject({
      status: 400,
      code: 'CURRENCY_NOT_SUPPORTED',
    });
  });

  it('demo anónimo: usa la defaultCurrency del operador de la sesión con saldo demo en COP', async () => {
    const s = setup({ operators: copOperator() });
    const bal = await s.play.balance({ mode: 'demo', demoSession: 'demo-session-1', operatorId: OP });
    expect(bal).toEqual({ currency: 'COP', balance: 100_000_000n, mode: 'demo' });
    const out = await s.play.play('nymfo-dice', { mode: 'demo', demoSession: 'demo-session-1', operatorId: OP, amount: 50_000n, params: DICE });
    expect(out.round).toMatchObject({ currency: 'COP', mode: 'demo' });
  });

  it('sin operador conocido usa el respaldo de entorno (dev-server) y, si falta, USD', async () => {
    const withEnv = setup({ demoCurrency: 'EUR' });
    expect((await withEnv.play.balance({ mode: 'demo', demoSession: 'demo-session-2', operatorId: 'otro' })).currency).toBe('EUR');
    const bare = setup();
    expect((await bare.play.balance({ principal: PLAYER })).currency).toBe('USD');
  });
});

describe('Studio: límites de apuesta del operador', () => {
  it('aplica Operator.limits.minBet/maxBet si el juego no los configura y la apuesta va en la moneda del operador', async () => {
    const s = setup({ operators: copOperator({ minBet: 50_000n, maxBet: 5_000_000n }) });
    await expect(s.play.play('nymfo-dice', { principal: PLAYER, amount: 1_000n, params: DICE })).rejects.toMatchObject({ code: 'BET_TOO_LOW' });
    await expect(s.play.play('nymfo-dice', { principal: PLAYER, amount: 6_000_000n, params: DICE })).rejects.toMatchObject({ code: 'BET_TOO_HIGH' });
    await expect(s.play.play('nymfo-dice', { principal: PLAYER, amount: 50_000n, params: DICE })).resolves.toBeTruthy();
  });

  it('la config del juego prevalece y los límites del operador no aplican a otra moneda', async () => {
    const s = setup({ operators: copOperator({ minBet: 50_000n }, ['COP', 'USD']) });
    await expect(s.play.play('nymfo-dice', { principal: PLAYER, amount: 100n, currency: 'USD', params: DICE })).resolves.toBeTruthy();
    await s.config.update(OP, { gameId: 'nymfo-dice', minBet: 1_000n });
    await expect(s.play.play('nymfo-dice', { principal: PLAYER, amount: 1_000n, params: DICE })).resolves.toBeTruthy();
  });

  it('crash en vivo: betCurrency respeta la divisa fijada por la sesión y assertBetLimits aplica los del operador', async () => {
    const s = setup({ operators: copOperator({ minBet: 50_000n }, ['COP', 'USD']) });
    const real = await s.play.resolveActor({ principal: PLAYER });
    expect(real.currency).toBe('COP');
    expect(await s.play.betCurrency(real, 'USD')).toBe('USD');
    await expect(s.play.betCurrency(real, 'EUR')).rejects.toMatchObject({ code: 'CURRENCY_NOT_SUPPORTED' });
    const demo = await s.play.resolveActor({ mode: 'demo', demoSession: 'demo-session-3', operatorId: OP });
    expect(await s.play.betCurrency(demo, 'USD')).toBe('COP');
    await expect(s.play.assertBetLimits(real, 'nymfo-crash', 1_000n, 'COP')).rejects.toMatchObject({ code: 'BET_TOO_LOW' });
    await expect(s.play.assertBetLimits(real, 'nymfo-crash', 1_000n, 'USD')).resolves.toBeUndefined();
  });
});
