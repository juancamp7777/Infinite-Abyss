import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { GameStatus, GameType } from '@prisma/client';
import { prisma } from '../../src/infrastructure/database/prisma';
import { PrismaGameSessionRepository } from '../../src/infrastructure/repositories/PrismaGameSessionRepository';
import { createTestOperator, createTestPlayer } from '../setup/factories';

afterAll(async () => { await prisma.$disconnect(); });

describe('PrismaGameSessionRepository (integración)', () => {
  it('finishIfActive cierra una sola vez y getSession respeta usuario/operador', async () => {
    const op = await createTestOperator();
    const user = await createTestPlayer(op.id);
    const operatorId = op.id;
    const userId = user.id;

    const repo = new PrismaGameSessionRepository();
    const s = await repo.createSession({ operatorId, userId, gameType: GameType.MINES, betAmount: 500n, currency: 'COP', state: { a: 1 } });
    expect(s.betAmount).toBe(500n);
    expect(await repo.getSession(s.id, { operatorId, userId })).not.toBeNull();
    expect(await repo.getSession(s.id, { operatorId, userId: randomUUID() })).toBeNull();
    expect(await repo.getSession(s.id, { operatorId: randomUUID(), userId })).toBeNull();

    const results = await Promise.all([repo.finishIfActive(s.id, { a: 2 }), repo.finishIfActive(s.id, { a: 3 })]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const after = await repo.getSession(s.id, { operatorId, userId });
    expect(after!.status).toBe(GameStatus.FINISHED);
  });
});
