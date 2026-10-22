import { describe, expect, it } from 'vitest';
import { localDay } from '../application/CrewService';
import { autoCloseAt, cashExpected, computePayroll, lateMinutes, monthRange, netMinutes } from '../domain/rules';

const t = (iso: string) => new Date(iso);

describe('reglas de Crew', () => {
  it('minutos netos descuentan pausas (incluida una abierta) y nunca son negativos', () => {
    const start = t('2026-10-24T12:00:00Z');
    expect(netMinutes(start, t('2026-10-24T20:00:00Z'), [])).toBe(480);
    expect(netMinutes(start, t('2026-10-24T20:00:00Z'), [{ from: t('2026-10-24T15:00:00Z'), to: t('2026-10-24T15:30:00Z') }])).toBe(450);
    expect(netMinutes(start, t('2026-10-24T13:00:00Z'), [{ from: t('2026-10-24T12:30:00Z') }])).toBe(30);
    expect(netMinutes(start, t('2026-10-24T11:00:00Z'), [])).toBe(0);
  });

  it('tardanza con tolerancia de 5 minutos y sin turno planificado = 0', () => {
    const planned = t('2026-10-24T12:00:00Z');
    expect(lateMinutes(planned, t('2026-10-24T12:04:00Z'))).toBe(0);
    expect(lateMinutes(planned, t('2026-10-24T12:17:00Z'))).toBe(17);
    expect(lateMinutes(planned, t('2026-10-24T11:50:00Z'))).toBe(0);
    expect(lateMinutes(null, t('2026-10-24T12:30:00Z'))).toBe(0);
  });

  it('cierre de seguridad a las 14 h netas o 20 h de reloj', () => {
    const start = t('2026-10-24T00:00:00Z');
    expect(autoCloseAt(start, [], t('2026-10-24T10:00:00Z'))).toBeNull();
    expect(autoCloseAt(start, [], t('2026-10-24T14:00:00Z'))).toEqual(t('2026-10-24T14:00:00Z'));
    const longPause = [{ from: t('2026-10-24T01:00:00Z'), to: t('2026-10-24T08:00:00Z') }];
    expect(autoCloseAt(start, longPause, t('2026-10-24T15:00:00Z'))).toBeNull();
    expect(autoCloseAt(start, longPause, t('2026-10-24T21:00:00Z'))).toEqual(t('2026-10-24T20:00:00Z'));
  });

  it('nómina mensual: sueldo + extra a 1,5 + ajustes; por hora: horas × valor', () => {
    const monthly = computePayroll({
      payType: 'monthly', baseAmount: 2_400_000n,
      sessions: [{ kind: 'normal', netMinutes: 480 }, { kind: 'extra', netMinutes: 120 }, { kind: 'dayoff', netMinutes: 60 }],
      adjustments: [{ type: 'bonus', amount: 5_000n }, { type: 'discount', amount: 1_000n }],
    });
    // valor hora = 2.400.000 / 240 = 10.000; extra 3 h × 10.000 × 1,5 = 45.000
    expect(monthly).toMatchObject({ hourlyRate: 10_000n, base: 2_400_000n, overtime: 45_000n, total: 2_449_000n, normalMinutes: 480, extraMinutes: 180 });
    const hourly = computePayroll({ payType: 'hourly', baseAmount: 3_000n, sessions: [{ kind: 'normal', netMinutes: 90 }, { kind: 'extra', netMinutes: 60 }], adjustments: [] });
    expect(hourly).toMatchObject({ base: 4_500n, overtime: 4_500n, total: 9_000n });
  });

  it('caja esperada y rango del mes', () => {
    expect(cashExpected(10_000n, [{ type: 'in', amount: 5_000n }, { type: 'out', amount: 2_500n }])).toBe(12_500n);
    expect(monthRange('2026-12')).toEqual({ from: t('2026-12-01T00:00:00Z'), to: t('2027-01-01T00:00:00Z') });
  });

  it('día local según la zona horaria (Argentina vs Colombia)', () => {
    const d = t('2026-10-25T02:30:00Z'); // sábado 23:30 en Buenos Aires, sábado 21:30 en Bogotá
    expect(localDay(d, 'America/Argentina/Buenos_Aires')).toEqual({ day: '2026-10-24', weekday: 6 });
    expect(localDay(d, 'America/Bogota')).toEqual({ day: '2026-10-24', weekday: 6 });
    expect(localDay(t('2026-10-25T04:30:00Z'), 'America/Argentina/Buenos_Aires')).toEqual({ day: '2026-10-25', weekday: 0 });
  });
});
