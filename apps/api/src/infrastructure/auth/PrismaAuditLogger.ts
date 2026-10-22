import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuditEvent, IAuditLogger } from '../../domain/contracts';
import { toJsonSafe } from '../http/serialize';

/** Implementación de IAuditLogger sobre la tabla AuditLog (bigint → string). */
export class PrismaAuditLogger implements IAuditLogger {
  constructor(private readonly prisma: PrismaClient) {}

  async log(event: AuditEvent): Promise<void> {
    const json = (v: unknown) => (v === undefined || v === null ? undefined : (toJsonSafe(v) as Prisma.InputJsonValue));
    await this.prisma.auditLog.create({
      data: {
        operatorId: event.operatorId ?? null,
        actorType: event.actorType,
        actorId: event.actorId ?? null,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        reason: event.reason ?? null,
        before: json(event.before),
        after: json(event.after),
        ip: event.ip ?? null,
      },
    });
  }
}
