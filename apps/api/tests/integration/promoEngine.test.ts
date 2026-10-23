import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/database/prisma';
import { BotConfigService } from '../../src/modules/pearl/application/BotConfigService';
import { PromoEngine, type BonusGrant } from '../../src/modules/pearl/application/PromoEngine';
import { defaultBotConfig } from '../../src/modules/pearl/domain/botConfig';
import { silentLogger } from '../../src/modules/shared/module';
import { createTestOperator, createTestPlayer } from '../setup/factories';

const ALL_DAY = [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' }];

describe('Cajero IA: bonos y promos con Postgres', () => {
  it('Flash por palabra gana al happy hour y a la casa; regalo con tope; observación no paga; sin cuenta pide crearla', async () => {
    const opId = (await createTestOperator()).id;
    const player = await createTestPlayer(opId, { currency: 'USD' });
    const bot = new BotConfigService(prisma, { cacheMs: 0 });
    const c = defaultBotConfig();
    c.bonuses.housePct = 10;
    c.bonuses.happyHourPct = 25;
    c.bonuses.happyHours = ALL_DAY;
    c.bonuses.promos = [
      { id: 'flash1', type: 'flash', name: 'Flash ABYSS', active: true, observeOnly: false, keyword: 'abyss', bonusPct: 40, minDeposit: null, windows: [], maxClaimsPerPlayer: 3, maxClaimsTotal: null, message: '' },
      { id: 'gift1', type: 'gift', name: 'Regalo', active: true, observeOnly: false, keyword: 'regalo', chips: '100000', windows: [], maxClaimsPerPlayer: 1, maxClaimsTotal: 10, message: '' },
      { id: 'obs1', type: 'flash', name: 'Prueba', active: true, observeOnly: true, keyword: 'mirar', bonusPct: 50, minDeposit: null, windows: [], maxClaimsPerPlayer: 1, maxClaimsTotal: null, message: '' },
    ];
    await bot.saveDraft(opId, c, 'admin');
    await bot.publish(opId, 'admin');

    const grants: Parameters<BonusGrant>[0][] = [];
    const engine = new PromoEngine(prisma, bot, { logger: silentLogger, grant: async (g) => { grants.push(g); return { duplicate: grants.filter((x) => x.reason === g.reason).length > 1 }; } });

    const on = await engine.onMessage(opId, player.id, '¡Quiero el bono ABYSS ya!');
    expect(on).toMatchObject({ handled: true });
    expect(on.reply).toContain('40 %');
    await engine.onMessage(opId, player.id, 'abyss'); // repetir no apila

    const load = (amount: bigint) => ({ id: randomUUID(), operatorId: opId, playerId: player.id, amount, currency: 'USD', createdAt: new Date() });
    const first = await engine.onCredited(load(100_000n));
    expect(first).toMatchObject({ pct: 40, amount: 40_000n, source: 'flash' });
    expect(await prisma.pearlPromoClaim.count({ where: { operatorId: opId, promoId: 'flash1', consumedAt: { not: null } } })).toBe(1);
    expect(await engine.onCredited(load(100_000n))).toMatchObject({ pct: 25, source: 'happy_hour' });

    const gift = await engine.onMessage(opId, player.id, 'me das el regalo?');
    expect(gift.handled).toBe(true);
    expect(grants.find((g) => g.reason.startsWith('cajero:gift:'))).toMatchObject({ amount: 100_000n, currency: 'USD' });
    expect((await engine.onMessage(opId, player.id, 'regalo')).reply).toContain('Ya usaste');

    const paidBefore = grants.length;
    expect(await engine.onMessage(opId, player.id, 'quiero mirar')).toEqual({ handled: false });
    expect(await prisma.pearlPromoClaim.count({ where: { operatorId: opId, promoId: 'obs1', observed: true } })).toBe(1);
    expect(grants.length).toBe(paidBefore);

    expect((await engine.onMessage(opId, undefined, 'abyss')).reply).toContain('crear tu cuenta');
    expect(await engine.onMessage(opId, player.id, 'hola, buenas')).toEqual({ handled: false });
  });
});
