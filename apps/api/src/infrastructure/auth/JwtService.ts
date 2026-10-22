import jwt from 'jsonwebtoken';
import { AppError } from '../../domain/errors/AppError';
import type { BackofficeRoleName } from '../../domain/contracts';

export interface AccessClaims {
  /** userId o backofficeUserId */
  sub: string;
  /** operatorId (en PLATFORM_ADMIN: cadena vacía) */
  op: string;
  typ: 'player' | 'backoffice';
  role?: BackofficeRoleName;
}

export interface JwtServiceOptions {
  secret: string;
  /** p. ej. '15m' */
  accessTtl: string;
}

const ROLES: readonly string[] = ['PLATFORM_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_SUPPORT', 'OPERATOR_FINANCE'];

/** Firma/verifica access tokens. El algoritmo se fija en ambos lados (HS256). */
export class JwtService {
  constructor(private readonly opts: JwtServiceOptions) {
    if (!opts.secret || opts.secret.length < 32) throw new Error('JWT secret must have at least 32 characters');
  }

  signAccess(claims: AccessClaims): string {
    const payload: Record<string, unknown> = { sub: claims.sub, op: claims.op, typ: claims.typ };
    if (claims.role) payload.role = claims.role;
    return jwt.sign(payload, this.opts.secret, {
      algorithm: 'HS256',
      expiresIn: this.opts.accessTtl as jwt.SignOptions['expiresIn'],
    });
  }

  /** Lanza AppError 401 si el token es inválido, expirado o con algoritmo distinto. */
  verifyAccess(token: string): AccessClaims {
    let decoded: string | jwt.JwtPayload;
    try {
      decoded = jwt.verify(token, this.opts.secret, { algorithms: ['HS256'] });
    } catch {
      throw AppError.unauthorized('Token inválido o vencido');
    }
    if (typeof decoded === 'string') throw AppError.unauthorized('Token inválido');
    const { sub, op, typ, role } = decoded as Record<string, unknown>;
    if (typeof sub !== 'string' || typeof op !== 'string' || (typ !== 'player' && typ !== 'backoffice')) {
      throw AppError.unauthorized('Token inválido');
    }
    if (typ === 'backoffice' && (typeof role !== 'string' || !ROLES.includes(role))) {
      throw AppError.unauthorized('Token inválido');
    }
    return { sub, op, typ, role: typ === 'backoffice' ? (role as BackofficeRoleName) : undefined };
  }
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(header.trim());
  return m ? m[1] : null;
}
