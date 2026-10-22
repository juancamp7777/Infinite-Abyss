/**
 * Almacén documental del módulo. Implementaciones: InMemory (pruebas) y Prisma (tabla gami_records).
 * Los documentos pueden contener bigint (se codifican como {"$b":"123"} en JSON).
 */

export interface ListOptions {
  playerId?: string;
  idPrefix?: string;
}

export interface DocStore {
  get<T>(col: string, op: string, id: string): Promise<T | undefined>;
  put<T>(col: string, op: string, id: string, doc: T, playerId?: string): Promise<void>;
  /** Crea solo si no existe. Devuelve true si creó (base de la deduplicación). */
  putIfAbsent<T>(col: string, op: string, id: string, doc: T, playerId?: string): Promise<boolean>;
  delete(col: string, op: string, id: string): Promise<void>;
  /** op undefined = todos los operadores. */
  list<T>(col: string, op?: string, opts?: ListOptions): Promise<T[]>;
}

export function encodeDoc(doc: unknown): unknown {
  return JSON.parse(JSON.stringify(doc, (_k, v) => (typeof v === 'bigint' ? { $b: v.toString() } : v)));
}

export function decodeDoc<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map((v) => decodeDoc(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === '$b' && typeof o.$b === 'string') return BigInt(o.$b) as unknown as T;
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = decodeDoc(o[k]);
    return out as T;
  }
  return value as T;
}

interface Row {
  playerId?: string;
  data: unknown;
}

export class InMemoryDocStore implements DocStore {
  private readonly rows = new Map<string, Row>();
  private static key(col: string, op: string, id: string): string {
    return `${col}\u0000${op}\u0000${id}`;
  }

  async get<T>(col: string, op: string, id: string): Promise<T | undefined> {
    const r = this.rows.get(InMemoryDocStore.key(col, op, id));
    return r ? (structuredClone(r.data) as T) : undefined;
  }

  async put<T>(col: string, op: string, id: string, doc: T, playerId?: string): Promise<void> {
    this.rows.set(InMemoryDocStore.key(col, op, id), { playerId, data: structuredClone(doc) });
  }

  async putIfAbsent<T>(col: string, op: string, id: string, doc: T, playerId?: string): Promise<boolean> {
    const k = InMemoryDocStore.key(col, op, id);
    if (this.rows.has(k)) return false;
    this.rows.set(k, { playerId, data: structuredClone(doc) });
    return true;
  }

  async delete(col: string, op: string, id: string): Promise<void> {
    this.rows.delete(InMemoryDocStore.key(col, op, id));
  }

  async list<T>(col: string, op?: string, opts: ListOptions = {}): Promise<T[]> {
    const out: T[] = [];
    for (const [k, r] of this.rows) {
      const [c, o, id] = k.split('\u0000');
      if (c !== col) continue;
      if (op !== undefined && o !== op) continue;
      if (opts.playerId !== undefined && r.playerId !== opts.playerId) continue;
      if (opts.idPrefix !== undefined && !id.startsWith(opts.idPrefix)) continue;
      out.push(structuredClone(r.data) as T);
    }
    return out;
  }
}

/** Subconjunto del PrismaClient que usamos (el modelo GamiRecord proviene de prisma/modules/gamification.prisma). */
interface GamiRecordDelegate {
  findUnique(args: unknown): Promise<{ data: unknown } | null>;
  upsert(args: unknown): Promise<unknown>;
  create(args: unknown): Promise<unknown>;
  delete(args: unknown): Promise<unknown>;
  deleteMany(args: unknown): Promise<unknown>;
  findMany(args: unknown): Promise<Array<{ data: unknown }>>;
}

export class PrismaDocStore implements DocStore {
  private readonly rec: GamiRecordDelegate;

  constructor(prisma: unknown) {
    const delegate = (prisma as { gamiRecord?: GamiRecordDelegate }).gamiRecord;
    if (!delegate) throw new Error('PrismaClient sin el modelo GamiRecord (ejecuta npx prisma generate)');
    this.rec = delegate;
  }

  async get<T>(col: string, op: string, id: string): Promise<T | undefined> {
    const r = await this.rec.findUnique({ where: { collection_operatorId_id: { collection: col, operatorId: op, id } } });
    return r ? decodeDoc<T>(r.data) : undefined;
  }

  async put<T>(col: string, op: string, id: string, doc: T, playerId?: string): Promise<void> {
    const data = encodeDoc(doc);
    await this.rec.upsert({
      where: { collection_operatorId_id: { collection: col, operatorId: op, id } },
      create: { collection: col, operatorId: op, id, playerId: playerId ?? null, data },
      update: { data, ...(playerId !== undefined ? { playerId } : {}) },
    });
  }

  async putIfAbsent<T>(col: string, op: string, id: string, doc: T, playerId?: string): Promise<boolean> {
    try {
      await this.rec.create({ data: { collection: col, operatorId: op, id, playerId: playerId ?? null, data: encodeDoc(doc) } });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return false;
      throw e;
    }
  }

  async delete(col: string, op: string, id: string): Promise<void> {
    await this.rec.deleteMany({ where: { collection: col, operatorId: op, id } });
  }

  async list<T>(col: string, op?: string, opts: ListOptions = {}): Promise<T[]> {
    const rows = await this.rec.findMany({
      where: {
        collection: col,
        ...(op !== undefined ? { operatorId: op } : {}),
        ...(opts.playerId !== undefined ? { playerId: opts.playerId } : {}),
        ...(opts.idPrefix !== undefined ? { id: { startsWith: opts.idPrefix } } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => decodeDoc<T>(r.data));
  }
}
