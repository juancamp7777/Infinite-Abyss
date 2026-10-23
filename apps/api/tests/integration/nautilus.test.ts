import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/database/prisma';
import { NautilusService } from '../../src/modules/nautilus/application/NautilusService';
import type { NautilusBrain, ReadOnlyTool } from '../../src/modules/nautilus/infrastructure/brain';
import type { IntegrationsPort } from '../../src/modules/shared/ports/IntegrationsPort';
import { createTestOperator, createTestPlayer } from '../setup/factories';

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const NOW = new Date('2026-10-28T15:00:00Z'); // 10:00 en Bogotá
let opId: string;
let otherOpId: string;
let playerId: string;
const telegram: string[] = [];
const fakeFetch = async (url: string, init?: RequestInit) => {
  if (url.includes('api.telegram.org')) telegram.push(JSON.parse(String(init?.body)).text);
  return new Response('{"ok":true}', { status: 200 });
};
const port = (keys: Record<string, string>): IntegrationsPort => ({
  value: async (_op, key, field) => keys[`${key}.${field}`],
  envOverlay: async () => ({}),
});

beforeAll(async () => {
  const op = await createTestOperator({ defaultCurrency: 'COP', currencies: ['COP'] });
  opId = op.id;
  otherOpId = (await createTestOperator()).id;
  const p = await createTestPlayer(opId, { username: 'cliente_vip' });
  playerId = p.id;
  await createTestPlayer(otherOpId, { username: 'cliente_ajeno' });
  const old = (min: number) => new Date(NOW.getTime() - min * 60_000);
  await prisma.inboxConversation.create({ data: { id: randomUUID(), operatorId: opId, channel: 'webchat', externalId: randomUUID(), contactName: 'Ana', status: 'open', unread: 2, lastMessageAt: old(50), updatedAt: NOW } });
  await prisma.pearlReceipt.create({ data: { id: randomUUID(), operatorId: opId, extracted: {}, currency: 'COP', status: 'pending_review', checks: {}, source: 'webchat', createdAt: old(30), updatedAt: NOW } });
  await prisma.withdrawal.create({ data: { operatorId: opId, userId: playerId, provider: 'PEARL', amount: 150_000_00n, currency: 'COP', destination: {}, reserveLedgerTxId: randomUUID(), createdAt: old(60 * 5) } });
  for (let i = 0; i < 6; i++) {
    await prisma.deposit.create({ data: { operatorId: opId, userId: playerId, provider: 'PEARL', amount: 10_000_00n, currency: 'COP', providerReference: `nautilus-${randomUUID()}`, status: 'FAILED', createdAt: old(10) } });
  }
  await prisma.boDayKpi.create({ data: { operatorId: opId, day: '2026-10-27', registrations: 12, activePlayers: 40, depositors: 9, ftdCount: 3, depositsAmount: 2_500_000_00n, withdrawalsAmount: 700_000_00n, settledStake: 5_000_000_00n, settledWins: 4_600_000_00n, betCount: 900 } });
});

afterAll(async () => {
  await prisma.nautilusFinding.deleteMany({ where: { operatorId: { in: [opId, otherOpId] } } });
  await prisma.nautilusReport.deleteMany({ where: { operatorId: { in: [opId, otherOpId] } } });
});

describe('Nautilus con Postgres', () => {
  it('escanea, guarda sin duplicar, avisa lo grave una sola vez y cierra lo que se resolvió solo', async () => {
    telegram.length = 0;
    const svc = new NautilusService(prisma, { logger: silent, now: () => NOW, fetch: fakeFetch, integrations: () => port({ 'telegram-alerts.botToken': '1:x', 'telegram-alerts.chatId': '-1' }), brainFactory: () => { throw new Error('sin IA'); } });
    const first = await svc.scan(opId);
    expect(first).toMatchObject({ created: 4, resolved: 0 });
    const keys = (await svc.findings(opId)).map((f) => f.key).sort();
    expect(keys).toEqual(['cashier:pending_review', `fraud:failed_deposits:${playerId}`, 'payments:withdrawals_pending', 'support:unanswered']);
    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toContain('Posible prueba de tarjetas: cliente_vip');
    expect(telegram[0]).toContain('jugador espera respuesta');

    expect(await svc.scan(opId)).toMatchObject({ created: 0 });
    expect(telegram).toHaveLength(1); // ya avisado: no se repite

    await prisma.inboxConversation.updateMany({ where: { operatorId: opId }, data: { unread: 0 } });
    expect(await svc.scan(opId)).toMatchObject({ resolved: 1 });
    expect((await svc.findings(opId)).map((f) => f.key)).not.toContain('support:unanswered');
    expect(await svc.findings(otherOpId)).toEqual([]);
  });

  it('sin llave de Claude no inventa nada: pide conectarla en Integraciones', async () => {
    const svc = new NautilusService(prisma, { logger: silent, now: () => NOW, integrations: () => port({}), brainFactory: () => { throw new Error('no debería llamarse'); } });
    await expect(svc.ask(opId, '¿cómo vamos?')).rejects.toMatchObject({ code: 'AI_NOT_CONNECTED' });
  });

  it('resumen diario con Claude: cifras reales de ayer, guardado una vez por día y enviado por Telegram', async () => {
    telegram.length = 0;
    let received: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const brain: NautilusBrain = {
      briefing: async (data) => { received = data; return { headline: 'Buen día: GGR positivo', summary: 'Resumen', risks: [{ title: 'Retiro lento', detail: '5 h', severity: 'warn' }], recommendations: [{ action: 'Aprobar el retiro', why: 'evita reclamos' }] }; },
      ask: async () => '',
    };
    let keyUsed = '';
    const svc = new NautilusService(prisma, { logger: silent, now: () => NOW, fetch: fakeFetch, integrations: () => port({ 'anthropic.apiKey': 'sk-ant-casino', 'telegram-alerts.botToken': '1:x', 'telegram-alerts.chatId': '-1' }), brainFactory: (k) => { keyUsed = k; return brain; } });
    const rep = await svc.report(opId);
    expect(keyUsed).toBe('sk-ant-casino');
    expect(rep.day).toBe('2026-10-27');
    expect(received.lastDays).toEqual([expect.objectContaining({ day: '2026-10-27', registrations: 12, ggr: expect.stringContaining('400.000') })]);
    expect(telegram[0]).toContain('Buen día: GGR positivo');
    expect(telegram[0]).toContain('Aprobar el retiro');
    // Mismo día: devuelve el guardado sin volver a llamar a Claude.
    const again = await svc.report(opId);
    expect(again.id).toBe(rep.id);
    expect(telegram).toHaveLength(1);
  });

  it('pregúntale a Nautilus: Claude usa herramientas de solo lectura limitadas a su casino', async () => {
    let tools: ReadOnlyTool[] = [];
    const brain: NautilusBrain = {
      briefing: async () => { throw new Error('no'); },
      ask: async (_q, ctx, t) => {
        tools = t;
        const players = (await t.find(x => x.name === 'find_player')!.run({ query: 'cliente' })) as Array<{ username: string }>;
        const pending = (await t.find(x => x.name === 'pending_withdrawals')!.run({ limit: 5 })) as Array<{ amount: string }>;
        return `${ctx} | jugadores: ${players.map((p) => p.username).join(',')} | retiro: ${pending[0]?.amount}`;
      },
    };
    const svc = new NautilusService(prisma, { logger: silent, now: () => NOW, integrations: () => port({ 'anthropic.apiKey': 'k' }), brainFactory: () => brain });
    const answer = await svc.ask(opId, '¿quién pidió retiro?');
    expect(answer).toContain('Moneda: COP');
    expect(answer).toContain('jugadores: cliente_vip |'); // nunca el jugador del otro casino
    expect(answer).toContain('150.000 COP');
    expect(tools.map((t) => t.name).sort()).toEqual(['cashier_queue', 'find_player', 'kpis', 'open_findings', 'pending_withdrawals']);
  });
});
