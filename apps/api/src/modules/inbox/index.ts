import type { NymfoModule } from '../shared/module';
import { randomBytes } from 'crypto';
import { ChannelService } from './application/ChannelService';
import { InboxService } from './application/InboxService';
import { LeadService } from './application/LeadService';
import type { PlayerAccountsPort } from '../shared/ports/PlayerAccountsPort';
import { SecretBox } from './domain/secretBox';
import type { InboxRepository } from './domain/types';
import { buildInboxRouter } from './http/routes';
import { InMemoryInboxRepository } from './infrastructure/InMemoryInboxRepository';
import { PrismaInboxRepository, type InboxPrismaLike } from './infrastructure/PrismaInboxRepository';
import type { ChannelAdapter } from './infrastructure/channels/ChannelAdapter';
import { TelegramAdapter } from './infrastructure/channels/TelegramAdapter';
import { WhatsAppAdapter } from './infrastructure/channels/WhatsAppAdapter';
import { attachInboxSockets } from './infrastructure/socket';

export const INBOX_PREFIX = '/inbox/v1';

export interface InboxModuleOptions {
  repo?: InboxRepository;
  contactRatePerMinute?: number;
  sessionsPerMinute?: number;
  /** Adaptadores de canal (las pruebas inyectan transportes falsos). */
  adapters?: ChannelAdapter<any>[];
}

/**
 * Inbox omnicanal del CRM: conversaciones de webchat (y pronto WhatsApp/Telegram) atendidas por los agentes
 * del operador, con notas internas, asignación, estados y respuestas rápidas.
 * Canales externos: WhatsApp Cloud API y bots de Telegram, con credenciales cifradas (INBOX_SECRETS_KEY) y webhooks
 * en INBOX_PUBLIC_URL/inbox/v1/channels/<id>/webhook.
 * HTTP en /inbox/v1; socket.io en /inbox (agentes) y /webchat (contactos). Servicio publicado: 'inbox.service'.
 */
export function createInboxModule(opts: InboxModuleOptions = {}): NymfoModule {
  return {
    name: 'inbox',
    async register(app, io, deps) {
      const repo = opts.repo ?? (deps.prisma ? new PrismaInboxRepository(deps.prisma as InboxPrismaLike) : new InMemoryInboxRepository());
      const svc = new InboxService(repo, { contactRatePerMinute: opts.contactRatePerMinute });
      if (io) svc.setNotifier(attachInboxSockets(io, deps.auth, svc));
      let key = deps.env.INBOX_SECRETS_KEY;
      if (!key) {
        key = randomBytes(32).toString('hex');
        deps.logger.warn('[inbox] INBOX_SECRETS_KEY no definido: se usa una clave efímera (las credenciales de canales no sobreviven a un reinicio)');
      }
      const channels = new ChannelService(repo, svc, new SecretBox(key), opts.adapters ?? [new WhatsAppAdapter(), new TelegramAdapter()], {
        // HUB_PUBLIC_API_URL solo sirve si es absoluta (en producción suele ser /api-proxy).
        publicBaseUrl: deps.env.INBOX_PUBLIC_URL || (/^https?:\/\//i.test(deps.env.HUB_PUBLIC_API_URL ?? '') ? deps.env.HUB_PUBLIC_API_URL : undefined),
        logger: deps.logger,
      });
      const accounts = deps.services['players.accounts'] as PlayerAccountsPort | undefined;
      const leads = accounts ? new LeadService(svc, accounts, { webUrl: deps.env.PUBLIC_WEB_URL }) : undefined;
      app.use(INBOX_PREFIX, buildInboxRouter({ auth: deps.auth, svc, channels, leads, operators: deps.operators, logger: deps.logger, sessionsPerMinute: opts.sessionsPerMinute }));
      return { 'inbox.service': svc, 'inbox.channels': channels, ...(leads ? { 'inbox.leads': leads } : {}) };
    },
  };
}

export const inboxModule = createInboxModule();

export { InboxService } from './application/InboxService';
