/**
 * Leviathan (concursos de fichas sobre deportes, heredado de BetBattle): reglas puras.
 * Todos pagan la misma entrada y reciben las mismas fichas; apuestan esas fichas a cuotas reales y, al terminar,
 * el pozo (entradas − comisión) se reparte por posición según las fichas finales. El casino nunca es contraparte.
 */
export type GameMode = 'QUICK' | 'FRIENDS';
export type GameStatus = 'OPEN' | 'RUNNING' | 'SETTLING' | 'SETTLED' | 'CANCELLED';
export type Curve = 'TOP_3_60_25_15' | 'TOP_20_PCT_LINEAR' | 'NONE';

export const OPENING_CHIPS = 1000n;
/** Comisión: 5 % del pozo (partes por millón). */
export const RAKE_PPM = 50_000;

export const MODE_SPEC: Record<GameMode, { durationMin: number; minBets: number; maxBets: number; minPlayers: number; maxPlayers: number; curve: Curve }> = {
  QUICK: { durationMin: 120, minBets: 3, maxBets: 15, minPlayers: 2, maxPlayers: 100, curve: 'TOP_3_60_25_15' },
  FRIENDS: { durationMin: 120, minBets: 1, maxBets: 15, minPlayers: 2, maxPlayers: 20, curve: 'TOP_3_60_25_15' },
};

/** Código de sala: 5 caracteres sin letras confusas (sin I, O, 0, 1). */
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function roomCode(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += ROOM_ALPHABET[Math.floor(rand() * ROOM_ALPHABET.length)];
  return s;
}
export const isRoomCode = (s: string) => new RegExp(`^[${ROOM_ALPHABET}]{5}$`).test(s);

/** Cuotas decimales con 2 decimales, guardadas ×100 (1.85 → 185). Rango [1.01, 1000]. */
export const MIN_ODDS_E2 = 101;
export const MAX_ODDS_E2 = 100_000;

/** Retorno en fichas de una apuesta ganada, congelado al apostar: stake × cuota, redondeo half-up. */
export const betReturn = (stake: bigint, oddsE2: number): bigint => (2n * stake * BigInt(oddsE2) + 100n) / 200n;

/** Redondeo half-up de a·num/den (enteros no negativos). */
const halfUp = (a: bigint, num: bigint, den: bigint) => (2n * a * num + den) / (2n * den);

/** Comisión y pozo, con el residuo de redondeo aparte (rake + pool + residue = pot). */
export function splitPot(pot: bigint, rakePpm = RAKE_PPM) {
  const rake = halfUp(pot, BigInt(rakePpm), 1_000_000n);
  const pool = halfUp(pot, BigInt(1_000_000 - rakePpm), 1_000_000n);
  return { rake, pool, residue: pot - rake - pool };
}

/** Pesos por posición de una curva para `qualified` jugadores que califican. */
export function curveWeights(curve: Curve, qualified: number): bigint[] {
  if (curve === 'NONE' || qualified <= 0) return [];
  if (curve === 'TOP_3_60_25_15') return [60n, 25n, 15n].slice(0, Math.min(3, qualified));
  const n = Math.max(1, Math.floor(qualified / 5));
  return Array.from({ length: n }, (_, i) => BigInt(n - i));
}

/**
 * Reparto por resto mayor: cada parte = piso(pool·wᵢ/W); lo que sobra (menos de n unidades) se reparte de a 1
 * a los restos mayores, desempatando a favor de la mejor posición. La suma es exactamente el pool.
 */
export function divideLargestRemainder(pool: bigint, weights: bigint[]): bigint[] {
  if (!weights.length) return [];
  const W = weights.reduce((a, b) => a + b, 0n);
  const base = weights.map((w) => (pool * w) / W);
  const rem = weights.map((w, i) => ({ i, r: (pool * w) % W }));
  let left = pool - base.reduce((a, b) => a + b, 0n);
  rem.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of rem) {
    if (left <= 0n) break;
    base[i] += 1n;
    left -= 1n;
  }
  return base;
}

export interface Standing {
  entryId: string;
  playerId: string;
  chips: bigint;
  bets: number;
  joinedAt: Date;
}

/** Orden final: más fichas primero; empate, quien entró antes; luego el id (posiciones únicas). */
export const rankStandings = <T extends Standing>(xs: T[]): T[] =>
  [...xs].sort((a, b) => (a.chips === b.chips ? a.joinedAt.getTime() - b.joinedAt.getTime() || a.entryId.localeCompare(b.entryId) : a.chips > b.chips ? -1 : 1));

/**
 * Premios: solo califican quienes hicieron entre minBets y maxBets apuestas; los demás no cobran y la tabla
 * se corre. Si nadie califica, el pool entero queda como residuo de la curva.
 */
export function settle(standings: Standing[], opts: { pot: bigint; rakePpm: number; curve: Curve; minBets: number; maxBets: number }) {
  const { rake, pool, residue } = splitPot(opts.pot, opts.rakePpm);
  const ranked = rankStandings(standings);
  const qualified = ranked.filter((s) => s.bets >= opts.minBets && s.bets <= opts.maxBets);
  const shares = divideLargestRemainder(pool, curveWeights(opts.curve, qualified.length));
  const prizeOf = new Map(qualified.map((s, i) => [s.entryId, shares[i] ?? 0n]));
  const curveResidue = shares.length ? 0n : pool;
  return {
    rake,
    pool,
    residue,
    curveResidue,
    results: ranked.map((s, i) => ({ entryId: s.entryId, playerId: s.playerId, rank: i + 1, qualified: qualified.includes(s), prize: prizeOf.get(s.entryId) ?? 0n })),
  };
}
