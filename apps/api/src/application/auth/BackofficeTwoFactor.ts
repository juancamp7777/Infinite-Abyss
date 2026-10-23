import bcrypt from 'bcryptjs';
import type { BackofficeUser, PrismaClient } from '@prisma/client';
import QRCode from 'qrcode';
import { AppError } from '../../domain/errors/AppError';
import {
  generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, openTotpSecret, otpauthUrl, sealTotpSecret, verifyTotp,
} from '../../domain/auth/totp';

export interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
}

export interface TwoFactorSetup {
  /** Para escribirlo a mano si no se puede escanear el QR. */
  secret: string;
  otpauthUrl: string;
  /** QR en SVG (se muestra tal cual en el panel). */
  qrSvg: string;
}

const mfaError = (code: 'MFA_REQUIRED' | 'MFA_INVALID', message: string) => new AppError(message, 401, true, code);

/**
 * Verificación en dos pasos del backoffice (TOTP + códigos de respaldo de un solo uso).
 * El secreto se guarda cifrado; mientras no se confirma con un código queda "pendiente" y no afecta el login.
 */
export class BackofficeTwoFactor {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly opts: { key: string; now?: () => number },
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private async user(id: string): Promise<BackofficeUser> {
    const u = await this.prisma.backofficeUser.findUnique({ where: { id } });
    if (!u || u.status !== 'ACTIVE') throw AppError.unauthorized();
    return u;
  }

  status(u: Pick<BackofficeUser, 'totpEnabledAt' | 'totpRecovery'>): TwoFactorStatus {
    return { enabled: !!u.totpEnabledAt, enabledAt: u.totpEnabledAt?.toISOString() ?? null, recoveryCodesLeft: u.totpRecovery.length };
  }

  async getStatus(userId: string): Promise<TwoFactorStatus> {
    return this.status(await this.user(userId));
  }

  /** Genera un secreto nuevo (pendiente). Si ya hay 2FA activo, hay que desactivarlo primero. */
  async setup(userId: string): Promise<TwoFactorSetup> {
    const u = await this.user(userId);
    if (u.totpEnabledAt) throw AppError.conflict('La verificación en dos pasos ya está activa');
    const secret = generateTotpSecret();
    await this.prisma.backofficeUser.update({ where: { id: u.id }, data: { totpPendingEnc: sealTotpSecret(secret, this.opts.key) } });
    const url = otpauthUrl(secret, u.email);
    const qrSvg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#000000', light: '#ffffff' } });
    return { secret, otpauthUrl: url, qrSvg };
  }

  /** Confirma con un código de la app: activa el 2FA y devuelve los códigos de respaldo (se muestran una sola vez). */
  async enable(userId: string, code: string): Promise<{ recoveryCodes: string[]; status: TwoFactorStatus }> {
    const u = await this.user(userId);
    if (u.totpEnabledAt) throw AppError.conflict('La verificación en dos pasos ya está activa');
    if (!u.totpPendingEnc) throw AppError.conflict('Primero genera el código QR');
    const secret = openTotpSecret(u.totpPendingEnc, this.opts.key);
    const step = verifyTotp(secret, code, this.now());
    if (step === null) throw AppError.validation('El código no coincide. Revisa la hora de tu celular y vuelve a intentar.');
    const recoveryCodes = generateRecoveryCodes();
    const saved = await this.prisma.backofficeUser.update({
      where: { id: u.id },
      data: {
        totpSecretEnc: u.totpPendingEnc, totpPendingEnc: null, totpEnabledAt: new Date(this.now()), totpLastStep: step,
        totpRecovery: recoveryCodes.map(hashRecoveryCode),
      },
    });
    return { recoveryCodes, status: this.status(saved) };
  }

  /** Desactivar exige la contraseña y un código vigente (o de respaldo). */
  async disable(userId: string, password: string, code: string): Promise<TwoFactorStatus> {
    const u = await this.user(userId);
    if (!u.totpEnabledAt) return this.status(u);
    if (!(await bcrypt.compare(password, u.passwordHash))) throw AppError.unauthorized('Contraseña incorrecta');
    await this.check(u, code);
    const saved = await this.prisma.backofficeUser.update({
      where: { id: u.id },
      data: { totpSecretEnc: null, totpPendingEnc: null, totpEnabledAt: null, totpLastStep: null, totpRecovery: [] },
    });
    return this.status(saved);
  }

  /** En el login: sin 2FA no hace nada; con 2FA exige un código válido y no reutilizado, o uno de respaldo. */
  async verifyLogin(u: BackofficeUser, code: string | undefined): Promise<void> {
    if (!u.totpEnabledAt) return;
    if (!code || !code.trim()) throw mfaError('MFA_REQUIRED', 'Ingresa el código de tu app de autenticación');
    await this.check(u, code);
  }

  private async check(u: BackofficeUser, code: string): Promise<void> {
    if (!u.totpSecretEnc) throw mfaError('MFA_INVALID', 'Código de verificación incorrecto');
    const step = verifyTotp(openTotpSecret(u.totpSecretEnc, this.opts.key), code, this.now(), u.totpLastStep);
    if (step !== null) {
      // Solo avanza si nadie usó un paso posterior entre medio (dos logins simultáneos con el mismo código: gana uno).
      const r = await this.prisma.backofficeUser.updateMany({ where: { id: u.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] }, data: { totpLastStep: step } });
      if (r.count === 1) return;
      throw mfaError('MFA_INVALID', 'Ese código ya se usó; espera el siguiente');
    }
    const h = hashRecoveryCode(code);
    if (u.totpRecovery.includes(h)) {
      const left = u.totpRecovery.filter((x) => x !== h);
      const r = await this.prisma.backofficeUser.updateMany({ where: { id: u.id, totpRecovery: { has: h } }, data: { totpRecovery: left } });
      if (r.count === 1) return;
    }
    throw mfaError('MFA_INVALID', 'Código de verificación incorrecto');
  }
}
