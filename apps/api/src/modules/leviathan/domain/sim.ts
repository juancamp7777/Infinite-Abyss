import { MAX_ODDS_E2, MIN_ODDS_E2 } from './rules';

/**
 * Feed deportivo simulado (mientras no haya proveedor real): partidos cortos de fútbol, básquet y béisbol con
 * cuotas coherentes con la fuerza de cada equipo y un resultado sorteado según esas probabilidades.
 * El día que se conecte un proveedor, solo cambia la fuente de eventos y resultados.
 */
export type Sport = 'football' | 'basketball' | 'baseball';

export interface SimSelection {
  market: 'MATCH_RESULT' | 'TOTAL';
  line?: string;
  key: string;
  label: string;
  prob: number;
}

const TEAMS: Record<Sport, { league: string; teams: string[] }> = {
  football: { league: 'Liga Abyss', teams: ['Atlético Coral', 'Deportivo Marea', 'Real Abisal', 'Tiburones FC', 'Unión Perla', 'Club Ancla', 'Corsarios', 'Leviatanes', 'Medusas United', 'Kraken CF'] },
  basketball: { league: 'Abyss Basket', teams: ['Orcas', 'Mantarrayas', 'Barracudas', 'Delfines', 'Pulpos', 'Ballenas'] },
  baseball: { league: 'Abyss Béisbol', teams: ['Piratas del Caribe', 'Navegantes', 'Tritones', 'Faros', 'Arrecifes', 'Galeones'] },
};

const pick = <T>(xs: T[], rand: () => number) => xs[Math.floor(rand() * xs.length)];

/** Cuota con 6 % de margen de la casa de referencia, ×100, dentro del rango permitido. */
export const oddsFor = (prob: number) => Math.min(MAX_ODDS_E2, Math.max(MIN_ODDS_E2, Math.round(100 / (prob * 1.06))));

/** Un partido nuevo con sus mercados (1X2 o ganador, y total de puntos). */
export function simFixture(sport: Sport, rand: () => number = Math.random, busy: ReadonlySet<string> = new Set()) {
  const { league } = TEAMS[sport];
  // Un equipo no juega dos partidos a la vez.
  const free = TEAMS[sport].teams.filter((t) => !busy.has(t));
  const teams = free.length >= 2 ? free : TEAMS[sport].teams;
  const home = pick(teams, rand);
  let away = pick(teams, rand);
  while (away === home) away = pick(teams, rand);
  const strength = 0.25 + rand() * 0.5; // probabilidad base del local
  const sel: SimSelection[] = [];
  if (sport === 'football') {
    const draw = 0.22 + rand() * 0.08;
    const homeP = (1 - draw) * strength;
    sel.push(
      { market: 'MATCH_RESULT', key: '1', label: home, prob: homeP },
      { market: 'MATCH_RESULT', key: 'X', label: 'Empate', prob: draw },
      { market: 'MATCH_RESULT', key: '2', label: away, prob: 1 - draw - homeP },
      { market: 'TOTAL', line: '2.5', key: 'OVER', label: 'Más de 2.5 goles', prob: 0.5 },
      { market: 'TOTAL', line: '2.5', key: 'UNDER', label: 'Menos de 2.5 goles', prob: 0.5 },
    );
  } else {
    const line = sport === 'basketball' ? '160.5' : '8.5';
    const unit = sport === 'basketball' ? 'puntos' : 'carreras';
    sel.push(
      { market: 'MATCH_RESULT', key: '1', label: home, prob: strength },
      { market: 'MATCH_RESULT', key: '2', label: away, prob: 1 - strength },
      { market: 'TOTAL', line, key: 'OVER', label: `Más de ${line} ${unit}`, prob: 0.5 },
      { market: 'TOTAL', line, key: 'UNDER', label: `Menos de ${line} ${unit}`, prob: 0.5 },
    );
  }
  return { sport, league, home, away, selections: sel.map((s) => ({ ...s, oddsE2: oddsFor(s.prob) })) };
}

/** Resultado del partido: marcador coherente con las probabilidades y qué selecciones ganan. */
export function simResult(sport: Sport, selections: Array<{ market: string; key: string; line?: string | null; oddsE2: number }>, rand: () => number = Math.random) {
  const winnerOf = (market: string) => {
    const ss = selections.filter((s) => s.market === market);
    const w = ss.map((s) => 1 / (s.oddsE2 / 100));
    const total = w.reduce((a, b) => a + b, 0);
    let r = rand() * total;
    for (let i = 0; i < ss.length; i++) {
      r -= w[i];
      if (r <= 0) return ss[i].key;
    }
    return ss[ss.length - 1]?.key;
  };
  const result = winnerOf('MATCH_RESULT');
  const over = winnerOf('TOTAL') === 'OVER';
  const line = Number(selections.find((s) => s.market === 'TOTAL')?.line ?? (sport === 'football' ? 2.5 : 8.5));
  // Marcador que respeta el ganador y el total sorteados.
  const total = over ? Math.ceil(line) + Math.floor(rand() * (sport === 'basketball' ? 25 : 3)) : Math.max(0, Math.floor(line) - Math.floor(rand() * (sport === 'basketball' ? 25 : 3)));
  let home: number;
  let away: number;
  if (result === 'X') {
    // Empate: total par (si no, se ajusta y el total se recalcula abajo).
    home = away = Math.floor(total / 2);
  } else {
    const margin = 1 + Math.floor(rand() * Math.max(1, Math.min(total, sport === 'basketball' ? 15 : 3)));
    const hi = Math.max(margin, Math.ceil((total + margin) / 2));
    const lo = Math.max(0, total - hi);
    [home, away] = result === '1' ? [hi, lo] : [lo, hi];
  }
  const finalOver = home + away > line;
  const winners = new Set<string>([`MATCH_RESULT:${result}`, `TOTAL:${finalOver ? 'OVER' : 'UNDER'}`]);
  return { home, away, winners };
}

export const SPORTS: Sport[] = ['football', 'basketball', 'baseball'];
/** Duración simulada de cada partido (minutos). Cortos para que caigan dentro de un concurso de 2 horas. */
export const MATCH_MINUTES: Record<Sport, number> = { football: 30, basketball: 25, baseball: 35 };
