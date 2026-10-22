import type { GameMath } from '../GameMath';

/**
 * Registro de matemáticas de juegos de Nymfo Studios (slots y originals).
 * Lo llena la integración importando cada juego y llamando a registerGame.
 */
export const GAMES: Record<string, GameMath<any, any>> = {};

export function registerGame(game: GameMath<any, any>): GameMath<any, any> {
  if (!game?.id) throw new Error('El juego debe tener id');
  const existing = GAMES[game.id];
  if (existing && existing !== game) throw new Error(`Juego duplicado en el registro: ${game.id}`);
  GAMES[game.id] = game;
  return game;
}

export function getGameMath(id: string): GameMath<any, any> | undefined {
  return GAMES[id];
}

export function listGameMath(): GameMath<any, any>[] {
  return Object.values(GAMES);
}
