import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/database/prisma';
import { InMemoryWallet } from '../../src/modules/shared/adapters/InMemoryWallet';
import { silentLogger } from '../../src/modules/shared/module';
import { LeviathanService } from '../../src/modules/leviathan/application/LeviathanService';
import { createTestOperator } from '../setup/factories';

const MIN = 60_000;
let now = new Date('2030-01-01T12:00:00Z');
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const wallet = new InMemoryWallet();
const lev = new LeviathanService(prisma, wallet, { logger: silentLogger, now: () => now, rand });
let op: string;
const cash = async (p: string) => (await wallet.getBalance(op, p, 'COP')).cash;

beforeAll(async () => {
  // Partidos simulados propios de esta prueba (fecha futura para no mezclarse con otros).
  await prisma.levSelection.deleteMany({ where: { eventId: { in: (await prisma.levEvent.findMany({ where: { startsAt: { gte: new Date('2029-12-31') } }, select: { id: true } })).map((e) => e.id) } } });
  await prisma.levEvent.deleteMany({ where: { startsAt: { gte: new Date('2029-12-31') } } });
  op = (await createTestOperator({ currencies: ['COP'], defaultCurrency: 'COP' })).id;
  for (const p of ['p1', 'p2', 'p3', 'p5']) wallet.seed(op, p, 'COP', 5_000_000n);
});

afterAll(async () => {
  lev.stop();
});

describe('Leviathan: concurso rápido de punta a punta', () => {
  it('entradas al pozo, apuestas en fichas, partidos simulados y reparto exacto con comisión', async () => {
    const g = await lev.createGame({ operatorId: op, mode: 'QUICK', title: 'Rápido 10K', entry: 1_000_000n, startsInMin: 10 });
    expect(g).toMatchObject({ status: 'OPEN', currency: 'COP', curve: 'TOP_3_60_25_15', minBets: 3 });

    for (const p of ['p1', 'p2', 'p3']) await lev.join(op, p, g.id);
    await lev.join(op, 'p1', g.id); // repetir no cobra dos veces
    expect(await cash('p1')).toBe(4_000_000n);
    await expect(lev.join(op, 'pobre', g.id)).rejects.toMatchObject({ status: 402 });
    expect((await prisma.levGame.findUniqueOrThrow({ where: { id: g.id } })).pot).toBe(3_000_000n);

    // Antes de empezar no se apuesta.
    const d0 = await lev.detail(op, g.id, 'p1');
    const sel = d0.events[0].selections[0];
    await expect(lev.placeBet(op, 'p1', g.id, { selectionId: sel.id, stake: 100n, oddsE2: sel.oddsE2 })).rejects.toMatchObject({ code: 'NOT_RUNNING' });

    now = new Date(now.getTime() + 11 * MIN);
    await lev.tick();
    expect((await prisma.levGame.findUniqueOrThrow({ where: { id: g.id } })).status).toBe('RUNNING');

    const d = await lev.detail(op, g.id, 'p1');
    const sels = d.events.flatMap((e) => e.selections);
    await expect(lev.placeBet(op, 'p1', g.id, { selectionId: sels[0].id, stake: 100n, oddsE2: sels[0].oddsE2 + 1 })).rejects.toMatchObject({ status: 422 });
    await expect(lev.placeBet(op, 'p1', g.id, { selectionId: sels[0].id, stake: 5_000n, oddsE2: sels[0].oddsE2 })).rejects.toMatchObject({ code: 'CANNOT_BET' });
    for (const p of ['p1', 'p2']) for (const s of sels.slice(0, 3)) await lev.placeBet(op, p, g.id, { selectionId: s.id, stake: 200n, oddsE2: s.oddsE2 });
    await lev.placeBet(op, 'p3', g.id, { selectionId: sels[1].id, stake: 500n, oddsE2: sels[1].oddsE2 });
    expect((await prisma.levEntry.findUniqueOrThrow({ where: { gameId_playerId: { gameId: g.id, playerId: 'p1' } } })).chips).toBe(400n);

    // Termina el concurso y todos sus partidos: se resuelven las apuestas y se reparte.
    now = new Date(g.endsAt.getTime() + MIN);
    await lev.tick();
    const done = await prisma.levGame.findUniqueOrThrow({ where: { id: g.id } });
    expect(done.status).toBe('SETTLED');
    expect(done.rake).toBe(150_000n);
    expect(done.pool! + done.rake! + done.residue!).toBe(3_000_000n);
    const entries = await prisma.levEntry.findMany({ where: { gameId: g.id } });
    expect(await prisma.levBet.count({ where: { gameId: g.id, status: 'OPEN' } })).toBe(0);
    expect(entries.find((e) => e.playerId === 'p3')).toMatchObject({ qualified: false, prize: 0n });
    expect(entries.reduce((a, e) => a + (e.prize ?? 0n), 0n)).toBe(2_850_000n);
    // Lo que cobró cada uno quedó en su billetera; la casa solo retuvo la comisión.
    const total = (await cash('p1')) + (await cash('p2')) + (await cash('p3'));
    expect(total).toBe(15_000_000n - 150_000n);

    // Repetir el barrido no paga dos veces.
    await lev.tick();
    expect((await cash('p1')) + (await cash('p2')) + (await cash('p3'))).toBe(total);
  });

  it('sin el mínimo de jugadores se cancela y se devuelve la entrada completa', async () => {
    const g = await lev.createGame({ operatorId: op, mode: 'QUICK', title: 'Solitario', entry: 2_000_000n, startsInMin: 5 });
    await lev.join(op, 'p5', g.id);
    expect(await cash('p5')).toBe(3_000_000n);
    now = new Date(now.getTime() + 6 * MIN);
    await lev.tick();
    expect((await prisma.levGame.findUniqueOrThrow({ where: { id: g.id } })).status).toBe('CANCELLED');
    expect(await cash('p5')).toBe(5_000_000n);
  });

  it('con API-Football: partidos reales con cuotas, resultado a los 90 y aplazados anulados', async () => {
    const T = new Date(now.getTime() + 60 * MIN);
    const fx = (id: number, short: string, startsAt: Date, h: number | null = null, a: number | null = null) => ({
      externalId: String(id), leagueId: 239, league: 'Primera A', home: `Local ${id}`, away: `Visita ${id}`, startsAt, status: short as 'SCHEDULED' | 'LIVE' | 'FINISHED' | 'CANCELLED', homeScore: h, awayScore: a,
    });
    let state = [fx(900001, 'SCHEDULED', T), fx(900002, 'SCHEDULED', T), fx(900003, 'SCHEDULED', T)];
    const api = {
      fixturesByDate: async () => state,
      fixturesByIds: async (ids: string[]) => state.filter((f) => ids.includes(f.externalId)),
      odds: async (id: string) => (id === '900003' ? [] : [
        { market: 'MATCH_RESULT' as const, key: '1', label: 'Local', oddsE2: 210 }, { market: 'MATCH_RESULT' as const, key: 'X', label: 'Empate', oddsE2: 330 }, { market: 'MATCH_RESULT' as const, key: '2', label: 'Visita', oddsE2: 360 },
      ]),
    };
    const real = new LeviathanService(prisma, wallet, { logger: silentLogger, now: () => now, rand, realFeed: async () => ({ api: api as never, leagues: [239] }) });
    await real.tick();
    const evs = await prisma.levEvent.findMany({ where: { source: 'api-football', externalId: { in: ['900001', '900002', '900003'] } } });
    expect(evs.map((e) => e.externalId).sort()).toEqual(['900001', '900002']); // sin cuotas no entra

    // Concurso sobre esos partidos (desde 30 min antes del pitazo, 3 h).
    const g = await real.createGame({ operatorId: op, mode: 'QUICK', title: 'Fútbol real', entry: 1_000_000n, startsInMin: 30, durationMin: 180 });
    for (const p of ['p1', 'p2']) await real.join(op, p, g.id);
    now = new Date(now.getTime() + 31 * MIN);
    await real.tick();
    const d = await real.detail(op, g.id, 'p1');
    expect(d.events.every((e) => e.source === 'api-football')).toBe(true);
    const [e1, e2] = d.events;
    await real.placeBet(op, 'p1', g.id, { selectionId: e1.selections.find((s) => s.key === '1')!.id, stake: 100n, oddsE2: 210 });
    await real.placeBet(op, 'p2', g.id, { selectionId: e2.selections.find((s) => s.key === '2')!.id, stake: 100n, oddsE2: 360 });

    // Termina 900001 (2-1, gana el local) y se aplaza 900002: la apuesta de p2 se anula y devuelve sus fichas.
    state = [fx(900001, 'FINISHED', T, 2, 1), fx(900002, 'CANCELLED', T)];
    now = new Date(T.getTime() + 120 * MIN);
    await real.tick();
    const p1 = await prisma.levEntry.findUniqueOrThrow({ where: { gameId_playerId: { gameId: g.id, playerId: 'p1' } } });
    const p2 = await prisma.levEntry.findUniqueOrThrow({ where: { gameId_playerId: { gameId: g.id, playerId: 'p2' } } });
    expect(p1.chips).toBe(1110n); // 900 + 210
    expect(p2.chips).toBe(1000n); // anulada: vuelven las 100
    real.stop();
  });

  it('sala de amigos con código', async () => {
    const g = await lev.createGame({ operatorId: op, mode: 'FRIENDS', title: 'Los del barrio', entry: 0n, maxPlayers: 5 });
    expect(g.roomCode).toMatch(/^[A-Z2-9]{5}$/);
    expect(g.curve).toBe('NONE');
    const r = await lev.joinByCode(op, 'p2', g.roomCode!.toLowerCase());
    expect(r.game.id).toBe(g.id);
    expect((await lev.lobby(op)).some((x) => x.id === g.id)).toBe(false); // privada: no sale en el lobby
  });
});
