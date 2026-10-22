import { describe, expect, it } from 'vitest';
import { InMemoryWallet } from '../adapters/InMemoryWallet';
import { DebitRequest, WalletError } from '../ports/WalletPort';

const OP = 'op-1';
const P = 'p-1';
const CUR = 'USD';

const bet = (key: string, amount: bigint, roundId = 'r-1'): DebitRequest => ({
  operatorId: OP,
  playerId: P,
  currency: CUR,
  amount,
  idempotencyKey: key,
  reason: 'BET',
  ref: { provider: 'nymfo', gameId: 'g-1', roundId },
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return e instanceof WalletError ? e.code : 'OTHER';
  }
};

describe('InMemoryWallet', () => {
  it('repetir la misma clave con el mismo payload devuelve el resultado original sin volver a debitar', async () => {
    const w = new InMemoryWallet();
    w.seed(OP, P, CUR, 1000n);
    const a = await w.debit(bet('k1', 100n));
    const b = await w.debit(bet('k1', 100n));
    expect(b).toEqual(a);
    expect(a.balance).toBe(900n);
    expect((await w.getBalance(OP, P, CUR)).cash).toBe(900n);
    expect(w.getHistory({ playerId: P })).toHaveLength(1);
  });

  it('misma clave con otro payload → IDEMPOTENCY_CONFLICT', async () => {
    const w = new InMemoryWallet();
    w.seed(OP, P, CUR, 1000n);
    await w.debit(bet('k1', 100n));
    expect(await code(w.debit(bet('k1', 200n)))).toBe('IDEMPOTENCY_CONFLICT');
    expect(await code(w.debit(bet('k1', 100n, 'otra-ronda')))).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('fondos insuficientes y montos inválidos', async () => {
    const w = new InMemoryWallet();
    w.seed(OP, P, CUR, 50n, 20n);
    expect(await code(w.debit(bet('k1', 71n)))).toBe('INSUFFICIENT_FUNDS');
    expect(await code(w.debit(bet('k2', 0n)))).toBe('INVALID_AMOUNT');
    expect(await code(w.debit(bet('k3', -5n)))).toBe('INVALID_AMOUNT');
    expect(await w.getBalance(OP, P, CUR)).toEqual({ cash: 50n, bonus: 20n });
  });

  it('debit consume primero cash y luego bonus; BONUS_GRANT va a bonus y WIN a cash', async () => {
    const w = new InMemoryWallet();
    w.seed(OP, P, CUR, 30n, 50n);
    const r = await w.debit(bet('k1', 50n));
    expect(r.balance).toBe(30n);
    expect(await w.getBalance(OP, P, CUR)).toEqual({ cash: 0n, bonus: 30n });
    await w.credit({ ...bet('k2', 40n), reason: 'BONUS_GRANT' });
    await w.credit({ ...bet('k3', 15n), reason: 'WIN' });
    expect(await w.getBalance(OP, P, CUR)).toEqual({ cash: 15n, bonus: 70n });
  });

  it('rollback restaura exactamente los sub-saldos y es idempotente', async () => {
    const w = new InMemoryWallet();
    w.seed(OP, P, CUR, 30n, 50n);
    await w.debit(bet('k1', 50n));
    const rb = { operatorId: OP, playerId: P, originalIdempotencyKey: 'k1', idempotencyKey: 'rb-1' };
    const a = await w.rollback(rb);
    const b = await w.rollback(rb);
    expect(b).toEqual(a);
    expect(await w.getBalance(OP, P, CUR)).toEqual({ cash: 30n, bonus: 50n });
    expect(w.findTransaction(OP, 'k1')?.rolledBackBy).toBe('rb-1');
    // Otra clave sobre la misma transacción ya anulada.
    expect(await code(w.rollback({ ...rb, idempotencyKey: 'rb-2' }))).toBe('ALREADY_ROLLED_BACK');
    // Misma clave de rollback apuntando a otra original.
    expect(await code(w.rollback({ ...rb, originalIdempotencyKey: 'otra' }))).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('rollback de una transacción desconocida → UNKNOWN_TRANSACTION', async () => {
    const w = new InMemoryWallet();
    w.seed(OP, P, CUR, 100n);
    expect(await code(w.rollback({ operatorId: OP, playerId: P, originalIdempotencyKey: 'nope', idempotencyKey: 'rb' }))).toBe(
      'UNKNOWN_TRANSACTION',
    );
    // Otro jugador no puede anular una transacción ajena.
    await w.debit(bet('k1', 10n));
    expect(await code(w.rollback({ operatorId: OP, playerId: 'p-2', originalIdempotencyKey: 'k1', idempotencyKey: 'rb2' }))).toBe(
      'UNKNOWN_TRANSACTION',
    );
  });

  it('las claves están aisladas por operador', async () => {
    const w = new InMemoryWallet();
    w.seed(OP, P, CUR, 100n);
    w.seed('op-2', P, CUR, 100n);
    await w.debit(bet('k1', 10n));
    await w.debit({ ...bet('k1', 20n), operatorId: 'op-2' });
    expect((await w.getBalance('op-2', P, CUR)).cash).toBe(80n);
  });
});
