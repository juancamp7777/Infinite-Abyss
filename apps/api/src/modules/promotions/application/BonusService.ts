import type { DomainEvents } from '../../shared/events/EventBus';
import type { ModuleLogger } from '../../shared/module';
import { minBigint } from '../../shared/money';
import type { BetCheckRequest, BetCheckResult, BetGuardPort } from '../../shared/ports/BetGuardPort';
import type { GameCatalogPort } from '../../shared/ports/GameCatalogPort';
import { type OperatorCurrencyPort, resolveOperatorCurrency } from '../../shared/ports/OperatorCurrencyPort';
import type { PlayerCompliancePort } from '../../shared/ports/PlayerCompliancePort';
import {
  assertTransition,
  BonusSource,
  BonusTemplate,
  BonusType,
  cashbackAmount,
  DEFAULT_CONTRIBUTION_BPS,
  depositMatchAmount,
  normalizeCode,
  PlayerBonus,
  progressBps,
  wageringContribution,
  wageringRequirement,
  WageringBase,
} from '../domain/bonus';
import { Clock, PromoError } from '../domain/common';
import { KeyedMutex } from '../infrastructure/KeyedMutex';
import type { BonusFundsPort } from './BonusFunds';
import type { BonusRepository, BonusTemplatePatch, NewBonusTemplate, NewPlayerBonus } from './ports';

const HOUR_MS = 3_600_000;

export interface BonusServiceDeps {
  repo: BonusRepository;
  funds: BonusFundsPort;
  clock: Clock;
  logger: ModuleLogger;
  catalog?: GameCatalogPort;
  compliance?: PlayerCompliancePort;
  /** Moneda del operador: grantCashback sin currency usa su defaultCurrency. */
  operators?: OperatorCurrencyPort;
  /** Respaldo SOLO para el dev-server (sin operador real): PROMO_DEFAULT_CURRENCY. */
  defaultCurrency?: string;
}

/** Datos de entrada de una plantilla (los opcionales toman valores por defecto). */
export type BonusTemplateInput = Partial<Omit<NewBonusTemplate, 'operatorId' | 'name' | 'type' | 'currency'>> &
  Pick<NewBonusTemplate, 'operatorId' | 'name' | 'type' | 'currency'>;

export interface GrantOptions {
  source: BonusSource;
  sourceRef?: string | null;
  depositAmount?: bigint;
  amount?: bigint;
  /** deposit_match reclamado por código sin depósito todavía → PENDING. */
  pendingDeposit?: boolean;
}

export interface GrantCashbackOptions {
  currency?: string;
  /** 0 (por defecto) = cash directo sin wagering; >0 = bono con ese rollover. */
  wageringMultiplier?: number;
  validityHours?: number;
  maxBet?: bigint | null;
}

export interface FreeSpinGrant {
  bonusId: string;
  gameId: string;
  spinValue: bigint;
  remaining: number;
}

/** Vista serializable de un bono con su progreso. */
export function bonusView(b: PlayerBonus) {
  return {
    id: b.id,
    templateId: b.templateId,
    type: b.type,
    status: b.status,
    phase: b.phase,
    currency: b.currency,
    source: b.source,
    amount: b.amount,
    depositAmount: b.depositAmount,
    wageringRequired: b.wageringRequired,
    wageringProgress: b.wageringProgress,
    wageringRemaining: b.wageringRequired > b.wageringProgress ? b.wageringRequired - b.wageringProgress : 0n,
    progressBps: progressBps(b),
    maxBet: b.maxBet,
    contributionBps: b.contributionBps,
    freeSpins:
      b.type === 'free_spins'
        ? { gameId: b.freeSpinGameId, total: b.freeSpinsTotal, used: b.freeSpinsUsed, remaining: b.freeSpinsTotal - b.freeSpinsUsed, spinValue: b.freeSpinValue, winnings: b.freeSpinWin }
        : null,
    expiresAt: b.expiresAt,
    settlementAmount: b.settlementAmount,
    statusReason: b.statusReason,
    createdAt: b.createdAt,
    activatedAt: b.activatedAt,
    closedAt: b.closedAt,
  };
}

/**
 * Motor de bonos: plantillas, otorgamiento (código, depósito, manual, cashback), wagering con contribución por
 * categoría, apuesta máxima, expiración y ciclo de vida PENDING → ACTIVE → COMPLETED | FORFEITED | CANCELLED.
 * Cada movimiento de dinero es idempotente (claves promo:bonus:<bonusId>:<op>) y se reintenta en tick().
 */
export class BonusService implements BetGuardPort {
  private readonly playerLock = new KeyedMutex();

  constructor(private readonly d: BonusServiceDeps) {}

  // ───────────── Plantillas ─────────────

  async createTemplate(input: BonusTemplateInput): Promise<BonusTemplate> {
    const t: NewBonusTemplate = {
      operatorId: input.operatorId,
      name: input.name,
      type: input.type,
      currency: input.currency,
      status: input.status ?? 'ACTIVE',
      code: input.code ? normalizeCode(input.code) : null,
      maxUsesTotal: input.maxUsesTotal ?? null,
      maxUsesPerPlayer: input.maxUsesPerPlayer ?? (input.code ? 1 : null),
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      autoOnDeposit: input.autoOnDeposit ?? false,
      firstDepositOnly: input.firstDepositOnly ?? false,
      stackable: input.stackable ?? false,
      matchBps: input.matchBps ?? null,
      minDeposit: input.minDeposit ?? null,
      maxBonusAmount: input.maxBonusAmount ?? null,
      fixedAmount: input.fixedAmount ?? null,
      freeSpinGameId: input.freeSpinGameId ?? null,
      freeSpinCount: input.freeSpinCount ?? null,
      freeSpinValue: input.freeSpinValue ?? null,
      cashbackBps: input.cashbackBps ?? null,
      wageringMultiplier: input.wageringMultiplier ?? 0,
      wageringBase: input.wageringBase ?? 'BONUS',
      contributionBps: { ...(input.contributionBps ?? DEFAULT_CONTRIBUTION_BPS) },
      excludedGameIds: input.excludedGameIds ?? [],
      maxBet: input.maxBet ?? null,
      maxConversion: input.maxConversion ?? null,
      validityHours: input.validityHours ?? 24 * 7,
      claimWindowHours: input.claimWindowHours ?? 24,
    };
    this.validateTemplate(t);
    return this.mapUnique(() => this.d.repo.createTemplate(t));
  }

  async updateTemplate(operatorId: string | undefined, id: string, patch: BonusTemplatePatch): Promise<BonusTemplate> {
    const current = await this.getTemplateScoped(operatorId, id);
    const next: BonusTemplatePatch = { ...patch };
    if (patch.code !== undefined) next.code = patch.code ? normalizeCode(patch.code) : null;
    this.validateTemplate({ ...current, ...next });
    const t = await this.mapUnique(() => this.d.repo.updateTemplate(id, next));
    if (!t) throw new PromoError(404, 'NOT_FOUND', 'Plantilla no encontrada');
    return t;
  }

  /** Borra si nunca se usó; si tiene bonos asociados la desactiva (se conserva el historial). */
  async deleteTemplate(operatorId: string | undefined, id: string): Promise<{ deleted: boolean; deactivated: boolean }> {
    await this.getTemplateScoped(operatorId, id);
    if ((await this.d.repo.countBonusesByTemplate(id)) > 0) {
      await this.d.repo.updateTemplate(id, { status: 'INACTIVE' });
      return { deleted: false, deactivated: true };
    }
    return { deleted: await this.d.repo.deleteTemplate(id), deactivated: false };
  }

  listTemplates(operatorId?: string): Promise<BonusTemplate[]> {
    return this.d.repo.listTemplates(operatorId);
  }

  async getTemplateScoped(operatorId: string | undefined, id: string): Promise<BonusTemplate> {
    const t = await this.d.repo.getTemplate(id);
    if (!t || (operatorId && t.operatorId !== operatorId)) throw new PromoError(404, 'NOT_FOUND', 'Plantilla no encontrada');
    return t;
  }

  private validateTemplate(t: Omit<BonusTemplate, 'id' | 'usesCount' | 'createdAt' | 'updatedAt'>): void {
    const bad = (m: string) => new PromoError(400, 'BAD_REQUEST', m);
    if (!Number.isInteger(t.wageringMultiplier) || t.wageringMultiplier < 0 || t.wageringMultiplier > 200) throw bad('wageringMultiplier debe ser un entero entre 0 y 200');
    if (t.validFrom && t.validTo && t.validFrom >= t.validTo) throw bad('validFrom debe ser anterior a validTo');
    for (const [k, v] of Object.entries(t.contributionBps)) {
      if (!Number.isInteger(v) || v < 0 || v > 10000) throw bad(`contributionBps.${k} debe estar entre 0 y 10000`);
    }
    switch (t.type) {
      case 'deposit_match':
        if (!t.matchBps || t.matchBps <= 0) throw bad('deposit_match requiere matchBps > 0');
        if (!t.code && !t.autoOnDeposit) throw bad('deposit_match requiere code o autoOnDeposit');
        break;
      case 'promo_code':
        if (!t.code) throw bad('promo_code requiere code');
        if (!t.fixedAmount || t.fixedAmount <= 0n) throw bad('promo_code requiere fixedAmount > 0');
        break;
      case 'free_spins':
        if (!t.freeSpinGameId || !t.freeSpinCount || t.freeSpinCount <= 0 || !t.freeSpinValue || t.freeSpinValue <= 0n) {
          throw bad('free_spins requiere freeSpinGameId, freeSpinCount > 0 y freeSpinValue > 0');
        }
        break;
      case 'cashback':
        if (!t.cashbackBps || t.cashbackBps <= 0 || t.cashbackBps > 10000) throw bad('cashback requiere cashbackBps entre 1 y 10000');
        if (t.code || t.autoOnDeposit) throw bad('cashback no es canjeable por código ni automático por depósito');
        break;
    }
    if (t.autoOnDeposit && t.type !== 'deposit_match') throw bad('autoOnDeposit solo aplica a deposit_match');
  }

  private async mapUnique<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') throw new PromoError(409, 'CODE_TAKEN', 'Ya existe una plantilla con ese código en el operador');
      throw e;
    }
  }

  // ───────────── Consultas ─────────────

  async listPlayerBonuses(operatorId: string, playerId: string) {
    const all = await this.d.repo.listBonuses({ operatorId, playerId, limit: 200 });
    const views = all.map(bonusView);
    return { active: views.filter((b) => b.status === 'ACTIVE' || b.status === 'PENDING'), history: views.filter((b) => b.status !== 'ACTIVE' && b.status !== 'PENDING') };
  }

  listBonuses(filter: Parameters<BonusRepository['listBonuses']>[0]): Promise<PlayerBonus[]> {
    return this.d.repo.listBonuses(filter);
  }

  getBonus(id: string): Promise<PlayerBonus | null> {
    return this.d.repo.getBonus(id);
  }

  // ───────────── Otorgamiento ─────────────

  /** Canje por código (promo_code, free_spins o deposit_match → PENDING hasta el depósito). */
  async claim(operatorId: string, playerId: string, rawCode: string): Promise<PlayerBonus> {
    const code = normalizeCode(rawCode);
    if (!code) throw new PromoError(400, 'BAD_REQUEST', 'Código vacío');
    return this.playerLock.run(`${operatorId}\u0000${playerId}`, async () => {
      await this.assertNotExcluded(operatorId, playerId);
      const t = await this.d.repo.findTemplateByCode(operatorId, code);
      if (!t || t.status !== 'ACTIVE') throw new PromoError(404, 'CODE_NOT_FOUND', 'Código promocional inválido');
      const now = this.d.clock();
      if ((t.validFrom && now < t.validFrom) || (t.validTo && now >= t.validTo)) throw new PromoError(409, 'CODE_NOT_ACTIVE', 'El código no está vigente');
      if (t.type === 'cashback') throw new PromoError(400, 'NOT_CLAIMABLE', 'Este bono no es canjeable');
      await this.assertCanOpen(t, operatorId, playerId);
      const r = await this.d.repo.reserveCodeUse(t.id, playerId);
      if (r === 'TOTAL_LIMIT') throw new PromoError(409, 'CODE_LIMIT_REACHED', 'El código alcanzó su máximo de usos');
      if (r === 'PLAYER_LIMIT') throw new PromoError(409, 'PLAYER_CODE_LIMIT', 'Ya usaste este código el máximo de veces');
      try {
        return await this.grantFromTemplate(t, playerId, { source: 'CODE', pendingDeposit: t.type === 'deposit_match' });
      } catch (e) {
        await this.d.repo.releaseCodeUse(t.id, playerId);
        throw e;
      }
    });
  }

  /** Otorgamiento manual de un admin (idempotente si se pasa idempotencyKey). */
  async grantManual(
    operatorId: string,
    templateId: string,
    playerId: string,
    opts: { amount?: bigint; depositAmount?: bigint; idempotencyKey?: string } = {},
  ): Promise<PlayerBonus> {
    const t = await this.getTemplateScoped(operatorId, templateId);
    return this.playerLock.run(`${operatorId}\u0000${playerId}`, async () => {
      const sourceRef = opts.idempotencyKey ? `manual:${opts.idempotencyKey}` : null;
      if (sourceRef) {
        const existing = await this.d.repo.findBySourceRef(operatorId, sourceRef);
        if (existing) return this.activateFunds(existing);
      }
      await this.assertCanOpen(t, operatorId, playerId);
      return this.grantFromTemplate(t, playerId, {
        source: 'MANUAL',
        sourceRef,
        amount: opts.amount,
        depositAmount: opts.depositAmount,
      });
    });
  }

  /**
   * Crea el bono a partir de una plantilla y, si queda ACTIVE, abona los fondos y lo completa si no requiere rollover.
   * Idempotente por sourceRef.
   */
  async grantFromTemplate(t: BonusTemplate, playerId: string, opts: GrantOptions): Promise<PlayerBonus> {
    const now = this.d.clock();
    const deposit = opts.depositAmount ?? 0n;
    let amount = 0n;
    let pending = false;
    switch (t.type) {
      case 'deposit_match':
        if (opts.amount != null) amount = opts.amount;
        else if (opts.depositAmount != null) amount = depositMatchAmount(t, deposit);
        else if (opts.pendingDeposit) pending = true;
        else throw new PromoError(400, 'BAD_REQUEST', 'deposit_match requiere depositAmount o amount');
        break;
      case 'promo_code':
        amount = opts.amount ?? t.fixedAmount ?? 0n;
        break;
      case 'cashback':
        if (opts.amount == null) throw new PromoError(400, 'BAD_REQUEST', 'cashback requiere amount');
        amount = opts.amount;
        break;
      case 'free_spins':
        break;
    }
    if (!pending && t.type !== 'free_spins' && amount <= 0n) throw new PromoError(400, 'BAD_REQUEST', 'El bono resultante es 0');
    const b: NewPlayerBonus = {
      operatorId: t.operatorId,
      playerId,
      templateId: t.id,
      type: t.type,
      status: pending ? 'PENDING' : 'ACTIVE',
      phase: t.type === 'free_spins' ? 'SPINS' : 'WAGERING',
      currency: t.currency,
      source: opts.source,
      sourceRef: opts.sourceRef ?? null,
      amount,
      depositAmount: deposit,
      wageringMultiplier: t.wageringMultiplier,
      wageringBase: t.wageringBase,
      wageringRequired: t.type === 'free_spins' || pending ? 0n : wageringRequirement(t.wageringMultiplier, t.wageringBase, amount, deposit),
      wageringProgress: 0n,
      contributionBps: { ...t.contributionBps },
      excludedGameIds: [...t.excludedGameIds],
      maxBet: t.maxBet,
      maxConversion: t.maxConversion,
      freeSpinGameId: t.freeSpinGameId,
      freeSpinsTotal: t.type === 'free_spins' ? t.freeSpinCount ?? 0 : 0,
      freeSpinsUsed: 0,
      freeSpinsSettled: 0,
      freeSpinValue: t.freeSpinValue,
      freeSpinWin: 0n,
      validityHours: t.validityHours,
      expiresAt: new Date(now.getTime() + (pending ? t.claimWindowHours : t.validityHours) * HOUR_MS),
      grantTxId: null,
      settlementAmount: 0n,
      settlementTxId: null,
      statusReason: null,
      activatedAt: pending ? null : now,
      closedAt: null,
    };
    const { bonus } = await this.d.repo.createBonus(b);
    return this.activateFunds(bonus);
  }

  /**
   * Cashback idempotente para otros módulos (marketing: "gran pérdida → cashback").
   * La clave de idempotencia es (operatorId, reason): la misma razón nunca paga dos veces.
   */
  async grantCashback(operatorId: string, playerId: string, amount: bigint, reason: string, opts: GrantCashbackOptions = {}): Promise<{ bonus: PlayerBonus; duplicate: boolean }> {
    if (typeof amount !== 'bigint' || amount <= 0n) throw new PromoError(400, 'BAD_REQUEST', 'El monto del cashback debe ser un bigint positivo');
    if (!reason) throw new PromoError(400, 'BAD_REQUEST', 'reason es obligatorio (se usa como clave de idempotencia)');
    const mult = opts.wageringMultiplier ?? 0;
    const now = this.d.clock();
    const validityHours = opts.validityHours ?? 24 * 7;
    const sourceRef = `svc:${playerId}:${reason}`;
    const dup = await this.d.repo.findBySourceRef(operatorId, sourceRef);
    if (dup) return { bonus: await this.activateFunds(dup), duplicate: true };
    await this.assertNotExcluded(operatorId, playerId);
    const { bonus, created } = await this.d.repo.createBonus({
      operatorId,
      playerId,
      templateId: null,
      type: 'cashback',
      status: 'ACTIVE',
      phase: 'WAGERING',
      currency: opts.currency ?? (await resolveOperatorCurrency(this.d.operators, operatorId, this.d.defaultCurrency, this.d.logger)),
      source: 'SERVICE',
      sourceRef,
      amount,
      depositAmount: 0n,
      wageringMultiplier: mult,
      wageringBase: 'BONUS',
      wageringRequired: wageringRequirement(mult, 'BONUS', amount, 0n),
      wageringProgress: 0n,
      contributionBps: { ...DEFAULT_CONTRIBUTION_BPS },
      excludedGameIds: [],
      maxBet: opts.maxBet ?? null,
      maxConversion: null,
      freeSpinGameId: null,
      freeSpinsTotal: 0,
      freeSpinsUsed: 0,
      freeSpinsSettled: 0,
      freeSpinValue: null,
      freeSpinWin: 0n,
      validityHours,
      expiresAt: new Date(now.getTime() + validityHours * HOUR_MS),
      grantTxId: null,
      settlementAmount: 0n,
      settlementTxId: null,
      statusReason: reason.slice(0, 200),
      activatedAt: now,
      closedAt: null,
    });
    return { bonus: await this.activateFunds(bonus), duplicate: !created };
  }

  /** Cashback por pérdida neta del periodo [from, to) para todos los jugadores con pérdida. Idempotente por periodo. */
  async runCashback(operatorId: string | undefined, templateId: string, from: Date, to: Date) {
    const t = await this.getTemplateScoped(operatorId, templateId);
    if (t.type !== 'cashback') throw new PromoError(400, 'BAD_REQUEST', 'La plantilla no es de cashback');
    if (from >= to) throw new PromoError(400, 'BAD_REQUEST', 'Periodo inválido');
    const results = await this.d.repo.netResults(t.operatorId, t.currency, from, to);
    let granted = 0;
    let skipped = 0;
    let total = 0n;
    for (const r of results) {
      const amount = cashbackAmount(t, r.wagered - r.won);
      if (amount <= 0n || (t.minDeposit != null && r.wagered - r.won < t.minDeposit)) continue;
      try {
        await this.assertNotExcluded(t.operatorId, r.playerId);
        const sourceRef = `cashback:${t.id}:${from.toISOString()}:${to.toISOString()}:${r.playerId}`;
        await this.grantFromTemplate(t, r.playerId, { source: 'CASHBACK', sourceRef, amount });
        granted++;
        total += amount;
      } catch (e) {
        skipped++;
        this.d.logger.warn('promotions: cashback omitido', { playerId: r.playerId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { templateId: t.id, from, to, players: results.length, granted, skipped, total };
  }

  // ───────────── Cancelación ─────────────

  async cancelByPlayer(operatorId: string, playerId: string, bonusId: string): Promise<PlayerBonus> {
    const b = await this.d.repo.getBonus(bonusId);
    if (!b || b.operatorId !== operatorId || b.playerId !== playerId) throw new PromoError(404, 'NOT_FOUND', 'Bono no encontrado');
    return this.close(b, 'CANCELLED', 'PLAYER_CANCELLED', true);
  }

  async cancelByAdmin(operatorId: string | undefined, bonusId: string, reason = 'ADMIN_CANCELLED'): Promise<PlayerBonus> {
    const b = await this.d.repo.getBonus(bonusId);
    if (!b || (operatorId && b.operatorId !== operatorId)) throw new PromoError(404, 'NOT_FOUND', 'Bono no encontrado');
    return this.close(b, 'CANCELLED', reason.slice(0, 200), true);
  }

  // ───────────── Eventos ─────────────

  async onDeposit(e: DomainEvents['deposit.completed']): Promise<void> {
    await this.playerLock.run(`${e.operatorId}\u0000${e.playerId}`, async () => {
      const sourceRef = `deposit:${e.txId}`;
      if (await this.d.repo.findBySourceRef(e.operatorId, sourceRef)) return; // evento reprocesado
      const open = await this.d.repo.findOpenBonuses(e.operatorId, e.playerId);
      const now = this.d.clock();
      // 1) deposit_match reclamado por código y esperando el depósito.
      for (const p of open.filter((b) => b.status === 'PENDING' && b.type === 'deposit_match' && b.currency === e.currency)) {
        const t = p.templateId ? await this.d.repo.getTemplate(p.templateId) : null;
        if (!t) continue;
        if (t.minDeposit != null && e.amount < t.minDeposit) continue;
        if (t.firstDepositOnly && !e.isFirst) continue;
        const amount = depositMatchAmount(t, e.amount);
        if (amount <= 0n) continue;
        assertTransition(p.status, 'ACTIVE');
        const activated = await this.d.repo.updateIf(p.id, { status: ['PENDING'] }, {
          status: 'ACTIVE',
          amount,
          depositAmount: e.amount,
          wageringRequired: wageringRequirement(p.wageringMultiplier, p.wageringBase, amount, e.amount),
          sourceRef,
          activatedAt: now,
          expiresAt: new Date(now.getTime() + p.validityHours * HOUR_MS),
        });
        if (activated) {
          await this.activateFunds(activated);
          return;
        }
      }
      // 2) Bonos automáticos por depósito.
      const blocking = open.filter((b) => b.status === 'ACTIVE' || b.status === 'PENDING');
      for (const t of await this.d.repo.listAutoDepositTemplates(e.operatorId, e.currency)) {
        if (t.firstDepositOnly && !e.isFirst) continue;
        if (t.minDeposit != null && e.amount < t.minDeposit) continue;
        if ((t.validFrom && now < t.validFrom) || (t.validTo && now >= t.validTo)) continue;
        if (!t.stackable && blocking.length > 0) continue;
        if (await this.isExcluded(e.operatorId, e.playerId)) return;
        if (depositMatchAmount(t, e.amount) <= 0n) continue;
        await this.grantFromTemplate(t, e.playerId, { source: 'DEPOSIT', sourceRef, depositAmount: e.amount });
        return;
      }
    });
  }

  /** Progreso del rollover (dedupe por roundId) y detección de violación de apuesta máxima. */
  async onBetPlaced(e: DomainEvents['bet.placed']): Promise<void> {
    const open = (await this.d.repo.findOpenBonuses(e.operatorId, e.playerId)).filter(
      (b) => b.status === 'ACTIVE' && b.phase === 'WAGERING' && b.currency === e.currency,
    );
    if (open.length === 0) return;
    const category = await this.resolveCategory(e.gameId, e.category);
    for (const b of open) {
      if (b.maxBet != null && e.amount > b.maxBet) {
        await this.close(b, 'FORFEITED', 'MAX_BET_VIOLATION', false);
        continue;
      }
      const updated = await this.d.repo.addWagering(b.id, e.roundId, wageringContribution(b, category, e.gameId, e.amount));
      if (updated) await this.maybeComplete(updated);
    }
  }

  async onBetSettled(e: DomainEvents['bet.settled']): Promise<void> {
    await this.d.repo.recordSettledRound({
      operatorId: e.operatorId,
      playerId: e.playerId,
      currency: e.currency,
      roundId: e.roundId,
      amount: e.amount,
      win: e.win,
      at: new Date(e.at),
    });
  }

  // ───────────── Giros gratis (los consume Studio/Hub) ─────────────

  async availableFreeSpins(operatorId: string, playerId: string, gameId?: string): Promise<FreeSpinGrant[]> {
    const open = await this.d.repo.findOpenBonuses(operatorId, playerId);
    return open
      .filter((b) => b.status === 'ACTIVE' && b.phase === 'SPINS' && b.freeSpinsUsed < b.freeSpinsTotal && (!gameId || b.freeSpinGameId === gameId))
      .map((b) => ({ bonusId: b.id, gameId: b.freeSpinGameId ?? '', spinValue: b.freeSpinValue ?? 0n, remaining: b.freeSpinsTotal - b.freeSpinsUsed }));
  }

  /** Consume un giro gratis para la ronda (sin débito de billetera). null si no hay giros disponibles. */
  async consumeFreeSpin(operatorId: string, playerId: string, gameId: string, roundId: string): Promise<FreeSpinGrant | null> {
    const now = this.d.clock();
    for (const g of await this.availableFreeSpins(operatorId, playerId, gameId)) {
      const b = await this.d.repo.getBonus(g.bonusId);
      if (!b || (b.expiresAt && b.expiresAt <= now)) continue;
      const updated = await this.d.repo.consumeFreeSpin(g.bonusId, roundId);
      if (updated) return { bonusId: updated.id, gameId, spinValue: updated.freeSpinValue ?? 0n, remaining: updated.freeSpinsTotal - updated.freeSpinsUsed };
    }
    return null;
  }

  /** Registra la ganancia del giro gratis; al liquidar el último, las ganancias pasan a bono con wagering. */
  async recordFreeSpinWin(bonusId: string, roundId: string, win: bigint): Promise<PlayerBonus | null> {
    if (typeof win !== 'bigint' || win < 0n) throw new PromoError(400, 'BAD_REQUEST', 'win inválido');
    const updated = await this.d.repo.addFreeSpinWin(bonusId, roundId, win);
    if (!updated) return this.d.repo.getBonus(bonusId);
    if (updated.freeSpinsSettled >= updated.freeSpinsTotal) return this.finishSpins(updated);
    return updated;
  }

  private async finishSpins(b: PlayerBonus): Promise<PlayerBonus> {
    const now = this.d.clock();
    if (b.freeSpinWin === 0n) {
      assertTransition(b.status, 'COMPLETED');
      return (await this.d.repo.updateIf(b.id, { status: ['ACTIVE'], phase: 'SPINS' }, { status: 'COMPLETED', statusReason: 'NO_WINNINGS', closedAt: now })) ?? b;
    }
    const moved = await this.d.repo.updateIf(b.id, { status: ['ACTIVE'], phase: 'SPINS' }, {
      phase: 'WAGERING',
      amount: b.freeSpinWin,
      wageringRequired: wageringRequirement(b.wageringMultiplier, 'BONUS', b.freeSpinWin, 0n),
    });
    return moved ? this.activateFunds(moved) : ((await this.d.repo.getBonus(b.id)) ?? b);
  }

  // ───────────── Apuesta máxima (BetGuardPort) ─────────────

  async checkBet(req: BetCheckRequest): Promise<BetCheckResult> {
    const open = await this.d.repo.findOpenBonuses(req.operatorId, req.playerId);
    for (const b of open) {
      if (b.status === 'ACTIVE' && b.phase === 'WAGERING' && b.currency === req.currency && b.maxBet != null && req.amount > b.maxBet) {
        return { allowed: false, reason: `BONUS_MAX_BET: apuesta máxima con bono activo ${b.maxBet.toString()}` };
      }
    }
    return { allowed: true };
  }

  // ───────────── Job ─────────────

  /** Expira bonos vencidos (→ FORFEITED) y reintenta movimientos de billetera pendientes. */
  async tick(now: Date = this.d.clock()): Promise<{ expired: number; retried: number }> {
    let expired = 0;
    for (const b of await this.d.repo.listExpired(now, 500)) {
      try {
        await this.close(b, 'FORFEITED', 'EXPIRED', false);
        expired++;
      } catch (e) {
        this.d.logger.warn('promotions: no se pudo expirar el bono', { bonusId: b.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    let retried = 0;
    for (const b of await this.d.repo.listUnsettled(500)) {
      retried++;
      if (b.status === 'ACTIVE') await this.activateFunds(b);
      else await this.settle(b);
    }
    return { expired, retried };
  }

  // ───────────── Internos ─────────────

  /** Abona los fondos del bono (idempotente) y lo completa si ya cumple el rollover. */
  private async activateFunds(b: PlayerBonus): Promise<PlayerBonus> {
    if (b.status !== 'ACTIVE' || b.phase !== 'WAGERING') return b;
    let cur = b;
    if (cur.amount > 0n && !cur.grantTxId) {
      try {
        const cashOnly = cur.type === 'cashback' && cur.wageringRequired === 0n;
        const { txId } = cashOnly ? await this.d.funds.grantCash(cur, cur.amount) : await this.d.funds.grant(cur, cur.amount);
        cur = (await this.d.repo.updateIf(cur.id, { status: ['ACTIVE'] }, { grantTxId: txId })) ?? cur;
      } catch (e) {
        this.d.logger.error('promotions: fallo al abonar el bono (se reintentará en tick)', { bonusId: cur.id, error: e instanceof Error ? e.message : String(e) });
        return cur;
      }
    }
    return this.maybeComplete(cur);
  }

  private async maybeComplete(b: PlayerBonus): Promise<PlayerBonus> {
    if (b.status !== 'ACTIVE' || b.phase !== 'WAGERING') return b;
    if (b.amount > 0n && !b.grantTxId) return b;
    if (b.wageringProgress < b.wageringRequired) return b;
    assertTransition(b.status, 'COMPLETED');
    const cashOnly = b.type === 'cashback' && b.wageringRequired === 0n;
    let settlement = 0n;
    if (!cashOnly && b.amount > 0n) {
      settlement = await this.d.funds.bonusBalance(b.operatorId, b.playerId, b.currency);
      if (b.maxConversion != null) settlement = minBigint(settlement, b.maxConversion);
      const others = (await this.d.repo.findOpenBonuses(b.operatorId, b.playerId)).filter((x) => x.id !== b.id && x.status === 'ACTIVE' && x.phase === 'WAGERING' && x.currency === b.currency);
      // Con bonos simultáneos el saldo de bono es compartido: solo se convierte lo aportado por este bono.
      if (others.length > 0) settlement = minBigint(settlement, b.amount);
    }
    const done = await this.d.repo.updateIf(b.id, { status: ['ACTIVE'], phase: 'WAGERING' }, {
      status: 'COMPLETED',
      settlementAmount: settlement,
      statusReason: b.wageringRequired === 0n ? 'NO_WAGERING' : 'WAGERING_MET',
      closedAt: this.d.clock(),
    });
    if (!done) return (await this.d.repo.getBonus(b.id)) ?? b;
    return this.settle(done);
  }

  /** Cierra un bono abierto (FORFEITED o CANCELLED) retirando el saldo de bono que aportó. */
  private async close(b: PlayerBonus, to: 'FORFEITED' | 'CANCELLED', reason: string, strict: boolean): Promise<PlayerBonus> {
    assertTransition(b.status, to);
    let settlement = 0n;
    const funded = b.status === 'ACTIVE' && b.phase === 'WAGERING' && !!b.grantTxId && !(b.type === 'cashback' && b.wageringRequired === 0n);
    if (funded) settlement = minBigint(await this.d.funds.bonusBalance(b.operatorId, b.playerId, b.currency), b.amount);
    const closed = await this.d.repo.updateIf(b.id, { status: [b.status] }, { status: to, settlementAmount: settlement, statusReason: reason, closedAt: this.d.clock() });
    if (!closed) {
      const fresh = await this.d.repo.getBonus(b.id);
      if (strict) throw new PromoError(409, 'INVALID_TRANSITION', `El bono cambió de estado (${fresh?.status ?? 'desconocido'})`);
      return fresh ?? b;
    }
    return this.settle(closed);
  }

  private async settle(b: PlayerBonus): Promise<PlayerBonus> {
    if (b.settlementAmount <= 0n || b.settlementTxId) return b;
    try {
      const { txId } = b.status === 'COMPLETED' ? await this.d.funds.convert(b, b.settlementAmount) : await this.d.funds.forfeit(b, b.settlementAmount);
      return (await this.d.repo.updateIf(b.id, { status: [b.status] }, { settlementTxId: txId })) ?? b;
    } catch (e) {
      this.d.logger.error('promotions: fallo al liquidar el bono (se reintentará en tick)', { bonusId: b.id, status: b.status, error: e instanceof Error ? e.message : String(e) });
      return b;
    }
  }

  private async assertCanOpen(t: BonusTemplate, operatorId: string, playerId: string): Promise<void> {
    if (t.stackable) return;
    const open = await this.d.repo.findOpenBonuses(operatorId, playerId);
    if (open.some((b) => b.status === 'ACTIVE' || b.status === 'PENDING')) {
      throw new PromoError(409, 'BONUS_ALREADY_ACTIVE', 'Ya tienes un bono activo');
    }
  }

  private async isExcluded(operatorId: string, playerId: string): Promise<boolean> {
    if (!this.d.compliance) return false;
    const s = await this.d.compliance.getStatus(operatorId, playerId);
    return s.selfExcluded || s.isMinor;
  }

  private async assertNotExcluded(operatorId: string, playerId: string): Promise<void> {
    if (await this.isExcluded(operatorId, playerId)) throw new PromoError(403, 'PLAYER_EXCLUDED', 'El jugador no puede recibir bonos');
  }

  private async resolveCategory(gameId: string, fallback: string): Promise<string> {
    if (!this.d.catalog) return fallback;
    try {
      return (await this.d.catalog.getGame(gameId))?.category ?? fallback;
    } catch {
      return fallback;
    }
  }
}

export type { BonusType, WageringBase };
