import type { GameMath } from '../GameMath';
import { nymfoBlackjack } from './blackjack';
import { nymfoCrash, nymfoCrashLive } from './crash';
import { nymfoDice } from './dice';
import { nymfoMines, nymfoMinesInteractive } from './mines';
import { nymfoPlinko } from './plinko';
import { nymfoRoulette } from './roulette';
import type { InteractiveGame } from './types';

export * from './types';
export { nymfoBlackjack, nymfoCrash, nymfoCrashLive, nymfoDice, nymfoMines, nymfoMinesInteractive, nymfoPlinko, nymfoRoulette };

/** Originals de una sola acción (GameMath: sirven al simulador y a POST /play). */
export const ORIGINAL_GAMES: GameMath<any, any>[] = [nymfoDice, nymfoPlinko, nymfoRoulette, nymfoCrash, nymfoMines];

/** Originals interactivos (POST /games/:id/start|action). */
export const INTERACTIVE_GAMES: Record<string, InteractiveGame<any>> = {
  [nymfoMinesInteractive.id]: nymfoMinesInteractive,
  [nymfoBlackjack.id]: nymfoBlackjack,
  [nymfoCrashLive.id]: nymfoCrashLive,
};
