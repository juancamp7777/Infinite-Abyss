import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { ModuleLogger } from '../../shared/module';
import { inWindows, type BotConfig, type Promo } from '../domain/botConfig';
import type { BotConfigService } from './BotConfigService';

/** Paga en el ledger de la plataforma (bono de promociones, idempotente por `reason`). */
export type BonusGrant = (req: { operatorId: string; playerId: string; amount: bigint; currency: string; reason: string; wagering: number }) => Promise<{ duplicate: boolean }>;

export interface CreditedLoad { id: string; operatorId: string; playerId: string; amount: bigint; currency: string; createdAt: Date }
export interface AppliedBonus { pct: number; amount: bigint; source: string; label: string }

/** Un reclamo que vale para la próxima carga: dura 24 h. */
const PENDING_TTL_MS = 24 * 3_600_000;
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (s: string) => ` ${norm(s).replace(/[^a-z0-9ñ]+/g, ' ').trim()} `;

/**
 * Bonos y promos del Cajero IA (las de RoboBeast, con topes, modo observación y pago en el ledger):
 * - En cada carga acreditada se aplica el MAYOR bono que corresponda (casa, happy hour, bienvenida, o la promo que
 *   el jugador activó: Flash, a elección, flyer, racha del día o post-retiro). Nunca se suman entre sí.
 * - En el chat, la palabra o el emoji de una promo activa la deja lista (el regalo de fichas se paga al instante).
 */
export class PromoEngine {
  constructor(
    private readonly db: PrismaClient,
    private readonly bot: BotConfigService,
    private readonly opts: { grant?: BonusGrant; logger: ModuleLogger; now?: () => Date },
  ) {}

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  private active(c: BotConfig, at: Date) {
    return c.bonuses.promos.filter((p) => p.active && (!p.windows.length || inWindows(p.windows, at, c.hours.timezone)));
  }

  private async claims(operatorId: string, promoId: string, playerId?: string) {
    return this.db.pearlPromoClaim.count({ where: { operatorId, promoId, observed: false, ...(playerId ? { playerKey: playerId } : {}) } });
  }

  private async limitsLeft(operatorId: string, p: Promo, playerId: string): Promise<'ok' | 'player' | 'total'> {
    if ((await this.claims(operatorId, p.id, playerId)) >= p.maxClaimsPerPlayer) return 'player';
    if (p.maxClaimsTotal != null && (await this.claims(operatorId, p.id)) >= p.maxClaimsTotal) return 'total';
    return 'ok';
  }

  /** Mensaje del jugador: ¿activa alguna promo? Devuelve la respuesta del bot (o nada si no aplica). */
  async onMessage(operatorId: string, playerId: string | undefined, text: string): Promise<{ handled: boolean; reply?: string }> {
    const c = await this.bot.live(operatorId);
    if (!c?.enabled || !text.trim()) return { handled: false };
    const at = this.now();
    const w = words(text);
    for (const p of this.active(c, at)) {
      let pct: number | null = null;
      let reply = p.message;
      if ((p.type === 'flash' || p.type === 'gift' || p.type === 'flyer') && p.keyword && w.includes(` ${words(p.keyword).trim()} `)) pct = p.type === 'gift' ? 0 : p.bonusPct;
      else if (p.type === 'choice') {
        const opt = p.options.find((o) => text.includes(o.trigger) || (words(o.trigger).trim() && w.includes(` ${words(o.trigger).trim()} `)));
        if (opt) { pct = opt.bonusPct; reply = opt.reply || reply; }
      }
      if (pct === null) continue;
      if (!playerId) return { handled: true, reply: 'Para usar esta promo primero necesitamos crear tu cuenta 😉 ¿Te la creo?' };
      const n = await this.claims(operatorId, p.id, playerId);
      if (p.observeOnly) {
        await this.record(operatorId, p.id, playerId, `${p.id}:${playerId}:obs:${at.getTime()}`, { observed: true, pct });
        return { handled: false };
      }
      const left = await this.limitsLeft(operatorId, p, playerId);
      if (left === 'player') return { handled: true, reply: 'Ya usaste esta promo 🙌 ¡Atento a las próximas!' };
      if (left === 'total') return { handled: true, reply: 'Esta promo ya se agotó 😕 ¡Atento a las próximas!' };
      if (p.type === 'gift') {
        const amount = BigInt(p.chips);
        const ref = `${p.id}:${playerId}:${n + 1}`;
        await this.record(operatorId, p.id, playerId, ref, { amount, consumedAt: at });
        const currency = await this.currency(operatorId, playerId);
        await this.opts.grant?.({ operatorId, playerId, amount, currency, reason: `cajero:gift:${ref}`, wagering: c.bonuses.wageringMultiplier });
        return { handled: true, reply: reply || `🎁 ¡Listo! Te regalamos fichas. ¡Mucha suerte!` };
      }
      // Pendiente de una existente: no se apila, se renueva.
      const pending = await this.db.pearlPromoClaim.findFirst({ where: { operatorId, promoId: p.id, playerKey: playerId, observed: false, consumedAt: null } });
      if (!pending) await this.record(operatorId, p.id, playerId, `${p.id}:${playerId}:${n + 1}`, { pct });
      return { handled: true, reply: reply || `🔥 ¡Activado! Tu próxima carga lleva ${pct} % de bono.` };
    }
    return { handled: false };
  }

  /** Carga acreditada: calcula y paga el mayor bono que corresponda. */
  async onCredited(load: CreditedLoad): Promise<AppliedBonus | null> {
    const c = await this.bot.live(load.operatorId);
    if (!c?.enabled || load.amount <= 0n) return null;
    const at = this.now();
    const b = c.bonuses;
    const options: Array<{ pct: number; source: string; label: string; claimId?: string; promo?: Promo }> = [];
    const inRange = (b.houseMin == null || load.amount >= BigInt(b.houseMin)) && (b.houseMax == null || load.amount <= BigInt(b.houseMax));
    if (b.housePct > 0 && inRange) options.push({ pct: b.housePct, source: 'house', label: 'bono de la casa' });
    if (b.happyHourPct > 0 && inWindows(b.happyHours, at, c.hours.timezone)) options.push({ pct: b.happyHourPct, source: 'happy_hour', label: 'happy hour' });
    if (b.welcomePct > 0 && (await this.isFirstLoad(load))) options.push({ pct: b.welcomePct, source: 'welcome', label: 'bono de bienvenida' });

    const promos = this.active(c, at);
    const pending = await this.db.pearlPromoClaim.findMany({ where: { operatorId: load.operatorId, playerKey: load.playerId, observed: false, consumedAt: null, createdAt: { gte: new Date(at.getTime() - PENDING_TTL_MS) } } });
    for (const cl of pending) {
      const p = promos.find((x) => x.id === cl.promoId);
      if (!p || cl.pct == null) continue;
      if (p.type === 'flash' && p.minDeposit && load.amount < BigInt(p.minDeposit)) continue;
      options.push({ pct: cl.pct, source: p.type, label: p.name, claimId: cl.id, promo: p });
    }
    for (const p of promos) {
      if (p.type === 'streak') {
        const n = await this.loadsToday(load, c.hours.timezone);
        const pct = p.steps[Math.min(n, p.steps.length) - 1];
        if (pct) options.push({ pct, source: 'streak', label: `${p.name} (${n}ª carga)`, promo: p });
      } else if (p.type === 'post_withdraw' && (await this.withdrewToday(load, c.hours.timezone))) {
        options.push({ pct: p.bonusPct, source: 'post_withdraw', label: p.name, promo: p });
      }
    }
    // Las automáticas en modo observación solo se registran.
    for (const o of options.filter((x) => x.promo?.observeOnly && !x.claimId)) {
      await this.record(load.operatorId, o.promo!.id, load.playerId, `${o.promo!.id}:${load.id}:obs`, { observed: true, pct: o.pct });
    }
    const payable: typeof options = [];
    for (const o of options) {
      if (o.promo?.observeOnly) continue;
      if (o.promo && !o.claimId && (await this.limitsLeft(load.operatorId, o.promo, load.playerId)) !== 'ok') continue;
      payable.push(o);
    }
    const best = payable.sort((x, y) => y.pct - x.pct)[0];
    if (!best || best.pct <= 0) return null;
    const amount = (load.amount * BigInt(best.pct)) / 100n;
    if (amount <= 0n) return null;
    const res = await this.opts.grant?.({ operatorId: load.operatorId, playerId: load.playerId, amount, currency: load.currency, reason: `cajero:carga:${load.id}`, wagering: b.wageringMultiplier });
    if (res?.duplicate) return null;
    if (best.claimId) await this.db.pearlPromoClaim.update({ where: { id: best.claimId }, data: { consumedAt: at, amount } });
    else if (best.promo) await this.record(load.operatorId, best.promo.id, load.playerId, `${best.promo.id}:${load.id}`, { amount, pct: best.pct, consumedAt: at });
    return { pct: best.pct, amount, source: best.source, label: best.label };
  }

  private async record(operatorId: string, promoId: string, playerKey: string, refKey: string, d: { observed?: boolean; amount?: bigint; pct?: number | null; consumedAt?: Date }) {
    try {
      await this.db.pearlPromoClaim.create({ data: { id: randomUUID(), operatorId, promoId, playerKey, refKey, observed: d.observed ?? false, amount: d.amount ?? null, pct: d.pct ?? null, consumedAt: d.consumedAt ?? null } });
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e; // reintento: ya registrado
    }
  }

  private async currency(operatorId: string, playerId: string) {
    const u = await this.db.user.findFirst({ where: { id: playerId, operatorId }, select: { currency: true } });
    return u?.currency ?? '';
  }

  private async isFirstLoad(load: CreditedLoad) {
    return (await this.db.deposit.count({ where: { userId: load.playerId, status: 'CONFIRMED' } })) <= 1;
  }

  private startOfDay(at: Date, timeZone: string) {
    const local = new Date(at.toLocaleString('en-US', { timeZone }));
    const offset = at.getTime() - local.getTime();
    local.setHours(0, 0, 0, 0);
    return new Date(local.getTime() + offset);
  }

  private async loadsToday(load: CreditedLoad, tz: string) {
    return this.db.deposit.count({ where: { userId: load.playerId, status: 'CONFIRMED', createdAt: { gte: this.startOfDay(this.now(), tz) } } });
  }

  private async withdrewToday(load: CreditedLoad, tz: string) {
    return (await this.db.withdrawal.count({ where: { userId: load.playerId, status: { in: ['APPROVED', 'PROCESSING', 'PAID'] }, createdAt: { gte: this.startOfDay(this.now(), tz) } } })) > 0;
  }
}
