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

/**
 * Repositorios Prisma. Se tipan con una forma mínima del cliente para no acoplar el dominio al cliente generado;
 * los modelos Studio* viven en la sección «Módulos» de prisma/schema.prisma.
 */
type Delegate = {
  create(args: unknown): Promise<any>;
  findUnique(args: unknown): Promise<any>;
  findFirst(args: unknown): Promise<any>;
  findMany(args: unknown): Promise<any[]>;
  update(args: unknown): Promise<any>;
  updateMany(args: unknown): Promise<{ count: number }>;
  upsert(args: unknown): Promise<any>;
  count(args: unknown): Promise<number>;
};

export interface StudioPrismaClient {
  studioRound: Delegate;
  studioSeedPair: Delegate;
  studioOperatorConfig: Delegate;
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === 'P2002';

function toRound(r: any): StudioRound {
  return {
    ...r,
    outcome: r.outcome ?? null,
    state: r.state ?? null,
    params: (r.params ?? {}) as Record<string, unknown>,
  };
}

function roundData(r: StudioRound) {
  const { createdAt: _c, updatedAt: _u, ...rest } = r;
  return { ...rest, outcome: r.outcome ?? undefined, state: r.state ?? undefined };
}

export class PrismaRoundRepository implements RoundRepository {
  constructor(private readonly db: StudioPrismaClient) {}

  async create(round: StudioRound): Promise<void> {
    try {
      await this.db.studioRound.create({ data: { ...roundData(round), createdAt: round.createdAt } });
    } catch (e) {
      if (isUniqueViolation(e)) throw new RoundExistsError(round.id);
      throw e;
    }
  }

  async get(id: string): Promise<StudioRound | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const r = await this.db.studioRound.findUnique({ where: { id } });
    return r ? toRound(r) : null;
  }

  async update(round: StudioRound, expectedVersion: number): Promise<boolean> {
    const { id, ...data } = roundData(round);
    const res = await this.db.studioRound.updateMany({
      where: { id, version: expectedVersion },
      data: { ...data, version: expectedVersion + 1 },
    });
    return res.count === 1;
  }

  async list(f: RoundFilter): Promise<StudioRound[]> {
    const rows = await this.db.studioRound.findMany({
      where: { operatorId: f.operatorId, playerId: f.playerId, ...(f.gameId ? { gameId: f.gameId } : {}), ...(f.mode ? { mode: f.mode } : {}) },
      orderBy: [{ createdAt: 'desc' }, { nonce: 'desc' }],
      take: f.limit,
      skip: f.offset,
    });
    return rows.map(toRound);
  }

  async findOpen(operatorId: string, playerId: string, gameId: string, mode: RoundMode): Promise<StudioRound | null> {
    const r = await this.db.studioRound.findFirst({ where: { operatorId, playerId, gameId, mode, status: 'OPEN' }, orderBy: { createdAt: 'desc' } });
    return r ? toRound(r) : null;
  }

  async countOpen(operatorId: string, playerId: string): Promise<number> {
    return this.db.studioRound.count({ where: { operatorId, playerId, status: 'OPEN' } });
  }
}

export class PrismaSeedPairRepository implements SeedPairRepository {
  constructor(private readonly db: StudioPrismaClient) {}

  async getActive(operatorId: string, playerId: string): Promise<StudioSeedPair | null> {
    return this.db.studioSeedPair.findFirst({ where: { operatorId, playerId, active: true }, orderBy: { createdAt: 'desc' } });
  }

  async create(pair: StudioSeedPair): Promise<StudioSeedPair> {
    return this.db.studioSeedPair.create({ data: pair });
  }

  async consumeNonce(id: string): Promise<number | null> {
    // Incremento atómico condicionado a que el par siga activo.
    const res = await this.db.studioSeedPair.updateMany({ where: { id, active: true }, data: { nonce: { increment: 1 } } });
    if (res.count !== 1) return null;
    const p = await this.db.studioSeedPair.findUnique({ where: { id } });
    return (p.nonce as number) - 1;
  }

  async setClientSeed(id: string, clientSeed: string): Promise<void> {
    await this.db.studioSeedPair.update({ where: { id }, data: { clientSeed } });
  }

  async deactivate(id: string, at: Date): Promise<void> {
    await this.db.studioSeedPair.update({ where: { id }, data: { active: false, revealedAt: at } });
  }

  async get(id: string): Promise<StudioSeedPair | null> {
    return this.db.studioSeedPair.findUnique({ where: { id } });
  }
}

export class PrismaOperatorConfigRepository implements OperatorConfigRepository {
  constructor(private readonly db: StudioPrismaClient) {}

  async get(operatorId: string, gameId: string): Promise<StudioOperatorConfig | null> {
    return this.db.studioOperatorConfig.findUnique({ where: { operatorId_gameId: { operatorId, gameId } } });
  }

  async list(operatorId: string): Promise<StudioOperatorConfig[]> {
    return this.db.studioOperatorConfig.findMany({ where: { operatorId } });
  }

  async upsert(c: StudioOperatorConfig): Promise<StudioOperatorConfig> {
    const { updatedAt: _u, ...data } = c;
    return this.db.studioOperatorConfig.upsert({
      where: { operatorId_gameId: { operatorId: c.operatorId, gameId: c.gameId } },
      create: data,
      update: data,
    });
  }
}
