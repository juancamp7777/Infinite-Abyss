import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 10;
/** bcrypt solo considera los primeros 72 bytes: se rechaza más para no truncar en silencio. */
export const PASSWORD_MAX_BYTES = 72;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must have at least ${PASSWORD_MIN_LENGTH} characters`)
  .refine((v) => Buffer.byteLength(v, 'utf8') <= PASSWORD_MAX_BYTES, {
    message: `Password must not exceed ${PASSWORD_MAX_BYTES} bytes`,
  });

export const emailSchema = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email());

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
