import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { AuthPort } from '../../shared/ports/AuthPort';
import type { InboxNotifier, InboxService } from '../application/InboxService';
import { publicMessage, resolveContact } from '../http/routes';

const AGENT_ROLES = new Set(['PLATFORM_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_AGENT']);
const agentsRoom = (operatorId: string) => `op:${operatorId}`;
const contactRoom = (operatorId: string, externalId: string) => `contact:${operatorId}:${externalId}`;

/**
 * Namespaces:
 * - /inbox (agentes): `auth: { token }` de backoffice (PLATFORM_ADMIN indica `query.operatorId`).
 *   Eventos `inbox:conversation` y `inbox:message` (incluye notas internas).
 * - /webchat (contacto): `auth: { token }` de jugador o `auth: { visitorToken }`.
 *   Evento `webchat:message` solo con respuestas y mensajes propios (nunca notas).
 */
export function attachInboxSockets(io: SocketIOServer, auth: AuthPort, svc: InboxService): InboxNotifier {
  const agents = io.of('/inbox');
  const contacts = io.of('/webchat');

  agents.on('connection', async (socket: Socket) => {
    try {
      const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
      const p = typeof token === 'string' && token ? await auth.verify(token) : null;
      if (!p || !AGENT_ROLES.has(p.role)) throw new Error('forbidden');
      const asked = socket.handshake.query?.operatorId;
      const op = p.role === 'PLATFORM_ADMIN' ? (typeof asked === 'string' && asked) || p.operatorId : p.operatorId;
      if (!op || op.length > 100) throw new Error('operator');
      await socket.join(agentsRoom(op));
      socket.emit('inbox:ready', { operatorId: op });
    } catch {
      socket.emit('inbox:error', { code: 'UNAUTHORIZED' });
      socket.disconnect(true);
    }
  });

  contacts.on('connection', async (socket: Socket) => {
    try {
      const a = (socket.handshake.auth ?? {}) as { token?: unknown; visitorToken?: unknown };
      const p = typeof a.token === 'string' && a.token ? await auth.verify(a.token) : null;
      const c = await resolveContact(svc, p, a.visitorToken);
      if (!c) throw new Error('unauthorized');
      await socket.join(contactRoom(c.operatorId, c.externalId));
      socket.emit('webchat:ready', {});
    } catch {
      socket.emit('webchat:error', { code: 'UNAUTHORIZED' });
      socket.disconnect(true);
    }
  });

  return {
    toAgents(operatorId, event, payload) {
      agents.to(agentsRoom(operatorId)).emit(event, payload);
    },
    toContact(conversation, message) {
      if (message.direction === 'note') return;
      contacts.to(contactRoom(conversation.operatorId, conversation.externalId)).emit('webchat:message', publicMessage(message));
    },
  };
}
