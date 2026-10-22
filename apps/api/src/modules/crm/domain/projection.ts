import type { DomainEvents } from '../../shared/events/EventBus';
import type { CrmProfile } from './types';
import { toDay } from './rfm';

export function newProfile(operatorId: string, playerId: string, nowIso: string): CrmProfile {
  return {
    operatorId,
    playerId,
    depositsTotal: 0n,
    depositsCount: 0,
    withdrawalsTotal: 0n,
    withdrawalsCount: 0,
    totalWagered: 0n,
    totalWon: 0n,
    betCount: 0,
    sessionCount: 0,
    loginCount: 0,
    activeDays: [],
    games: {},
    categories: {},
    tags: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

const later = (a: string | undefined, b: string): string => (!a || Date.parse(b) > Date.parse(a) ? b : a);
const earlier = (a: string | undefined, b: string): string => (!a || Date.parse(b) < Date.parse(a) ? b : a);

function touch(p: CrmProfile, at: string): void {
  p.lastActivityAt = later(p.lastActivityAt, at);
  const day = toDay(at);
  if (!p.activeDays.includes(day)) {
    p.activeDays.push(day);
    p.activeDays.sort();
    if (p.activeDays.length > 90) p.activeDays.splice(0, p.activeDays.length - 90);
  }
}

/**
 * Clave de deduplicación de cada evento (el bus entrega al-menos-una-vez y no trae id propio).
 * Se arma con identificadores naturales: txId, roundId, sessionId.
 */
export function eventKey<K extends keyof DomainEvents>(name: K, e: DomainEvents[K]): string {
  const base = `${e.operatorId}:${e.playerId}:${name}`;
  switch (name) {
    case 'player.registered':
      return base;
    case 'deposit.completed':
    case 'withdrawal.completed':
      return `${base}:${(e as DomainEvents['deposit.completed']).txId}`;
    case 'bet.placed':
    case 'bet.settled':
      return `${base}:${(e as DomainEvents['bet.placed']).roundId}`;
    case 'session.started':
      return `${base}:${(e as DomainEvents['session.started']).sessionId}`;
    default:
      return `${base}:${e.at}:${(e as DomainEvents['login']).ip ?? ''}`;
  }
}

/** Aplica un evento al perfil (muta). Cada evento debe aplicarse una sola vez (ver eventKey). */
export function applyEvent<K extends keyof DomainEvents>(p: CrmProfile, name: K, e: DomainEvents[K], nowIso: string): void {
  p.updatedAt = nowIso;
  switch (name) {
    case 'player.registered': {
      const ev = e as DomainEvents['player.registered'];
      p.registeredAt = earlier(p.registeredAt, ev.at);
      p.currency = ev.currency;
      if (ev.country) p.country = ev.country;
      if (ev.email) p.email = ev.email;
      if (ev.birthDate) p.birthDate = ev.birthDate;
      if (ev.utm) p.utm = ev.utm;
      if (ev.affiliateCode) p.affiliateCode = ev.affiliateCode;
      touch(p, ev.at);
      break;
    }
    case 'deposit.completed': {
      const ev = e as DomainEvents['deposit.completed'];
      p.depositsTotal += ev.amount;
      p.depositsCount += 1;
      p.firstDepositAt = earlier(p.firstDepositAt, ev.at);
      p.lastDepositAt = later(p.lastDepositAt, ev.at);
      touch(p, ev.at);
      break;
    }
    case 'withdrawal.completed': {
      const ev = e as DomainEvents['withdrawal.completed'];
      p.withdrawalsTotal += ev.amount;
      p.withdrawalsCount += 1;
      touch(p, ev.at);
      break;
    }
    case 'bet.placed': {
      const ev = e as DomainEvents['bet.placed'];
      p.totalWagered += ev.amount;
      p.betCount += 1;
      p.games[ev.gameId] = (p.games[ev.gameId] ?? 0n) + ev.amount;
      const cat = String(ev.category);
      p.categories[cat] = (p.categories[cat] ?? 0n) + ev.amount;
      p.lastBetAt = later(p.lastBetAt, ev.at);
      touch(p, ev.at);
      break;
    }
    case 'bet.settled': {
      const ev = e as DomainEvents['bet.settled'];
      p.totalWon += ev.win;
      touch(p, ev.at);
      break;
    }
    case 'session.started': {
      const ev = e as DomainEvents['session.started'];
      p.sessionCount += 1;
      p.lastSessionAt = later(p.lastSessionAt, ev.at);
      touch(p, ev.at);
      break;
    }
    case 'login': {
      const ev = e as DomainEvents['login'];
      p.loginCount += 1;
      p.lastLoginAt = later(p.lastLoginAt, ev.at);
      touch(p, ev.at);
      break;
    }
  }
}
