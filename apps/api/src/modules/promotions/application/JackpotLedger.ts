import type { ModuleLogger } from '../../shared/module';
import type { Jackpot, JackpotLevelKey } from '../domain/jackpot';
import type { ContributionHooks, ContributionInput, ContributionResult, JackpotRepository, NewJackpot } from './ports';

/**
 * Puerto opcional para reflejar en el ledger de la plataforma el dinero que entra a los pozos de
 * jackpot (cuentas de operador HOUSE → JACKPOT_POOL). El pago al jugador ya pasa por
 * WalletPort.credit(reason 'JACKPOT'), que el adaptador real debita de JACKPOT_POOL.
 *
 * Si la plataforma publica `services['wallet.jackpotLedger']`, el módulo envuelve su repositorio
 * de jackpots con `withJackpotLedger`. Todas las operaciones deben ser idempotentes por `key`.
 */
export interface JackpotLedgerPort {
  /** Contribución de una ronda (suma de todos los niveles). */
  recordContribution(input: {
    key: string;
    operatorId: string;
    currency: string;
    jackpotId: string;
    roundId: string;
    gameId: string;
    playerId: string;
    amount: bigint;
  }): Promise<void>;
  /** Semilla financiada por la casa (alta del nivel o reinicio tras un disparo). */
  recordSeed(input: {
    key: string;
    operatorId: string;
    currency: string;
    jackpotId: string;
    levelKey: JackpotLevelKey;
    reason: 'INITIAL' | 'RESEED';
    amount: bigint;
  }): Promise<void>;
}

/**
 * Decorador del repositorio: tras cada contribución nueva registra su total y las semillas de
 * reinicio de los niveles disparados; al crear un jackpot registra las semillas iniciales.
 * Un fallo del ledger se registra en el log y no deshace la contribución (las claves idempotentes
 * permiten reconciliar después).
 */
export function withJackpotLedger(repo: JackpotRepository, ledger: JackpotLedgerPort, logger?: ModuleLogger): JackpotRepository {
  const safe = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      logger?.error(`promotions: fallo al registrar ${what} de jackpot en el ledger`, { error: e instanceof Error ? e.message : String(e) });
    }
  };

  const seedsOf = async (j: Jackpot, reason: 'INITIAL' | 'RESEED', keyOf: (level: JackpotLevelKey) => string, only?: Set<JackpotLevelKey>) => {
    for (const l of j.levels) {
      if (only && !only.has(l.key)) continue;
      if (l.seedAmount <= 0n) continue;
      await safe('semilla', () =>
        ledger.recordSeed({ key: keyOf(l.key), operatorId: j.operatorId, currency: j.currency, jackpotId: j.id, levelKey: l.key, reason, amount: l.seedAmount }),
      );
    }
  };

  const overrides: Partial<JackpotRepository> = {};
  const wrapped = new Proxy(repo, {
    get(target, prop, receiver) {
      if (prop in overrides) return overrides[prop as keyof JackpotRepository];
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  overrides.create = async (j: NewJackpot) => {
    const created = await repo.create(j);
    await seedsOf(created, 'INITIAL', (level) => `jp:seed:${created.id}:${level}:initial`);
    return created;
  };
  overrides.contribute = async (input: ContributionInput, hooks: ContributionHooks): Promise<ContributionResult> => {
    let total = 0n;
    const res = await repo.contribute(input, {
      split: (j) => {
        const s = hooks.split(j);
        total = s.total;
        return s;
      },
      decide: (levels) => hooks.decide(levels),
    });
    if (res.duplicate) return res;
    if (total > 0n) {
      await safe('contribución', () =>
        ledger.recordContribution({
          key: `jp:contrib:${input.jackpotId}:${input.roundId}`,
          operatorId: input.operatorId,
          currency: input.currency,
          jackpotId: input.jackpotId,
          roundId: input.roundId,
          gameId: input.gameId,
          playerId: input.playerId,
          amount: total,
        }),
      );
    }
    const jackpot = res.jackpot ?? (await repo.get(input.jackpotId));
    if (jackpot) {
      for (const w of res.wins.filter((x) => x.roundId === input.roundId)) {
        await seedsOf(jackpot, 'RESEED', () => `jp:seed:${jackpot.id}:${w.id}`, new Set([w.levelKey]));
      }
    }
    return res;
  };
  return wrapped;
}
