import type { GameMath } from '../domain/GameMath';
import { getGameMath, listGameMath } from '../domain/games/registry';
import { INTERACTIVE_GAMES, InteractiveGame, rtpToProfile } from '../domain/originals';

/** Vista unificada de un juego de Studios (GameMath del registro y/o versión interactiva). */
export interface StudioGameEntry {
  id: string;
  name: string;
  kind: 'slot' | 'original';
  math?: GameMath<any, any>;
  interactive?: InteractiveGame<any>;
  rtpTarget: number;
  rtpRange?: { min: number; max: number };
  /** Perfiles discretos (slots) en porcentaje como string. */
  rtpProfiles?: string[];
}

export type RtpMode = 'range' | 'profiles' | 'fixed';

export function findGame(id: string): StudioGameEntry | undefined {
  const math = getGameMath(id);
  const interactive = INTERACTIVE_GAMES[id];
  if (!math && !interactive) return undefined;
  const base = math ?? interactive!;
  const profiles = (math as { rtpProfiles?: unknown } | undefined)?.rtpProfiles;
  return {
    id,
    name: base.name,
    kind: math?.kind ?? 'original',
    math,
    interactive,
    rtpTarget: base.rtpTarget,
    rtpRange: base.rtpRange,
    rtpProfiles: Array.isArray(profiles) ? profiles.map(String) : undefined,
  };
}

export function listGames(): StudioGameEntry[] {
  const ids = new Set<string>([...listGameMath().map((g) => g.id), ...Object.keys(INTERACTIVE_GAMES)]);
  return [...ids].map((id) => findGame(id)!).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Cómo se configura el RTP del juego:
 * - profiles: slots con `rtpProfiles` (perfiles discretos).
 * - range: originals con rtpRange (RTP continuo con 2 decimales en %).
 * - fixed: solo el RTP por defecto (slots sin perfiles, ruleta, blackjack).
 */
export function rtpMode(g: StudioGameEntry): RtpMode {
  if (g.rtpProfiles && g.rtpProfiles.length > 0) return 'profiles';
  if (g.kind === 'original' && g.rtpRange) return 'range';
  return 'fixed';
}

export const defaultProfile = (g: StudioGameEntry): string => rtpToProfile(g.rtpTarget);
