import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/** Cifrado simétrico AES-256-GCM para credenciales de canales (formato `v1.<iv>.<tag>.<datos>` en base64url). */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (!secret || secret.length < 32) throw new Error('INBOX_SECRETS_KEY debe tener al menos 32 caracteres');
    this.key = createHash('sha256').update(secret).digest();
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    return ['v1', iv, c.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }

  open<T>(sealed: string): T {
    const [v, iv, tag, data] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Credenciales cifradas con formato inválido');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8')) as T;
  }
}
