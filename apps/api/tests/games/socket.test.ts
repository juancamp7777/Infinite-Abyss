import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { io as connect, Socket as ClientSocket } from 'socket.io-client';
import { SocketServer } from '../../src/infrastructure/sockets/SocketServer';
import { PlaySlotsUseCase } from '../../src/application/use-cases/PlaySlotsUseCase';
import { FakeWalletService, makeAuth, SequenceRng } from './fakes';

let http: HttpServer;
let sockets: SocketServer;
let url: string;
let wallet: FakeWalletService;

const noop: any = { execute: async () => ({}) };

beforeAll(async () => {
  wallet = new FakeWalletService({ 'user-1': 100_000n });
  http = createServer();
  sockets = new SocketServer({
    server: http,
    // Middleware falso: sin token → rechazo; con token → fija socket.data.auth
    authMiddleware: (socket, next) => {
      if (socket.handshake.auth?.token !== 'ok') return next(new Error('unauthorized'));
      socket.data.auth = makeAuth();
      next();
    },
    corsOrigins: ['http://localhost:3000'],
    processBetUseCase: noop,
    playSlotsUseCase: new PlaySlotsUseCase(wallet, new SequenceRng([0, 3, 7])),
    startBlackjackHandUseCase: noop,
    hitBlackjackUseCase: noop,
    standBlackjackUseCase: noop,
    startMinesUseCase: noop,
    revealMinesUseCase: noop,
    cashoutMinesUseCase: noop,
    placeCrashBetUseCase: noop,
    cashoutCrashUseCase: noop,
    playPlinkoUseCase: noop,
  });
  await new Promise<void>((resolve) => http.listen(0, resolve));
  url = `http://localhost:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  sockets.getIO().close();
  await new Promise((r) => http.close(r));
});

function client(token?: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const s = connect(url, { auth: token ? { token } : {}, reconnection: false, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (err) => { s.close(); reject(err); });
  });
}

const emit = (s: ClientSocket, event: string, payload: any): Promise<any> =>
  new Promise((resolve) => s.emit(event, payload, resolve));

describe('SocketServer', () => {
  it('sin auth → connect_error', async () => {
    await expect(client()).rejects.toThrow('unauthorized');
  });

  it('juega slots y recibe payout/newBalance como string; ignora userId del cliente', async () => {
    const s = await client('ok');
    const res = await emit(s, 'playSlots', { amount: '1000', userId: 'otro-usuario' });
    expect(res.success).toBe(true);
    expect(typeof res.data.newBalance).toBe('string');
    expect(typeof res.data.payout).toBe('string');
    expect(BigInt(res.data.newBalance)).toBe(wallet.balances.get('user-1'));
    expect(wallet.callsOf('betAndSettle').at(-1).userId).toBe('user-1');
    s.close();
  });

  it.each([
    ['negativo', '-5'],
    ['decimal', '10.5'],
    ['enorme', '9'.repeat(30)],
    ['cero', '0'],
    ['número JSON', 1000],
    ['texto', 'abc'],
  ])('amount inválido (%s) → 400', async (_n, amount) => {
    const s = await client('ok');
    const res = await emit(s, 'playSlots', { amount });
    expect(res.success).toBe(false);
    expect(res.error.code).toBe(400);
    expect(res.error.errorCode).toBe('VALIDATION_ERROR');
    s.close();
  });

  it('errores de dominio incluyen errorCode', async () => {
    const s = await client('ok');
    const res = await emit(s, 'playSlots', { amount: '1000000000' });
    expect(res.success).toBe(false);
    expect(res.error.errorCode).toBe('INSUFFICIENT_FUNDS');
    s.close();
  });
});
