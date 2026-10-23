import { z } from 'zod';

/**
 * Configuración del Cajero IA por operador (sucesor de los ~100 ajustes sueltos de RoboBeast).
 * Todo tipado: montos en unidades mínimas (string), horarios HH:MM, salas de Sonar por nombre, nada de "true"/"false"
 * escritos a mano ni IDs pegados. Se edita como borrador y se publica en versiones inmutables.
 */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora HH:MM');
const minor = z.string().regex(/^\d{1,15}$/, 'Monto en unidades mínimas');
const text = (max = 1000) => z.string().max(max).default('');
const stage = z.enum(['new_lead', 'client', 'vip', 'deposit_review', 'withdraw', 'support']);
/** 0 = domingo … 6 = sábado. */
const days = z.array(z.number().int().min(0).max(6)).min(1).max(7);
export const windowSchema = z.object({ days, start: hhmm, end: hhmm });
export type TimeWindow = z.infer<typeof windowSchema>;

const pct = z.number().int().min(0).max(200);

/** Promos del día (las 6 de RoboBeast). Comunes + campos según el tipo. */
const promoBase = {
  id: z.string().min(1).max(40),
  name: z.string().trim().min(2).max(60),
  active: z.boolean().default(false),
  /** Modo observación: detecta y registra, pero no paga ni avisa. */
  observeOnly: z.boolean().default(true),
  windows: z.array(windowSchema).max(10).default([]),
  maxClaimsPerPlayer: z.number().int().min(1).max(100).default(1),
  maxClaimsTotal: z.number().int().min(1).max(100_000).nullable().default(null),
  message: text(600),
};
export const promoSchema = z.discriminatedUnion('type', [
  z.object({ ...promoBase, type: z.literal('flash'), keyword: z.string().trim().min(2).max(40), bonusPct: pct, minDeposit: minor.nullable().default(null) }),
  z.object({ ...promoBase, type: z.literal('gift'), keyword: z.string().trim().min(2).max(40), chips: minor }),
  z.object({ ...promoBase, type: z.literal('streak'), steps: z.array(pct).min(2).max(5) }),
  z.object({ ...promoBase, type: z.literal('choice'), options: z.array(z.object({ trigger: z.string().trim().min(1).max(20), bonusPct: pct, reply: text(300) })).min(2).max(4) }),
  z.object({ ...promoBase, type: z.literal('post_withdraw'), bonusPct: pct }),
  z.object({ ...promoBase, type: z.literal('flyer'), bonusPct: pct, keyword: z.string().trim().max(40).default('') }),
]);
export type Promo = z.infer<typeof promoSchema>;

export const botConfigSchema = z.object({
  enabled: z.boolean().default(true),
  persona: z.object({ name: z.string().trim().min(1).max(30).default('Abyss'), tone: z.enum(['cercano', 'formal']).default('cercano'), emojis: z.boolean().default(true) }).default({ name: 'Abyss', tone: 'cercano', emojis: true }),
  messages: z.object({
    welcome: text(),
    afterLoad: text(),
    existingClient: text(),
    handoff: text(300),
    noCharge: text(),
    askReferral: z.boolean().default(false),
  }).default({ welcome: '', afterLoad: '', existingClient: '', handoff: '', noCharge: '', askReferral: false }),
  amounts: z.object({
    minDeposit: minor.default('0'),
    minWithdraw: minor.default('0'),
    vipFrom: minor.default('0'),
    referralBonus: minor.default('0'),
    /** Tope de acreditación automática por comprobante (0 = sin tope). */
    autoCreditMax: minor.default('0'),
    /** Cargas bajo el mínimo del mismo jugador se suman si llegan dentro de estos minutos (0 = no se suman). */
    accumulateMinutes: z.number().int().min(0).max(120).default(10),
  }).default({ minDeposit: '0', minWithdraw: '0', vipFrom: '0', referralBonus: '0', autoCreditMax: '0', accumulateMinutes: 10 }),
  hours: z.object({
    timezone: z.string().min(3).max(60).default('America/Bogota'),
    /** Modo sin cargas: los comprobantes van a una persona en vez de acreditarse solos. */
    noCharge: z.enum(['off', 'always', 'schedule']).default('off'),
    windows: z.array(windowSchema).max(20).default([]),
  }).default({ timezone: 'America/Bogota', noCharge: 'off', windows: [] }),
  automation: z.object({
    autoCredit: z.boolean().default(true),
    createUsers: z.boolean().default(true),
    giveBankData: z.enum(['never', 'on_request', 'new_leads']).default('on_request'),
    takeWithdrawals: z.boolean().default(true),
    handoffOnPassword: z.boolean().default(true),
    handoffOnUnmatchedReceipt: z.boolean().default(true),
    naturalHandoff: z.boolean().default(true),
    replyDelaySeconds: z.number().int().min(0).max(120).default(8),
  }).default({ autoCredit: true, createUsers: true, giveBankData: 'on_request', takeWithdrawals: true, handoffOnPassword: true, handoffOnUnmatchedReceipt: true, naturalHandoff: true, replyDelaySeconds: 8 }),
  routing: z.object({ support: stage.default('support'), pendingCredit: stage.default('deposit_review'), vip: stage.default('vip'), withdraw: stage.default('withdraw') })
    .default({ support: 'support', pendingCredit: 'deposit_review', vip: 'vip', withdraw: 'withdraw' }),
  bonuses: z.object({
    /** Bono de la casa en cada carga (0 = sin bono), con rango de montos opcional. */
    housePct: pct.default(0),
    houseMin: minor.nullable().default(null),
    houseMax: minor.nullable().default(null),
    welcomePct: pct.default(0),
    /** Happy hour: % extra en esas ventanas (además del de la casa no se suma: gana el mayor). */
    happyHourPct: pct.default(0),
    happyHours: z.array(windowSchema).max(10).default([]),
    promos: z.array(promoSchema).max(30).default([]),
  }).default({ housePct: 0, houseMin: null, houseMax: null, welcomePct: 0, happyHourPct: 0, happyHours: [], promos: [] }),
});
export type BotConfig = z.infer<typeof botConfigSchema>;

export const defaultBotConfig = (): BotConfig => botConfigSchema.parse({});

/** Reglas que el esquema solo no ve. Errores bloquean publicar; avisos se muestran pero dejan publicar. */
export function checkBotConfig(c: BotConfig): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const n = (v: string | null) => (v == null ? null : BigInt(v));
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: c.hours.timezone });
  } catch {
    errors.push('Zona horaria inválida');
  }
  if (c.hours.noCharge === 'schedule' && !c.hours.windows.length) errors.push('Modo sin cargas por horario: agrega al menos una franja');
  const vip = n(c.amounts.vipFrom)!;
  if (vip > 0n && vip <= n(c.amounts.minDeposit)!) errors.push('El monto VIP debe ser mayor que la carga mínima');
  const cap = n(c.amounts.autoCreditMax)!;
  if (cap > 0n && cap < n(c.amounts.minDeposit)!) errors.push('El tope de acreditación automática es menor que la carga mínima');
  if (c.automation.autoCredit && cap === 0n) warnings.push('Acreditación automática sin tope: cualquier monto verificado con el banco se acredita solo');
  const hMin = n(c.bonuses.houseMin);
  const hMax = n(c.bonuses.houseMax);
  if (hMin != null && hMax != null && hMin > hMax) errors.push('Bono de la casa: el mínimo supera al máximo');
  if (c.bonuses.happyHourPct > 0 && !c.bonuses.happyHours.length) errors.push('Happy hour: agrega al menos una franja');
  const ids = new Set<string>();
  const words = new Map<string, string>();
  for (const p of c.bonuses.promos) {
    if (ids.has(p.id)) errors.push(`Promo repetida: ${p.name}`);
    ids.add(p.id);
    const kw = 'keyword' in p && p.keyword ? (p.keyword as string).toLowerCase() : null;
    if (kw && p.active) {
      if (words.has(kw)) errors.push(`La palabra "${kw}" la usan dos promos activas (${words.get(kw)} y ${p.name})`);
      words.set(kw, p.name);
    }
    if (p.type === 'choice' && new Set(p.options.map((o) => o.trigger)).size !== p.options.length) errors.push(`${p.name}: dos opciones con el mismo disparador`);
    if (p.active && !p.observeOnly && p.type !== 'gift' && 'bonusPct' in p && p.bonusPct > 100) warnings.push(`${p.name}: bono mayor al 100 %`);
    if (p.active && p.observeOnly) warnings.push(`${p.name}: en modo observación (no paga)`);
  }
  for (const w of [...c.hours.windows, ...c.bonuses.happyHours]) if (w.start === w.end) errors.push('Una franja horaria empieza y termina a la misma hora');
  return { errors, warnings };
}

/** ¿La hora local cae en alguna franja? Soporta franjas que cruzan la medianoche (la franja pertenece al día en que empieza). */
export function inWindows(windows: TimeWindow[], at: Date, timeZone: string): boolean {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((p) => [p.type, p.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  return windows.some((w) => {
    const s = m(w.start);
    const e = m(w.end);
    if (s < e) return w.days.includes(day) && mins >= s && mins < e;
    // Cruza la medianoche: la parte de la noche es del día de inicio; la de la madrugada, del día anterior.
    return (w.days.includes(day) && mins >= s) || (w.days.includes((day + 6) % 7) && mins < e);
  });
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** Plantillas por país para arrancar una agencia en un minuto (valores de referencia, editables). */
export function presetFor(country: 'CO' | 'MX' | 'AR'): BotConfig {
  const base = defaultBotConfig();
  const c = (units: number) => String(units * 100);
  const common = {
    welcome: '¡Hola! 👋 Bienvenido. Te ayudo a recargar, retirar o con lo que necesites.',
    afterLoad: '✅ ¡Listo! Ya tienes tus fichas cargadas. ¡Mucha suerte! 🍀',
    existingClient: '¡Hola de nuevo! 🙌 ¿Recargamos?',
    handoff: 'Dale, dame un ratito que lo reviso y te ayudo 🙏',
    noCharge: 'En este momento las cargas las revisa una persona. Envíame tu comprobante y te aviso apenas quede acreditado.',
  };
  if (country === 'CO') return { ...base, messages: { ...base.messages, ...common }, hours: { ...base.hours, timezone: 'America/Bogota' }, amounts: { minDeposit: c(10_000), minWithdraw: c(20_000), vipFrom: c(500_000), referralBonus: c(10_000), autoCreditMax: c(2_000_000), accumulateMinutes: 10 }, bonuses: { ...base.bonuses, happyHours: [{ days: ALL_DAYS, start: '20:00', end: '22:00' }] } };
  if (country === 'MX') return { ...base, messages: { ...base.messages, ...common }, hours: { ...base.hours, timezone: 'America/Mexico_City' }, amounts: { minDeposit: c(100), minWithdraw: c(200), vipFrom: c(5_000), referralBonus: c(100), autoCreditMax: c(20_000), accumulateMinutes: 10 }, bonuses: { ...base.bonuses, happyHours: [{ days: ALL_DAYS, start: '20:00', end: '22:00' }] } };
  return { ...base, messages: { ...base.messages, ...common }, hours: { ...base.hours, timezone: 'America/Argentina/Buenos_Aires' }, amounts: { minDeposit: c(2_000), minWithdraw: c(4_000), vipFrom: c(50_000), referralBonus: c(9_000), autoCreditMax: c(500_000), accumulateMinutes: 10 }, bonuses: { ...base.bonuses, happyHours: [{ days: ALL_DAYS, start: '20:00', end: '22:00' }] } };
}
