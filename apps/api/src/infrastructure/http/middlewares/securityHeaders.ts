import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface SecurityHeadersOptions {
  /** HSTS solo en producción (detrás de TLS). */
  isProduction: boolean;
  /**
   * Orígenes que pueden encuadrar las rutas embebibles (p. ej. el juego del MockProvider dentro del iframe de la web).
   * Se suman a 'self'. Normalmente PUBLIC_WEB_URL + CORS_ORIGINS.
   */
  frameAncestors?: string[];
  /** Prefijos de ruta que se pueden mostrar en un iframe (por defecto /hub/mock-provider/). */
  embeddablePrefixes?: string[];
}

export const DEFAULT_EMBEDDABLE_PREFIXES = ['/hub/mock-provider/'];

/** Valor de frame-ancestors para las rutas embebibles: 'self' + orígenes permitidos (deduplicados). */
export function buildFrameAncestors(origins: string[] = []): string {
  return ["'self'", ...new Set(origins.filter(Boolean))].join(' ');
}

/**
 * Cabeceras de seguridad de la API (equivalente acotado a helmet, sin dependencia extra):
 * - X-Content-Type-Options: nosniff, Referrer-Policy: strict-origin-when-cross-origin.
 * - Respuestas JSON: X-Frame-Options DENY + CSP `default-src 'none'; frame-ancestors 'none'` (la API no sirve HTML).
 * - Rutas embebibles (/hub/mock-provider/*): sin X-Frame-Options y frame-ancestors 'self' + orígenes de la web;
 *   la página del juego fija su propia CSP (scripts inline) manteniendo ese frame-ancestors.
 * - Strict-Transport-Security solo en producción.
 * x-powered-by se desactiva aparte con app.disable('x-powered-by').
 */
export function securityHeaders(opts: SecurityHeadersOptions): RequestHandler {
  const prefixes = opts.embeddablePrefixes ?? DEFAULT_EMBEDDABLE_PREFIXES;
  const ancestors = buildFrameAncestors(opts.frameAncestors);
  return (req: Request, res: Response, next: NextFunction) => {
    res.removeHeader('X-Powered-By');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    if (opts.isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const path = req.path;
    if (prefixes.some((p) => path.startsWith(p))) {
      res.setHeader('Content-Security-Policy', `frame-ancestors ${ancestors}`);
    } else {
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    }
    next();
  };
}
