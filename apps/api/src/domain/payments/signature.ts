import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Comparación de firmas en tiempo constante. Si las longitudes difieren devuelve false
 * (timingSafeEqual lanzaría excepción) sin filtrar información útil.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Igual que safeEqual pero ignorando mayúsculas (firmas hexadecimales). */
export function safeEqualHex(a: string, b: string): boolean {
  return safeEqual(a.trim().toLowerCase(), b.trim().toLowerCase());
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** JSON.stringify estilo PHP/JS-de-la-doc de Passimpay: escapa '/' como '\/'. */
export function jsonEscapeSlash(json: string): string {
  return json.replace(/\//g, '\\/');
}

/**
 * Firma de Passimpay: HMAC-SHA256 (hex), clave = API key, sobre `${platformId};${body};${apiKey}`
 * donde body es el JSON serializado.
 */
export function passimpaySignature(platformId: string, bodyJson: string, apiKey: string): string {
  return createHmac('sha256', apiKey).update(`${platformId};${bodyJson};${apiKey}`, 'utf8').digest('hex');
}

/** Firma de integridad del checkout de Wompi: SHA-256(reference + amountInCents + currency + secret). */
export function wompiIntegritySignature(
  reference: string,
  amountInCents: string,
  currency: string,
  integritySecret: string,
): string {
  return sha256Hex(`${reference}${amountInCents}${currency}${integritySecret}`);
}
