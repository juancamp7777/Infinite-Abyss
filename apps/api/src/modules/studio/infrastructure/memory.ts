import {
  OperatorConfigRepository,
  RoundExistsError,
  RoundFilter,
  RoundMode,
  RoundRepository,
  SeedPairRepository,
  StudioOperatorConfig,
  StudioRound,
  StudioSeedPair,
} from '../domain/rounds/types';

/** Copia profunda segura para JSON + bigint/Date (evita compartir referencias con el llamador). */
const copy = <T>(v: T): T => structuredClone(v);

export class InMemoryRoundRepository implements RoundRepository {
  private readonly rounds = new Map<string, StudioRound>();

  async create(round: StudioRound): Promise<void> {
    if (this.rounds.has(round.id)) throw new RoundExistsError(round.id);
    this.rounds.set(round.id, copy(round));
  }

  async get(id: string): Promise<StudioRound | null> {
    const r = this.rounds.get(id);
    return r ? copy(r) : null;
  }

  async update(round: StudioRound, expectedVersion: number): Promise<boolean> {
    const current = this.rounds.get(round.id);
    if (!current || current.version !== expectedVersion) return false;
    this.rounds.set(round.id, copy({ ...round, version: expectedVersion + 1, updatedAt: new Date() }));
    return true;
  }

  async list(f: RoundFilter): Promise<StudioRound[]> {
    return [...this.rounds.values()]
      .filter((r) => r.operatorId === f.operatorId && r.playerId === f.playerId)
      .filter((r) => (!f.gameId || r.gameId === f.gameId) && (!f.mode || r.mode === f.mode))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.nonce - a.nonce)
      .slice(f.offset, f.offset + f.limit)
      .map(copy);
  }

  async findOpen(operatorId: string, playerId: string, gameId: string, mode: RoundMode): Promise<StudioRound | null> {
    for (const r of this.rounds.values()) {
      if (r.operatorId === operatorId && r.playerId === playerId && r.gameId === gameId && r.mode === mode && r.status === 'OPEN') {
        return copy(r);
      }
    }
    return null;
  }

  async countOpen(operatorId: string, playerId: string): Promise<number> {
    let n = 0;
    for (const r of this.rounds.values()) if (r.operatorId === operatorId && r.playerId === playerId && r.status === 'OPEN') n++;
    return n;
  }
}

export class InMemorySeedPairRepository implements SeedPairRepository {
  private readonly pairs = new Map<string, StudioSeedPair>();

  async getActive(operatorId: string, playerId: string): Promise<StudioSeedPair | null> {
    for (const p of this.pairs.values()) if (p.operatorId === operatorId && p.playerId === playerId && p.active) return copy(p);
    return null;
  }

  async create(pair: StudioSeedPair): Promise<StudioSeedPair> {
    const existing = await this.getActive(pair.operatorId, pair.playerId);
    if (existing && pair.active) return existing;
    this.pairs.set(pair.id, copy(pair));
    return copy(pair);
  }

  async consumeNonce(id: string): Promise<number | null> {
    const p = this.pairs.get(id);
    if (!p || !p.active) return null;
    return p.nonce++;
  }

  async setClientSeed(id: string, clientSeed: string): Promise<void> {
    const p = this.pairs.get(id);
    if (p) p.clientSeed = clientSeed;
  }

  async deactivate(id: string, at: Date): Promise<void> {
    const p = this.pairs.get(id);
    if (p) {
      p.active = false;
      p.revealedAt = at;
    }
  }

  async get(id: string): Promise<StudioSeedPair | null> {
    const p = this.pairs.get(id);
    return p ? copy(p) : null;
  }
}

export class InMemoryOperatorConfigRepository implements OperatorConfigRepository {
  private readonly configs = new Map<string, StudioOperatorConfig>();

  async get(operatorId: string, gameId: string): Promise<StudioOperatorConfig | null> {
    const c = this.configs.get(`${operatorId}|${gameId}`);
    return c ? copy(c) : null;
  }

  async list(operatorId: string): Promise<StudioOperatorConfig[]> {
    return [...this.configs.values()].filter((c) => c.operatorId === operatorId).map(copy);
  }

  async upsert(config: StudioOperatorConfig): Promise<StudioOperatorConfig> {
    this.configs.set(`${config.operatorId}|${config.gameId}`, copy(config));
    return copy(config);
  }
}
