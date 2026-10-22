export interface AuditEvent {
  operatorId?: string | null;
  actorType: 'BACKOFFICE_USER' | 'PLAYER' | 'SYSTEM';
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

export interface IAuditLogger {
  log(event: AuditEvent): Promise<void>;
}
