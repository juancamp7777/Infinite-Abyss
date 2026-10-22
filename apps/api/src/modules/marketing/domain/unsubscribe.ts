import { signHmacSha256, verifyHmac } from '../../shared/crypto/hmac';
import type { ChannelKind } from './types';
import { CHANNEL_KINDS } from './types';

/** Token de baja firmado con HMAC: base64url(JSON[op, player, canal]).<hmac-hex>. */
export function signUnsubscribeToken(secret: string, operatorId: string, playerId: string, channel: ChannelKind): string {
  const payload = Buffer.from(JSON.stringify([operatorId, playerId, channel])).toString('base64url');
  return `${payload}.${signHmacSha256(secret, payload)}`;
}

export function verifyUnsubscribeToken(
  secret: string,
  token: string,
): { operatorId: string; playerId: string; channel: ChannelKind } | null {
  const [payload, sig, extra] = String(token).split('.');
  if (!payload || !sig || extra !== undefined || !verifyHmac(secret, payload, sig)) return null;
  try {
    const [operatorId, playerId, channel] = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as [string, string, ChannelKind];
    if (typeof operatorId !== 'string' || typeof playerId !== 'string' || !CHANNEL_KINDS.includes(channel)) return null;
    return { operatorId, playerId, channel };
  } catch {
    return null;
  }
}
