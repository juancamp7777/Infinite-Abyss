import {
  IGameSessionRepository,
  GameSessionData,
  CreateGameSessionInput,
  GameSessionScope,
} from '../../domain/repositories/IGameSessionRepository';
import { prisma } from '../database/prisma';
import { GameStatus } from '@prisma/client';

export class PrismaGameSessionRepository implements IGameSessionRepository {
  public async createSession(input: CreateGameSessionInput): Promise<GameSessionData> {
    const session = await prisma.gameSession.create({
      data: {
        ...(input.id ? { id: input.id } : {}),
        operatorId: input.operatorId,
        userId: input.userId,
        gameType: input.gameType,
        betAmount: input.betAmount,
        currency: input.currency,
        state: input.state,
        ...(input.status ? { status: input.status } : {}),
      },
    });
    return session as GameSessionData;
  }

  public async getSession(sessionId: string, scope: GameSessionScope): Promise<GameSessionData | null> {
    const session = await prisma.gameSession.findFirst({
      where: { id: sessionId, operatorId: scope.operatorId, userId: scope.userId },
    });
    return (session as GameSessionData | null) ?? null;
  }

  public async updateSessionState(sessionId: string, state: any, status?: GameStatus): Promise<GameSessionData> {
    const session = await prisma.gameSession.update({
      where: { id: sessionId },
      data: { state, ...(status ? { status } : {}) },
    });
    return session as GameSessionData;
  }

  public async finishIfActive(sessionId: string, state: any): Promise<boolean> {
    const result = await prisma.gameSession.updateMany({
      where: { id: sessionId, status: GameStatus.ACTIVE },
      data: { state, status: GameStatus.FINISHED },
    });
    return result.count > 0;
  }
}
