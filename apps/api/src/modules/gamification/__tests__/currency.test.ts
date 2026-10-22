import { describe, expect, it } from 'vitest';
import { InMemoryOperators } from '../../shared/adapters/InMemoryOperators';
import { InMemoryWallet } from '../../shared/adapters/InMemoryWallet';
import { InMemoryEventBus } from '../../shared/events/EventBus';
import { silentLogger } from '../../shared/module';
import { loadSettings, saveSettings } from '../application/context';
import { GamificationService } from '../application/service';
import { InMemoryDocStore } from '../infrastructure/DocStore';
import { defaultLevels, defaultSettings } from '../domain/types';

const OP = 'op-cop';

function svc(operators?: InMemoryOperators, fallbackCurrency?: string) {
  return new GamificationService({ store: new InMemoryDocStore(), wallet: new InMemoryWallet(), bus: new InMemoryEventBus(), logger: silentLogger, operators, fallbackCurrency });
}

describe('gamificación: moneda del operador', () => {
  it('los ajustes sin moneda guardada toman la defaultCurrency del operador', async () => {
    const s = svc(new InMemoryOperators().set(OP, { defaultCurrency: 'COP' }));
    expect((await loadSettings(s.ctx, OP)).currency).toBe('COP');
  });

  it('una moneda guardada en los ajustes del operador prevalece', async () => {
    const s = svc(new InMemoryOperators().set(OP, { defaultCurrency: 'COP' }));
    await saveSettings(s.ctx, OP, { currency: 'USD' });
    expect((await loadSettings(s.ctx, OP)).currency).toBe('USD');
  });

  it('sin operador conocido usa el respaldo del dev-server', async () => {
    expect((await loadSettings(svc(undefined, 'EUR').ctx, OP)).currency).toBe('EUR');
    expect((await loadSettings(svc().ctx, OP)).currency).toBe('USD');
  });

  it('en COP los montos por defecto se escalan (1 punto = 1.000 COP) y los niveles VIP pagan en COP', async () => {
    const s = svc(new InMemoryOperators().set(OP, { defaultCurrency: 'COP' }));
    const cfg = await loadSettings(s.ctx, OP);
    expect(cfg.unitsPerPoint.default).toBe(100_000n);
    expect(cfg.wheel.maxExpectedValue).toBe(500_000n);
    const levels = await s.vip.levels(OP);
    expect(levels.find((l) => l.id === 'silver')?.levelUpBonus).toBe(500_000n);
    expect(defaultSettings('USD').unitsPerPoint.default).toBe(100n);
    expect(defaultLevels(OP, 'USD').find((l) => l.id === 'silver')?.levelUpBonus).toBe(500n);
  });
});
