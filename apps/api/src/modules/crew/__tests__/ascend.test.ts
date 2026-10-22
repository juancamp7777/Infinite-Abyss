import { describe, expect, it } from 'vitest';
import { BADGES, firstResponseXp, leagueFor, levelFor, weekStart } from '../domain/ascend';

describe('Ascend del equipo: reglas', () => {
  it('XP por velocidad de primera respuesta', () => {
    expect([30, 120, 121, 300, 900, 3600].map(firstResponseXp)).toEqual([5, 5, 3, 3, 2, 1]);
  });

  it('niveles con curva cuadrática', () => {
    expect(levelFor(0)).toEqual({ level: 1, currentLevelXp: 0, nextLevelXp: 25 });
    expect(levelFor(24).level).toBe(1);
    expect(levelFor(25)).toEqual({ level: 2, currentLevelXp: 25, nextLevelXp: 100 });
    expect(levelFor(400).level).toBe(5);
  });

  it('ligas por XP semanal', () => {
    expect([0, 59, 60, 150, 300, 500].map((x) => leagueFor(x).key)).toEqual(['bronce', 'bronce', 'plata', 'oro', 'diamante', 'abismo']);
  });

  it('insignias por hitos', () => {
    const c = { first_response: 100, fast_response: 49, deposit_approved: 50, checklist: 0, task_done: 0, on_time: 20, cash_perfect: 9 };
    expect(BADGES.filter((b) => b.earned(c)).map((b) => b.key)).toEqual(['primeras_100', 'perla', 'puntual']);
  });

  it('la semana empieza el lunes (UTC)', () => {
    expect(weekStart(new Date('2026-10-25T15:00:00Z')).toISOString()).toBe('2026-10-19T00:00:00.000Z'); // domingo → lunes anterior
    expect(weekStart(new Date('2026-10-26T00:30:00Z')).toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });
});
