import { describe, expect, it } from 'vitest';
import { botConfigSchema, checkBotConfig, defaultBotConfig, inWindows, presetFor } from '../domain/botConfig';

describe('Cajero IA: configuración', () => {
  it('las plantillas por país son válidas y publicables', () => {
    for (const c of ['CO', 'MX', 'AR'] as const) {
      const p = presetFor(c);
      expect(botConfigSchema.parse(p)).toEqual(p);
      expect(checkBotConfig(p).errors).toEqual([]);
    }
    expect(presetFor('CO').hours.timezone).toBe('America/Bogota');
    expect(presetFor('AR').amounts.minDeposit).toBe('200000');
  });

  it('frena configuraciones peligrosas o contradictorias antes de publicar', () => {
    const c = defaultBotConfig();
    c.amounts.minDeposit = '1000000';
    c.amounts.vipFrom = '500000';
    c.amounts.autoCreditMax = '100';
    c.hours.noCharge = 'schedule';
    c.bonuses.happyHourPct = 20;
    c.bonuses.promos = [
      { id: 'a', type: 'flash', name: 'Flash 1', active: true, observeOnly: false, keyword: 'ABYSS', bonusPct: 30, minDeposit: null, windows: [], maxClaimsPerPlayer: 1, maxClaimsTotal: null, message: '' },
      { id: 'b', type: 'gift', name: 'Regalo', active: true, observeOnly: false, keyword: 'abyss', chips: '100000', windows: [], maxClaimsPerPlayer: 1, maxClaimsTotal: 50, message: '' },
    ];
    const { errors } = checkBotConfig(c);
    expect(errors).toEqual(expect.arrayContaining([
      'Modo sin cargas por horario: agrega al menos una franja',
      'El monto VIP debe ser mayor que la carga mínima',
      'El tope de acreditación automática es menor que la carga mínima',
      'Happy hour: agrega al menos una franja',
      'La palabra "abyss" la usan dos promos activas (Flash 1 y Regalo)',
    ]));
    expect(botConfigSchema.safeParse({ ...c, amounts: { ...c.amounts, minDeposit: '-5' } }).success).toBe(false);
    expect(botConfigSchema.safeParse({ ...c, bonuses: { ...c.bonuses, housePct: 500 } }).success).toBe(false);
  });

  it('franjas por día de la semana, incluso cruzando la medianoche, en la zona de la agencia', () => {
    const tz = 'America/Bogota'; // UTC-5, sin horario de verano
    const fridayNight = [{ days: [5], start: '22:00', end: '02:00' }];
    expect(inWindows(fridayNight, new Date('2026-10-24T03:30:00Z'), tz)).toBe(true); // viernes 22:30
    expect(inWindows(fridayNight, new Date('2026-10-24T06:30:00Z'), tz)).toBe(true); // sábado 01:30
    expect(inWindows(fridayNight, new Date('2026-10-24T08:00:00Z'), tz)).toBe(false); // sábado 03:00
    expect(inWindows(fridayNight, new Date('2026-10-23T03:30:00Z'), tz)).toBe(false); // jueves 22:30
    expect(inWindows([{ days: [0, 6], start: '10:00', end: '12:00' }], new Date('2026-10-25T15:30:00Z'), tz)).toBe(true); // domingo 10:30
  });
});
