import { randomUUID } from 'crypto';
import type { DomainEvents } from '../../shared/events/EventBus';
import type { ModuleLogger } from '../../shared/module';
import { applyBps } from '../../shared/money';
import type { Journey, JourneyRun, JourneyStep, PlayerState } from '../domain/types';
import type { MarketingRepos } from '../infrastructure/stores';
import type { MessagingService } from './MessagingService';

const DAY = 86_400_000;
const MAX_RECENT_MS = 7 * DAY;

/** Mantiene el estado mínimo del jugador que necesitan journeys y campañas (alimentado por eventos). */
export class PlayerStateService {
  constructor(private readonly repos: MarketingRepos, private readonly clock: () => Date) {}

  private async load(operatorId: string, playerId: string): Promise<PlayerState> {
    return (
      (await this.repos.players.get(`${operatorId}:${playerId}`)) ?? { id: `${operatorId}:${playerId}`, operatorId, playerId, depositCount: 0, recent: [] }
    );
  }

  async onRegistered(e: DomainEvents['player.registered']): Promise<void> {
    const s = await this.load(e.operatorId, e.playerId);
    s.registeredAt = e.at;
    s.currency = e.currency;
    if (e.email) s.email = e.email;
    if (e.birthDate) s.birthDate = e.birthDate;
    await this.repos.players.put(s);
  }

  async onDeposit(e: DomainEvents['deposit.completed']): Promise<void> {
    const s = await this.load(e.operatorId, e.playerId);
    s.depositCount += 1;
    s.lastDepositAt = e.at;
    s.currency = e.currency;
    await this.repos.players.put(s);
  }

  async onLogin(e: DomainEvents['login']): Promise<void> {
    const s = await this.load(e.operatorId, e.playerId);
    s.lastLoginAt = e.at;
    await this.repos.players.put(s);
  }

  /** Devuelve la pérdida neta (>0) acumulada dentro de la ventana. */
  async onBetSettled(e: DomainEvents['bet.settled'], windowHours: number): Promise<bigint> {
    const s = await this.load(e.operatorId, e.playerId);
    const now = new Date(e.at).getTime();
    s.currency = e.currency;
    s.recent = [...s.recent, { at: e.at, net: (e.win - e.amount).toString() }].filter((r) => now - new Date(r.at).getTime() <= MAX_RECENT_MS);
    await this.repos.players.put(s);
    return this.netLoss(s, windowHours, now);
  }

  netLoss(s: PlayerState, windowHours: number, nowMs = this.clock().getTime()): bigint {
    const since = nowMs - windowHours * 3_600_000;
    const net = s.recent.filter((r) => new Date(r.at).getTime() >= since).reduce((a, r) => a + BigInt(r.net), 0n);
    return net < 0n ? -net : 0n;
  }
}

type EventTrigger = Extract<Journey['trigger'], { type: 'event' }>;

export class JourneyEngine {
  private readonly newId: () => string = randomUUID;
  constructor(
    private readonly repos: MarketingRepos,
    private readonly messaging: MessagingService,
    private readonly state: PlayerStateService,
    private readonly clock: () => Date,
    private readonly logger: ModuleLogger,
    private readonly services: () => Record<string, unknown>,
  ) {}

  /** Debe llamarse DESPUÉS de actualizar el estado del jugador. */
  async onEvent<K extends 'player.registered' | 'deposit.completed' | 'login' | 'bet.settled'>(name: K, e: DomainEvents[K]): Promise<void> {
    // 1) cancelaciones por evento
    if (name === 'deposit.completed' || name === 'login') await this.cancelOn(name, e.operatorId, e.playerId);
    // 2) inscripciones
    const journeys = await this.repos.journeys.list({ operatorId: e.operatorId, status: 'active' });
    for (const j of journeys) {
      if (j.trigger.type !== 'event' || j.trigger.event !== name) continue;
      if (name === 'bet.settled') {
        await this.maybeEnrollBigLoss(j, j.trigger, e as DomainEvents['bet.settled']);
      } else {
        await this.enroll(j, e.playerId, 'once', {}, new Date(e.at));
      }
    }
  }

  private async cancelOn(event: 'deposit.completed' | 'login', operatorId: string, playerId: string): Promise<void> {
    const runs = await this.repos.runs.list({ operatorId, playerId, status: 'running' });
    for (const r of runs) {
      const j = await this.repos.journeys.get(r.journeyId);
      const cancelOn = j?.trigger.cancelOn as string[] | undefined;
      if (cancelOn?.includes(event)) await this.finish(r, 'cancelled', `cancelled_by_${event}`);
    }
  }

  private async maybeEnrollBigLoss(j: Journey, t: EventTrigger, e: DomainEvents['bet.settled']): Promise<void> {
    if (!t.lossThreshold) return;
    const windowHours = t.windowHours ?? 24;
    const loss = await this.state.onBetSettled(e, windowHours);
    if (loss < BigInt(t.lossThreshold)) return;
    const since = new Date(e.at).getTime() - windowHours * 3_600_000;
    const prev = await this.repos.runs.list({ operatorId: e.operatorId, playerId: e.playerId, refId: j.id });
    if (prev.some((r) => new Date(r.createdAt).getTime() >= since)) return;
    await this.enroll(j, e.playerId, `loss:${e.at}`, { netLoss: loss.toString(), currency: e.currency }, new Date(e.at));
  }

  /** Inscribe una vez por (journey, jugador, ciclo). Ejecuta de inmediato los pasos hasta el primer wait. */
  async enroll(j: Journey, playerId: string, cycleKey: string, context: Record<string, string>, now: Date): Promise<boolean> {
    const run: JourneyRun = {
      id: `${j.id}:${playerId}:${cycleKey}`, operatorId: j.operatorId, journeyId: j.id, playerId, stepIndex: 0, status: 'running',
      dueAt: now.toISOString(), cycleKey, context, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    if (!(await this.repos.runs.putIfAbsent(run))) return false;
    await this.advance(run, j, now);
    return true;
  }

  private async finish(run: JourneyRun, status: 'done' | 'cancelled', reason?: string): Promise<void> {
    run.status = status;
    run.endedReason = reason;
    run.dueAt = undefined;
    run.updatedAt = this.clock().toISOString();
    await this.repos.runs.put(run);
  }

  private async checkCondition(step: Extract<JourneyStep, { type: 'condition' }>, run: JourneyRun, now: Date): Promise<boolean> {
    const s = await this.repos.players.get(`${run.operatorId}:${run.playerId}`);
    const deposits = s?.depositCount ?? 0;
    switch (step.check) {
      case 'no_deposit':
        return deposits === 0;
      case 'has_deposited':
        return deposits > 0;
      case 'inactive_since_deposit_days':
        return !!s?.lastDepositAt && now.getTime() - new Date(s.lastDepositAt).getTime() >= (step.value ?? 7) * DAY;
    }
  }

  private async advance(run: JourneyRun, j: Journey, now: Date): Promise<void> {
    try {
      while (run.stepIndex < j.steps.length) {
        const step = j.steps[run.stepIndex];
        run.stepIndex += 1;
        if (step.type === 'wait') {
          run.dueAt = new Date(now.getTime() + step.minutes * 60_000).toISOString();
          run.updatedAt = now.toISOString();
          await this.repos.runs.put(run);
          return;
        }
        if (step.type === 'condition') {
          if (!(await this.checkCondition(step, run, now))) return this.finish(run, 'cancelled', `condition_${step.check}_false`);
        } else if (step.type === 'send') {
          await this.messaging.sendMarketing({
            operatorId: run.operatorId, playerId: run.playerId, templateId: step.templateId, refId: j.id, refType: 'journey',
            vars: { ...run.context },
          });
        } else if (step.type === 'action') {
          await this.grantCashback(run, step.percentBps);
        }
      }
      await this.finish(run, 'done');
    } catch (e) {
      this.logger.error('[marketing] fallo en journey run', { runId: run.id, error: e instanceof Error ? e.message : String(e) });
      run.dueAt = new Date(now.getTime() + 15 * 60_000).toISOString(); // reintenta el paso en el siguiente ciclo
      run.stepIndex = Math.max(0, run.stepIndex - 1);
      await this.repos.runs.put(run);
    }
  }

  /** Solicita cashback al módulo de promociones (si existe). No requiere opt-in, pero sí cumplimiento. */
  private async grantCashback(run: JourneyRun, percentBps: number): Promise<void> {
    const promo = this.services().promotions as { grantCashback?: (r: Record<string, unknown>) => Promise<unknown> } | undefined;
    if (!promo?.grantCashback || !run.context.netLoss) return;
    const comp = await this.messaging.checkCompliance(run.operatorId, run.playerId);
    if (!comp.ok) {
      this.logger.info('[marketing] cashback omitido por cumplimiento', { reason: comp.reason });
      return;
    }
    const amount = applyBps(BigInt(run.context.netLoss), percentBps);
    if (amount <= 0n) return;
    run.context.cashbackAmount = amount.toString();
    await promo.grantCashback({
      operatorId: run.operatorId, playerId: run.playerId, currency: run.context.currency, amount,
      source: 'marketing.big_loss', idempotencyKey: `mkt-cashback:${run.id}`,
    });
  }

  /** Reanuda runs vencidos y evalúa disparadores temporales. */
  async tick(now: Date): Promise<void> {
    await this.scanTimeTriggers(now);
    const due = await this.repos.runs.list({ status: 'running', dueBefore: new Date(now.getTime() + 1).toISOString() });
    for (const run of due) {
      const j = await this.repos.journeys.get(run.journeyId);
      if (!j || j.status !== 'active') continue;
      await this.advance(run, j, now);
    }
  }

  private async scanTimeTriggers(now: Date): Promise<void> {
    const all = await this.repos.journeys.list({ status: 'active' });
    const timed = all.filter((j) => j.trigger.type === 'time');
    if (timed.length === 0) return;
    const states = await this.repos.players.list();
    for (const j of timed) {
      const t = j.trigger;
      if (t.type !== 'time') continue;
      for (const s of states.filter((x) => x.operatorId === j.operatorId)) {
        if (t.condition === 'depositor_inactive') {
          if (s.depositCount > 0 && s.lastDepositAt && now.getTime() - new Date(s.lastDepositAt).getTime() >= t.days * DAY) {
            await this.enroll(j, s.playerId, `inactive:${s.lastDepositAt}`, {}, now);
          }
        } else if (t.condition === 'birthday') {
          const birth = s.birthDate ?? (await this.birthFromCompliance(s));
          if (birth && this.isBirthdayToday(birth, now)) await this.enroll(j, s.playerId, `birthday:${now.getUTCFullYear()}`, {}, now);
        }
      }
    }
  }

  private async birthFromCompliance(s: PlayerState): Promise<string | undefined> {
    if (s.birthChecked) return undefined;
    const c = await this.messaging.checkCompliance(s.operatorId, s.playerId);
    s.birthChecked = true;
    if (c.ok && c.compliance.birthDate) s.birthDate = c.compliance.birthDate;
    await this.repos.players.put(s);
    return s.birthDate;
  }

  private isBirthdayToday(birth: string, now: Date): boolean {
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(birth);
    if (!m) return false;
    let month = Number(m[1]);
    let day = Number(m[2]);
    const y = now.getUTCFullYear();
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (month === 2 && day === 29 && !leap) day = 28;
    return month === now.getUTCMonth() + 1 && day === now.getUTCDate();
  }
}
