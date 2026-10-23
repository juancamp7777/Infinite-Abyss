/**
 * API-Football v3 (api-sports.io): partidos, cuotas pre-partido y resultados de fútbol para Leviathan.
 * Host v3.football.api-sports.io, llave en la cabecera x-apisports-key. Respuestas { response: [...], errors }.
 * La lectura es tolerante: lo que no tenga la forma esperada se ignora en vez de romper el barrido.
 */
export type RealStatus = 'SCHEDULED' | 'LIVE' | 'FINISHED' | 'CANCELLED';

export interface RealFixture {
  externalId: string;
  leagueId: number;
  league: string;
  home: string;
  away: string;
  startsAt: Date;
  status: RealStatus;
  /** Marcador de los 90 minutos (con el que se liquidan 1X2 y total de goles). */
  homeScore: number | null;
  awayScore: number | null;
}

export interface RealSelection {
  market: 'MATCH_RESULT' | 'TOTAL';
  line?: string;
  key: string;
  label: string;
  oddsE2: number;
}

/** Ligas por defecto: BetPlay (Colombia), Champions, Libertadores, Premier, LaLiga, Argentina, Liga MX. */
export const DEFAULT_LEAGUES = [239, 2, 13, 39, 140, 128, 262];

const STATUS: Record<string, RealStatus> = {
  TBD: 'SCHEDULED', NS: 'SCHEDULED',
  '1H': 'LIVE', HT: 'LIVE', '2H': 'LIVE', ET: 'LIVE', BT: 'LIVE', P: 'LIVE', SUSP: 'LIVE', INT: 'LIVE', LIVE: 'LIVE',
  FT: 'FINISHED', AET: 'FINISHED', PEN: 'FINISHED',
  PST: 'CANCELLED', CANC: 'CANCELLED', ABD: 'CANCELLED', AWD: 'CANCELLED', WO: 'CANCELLED',
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseFixture(raw: unknown): RealFixture | null {
  const r = obj(raw);
  const f = obj(r.fixture);
  const league = obj(r.league);
  const teams = obj(r.teams);
  const id = num(f.id);
  const date = typeof f.date === 'string' ? new Date(f.date) : null;
  const home = obj(teams.home).name;
  const away = obj(teams.away).name;
  if (id === null || !date || Number.isNaN(date.getTime()) || typeof home !== 'string' || typeof away !== 'string') return null;
  const status = STATUS[String(obj(f.status).short ?? '')] ?? 'SCHEDULED';
  // 1X2 y total se liquidan con el marcador de los 90': score.fulltime; si no viene, goals.
  const ft = obj(obj(r.score).fulltime);
  const goals = obj(r.goals);
  return {
    externalId: String(id), leagueId: num(league.id) ?? 0, league: String(league.name ?? 'Fútbol'), home, away, startsAt: date, status,
    homeScore: num(ft.home) ?? num(goals.home), awayScore: num(ft.away) ?? num(goals.away),
  };
}

const toOddsE2 = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1.01 && n <= 1000 ? Math.round(n * 100) : null;
};

/** Cuotas del primer bookmaker que tenga "Match Winner"; suma "Goals Over/Under 2.5" si lo trae. */
export function parseOdds(raw: unknown, home: string, away: string): RealSelection[] {
  for (const bm of (obj(raw).bookmakers as unknown[] | undefined) ?? []) {
    const bets = (obj(bm).bets as unknown[] | undefined) ?? [];
    const byName = (name: string) => bets.map(obj).find((b) => String(b.name).toLowerCase() === name);
    const mw = byName('match winner');
    if (!mw) continue;
    const vals = ((mw.values as unknown[] | undefined) ?? []).map(obj);
    const odd = (v: string) => toOddsE2(vals.find((x) => x.value === v)?.odd);
    const h = odd('Home');
    const d = odd('Draw');
    const a = odd('Away');
    if (!h || !d || !a) continue;
    const out: RealSelection[] = [
      { market: 'MATCH_RESULT', key: '1', label: home, oddsE2: h },
      { market: 'MATCH_RESULT', key: 'X', label: 'Empate', oddsE2: d },
      { market: 'MATCH_RESULT', key: '2', label: away, oddsE2: a },
    ];
    const ou = ((byName('goals over/under')?.values as unknown[] | undefined) ?? []).map(obj);
    const over = toOddsE2(ou.find((x) => x.value === 'Over 2.5')?.odd);
    const under = toOddsE2(ou.find((x) => x.value === 'Under 2.5')?.odd);
    if (over && under) {
      out.push(
        { market: 'TOTAL', line: '2.5', key: 'OVER', label: 'Más de 2.5 goles', oddsE2: over },
        { market: 'TOTAL', line: '2.5', key: 'UNDER', label: 'Menos de 2.5 goles', oddsE2: under },
      );
    }
    return out;
  }
  return [];
}

/** Selecciones ganadoras con el marcador de los 90 minutos. */
export function winnersFor(home: number, away: number): Set<string> {
  return new Set([`MATCH_RESULT:${home > away ? '1' : home < away ? '2' : 'X'}`, `TOTAL:${home + away > 2.5 ? 'OVER' : 'UNDER'}`]);
}

export class ApiFootball {
  constructor(
    private readonly key: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly base = 'https://v3.football.api-sports.io',
  ) {}

  private async get(path: string, params: Record<string, string>): Promise<unknown[]> {
    const res = await this.fetchFn(`${this.base}/${path}?${new URLSearchParams(params).toString()}`, {
      headers: { 'x-apisports-key': this.key },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`API-Football respondió ${res.status}`);
    const body = obj(await res.json());
    const errors = body.errors;
    const hasErrors = Array.isArray(errors) ? errors.length > 0 : errors && typeof errors === 'object' && Object.keys(errors).length > 0;
    if (hasErrors) throw new Error(`API-Football: ${JSON.stringify(errors).slice(0, 200)}`);
    return Array.isArray(body.response) ? body.response : [];
  }

  async fixturesByDate(date: string): Promise<RealFixture[]> {
    return (await this.get('fixtures', { date, timezone: 'UTC' })).map(parseFixture).filter((f): f is RealFixture => !!f);
  }

  /** Hasta 20 partidos por consulta. */
  async fixturesByIds(ids: string[]): Promise<RealFixture[]> {
    if (!ids.length) return [];
    return (await this.get('fixtures', { ids: ids.slice(0, 20).join('-'), timezone: 'UTC' })).map(parseFixture).filter((f): f is RealFixture => !!f);
  }

  async odds(fixtureId: string, home: string, away: string): Promise<RealSelection[]> {
    const rows = await this.get('odds', { fixture: fixtureId });
    return rows.length ? parseOdds(rows[0], home, away) : [];
  }
}
