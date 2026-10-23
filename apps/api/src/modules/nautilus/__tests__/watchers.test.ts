import { describe, expect, it } from 'vitest';
import { detectFindings, type Snapshot } from '../domain/watchers';

const calm: Snapshot = {
  unansweredChats: { count: 0, oldestMinutes: 0 },
  pearlPendingReview: { count: 0, oldestMinutes: 0 },
  pearlWaitingBank: { count: 0, oldestMinutes: 0 },
  staleFeeds: [],
  withdrawalsPending: { count: 0, oldestHours: 0, totalMinor: 0n, currency: null },
  integrationErrors: [],
  failedDepositBursts: [],
};

describe('Nautilus: vigilantes', () => {
  it('un casino tranquilo no genera alertas', () => {
    expect(detectFindings(calm)).toEqual([]);
  });

  it('cada problema genera un hallazgo con clave estable y severidad según la demora', () => {
    const f = detectFindings({
      ...calm,
      unansweredChats: { count: 3, oldestMinutes: 45 },
      pearlPendingReview: { count: 1, oldestMinutes: 20 },
      pearlWaitingBank: { count: 2, oldestMinutes: 90 },
      staleFeeds: [{ name: 'Quikipay', hoursSilent: 30 }],
      withdrawalsPending: { count: 2, oldestHours: 13, totalMinor: 25_000_00n, currency: 'COP' },
      integrationErrors: [{ key: 'anthropic', message: 'Claude rechazó la llave (401)' }],
      failedDepositBursts: [{ userId: 'u-1', username: 'tarjetero', failed: 7 }],
    });
    const by = Object.fromEntries(f.map((x) => [x.key, x]));
    expect(Object.keys(by).sort()).toEqual([
      'cashier:pending_review', 'cashier:waiting_bank', 'fraud:failed_deposits:u-1', 'integrations:error:anthropic',
      'payments:feed_silent:Quikipay', 'payments:withdrawals_pending', 'support:unanswered',
    ]);
    expect(by['support:unanswered']).toMatchObject({ severity: 'high', title: '3 jugadores esperan respuesta' });
    expect(by['cashier:pending_review']).toMatchObject({ severity: 'warn', title: '1 comprobante para revisar en Pearl' });
    expect(by['payments:feed_silent:Quikipay'].severity).toBe('high');
    expect(by['payments:withdrawals_pending']).toMatchObject({ severity: 'high', data: { totalMinor: '2500000', currency: 'COP' } });
    expect(by['fraud:failed_deposits:u-1'].title).toContain('tarjetero');
    expect(by['integrations:error:anthropic'].detail).toContain('401');
  });

  it('demoras cortas son advertencias, no alarmas', () => {
    const f = detectFindings({ ...calm, unansweredChats: { count: 1, oldestMinutes: 12 }, withdrawalsPending: { count: 1, oldestHours: 3, totalMinor: 1n, currency: 'ARS' } });
    expect(f.map((x) => x.severity)).toEqual(['warn', 'warn']);
    expect(f[0].title).toBe('1 jugador espera respuesta');
  });
});
