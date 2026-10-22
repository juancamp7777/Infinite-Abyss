import { randomUUID } from 'crypto';
import type { BonusPhase, BonusStatus, BonusTemplate, PlayerBonus } from '../../domain/bonus';
import { OPEN_STATUSES } from '../../domain/bonus';
import type {
  BonusListFilter,
  BonusRepository,
  BonusTemplatePatch,
  NewBonusTemplate,
  NewPlayerBonus,
  PlayerNetResult,
  SettledRoundInput,
} from '../../application/ports';

const clone = <T>(v: T): T => structuredClone(v);

/** Repositorio de bonos en memoria (pruebas y desarrollo). Las operaciones son síncronas → atómicas en el event loop. */
export class InMemoryBonusRepository implements BonusRepository {
  private readonly templates = new Map<string, BonusTemplate>();
  private readonly bonuses = new Map<string, PlayerBonus>();
  private readonly bySource = new Map<string, string>();
  private readonly rounds = new Set<string>();
  private readonly redemptions: Array<{ templateId: string; playerId: string }> = [];
  private readonly settled = new Map<string, SettledRoundInput>();

  async createTemplate(t: NewBonusTemplate): Promise<BonusTemplate> {
    if (t.code && [...this.templates.values()].some((x) => x.operatorId === t.operatorId && x.code === t.code)) {
      throw Object.assign(new Error('Código duplicado'), { code: 'P2002' });
    }
    const now = new Date();
    const tpl: BonusTemplate = { ...clone(t), id: randomUUID(), usesCount: 0, createdAt: now, updatedAt: now };
    this.templates.set(tpl.id, tpl);
    return clone(tpl);
  }

  async updateTemplate(id: string, patch: BonusTemplatePatch): Promise<BonusTemplate | null> {
    const t = this.templates.get(id);
    if (!t) return null;
    if (patch.code && [...this.templates.values()].some((x) => x.id !== id && x.operatorId === t.operatorId && x.code === patch.code)) {
      throw Object.assign(new Error('Código duplicado'), { code: 'P2002' });
    }
    Object.assign(t, clone(patch), { updatedAt: new Date() });
    return clone(t);
  }

  async deleteTemplate(id: string): Promise<boolean> {
    return this.templates.delete(id);
  }

  async getTemplate(id: string): Promise<BonusTemplate | null> {
    const t = this.templates.get(id);
    return t ? clone(t) : null;
  }

  async listTemplates(operatorId?: string): Promise<BonusTemplate[]> {
    return [...this.templates.values()]
      .filter((t) => !operatorId || t.operatorId === operatorId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(clone);
  }

  async findTemplateByCode(operatorId: string, code: string): Promise<BonusTemplate | null> {
    const t = [...this.templates.values()].find((x) => x.operatorId === operatorId && x.code === code);
    return t ? clone(t) : null;
  }

  async listAutoDepositTemplates(operatorId: string, currency: string): Promise<BonusTemplate[]> {
    return [...this.templates.values()]
      .filter((t) => t.operatorId === operatorId && t.currency === currency && t.status === 'ACTIVE' && t.type === 'deposit_match' && t.autoOnDeposit)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(clone);
  }

  async countBonusesByTemplate(templateId: string): Promise<number> {
    return [...this.bonuses.values()].filter((b) => b.templateId === templateId).length;
  }

  async reserveCodeUse(templateId: string, playerId: string): Promise<'OK' | 'TOTAL_LIMIT' | 'PLAYER_LIMIT'> {
    const t = this.templates.get(templateId);
    if (!t) return 'TOTAL_LIMIT';
    if (t.maxUsesTotal != null && t.usesCount >= t.maxUsesTotal) return 'TOTAL_LIMIT';
    const mine = this.redemptions.filter((r) => r.templateId === templateId && r.playerId === playerId).length;
    if (t.maxUsesPerPlayer != null && mine >= t.maxUsesPerPlayer) return 'PLAYER_LIMIT';
    t.usesCount += 1;
    this.redemptions.push({ templateId, playerId });
    return 'OK';
  }

  async releaseCodeUse(templateId: string, playerId: string): Promise<void> {
    const t = this.templates.get(templateId);
    const idx = this.redemptions.findIndex((r) => r.templateId === templateId && r.playerId === playerId);
    if (idx >= 0) {
      this.redemptions.splice(idx, 1);
      if (t && t.usesCount > 0) t.usesCount -= 1;
    }
  }

  async createBonus(b: NewPlayerBonus): Promise<{ bonus: PlayerBonus; created: boolean }> {
    if (b.sourceRef) {
      const existing = this.bySource.get(`${b.operatorId}\u0000${b.sourceRef}`);
      if (existing) return { bonus: clone(this.bonuses.get(existing)!), created: false };
    }
    const bonus: PlayerBonus = { ...clone(b), id: b.id ?? randomUUID(), createdAt: new Date() };
    this.bonuses.set(bonus.id, bonus);
    if (bonus.sourceRef) this.bySource.set(`${bonus.operatorId}\u0000${bonus.sourceRef}`, bonus.id);
    return { bonus: clone(bonus), created: true };
  }

  async getBonus(id: string): Promise<PlayerBonus | null> {
    const b = this.bonuses.get(id);
    return b ? clone(b) : null;
  }

  async findBySourceRef(operatorId: string, sourceRef: string): Promise<PlayerBonus | null> {
    const id = this.bySource.get(`${operatorId}\u0000${sourceRef}`);
    return id ? clone(this.bonuses.get(id)!) : null;
  }

  async listBonuses(f: BonusListFilter): Promise<PlayerBonus[]> {
    const all = [...this.bonuses.values()]
      .filter((b) => (!f.operatorId || b.operatorId === f.operatorId) && (!f.playerId || b.playerId === f.playerId) && (!f.status || f.status.includes(b.status)))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const offset = f.offset ?? 0;
    return all.slice(offset, offset + (f.limit ?? 50)).map(clone);
  }

  async findOpenBonuses(operatorId: string, playerId: string): Promise<PlayerBonus[]> {
    return [...this.bonuses.values()]
      .filter((b) => b.operatorId === operatorId && b.playerId === playerId && OPEN_STATUSES.includes(b.status))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(clone);
  }

  async listExpired(now: Date, limit: number): Promise<PlayerBonus[]> {
    return [...this.bonuses.values()]
      .filter((b) => OPEN_STATUSES.includes(b.status) && b.expiresAt && b.expiresAt <= now)
      .slice(0, limit)
      .map(clone);
  }

  async listUnsettled(limit: number): Promise<PlayerBonus[]> {
    return [...this.bonuses.values()]
      .filter(
        (b) =>
          (b.status === 'ACTIVE' && b.phase === 'WAGERING' && b.amount > 0n && !b.grantTxId) ||
          (['COMPLETED', 'FORFEITED', 'CANCELLED'].includes(b.status) && b.settlementAmount > 0n && !b.settlementTxId),
      )
      .slice(0, limit)
      .map(clone);
  }

  async updateIf(id: string, expect: { status?: BonusStatus[]; phase?: BonusPhase }, patch: Partial<PlayerBonus>): Promise<PlayerBonus | null> {
    const b = this.bonuses.get(id);
    if (!b) return null;
    if (expect.status && !expect.status.includes(b.status)) return null;
    if (expect.phase && b.phase !== expect.phase) return null;
    const { id: _ignored, ...rest } = clone(patch);
    if (rest.sourceRef && rest.sourceRef !== b.sourceRef) {
      if (this.bySource.has(`${b.operatorId}\u0000${rest.sourceRef}`)) throw Object.assign(new Error('sourceRef duplicado'), { code: 'P2002' });
      if (b.sourceRef) this.bySource.delete(`${b.operatorId}\u0000${b.sourceRef}`);
      this.bySource.set(`${b.operatorId}\u0000${rest.sourceRef}`, b.id);
    }
    Object.assign(b, rest);
    return clone(b);
  }

  async addWagering(bonusId: string, roundId: string, contribution: bigint): Promise<PlayerBonus | null> {
    const b = this.bonuses.get(bonusId);
    if (!b || b.status !== 'ACTIVE' || b.phase !== 'WAGERING') return null;
    const k = `${bonusId}\u0000w:${roundId}`;
    if (this.rounds.has(k)) return null;
    this.rounds.add(k);
    b.wageringProgress += contribution;
    return clone(b);
  }

  async consumeFreeSpin(bonusId: string, roundId: string): Promise<PlayerBonus | null> {
    const b = this.bonuses.get(bonusId);
    if (!b || b.status !== 'ACTIVE' || b.phase !== 'SPINS' || b.freeSpinsUsed >= b.freeSpinsTotal) return null;
    const k = `${bonusId}\u0000fs:${roundId}`;
    if (this.rounds.has(k)) return null;
    this.rounds.add(k);
    b.freeSpinsUsed += 1;
    return clone(b);
  }

  async addFreeSpinWin(bonusId: string, roundId: string, win: bigint): Promise<PlayerBonus | null> {
    const b = this.bonuses.get(bonusId);
    if (!b || b.status !== 'ACTIVE' || b.phase !== 'SPINS') return null;
    if (!this.rounds.has(`${bonusId}\u0000fs:${roundId}`)) return null;
    const k = `${bonusId}\u0000fsw:${roundId}`;
    if (this.rounds.has(k)) return null;
    this.rounds.add(k);
    b.freeSpinWin += win;
    b.freeSpinsSettled += 1;
    return clone(b);
  }

  async recordSettledRound(r: SettledRoundInput): Promise<boolean> {
    const k = `${r.operatorId}\u0000${r.roundId}`;
    if (this.settled.has(k)) return false;
    this.settled.set(k, clone(r));
    return true;
  }

  async netResults(operatorId: string, currency: string, from: Date, to: Date): Promise<PlayerNetResult[]> {
    const acc = new Map<string, PlayerNetResult>();
    for (const r of this.settled.values()) {
      if (r.operatorId !== operatorId || r.currency !== currency || r.at < from || r.at >= to) continue;
      const cur = acc.get(r.playerId) ?? { playerId: r.playerId, wagered: 0n, won: 0n };
      cur.wagered += r.amount;
      cur.won += r.win;
      acc.set(r.playerId, cur);
    }
    return [...acc.values()].sort((a, b) => a.playerId.localeCompare(b.playerId));
  }
}
