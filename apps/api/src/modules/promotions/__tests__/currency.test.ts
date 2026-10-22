import { describe, expect, it } from 'vitest';
import { InMemoryOperators } from '../../shared/adapters/InMemoryOperators';
import { InMemoryWallet } from '../../shared/adapters/InMemoryWallet';
import { silentLogger } from '../../shared/module';
import { WalletBonusFunds } from '../application/BonusFunds';
import { BonusService } from '../application/BonusService';
import { InMemoryBonusRepository } from '../infrastructure/memory/InMemoryBonusRepository';

const OP = 'op-cop';
const P = 'p-cop';

function service(opts: { operators?: InMemoryOperators; defaultCurrency?: string }) {
  const wallet = new InMemoryWallet();
  const bonuses = new BonusService({
    repo: new InMemoryBonusRepository(),
    funds: new WalletBonusFunds(wallet),
    clock: () => new Date('2026-10-21T12:00:00Z'),
    logger: silentLogger,
    operators: opts.operators,
    defaultCurrency: opts.defaultCurrency,
  });
  return { wallet, bonuses };
}

describe('promociones: moneda del operador', () => {
  it('grantCashback sin currency usa la defaultCurrency del operador (COP)', async () => {
    const s = service({ operators: new InMemoryOperators().set(OP, { defaultCurrency: 'COP' }), defaultCurrency: 'USD' });
    const { bonus } = await s.bonuses.grantCashback(OP, P, 500_000n, 'perdida-semana-42');
    expect(bonus.currency).toBe('COP');
    expect((await s.wallet.getBalance(OP, P, 'COP')).cash).toBe(500_000n);
  });

  it('una currency explícita gana y sin operador se usa el respaldo de entorno', async () => {
    const s = service({ defaultCurrency: 'EUR' });
    expect((await s.bonuses.grantCashback(OP, P, 100n, 'r1')).bonus.currency).toBe('EUR');
    expect((await s.bonuses.grantCashback(OP, P, 100n, 'r2', { currency: 'USD' })).bonus.currency).toBe('USD');
  });
});
