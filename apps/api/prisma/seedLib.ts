/**
 * Lógica del seed de DESARROLLO (la CLI está en prisma/seed.ts). Idempotente (upsert) y se niega en producción.
 *
 * Crea 2 operadores demo (nymfo y aurora) con marca, dominios y límites de apuesta, UN PLATFORM_ADMIN
 * (platform@nymfo.local, sin operador) y por operador un OPERATOR_ADMIN (admin@<slug>.local), un OPERATOR_FINANCE
 * (finance@<slug>.local) y un jugador demo (demo@<slug>.local, isDemo=true, saldo 0).
 * Con demoChips acredita fichas demo vía walletService.creditDemo (asiento DEMO_CREDIT). Nunca escribe saldos fuera del ledger.
 *
 * Dominios extra (vista previa): SEED_EXTRA_DOMAINS="host1,aurora=host2" → host1 al operador nymfo, host2 a aurora.
 * Se registran en OperatorDomain sin cambiar el dominio primario.
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';
import { PrismaWalletService } from '../src/infrastructure/ledger/PrismaWalletService';

export const PLATFORM_ADMIN_EMAIL = 'platform@nymfo.local';
/** Operador al que se asignan los dominios extra sin prefijo `slug=`. */
export const DEFAULT_SEED_OPERATOR = 'nymfo';

interface OperatorSeed {
  slug: string;
  name: string;
  defaultCurrency: string;
  currencies: string[];
  chipsEnabled: boolean;
  chipMinorUnitsPerChip: bigint | null;
  domains: string[];
  /**
   * Límites de apuesta (Operator.limits, JSON). Montos en unidades mínimas del ledger (centavos), como strings de dígitos.
   * betPresets: montos rápidos por moneda que muestran los juegos.
   */
  limits: { minBet: string; maxBet: string; betPresets: Record<string, string[]> };
  brand: {
    displayName: string;
    logoUrl: string;
    colors: Record<string, string>;
    fontFamily: string;
    legal: Record<string, unknown>;
  };
  /** Fichas demo (en unidades mínimas) si demoChips. */
  demoCredit: bigint;
}

export const SEED_OPERATORS: OperatorSeed[] = [
  {
    slug: 'nymfo',
    name: 'Infinite Abyss',
    defaultCurrency: 'COP',
    currencies: ['COP', 'USD'],
    chipsEnabled: false,
    chipMinorUnitsPerChip: null,
    domains: ['localhost', 'localhost:3000', '127.0.0.1:3000'],
    // 500 … 500.000 COP por apuesta; presets 500, 1.000, 2.000, 5.000, 10.000 y 50.000 COP (centavos).
    limits: {
      minBet: '50000',
      maxBet: '50000000',
      betPresets: { COP: ['50000', '100000', '200000', '500000', '1000000', '5000000'] },
    },
    brand: {
      displayName: 'Infinite Abyss',
      logoUrl: '/brand/infinite-abyss-logo.svg',
      colors: {
        primary: '#f4b73f',
        secondary: '#3cc8f0',
        accent: '#ffd978',
        background: '#050d1c',
        surface: '#0b1a30',
        text: '#e8eef8',
      },
      fontFamily: 'Inter, system-ui, sans-serif',
      legal: {
        termsUrl: '/legal/terms',
        privacyUrl: '/legal/privacy',
        responsibleGamingText: 'Juega con responsabilidad. Solo mayores de 18 años.',
        licenseText: 'Entorno de desarrollo: sin licencia de juego.',
        minAge: 18,
      },
    },
    demoCredit: 10_000_000n, // 100.000,00 COP demo (centavos)
  },
  {
    slug: 'aurora',
    name: 'Aurora Bet',
    defaultCurrency: 'USD',
    currencies: ['USD'],
    chipsEnabled: true,
    chipMinorUnitsPerChip: 100n, // 1 ficha = 1,00 USD
    domains: ['demo.localhost', 'demo.localhost:3000'],
    // 0,10 … 1.000,00 USD por apuesta.
    limits: {
      minBet: '10',
      maxBet: '100000',
      betPresets: { USD: ['10', '50', '100', '200', '500', '1000'] },
    },
    brand: {
      displayName: 'Aurora Bet',
      logoUrl: '/brand/aurora-logo.svg',
      colors: {
        primary: '#22d3ee',
        secondary: '#1e1b4b',
        accent: '#f472b6',
        background: '#0b1020',
        surface: '#151a33',
        text: '#eef2ff',
      },
      fontFamily: 'Poppins, system-ui, sans-serif',
      legal: {
        termsUrl: '/legal/terms',
        privacyUrl: '/legal/privacy',
        responsibleGamingText: 'Aurora Bet promueve el juego responsable. +18.',
        licenseText: 'Operador de ejemplo (demo), sin licencia.',
        minAge: 18,
      },
    },
    demoCredit: 100_000n, // 1.000,00 USD demo
  },
];

export interface ExtraDomain {
  slug: string;
  host: string;
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/**
 * Interpreta SEED_EXTRA_DOMAINS: lista separada por comas; cada entrada es `host` (operador nymfo) o `slug=host`.
 * Acepta también una URL (se toma su host). Entradas inválidas → Error con el detalle.
 */
export function parseExtraDomains(raw: string | undefined, defaultSlug = DEFAULT_SEED_OPERATOR): ExtraDomain[] {
  if (!raw || !raw.trim()) return [];
  const out = new Map<string, ExtraDomain>();
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    const slug = (eq > 0 ? entry.slice(0, eq) : defaultSlug).trim().toLowerCase();
    let host = (eq > 0 ? entry.slice(eq + 1) : entry).trim().toLowerCase();
    if (host.includes('://')) {
      try {
        host = new URL(host).host;
      } catch {
        throw new Error(`SEED_EXTRA_DOMAINS: URL inválida "${entry}"`);
      }
    }
    host = host.replace(/\/.*$/, '');
    if (!HOST_RE.test(host)) throw new Error(`SEED_EXTRA_DOMAINS: host inválido "${entry}"`);
    out.set(host, { slug, host });
  }
  return [...out.values()];
}

export interface SeedOptions {
  /** Contraseña de todos los usuarios demo. Vacía o 'change-me' → se genera una aleatoria. */
  password?: string;
  demoChips?: boolean;
  /** Valor de SEED_EXTRA_DOMAINS. */
  extraDomains?: string;
  /** NODE_ENV efectivo (por defecto process.env.NODE_ENV). */
  nodeEnv?: string;
  /** Coste de bcrypt (por defecto 12; bajo solo en pruebas). */
  bcryptCost?: number;
  log?: (msg: string) => void;
}

export interface SeedResult {
  password: string;
  generatedPassword: boolean;
  operators: Array<{ slug: string; id: string }>;
  extraDomains: ExtraDomain[];
  credentials: { platformAdmin: string; operatorAdmins: string[]; finance: string[]; players: string[] };
}

/** Une los límites del seed con los existentes: conserva otras claves y los presets de otras monedas. */
export function mergeLimits(existing: unknown, seed: OperatorSeed['limits']): Record<string, unknown> {
  const cur = existing && typeof existing === 'object' && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {};
  const curPresets =
    cur.betPresets && typeof cur.betPresets === 'object' && !Array.isArray(cur.betPresets) ? (cur.betPresets as Record<string, unknown>) : {};
  return { ...cur, minBet: seed.minBet, maxBet: seed.maxBet, betPresets: { ...curPresets, ...seed.betPresets } };
}

/** Ejecuta el seed sobre `prisma`. Lanza Error si NODE_ENV=production. */
export async function runSeed(prisma: PrismaClient, opts: SeedOptions = {}): Promise<SeedResult> {
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV;
  if (nodeEnv === 'production') {
    throw new Error('Seed rechazado: NODE_ENV=production. El seed es solo para desarrollo.');
  }
  const log = opts.log ?? (() => undefined);
  const extraDomains = parseExtraDomains(opts.extraDomains);
  const known = new Set(SEED_OPERATORS.map((o) => o.slug));
  for (const d of extraDomains) {
    if (!known.has(d.slug)) throw new Error(`SEED_EXTRA_DOMAINS: operador desconocido "${d.slug}" (válidos: ${[...known].join(', ')})`);
  }

  let password = opts.password;
  let generatedPassword = false;
  if (!password || password === 'change-me') {
    password = randomBytes(12).toString('base64url') + 'aA1!';
    generatedPassword = true;
  }
  const passwordHash = await bcrypt.hash(password, opts.bcryptCost ?? 12);
  const wallet = new PrismaWalletService(prisma);

  // Admin de plataforma (email propio: no colisiona con admin@<slug>.local).
  await prisma.backofficeUser.upsert({
    where: { email: PLATFORM_ADMIN_EMAIL },
    update: { passwordHash, role: 'PLATFORM_ADMIN', operatorId: null, status: 'ACTIVE' },
    create: { email: PLATFORM_ADMIN_EMAIL, passwordHash, role: 'PLATFORM_ADMIN', operatorId: null },
  });

  const operators: SeedResult['operators'] = [];
  const credentials: SeedResult['credentials'] = { platformAdmin: PLATFORM_ADMIN_EMAIL, operatorAdmins: [], finance: [], players: [] };

  for (const o of SEED_OPERATORS) {
    const prev = await prisma.operator.findUnique({ where: { slug: o.slug }, select: { limits: true } });
    const limits = mergeLimits(prev?.limits, o.limits) as never;
    const operator = await prisma.operator.upsert({
      where: { slug: o.slug },
      update: {
        name: o.name,
        defaultCurrency: o.defaultCurrency,
        currencies: o.currencies,
        chipsEnabled: o.chipsEnabled,
        chipMinorUnitsPerChip: o.chipMinorUnitsPerChip,
        limits,
        status: 'ACTIVE',
      },
      create: {
        slug: o.slug,
        name: o.name,
        defaultCurrency: o.defaultCurrency,
        currencies: o.currencies,
        chipsEnabled: o.chipsEnabled,
        chipMinorUnitsPerChip: o.chipMinorUnitsPerChip,
        limits,
      },
    });
    operators.push({ slug: o.slug, id: operator.id });

    await prisma.operatorBrand.upsert({
      where: { operatorId: operator.id },
      update: o.brand as never,
      create: { operatorId: operator.id, ...(o.brand as object) } as never,
    });

    for (const [i, host] of o.domains.entries()) {
      await prisma.operatorDomain.upsert({
        where: { host },
        update: { operatorId: operator.id, isPrimary: i === 0 },
        create: { host, operatorId: operator.id, isPrimary: i === 0 },
      });
    }
    // Dominios extra de la vista previa: se asignan al operador pero no tocan el primario.
    for (const d of extraDomains.filter((x) => x.slug === o.slug)) {
      await prisma.operatorDomain.upsert({
        where: { host: d.host },
        update: { operatorId: operator.id },
        create: { host: d.host, operatorId: operator.id, isPrimary: false },
      });
    }

    // Si quedó un admin@nymfo.local antiguo como PLATFORM_ADMIN, este upsert lo deja como OPERATOR_ADMIN de su operador.
    const staff = [
      { email: `admin@${o.slug}.local`, role: 'OPERATOR_ADMIN' as const },
      { email: `finance@${o.slug}.local`, role: 'OPERATOR_FINANCE' as const },
    ];
    for (const s of staff) {
      await prisma.backofficeUser.upsert({
        where: { email: s.email },
        update: { passwordHash, role: s.role, operatorId: operator.id, status: 'ACTIVE' },
        create: { email: s.email, passwordHash, role: s.role, operatorId: operator.id },
      });
    }
    credentials.operatorAdmins.push(staff[0].email);
    credentials.finance.push(staff[1].email);

    const email = `demo@${o.slug}.local`;
    const player = await prisma.user.upsert({
      where: { operatorId_emailNormalized: { operatorId: operator.id, emailNormalized: email } },
      update: { isDemo: true, passwordHash },
      create: {
        operatorId: operator.id,
        email,
        emailNormalized: email,
        username: `demo_${o.slug}`,
        passwordHash,
        currency: o.defaultCurrency,
        isDemo: true,
      },
    });
    credentials.players.push(email);

    if (opts.demoChips) {
      // Idempotente: misma clave = mismo asiento (no se duplica al re-ejecutar el seed).
      await wallet.creditDemo({
        operatorId: operator.id,
        userId: player.id,
        currency: o.defaultCurrency,
        amount: o.demoCredit,
        idempotencyKey: `seed:demo-credit:${operator.slug}:${player.id}`,
      });
    }
    log(`✔ Operador ${o.name} (${o.slug}) listo${opts.demoChips ? ' con fichas demo' : ''}`);
  }

  return { password, generatedPassword, operators, extraDomains, credentials };
}
