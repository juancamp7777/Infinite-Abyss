/**
 * DSL de segmentos (lo evalúa el CRM; marketing/promociones lo consumen vía SegmentPort).
 * Ejemplo: { all: [ { field: 'country', op: 'eq', value: 'CO' },
 *                   { any: [ { field: 'depositCount', op: 'gte', value: 3 }, { field: 'vipLevel', op: 'in', value: ['GOLD','PLATINUM'] } ] } ] }
 * `within_days` / `older_than_days`: el campo es una fecha ISO y value un número de días.
 */
export type ConditionOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'nin'
  | 'contains'
  | 'exists'
  | 'within_days'
  | 'older_than_days';

export const CONDITION_OPS: readonly ConditionOp[] = [
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'contains', 'exists', 'within_days', 'older_than_days',
];

export interface Condition {
  field: string;
  op: ConditionOp;
  value?: unknown;
}

export interface Group {
  all?: Rule[];
  any?: Rule[];
}

export type Rule = Condition | Group;

export const isCondition = (r: Rule): r is Condition => typeof (r as Condition).field === 'string';

export interface SegmentPort {
  listPlayers(operatorId: string, segmentId: string): Promise<string[]>;
  isMember(operatorId: string, segmentId: string, playerId: string): Promise<boolean>;
}

/** Stub en memoria: miembros fijados a mano (pruebas de módulos que consumen segmentos). */
export class InMemorySegmentPort implements SegmentPort {
  private readonly members = new Map<string, Set<string>>();

  setMembers(operatorId: string, segmentId: string, playerIds: string[]): void {
    this.members.set(`${operatorId}\u0000${segmentId}`, new Set(playerIds));
  }

  async listPlayers(operatorId: string, segmentId: string): Promise<string[]> {
    return [...(this.members.get(`${operatorId}\u0000${segmentId}`) ?? [])];
  }

  async isMember(operatorId: string, segmentId: string, playerId: string): Promise<boolean> {
    return this.members.get(`${operatorId}\u0000${segmentId}`)?.has(playerId) ?? false;
  }
}
