import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { Phase1PlayerCompliance } from '../../src/infrastructure/modules/compliance/Phase1Compliance';
import { createTestOperator } from '../setup/factories';
import { buildIntegrationApp } from './helpers';

let created: CreatedApp;
let host: string;
let opId: string;

beforeAll(async () => {
  created = await buildIntegrationApp();
  const op = await createTestOperator();
  opId = op.id;
  host = op.host;
});

afterAll(async () => {
  await created.close?.();
});

describe('Declaración de mayoría de edad en el registro', () => {
  it('quien declara 18+ al registrarse puede recibir publicidad sin KYC; quien no declara, no', async () => {
    const compliance = new Phase1PlayerCompliance(prisma);
    const reg = (email: string, adult?: boolean) => request(created.app).post('/api/auth/register').set('Host', host).send({ email, password: 'Clave-Segura-123', ...(adult === undefined ? {} : { adult }) });

    const yes = await reg('mayor@test.local', true);
    expect(yes.status).toBe(201);
    const adultUser = await prisma.user.findFirstOrThrow({ where: { operatorId: opId, emailNormalized: 'mayor@test.local' } });
    expect(adultUser.ageDeclaredAt).toBeInstanceOf(Date);
    expect(adultUser.kycStatus).toBe('NONE');
    expect(await compliance.getStatus(opId, adultUser.id)).toMatchObject({ ageVerified: true, selfExcluded: false });

    await reg('sindeclarar@test.local').expect(201);
    const plain = await prisma.user.findFirstOrThrow({ where: { operatorId: opId, emailNormalized: 'sindeclarar@test.local' } });
    expect(plain.ageDeclaredAt).toBeNull();
    expect((await compliance.getStatus(opId, plain.id)).ageVerified).toBe(false);

    await prisma.user.update({ where: { id: plain.id }, data: { kycStatus: 'VERIFIED' } });
    expect((await compliance.getStatus(opId, plain.id)).ageVerified).toBe(true);
  });
});
