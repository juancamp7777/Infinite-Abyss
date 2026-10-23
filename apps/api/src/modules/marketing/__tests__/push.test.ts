import webpush from 'web-push';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../shared/module';
import type { ChannelMessage, PushSubscription } from '../domain/types';
import { ChannelError, PushChannel, resolveVapid, type PushSender } from '../infrastructure/channels';
import { createInMemoryRepos } from '../infrastructure/stores';

const vapid = { ...webpush.generateVAPIDKeys(), subject: 'mailto:test@example.com' };
const msg = (over: Partial<ChannelMessage> = {}): ChannelMessage => ({ sendId: 's1', operatorId: 'op', playerId: 'p1', channel: 'push', subject: '¡Carga acreditada!', text: 'Tienes ARS 5.000 listos para jugar', meta: { url: '/lobby' }, ...over } as ChannelMessage);

async function withSubs(n: number) {
  const repos = createInMemoryRepos();
  for (let i = 0; i < n; i++) {
    await repos.pushSubs.put({ id: `sub-${i}`, operatorId: 'op', playerId: 'p1', endpoint: `https://push.example/${i}`, keys: { p256dh: 'k', auth: 'a' }, createdAt: new Date().toISOString() } as PushSubscription);
  }
  return repos;
}

describe('push web real (VAPID)', () => {
  it('envía a todos los dispositivos del jugador con el payload esperado y borra los caducados', async () => {
    const repos = await withSubs(3);
    const calls: Array<{ endpoint: string; payload: any }> = [];
    const sender: PushSender = async (sub, payload, keys) => {
      expect(keys.publicKey).toBe(vapid.publicKey);
      calls.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
      return { statusCode: sub.endpoint.endsWith('/1') ? 410 : 201 };
    };
    const ch = new PushChannel(repos.pushSubs, vapid, silentLogger, sender);
    expect(await ch.send(msg())).toEqual({ providerMessageId: 'push-s1-2' });
    expect(calls).toHaveLength(3);
    expect(calls[0].payload).toEqual({ title: '¡Carga acreditada!', body: 'Tienes ARS 5.000 listos para jugar', url: '/lobby', tag: 's1' });
    expect((await repos.pushSubs.list({ operatorId: 'op', playerId: 'p1' })).filter((s) => !s.dead).map((s) => s.id).sort()).toEqual(['sub-0', 'sub-2']);
    expect((await repos.pushSubs.get('sub-1'))?.dead).toBe(true);
  });

  it('URL externa en el mensaje → se abre el lobby (nunca otro dominio)', async () => {
    const repos = await withSubs(1);
    let payload: any;
    const ch = new PushChannel(repos.pushSubs, vapid, silentLogger, async (_s, p) => { payload = JSON.parse(p); return { statusCode: 201 }; });
    await ch.send(msg({ meta: { url: 'https://phishing.example' } }));
    expect(payload.url).toBe('/lobby');
  });

  it('push premium: imagen, página al tocar y hasta 2 botones; botones con links externos se descartan', async () => {
    const repos = await withSubs(1);
    let payload: any;
    const ch = new PushChannel(repos.pushSubs, vapid, silentLogger, async (_s, p) => { payload = JSON.parse(p); return { statusCode: 201 }; });
    await ch.send(msg({ meta: { push: { image: '/brand/push/bono.png', url: '/cashier', actions: [{ title: '🎰 Jugar ahora', url: '/lobby' }, { title: 'Trampa', url: '//evil.example' }, { title: 'Tercero', url: '/vip' }] } } }));
    expect(payload).toMatchObject({ url: '/cashier', image: '/brand/push/bono.png', actions: [{ action: 'a0', title: '🎰 Jugar ahora', url: '/lobby' }] });
  });

  it('errores honestos: sin claves, sin dispositivos o ninguno aceptó', async () => {
    const repos = await withSubs(1);
    await expect(new PushChannel(repos.pushSubs, null, silentLogger).send(msg())).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(new PushChannel((await withSubs(0)).pushSubs, vapid, silentLogger).send(msg())).rejects.toMatchObject({ code: 'NO_ADDRESS' });
    const failing = new PushChannel(repos.pushSubs, vapid, silentLogger, async () => ({ statusCode: 500 }));
    await expect(failing.send(msg())).rejects.toBeInstanceOf(ChannelError);
  });

  it('claves: del entorno; efímeras fuera de producción; ninguna en producción sin configurar', () => {
    expect(resolveVapid({ MKT_VAPID_PUBLIC_KEY: vapid.publicKey, MKT_VAPID_PRIVATE_KEY: vapid.privateKey, MKT_VAPID_SUBJECT: 'mailto:ops@x.com' })).toEqual({ publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: 'mailto:ops@x.com' });
    expect(resolveVapid({ NODE_ENV: 'test' })?.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(resolveVapid({ NODE_ENV: 'production' }, silentLogger)).toBeNull();
  });

  it('el envío real (librería web-push) firma con VAPID y cifra el payload (aes128gcm)', async () => {
    const { createECDH, randomBytes } = await import('crypto');
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    const d = webpush.generateRequestDetails(sub, JSON.stringify({ title: 't', body: 'b' }), { vapidDetails: vapid, TTL: 24 * 3600 });
    expect(d.endpoint).toBe(sub.endpoint);
    expect(d.headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    expect(d.headers['Content-Encoding']).toBe('aes128gcm');
    expect(d.headers.TTL).toBe(24 * 3600);
    expect((d.body as Buffer).length).toBeGreaterThan(80);
    expect((d.body as Buffer).toString()).not.toContain('"title"');
  });
});
