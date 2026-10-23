import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import type { BotConfigService } from '../../src/modules/pearl/application/BotConfigService';
import { createBackofficeUser, createTestOperator } from '../setup/factories';
import { bearer, buildIntegrationApp, jwt } from './helpers';

let created: CreatedApp;
let opId: string;
let admin: string;
let agent: string;
let otherAdmin: string;

beforeAll(async () => {
  created = await buildIntegrationApp();
  opId = (await createTestOperator()).id;
  const other = (await createTestOperator()).id;
  const a = await createBackofficeUser('OPERATOR_ADMIN', opId);
  admin = jwt.signAccess({ sub: a.id, op: opId, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
  const s = await createBackofficeUser('OPERATOR_SUPPORT', opId);
  agent = jwt.signAccess({ sub: s.id, op: opId, typ: 'backoffice', role: 'OPERATOR_SUPPORT' });
  const o = await createBackofficeUser('OPERATOR_ADMIN', other);
  otherAdmin = jwt.signAccess({ sub: o.id, op: other, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
});

afterAll(async () => {
  await created.close?.();
});

describe('Cajero IA con Postgres', () => {
  it('plantilla → publicar → editar → publicar → volver atrás; validación, roles, aislamiento y política de caja', async () => {
    const api = () => request(created.app);
    const first = await api().get('/pearl/v1/admin/bot').set(bearer(admin));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ publishedVersion: null, versions: [] });
    expect((await api().get('/pearl/v1/admin/bot').set(bearer(agent))).status).toBe(403);

    const preset = await api().post('/pearl/v1/admin/bot/preset').set(bearer(admin)).send({ country: 'CO' });
    expect(preset.body.draft.hours.timezone).toBe('America/Bogota');
    expect(preset.body.dirty).toBe(true);

    const v1 = await api().post('/pearl/v1/admin/bot/publish').set(bearer(admin)).send({ note: 'Arranque Colombia' });
    expect(v1.status).toBe(200);
    expect(v1.body).toMatchObject({ publishedVersion: 1, dirty: false, versions: [{ version: 1, note: 'Arranque Colombia' }] });
    expect((await api().post('/pearl/v1/admin/bot/publish').set(bearer(admin)).send({})).status).toBe(409);

    const draft = { ...v1.body.draft, hours: { ...v1.body.draft.hours, noCharge: 'always' }, amounts: { ...v1.body.draft.amounts, autoCreditMax: '500000000' } };
    const saved = await api().put('/pearl/v1/admin/bot/draft').set(bearer(admin)).send(draft);
    expect(saved.body).toMatchObject({ dirty: true, publishedVersion: 1 });

    await created.ready;
    const bot = created.services.modules['pearl.bot'] as BotConfigService;
    expect(await bot.creditPolicy(opId)).toMatchObject({ noChargeNow: false, autoCredit: true }); // el borrador no tiene efecto
    await api().post('/pearl/v1/admin/bot/publish').set(bearer(admin)).send({}).expect(200);
    await new Promise((r) => setTimeout(r, 5));
    expect(await bot.creditPolicy(opId)).toMatchObject({ noChargeNow: true, autoCredit: false, autoCreditMax: 500000000n });

    const back = await api().post('/pearl/v1/admin/bot/rollback').set(bearer(admin)).send({ version: 1 });
    expect(back.body).toMatchObject({ publishedVersion: 3, versions: [{ version: 3, note: 'Vuelta a la versión 1' }, { version: 2 }, { version: 1 }] });
    expect(back.body.published.hours.noCharge).toBe('off');
    expect(await bot.creditPolicy(opId)).toMatchObject({ noChargeNow: false });

    const bad = { ...back.body.draft, hours: { ...back.body.draft.hours, noCharge: 'schedule', windows: [] } };
    await api().put('/pearl/v1/admin/bot/draft').set(bearer(admin)).send(bad).expect(200);
    const refused = await api().post('/pearl/v1/admin/bot/publish').set(bearer(admin)).send({});
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toContain('Modo sin cargas por horario');
    expect((await api().put('/pearl/v1/admin/bot/draft').set(bearer(admin)).send({ amounts: { minDeposit: 'mil' } })).status).toBe(400);

    const discarded = await api().post('/pearl/v1/admin/bot/discard').set(bearer(admin)).send({});
    expect(discarded.body.dirty).toBe(false);

    expect((await api().get('/pearl/v1/admin/bot').set(bearer(otherAdmin))).body.publishedVersion).toBeNull();
  });
});
