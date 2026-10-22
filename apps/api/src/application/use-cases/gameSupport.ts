import { randomUUID } from 'crypto';
import { GameStatus } from '@prisma/client';
import { AppError } from '../../domain/errors/AppError';
import { Card } from '../../domain/entities/Card';
import { PlayerAuth } from '../../domain/contracts';
import { GameSessionData, IGameSessionRepository } from '../../domain/repositories/IGameSessionRepository';

/** Clave de idempotencia de una apuesta: bet:<juego>:<userId>:<requestId|uuid>. */
export function betIdempotencyKey(game: string, userId: string, requestId?: string): string {
  return `bet:${game}:${userId}:${requestId ?? randomUUID()}`;
}

/** Clave de idempotencia del pago de una sesión: win:<sessionId>. */
export function winIdempotencyKey(sessionId: string): string {
  return `win:${sessionId}`;
}

/** Un reintento con el mismo requestId no vuelve a jugar: evita mostrar un resultado distinto al cobrado. */
export function assertNotReplay(idempotentReplay: boolean): void {
  if (idempotentReplay) throw AppError.conflict('Solicitud duplicada');
}

/** Carga una sesión ACTIVE del jugador (userId Y operatorId del contexto). */
export async function loadActiveSession(
  repo: IGameSessionRepository,
  auth: PlayerAuth,
  sessionId: string
): Promise<GameSessionData> {
  const session = await repo.getSession(sessionId, { operatorId: auth.operatorId, userId: auth.userId });
  if (!session || session.status !== GameStatus.ACTIVE) {
    throw new AppError('Sesión de juego inválida o inactiva', 400);
  }
  return session;
}

/** Cierra la sesión una sola vez; si otra petición ya lo hizo → 409 (no se paga). */
export async function finishOrConflict(repo: IGameSessionRepository, sessionId: string, state: any): Promise<void> {
  const changed = await repo.finishIfActive(sessionId, state);
  if (!changed) throw AppError.conflict('La sesión de juego ya terminó');
}

/**
 * El estado de blackjack se guarda como JSON: las cartas pierden el getter `value`.
 * Rehidrata mazo, mano del jugador y del crupier como instancias de Card.
 */
export function hydrateBlackjackState(state: any): void {
  const toCard = (c: any) => new Card(c.suit, c.rank);
  state.deckCards = (state.deckCards ?? []).map(toCard);
  state.playerCards = (state.playerCards ?? []).map(toCard);
  state.dealerCards = (state.dealerCards ?? []).map(toCard);
}
