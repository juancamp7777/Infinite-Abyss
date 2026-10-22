import type { NymfoModule } from '../shared/module';
import { InboxService } from './application/InboxService';
import type { InboxRepository } from './domain/types';
import { buildInboxRouter } from './http/routes';
import { InMemoryInboxRepository } from './infrastructure/InMemoryInboxRepository';
import { PrismaInboxRepository, type InboxPrismaLike } from './infrastructure/PrismaInboxRepository';
import { attachInboxSockets } from './infrastructure/socket';

export const INBOX_PREFIX = '/inbox/v1';

export interface InboxModuleOptions {
  repo?: InboxRepository;
  contactRatePerMinute?: number;
  sessionsPerMinute?: number;
}

/**
 * Inbox omnicanal del CRM: conversaciones de webchat (y pronto WhatsApp/Telegram) atendidas por los agentes
 * del operador, con notas internas, asignación, estados y respuestas rápidas.
 * HTTP en /inbox/v1; socket.io en /inbox (agentes) y /webchat (contactos). Servicio publicado: 'inbox.service'.
 */
export function createInboxModule(opts: InboxModuleOptions = {}): NymfoModule {
  return {
    name: 'inbox',
    async register(app, io, deps) {
      const repo = opts.repo ?? (deps.prisma ? new PrismaInboxRepository(deps.prisma as InboxPrismaLike) : new InMemoryInboxRepository());
      const svc = new InboxService(repo, { contactRatePerMinute: opts.contactRatePerMinute });
      if (io) svc.setNotifier(attachInboxSockets(io, deps.auth, svc));
      app.use(INBOX_PREFIX, buildInboxRouter({ auth: deps.auth, svc, operators: deps.operators, logger: deps.logger, sessionsPerMinute: opts.sessionsPerMinute }));
      return { 'inbox.service': svc };
    },
  };
}

export const inboxModule = createInboxModule();

export { InboxService } from './application/InboxService';
