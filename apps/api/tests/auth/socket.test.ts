import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/database/prisma';
import { createSocketAuthMiddleware } from '../../src/infrastructure/sockets/socketAuth';
import { createTestOperator, createTestPlayer } from '../setup/factories';
import { buildJwt } from './helpers';

const jwt = buildJwt();
let http: HttpServer;
let io: Server;
let url: string;
const clients: ClientSocket[] = [];

beforeAll(async () => {
  http = createServer();
  io = new Server(http, { connectionStateRecovery: { skipMiddlewares: false } });
  io.use(createSocketAuthMiddleware({ jwt, prisma }));
  io.on('connection', (s) => s.emit('whoami', s.data.auth));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  clients.forEach((c) => c.close());
  await io.close();
});

const open = (auth?: Record<string, unknown>) => {
  const c = connect(url, { auth, transports: ['websocket'], reconnection: false });
  clients.push(c);
  return c;
};

const outcome = (c: ClientSocket) =>
  new Promise<{ ok: true; who: any } | { ok: false; message: string }>((resolve) => {
    c.on('whoami', (who) => resolve({ ok: true, who }));
    c.on('connect_error', (e) => resolve({ ok: false, message: e.message }));
  });

describe('autenticación del socket', () => {
  it('sin token → UNAUTHORIZED', async () => {
    expect(await outcome(open())).toEqual({ ok: false, message: 'UNAUTHORIZED' });
  });

  it('token inválido o userId enviado por el cliente → UNAUTHORIZED', async () => {
    expect(await outcome(open({ token: 'abc.def.ghi' }))).toEqual({ ok: false, message: 'UNAUTHORIZED' });
    expect(await outcome(open({ userId: 'test-user-id' }))).toEqual({ ok: false, message: 'UNAUTHORIZED' });
  });

  it('token válido → socket.data.auth sale del token', async () => {
    const op = await createTestOperator();
    const u = await createTestPlayer(op.id);
    const token = jwt.signAccess({ sub: u.id, op: op.id, typ: 'player' });
    // Aunque el cliente mande otro userId, manda el token.
    const r = await outcome(open({ token, userId: 'otro' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.who).toMatchObject({ kind: 'player', userId: u.id, operatorId: op.id, currency: 'USD' });
  });

  it('usuario suspendido o token de backoffice → UNAUTHORIZED', async () => {
    const op = await createTestOperator();
    const u = await createTestPlayer(op.id, { status: 'SUSPENDED' });
    const t1 = jwt.signAccess({ sub: u.id, op: op.id, typ: 'player' });
    expect(await outcome(open({ token: t1 }))).toEqual({ ok: false, message: 'UNAUTHORIZED' });
    const t2 = jwt.signAccess({ sub: u.id, op: op.id, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
    expect(await outcome(open({ token: t2 }))).toEqual({ ok: false, message: 'UNAUTHORIZED' });
  });
});
