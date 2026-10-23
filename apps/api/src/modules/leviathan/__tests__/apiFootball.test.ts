import { describe, expect, it } from 'vitest';
import { ApiFootball, parseFixture, parseOdds, winnersFor } from '../infrastructure/apiFootball';

const fixture = (id: number, short: string, extra: Record<string, unknown> = {}) => ({
  fixture: { id, date: '2030-01-02T20:00:00+00:00', status: { short } },
  league: { id: 239, name: 'Primera A' },
  teams: { home: { name: 'Millonarios' }, away: { name: 'Nacional' } },
  goals: { home: 2, away: 1 },
  score: { fulltime: { home: 2, away: 1 } },
  ...extra,
});
const odds = {
  bookmakers: [
    { id: 1, bets: [{ id: 5, name: 'Goals Over/Under', values: [{ value: 'Over 2.5', odd: '1.95' }] }] }, // sin Match Winner: se salta
    { id: 8, bets: [
      { id: 1, name: 'Match Winner', values: [{ value: 'Home', odd: '2.10' }, { value: 'Draw', odd: '3.30' }, { value: 'Away', odd: '3.60' }] },
      { id: 5, name: 'Goals Over/Under', values: [{ value: 'Over 1.5', odd: '1.30' }, { value: 'Over 2.5', odd: '2.05' }, { value: 'Under 2.5', odd: '1.80' }] },
    ] },
  ],
};

describe('API-Football: lectura tolerante', () => {
  it('partido, estados y marcador de los 90 minutos', () => {
    expect(parseFixture(fixture(10, 'NS'))).toMatchObject({ externalId: '10', leagueId: 239, home: 'Millonarios', away: 'Nacional', status: 'SCHEDULED' });
    expect(parseFixture(fixture(10, '2H'))?.status).toBe('LIVE');
    expect(parseFixture(fixture(10, 'PST'))?.status).toBe('CANCELLED');
    // Con alargue, 1X2 se liquida con los 90': fulltime 1-1 aunque goals diga 2-1.
    const aet = parseFixture(fixture(10, 'AET', { goals: { home: 2, away: 1 }, score: { fulltime: { home: 1, away: 1 } } }));
    expect(aet).toMatchObject({ status: 'FINISHED', homeScore: 1, awayScore: 1 });
    expect(parseFixture({ fixture: { id: 'x' } })).toBeNull();
  });

  it('cuotas del primer bookmaker con ganador; total 2.5 si viene', () => {
    const sels = parseOdds(odds, 'Millonarios', 'Nacional');
    expect(sels.map((s) => [s.market, s.key, s.oddsE2])).toEqual([
      ['MATCH_RESULT', '1', 210], ['MATCH_RESULT', 'X', 330], ['MATCH_RESULT', '2', 360], ['TOTAL', 'OVER', 205], ['TOTAL', 'UNDER', 180],
    ]);
    expect(parseOdds({ bookmakers: [] }, 'a', 'b')).toEqual([]);
  });

  it('ganadores por marcador', () => {
    expect([...winnersFor(2, 1)]).toEqual(['MATCH_RESULT:1', 'TOTAL:OVER']);
    expect([...winnersFor(1, 1)]).toEqual(['MATCH_RESULT:X', 'TOTAL:UNDER']);
  });

  it('llave en la cabecera, ids en lote y errores de la API', async () => {
    let url = '';
    let key = '';
    const ok = (async (u: string, init: RequestInit) => {
      url = u;
      key = (init.headers as Record<string, string>)['x-apisports-key'];
      return new Response(JSON.stringify({ errors: [], response: [fixture(1, 'FT'), fixture(2, 'NS')] }));
    }) as unknown as typeof fetch;
    const api = new ApiFootball('llave-de-prueba', ok);
    expect((await api.fixturesByIds(['1', '2'])).map((f) => f.status)).toEqual(['FINISHED', 'SCHEDULED']);
    expect(url).toBe('https://v3.football.api-sports.io/fixtures?ids=1-2&timezone=UTC');
    expect(key).toBe('llave-de-prueba');
    const bad = (async () => new Response(JSON.stringify({ errors: { token: 'Error/Missing application key.' }, response: [] }))) as unknown as typeof fetch;
    await expect(new ApiFootball('x', bad).fixturesByDate('2030-01-02')).rejects.toThrow(/API-Football/);
  });
});
