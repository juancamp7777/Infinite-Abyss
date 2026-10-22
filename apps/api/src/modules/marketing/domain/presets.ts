import type { Journey, JourneyStep, JourneyTrigger, Template } from './types';

export const JOURNEY_PRESETS = ['signup_no_deposit_24h', 'depositor_inactive_7d', 'birthday', 'big_loss_cashback'] as const;
export type JourneyPresetName = (typeof JOURNEY_PRESETS)[number];

export interface PresetParams {
  /** Umbral de pérdida neta (unidades mínimas, string) para big_loss_cashback. */
  lossThreshold?: string;
  windowHours?: number;
  cashbackBps?: number;
  inactiveDays?: number;
}

type Draft = Pick<Journey, 'name' | 'trigger'> & { buildSteps: (templateId: string) => JourneyStep[]; template: Pick<Template, 'name' | 'subject' | 'body'> };

const wrap = (inner: string): string =>
  `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><img src="{{operator.logoUrl}}" alt="{{operator.name}}" height="40"><div style="border-top:4px solid {{operator.primaryColor}};padding:16px">${inner}</div></div>`;

/** Plantillas de journey listas para usar (el texto es un borrador editable por el operador). */
export function presetDraft(name: JourneyPresetName, p: PresetParams = {}): Draft {
  switch (name) {
    case 'signup_no_deposit_24h':
      return {
        name: 'Registro sin depósito (24 h)',
        trigger: { type: 'event', event: 'player.registered', cancelOn: ['deposit.completed'] },
        buildSteps: (t) => [{ type: 'wait', minutes: 24 * 60 }, { type: 'condition', check: 'no_deposit' }, { type: 'send', templateId: t }],
        template: {
          name: 'Registro sin depósito', subject: '{{firstName|Hola}}, tu cuenta en {{operator.name}} te espera',
          body: wrap('<p>¡Hola {{firstName|jugador}}!</p><p>Tu cuenta en {{operator.name}} está lista. Haz tu primer depósito cuando quieras. Juega con responsabilidad.</p><p style="font-size:12px"><a href="{{unsubscribeUrl}}">Darme de baja</a></p>'),
        },
      };
    case 'depositor_inactive_7d': {
      const days = p.inactiveDays ?? 7;
      return {
        name: `Depositante inactivo (${days} días)`,
        trigger: { type: 'time', condition: 'depositor_inactive', days, cancelOn: ['deposit.completed'] },
        buildSteps: (t) => [{ type: 'condition', check: 'inactive_since_deposit_days', value: days }, { type: 'send', templateId: t }],
        template: {
          name: 'Depositante inactivo', subject: 'Te echamos de menos en {{operator.name}}',
          body: wrap('<p>{{firstName|Hola}}, hace unos días que no te vemos por {{operator.name}}.</p><p>Recuerda que puedes fijar tus límites de juego en cualquier momento.</p><p style="font-size:12px"><a href="{{unsubscribeUrl}}">Darme de baja</a></p>'),
        },
      };
    }
    case 'birthday':
      return {
        name: 'Cumpleaños',
        trigger: { type: 'time', condition: 'birthday' },
        buildSteps: (t) => [{ type: 'send', templateId: t }],
        template: {
          name: 'Cumpleaños', subject: '¡Feliz cumpleaños, {{firstName|jugador}}!',
          body: wrap('<p>¡Feliz cumpleaños de parte de todo el equipo de {{operator.name}}!</p><p style="font-size:12px"><a href="{{unsubscribeUrl}}">Darme de baja</a></p>'),
        },
      };
    case 'big_loss_cashback': {
      const trigger: JourneyTrigger = { type: 'event', event: 'bet.settled', lossThreshold: p.lossThreshold ?? '1000000', windowHours: p.windowHours ?? 24 };
      return {
        name: 'Gran pérdida → cashback',
        trigger,
        buildSteps: (t) => [{ type: 'action', action: 'grantCashback', percentBps: p.cashbackBps ?? 1000 }, { type: 'send', templateId: t }],
        template: {
          name: 'Cashback por pérdida', subject: 'Un detalle de {{operator.name}} para ti',
          body: wrap('<p>{{firstName|Hola}}, tienes un cashback de {{cashbackAmount|0}} ({{currency}}) por tu actividad reciente. Juega con responsabilidad.</p><p style="font-size:12px"><a href="{{unsubscribeUrl}}">Darme de baja</a></p>'),
        },
      };
    }
  }
}
