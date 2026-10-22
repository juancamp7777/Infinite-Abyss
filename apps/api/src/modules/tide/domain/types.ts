import type { FlowGraph } from './graph';

export interface TideFlow {
  id: string;
  operatorId: string;
  name: string;
  /** Solo los flujos activos y publicados atienden conversaciones. */
  enabled: boolean;
  draft: FlowGraph;
  publishedVersion?: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Versión publicada e inmutable: las sesiones en curso siguen la versión con la que empezaron. */
export interface TideVersion {
  flowId: string;
  version: number;
  graph: FlowGraph;
  publishedBy: string;
  createdAt: Date;
}

/** waiting = esperando respuesta en un nodo Pregunta; handoff = atendido por humanos; done = terminó. */
export type SessionStatus = 'waiting' | 'handoff' | 'done';

/** Posición de una conversación dentro de un flujo (una por conversación). */
export interface TideSession {
  conversationId: string;
  operatorId: string;
  flowId: string;
  version: number;
  nodeId: string;
  status: SessionStatus;
  vars: Record<string, string>;
  expiresAt?: Date;
  /** Últimos nodos recorridos (depuración en el editor). */
  trace: string[];
  updatedAt: Date;
}

export interface TideRepository {
  listFlows(operatorId: string): Promise<TideFlow[]>;
  findFlow(operatorId: string, id: string): Promise<TideFlow | null>;
  saveFlow(f: TideFlow): Promise<TideFlow>;
  deleteFlow(operatorId: string, id: string): Promise<boolean>;
  saveVersion(v: TideVersion): Promise<TideVersion>;
  findVersion(flowId: string, version: number): Promise<TideVersion | null>;
  findSession(conversationId: string): Promise<TideSession | null>;
  saveSession(s: TideSession): Promise<TideSession>;
  deleteSession(conversationId: string): Promise<void>;
  /** Sesiones esperando cuya espera venció (para el puerto "timeout"). */
  dueSessions(now: Date, limit: number): Promise<TideSession[]>;
}
