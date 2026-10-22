import { z } from 'zod';
import { CONDITION_OPS, isCondition, type Condition, type ConditionOp, type Rule } from '../../shared/ports/SegmentPort';
import { DAY_MS } from './rfm';
import type { CrmPlayerView } from './types';

const MAX_DEPTH = 6;

const conditionSchema = z
  .object({
    field: z.string().min(1).max(64),
    op: z.enum(CONDITION_OPS as [ConditionOp, ...ConditionOp[]]),
    value: z.unknown().optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.op === 'exists') return;
    if (c.value === undefined) ctx.addIssue({ code: 'custom', message: `El operador ${c.op} requiere value`, path: ['value'] });
    if ((c.op === 'in' || c.op === 'nin') && !Array.isArray(c.value)) {
      ctx.addIssue({ code: 'custom', message: `${c.op} requiere un arreglo`, path: ['value'] });
    }
    if ((c.op === 'within_days' || c.op === 'older_than_days') && !(typeof c.value === 'number' && c.value >= 0)) {
      ctx.addIssue({ code: 'custom', message: `${c.op} requiere un número de días ≥ 0`, path: ['value'] });
    }
  });

function buildGroupSchema(depth: number): z.ZodType<Rule> {
  if (depth > MAX_DEPTH) return conditionSchema as unknown as z.ZodType<Rule>;
  const child = z.lazy(() => buildGroupSchema(depth + 1));
  const group = z
    .object({ all: z.array(child).max(50).optional(), any: z.array(child).min(1).max(50).optional() })
    .strict()
    .refine((g) => g.all !== undefined || g.any !== undefined, { message: 'Un grupo necesita all o any' });
  return z.union([conditionSchema, group]) as unknown as z.ZodType<Rule>;
}

/** Valida el DSL de segmentos (condiciones y grupos all/any anidados, hasta 6 niveles). */
export const ruleSchema: z.ZodType<Rule> = buildGroupSchema(0);

export type Attributes = Record<string, unknown>;

/** Atributos planos del perfil sobre los que se escriben las reglas. */
export function toAttributes(v: CrmPlayerView): Attributes {
  return {
    playerId: v.playerId,
    country: v.country,
    currency: v.currency,
    email: v.email,
    birthDate: v.birthDate,
    registeredAt: v.registeredAt,
    firstDepositAt: v.firstDepositAt,
    lastDepositAt: v.lastDepositAt,
    lastLoginAt: v.lastLoginAt,
    lastBetAt: v.lastBetAt,
    lastSessionAt: v.lastSessionAt,
    lastActivityAt: v.lastActivityAt,
    daysSinceLastActivity: v.daysSinceLastActivity ?? undefined,
    totalDeposits: v.depositsTotal,
    depositCount: v.depositsCount,
    totalWithdrawals: v.withdrawalsTotal,
    withdrawalCount: v.withdrawalsCount,
    totalWagered: v.totalWagered,
    totalWon: v.totalWon,
    betCount: v.betCount,
    sessionCount: v.sessionCount,
    loginCount: v.loginCount,
    ltv: v.ltv,
    ggr: v.ggr,
    activeDays30: v.activeDays30,
    favoriteGame: v.favoriteGames[0]?.id,
    favoriteCategory: v.favoriteCategories[0]?.id,
    rfmR: v.rfm.r,
    rfmF: v.rfm.f,
    rfmM: v.rfm.m,
    vipScore: v.vipScore,
    churnRisk: v.churnRisk,
    tags: v.tags,
    affiliateCode: v.affiliateCode,
    utmSource: v.utm?.source,
    utmMedium: v.utm?.medium,
    utmCampaign: v.utm?.campaign,
  };
}

const isNil = (x: unknown): x is null | undefined => x === null || x === undefined;

/** Compara números (bigint se pasa a Number: suficiente para umbrales de segmentación). */
function num(x: unknown): number | undefined {
  if (typeof x === 'bigint') return Number(x);
  if (typeof x === 'number') return Number.isNaN(x) ? undefined : x;
  if (typeof x === 'string' && x.trim() !== '' && !Number.isNaN(Number(x))) return Number(x);
  return undefined;
}

function looseEq(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return a.some((x) => looseEq(x, b));
  const na = num(a);
  const nb = num(b);
  if (na !== undefined && nb !== undefined && typeof a !== 'string') return na === nb;
  return String(a) === String(b);
}

function evalCondition(c: Condition, attrs: Attributes, now: Date): boolean {
  const actual = attrs[c.field];
  switch (c.op) {
    case 'exists': {
      const present = !isNil(actual) && !(Array.isArray(actual) && actual.length === 0);
      return present === (c.value !== false);
    }
    case 'eq':
      return !isNil(actual) && looseEq(actual, c.value);
    case 'neq':
      return isNil(actual) || !looseEq(actual, c.value);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = num(actual);
      const b = num(c.value);
      if (a === undefined || b === undefined) return false;
      return c.op === 'gt' ? a > b : c.op === 'gte' ? a >= b : c.op === 'lt' ? a < b : a <= b;
    }
    case 'in':
      return !isNil(actual) && Array.isArray(c.value) && c.value.some((v) => looseEq(actual, v));
    case 'nin':
      return isNil(actual) || !(Array.isArray(c.value) && c.value.some((v) => looseEq(actual, v)));
    case 'contains':
      if (Array.isArray(actual)) return actual.some((x) => looseEq(x, c.value));
      return typeof actual === 'string' && typeof c.value === 'string' && actual.toLowerCase().includes(c.value.toLowerCase());
    case 'within_days':
    case 'older_than_days': {
      if (typeof actual !== 'string') return false;
      const t = Date.parse(actual);
      const days = num(c.value);
      if (Number.isNaN(t) || days === undefined) return false;
      const ageMs = now.getTime() - t;
      // within_days: ocurrió hace ≤ N días (las fechas futuras cuentan como "dentro").
      return c.op === 'within_days' ? ageMs <= days * DAY_MS : ageMs > days * DAY_MS;
    }
  }
}

/** Evalúa una regla: condición, o grupo con all (AND) y/o any (OR). Un grupo vacío `all: []` incluye a todos. */
export function evaluateRule(rule: Rule, attrs: Attributes, now: Date): boolean {
  if (isCondition(rule)) return evalCondition(rule, attrs, now);
  const allOk = rule.all ? rule.all.every((r) => evaluateRule(r, attrs, now)) : true;
  const anyOk = rule.any ? rule.any.some((r) => evaluateRule(r, attrs, now)) : true;
  return allOk && anyOk;
}
