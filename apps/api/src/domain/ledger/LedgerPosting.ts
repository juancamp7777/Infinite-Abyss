import { AppError } from '../errors/AppError';

/** Tipos de cuenta del plan de cuentas (espejo del enum Prisma, sin depender de él). */
export type LedgerAccountKind =
  | 'PLAYER_CASH'
  | 'PLAYER_BONUS'
  | 'HOUSE'
  | 'PSP_CLEARING'
  | 'WITHDRAWAL_PENDING'
  | 'BONUS_EXPENSE'
  | 'MANUAL_ADJUSTMENT'
  | 'DEMO_FUNDING'
  /** Pozo de jackpots del operador: HOUSE → JACKPOT_POOL (contribución), JACKPOT_POOL → CASH (pago). */
  | 'JACKPOT_POOL'
  /** Pozo de torneos del operador: CASH → TOURNAMENT_POOL (buy-in), TOURNAMENT_POOL → CASH (premio). */
  | 'TOURNAMENT_POOL'
  /** Gasto de cashback/rakeback del operador. */
  | 'CASHBACK_EXPENSE';

export const PLAYER_ACCOUNT_KINDS: ReadonlySet<LedgerAccountKind> = new Set<LedgerAccountKind>([
  'PLAYER_CASH',
  'PLAYER_BONUS',
]);

/** Referencia lógica a una cuenta: las de jugador se resuelven con el userId de la operación. */
export interface AccountRef {
  type: LedgerAccountKind;
}

export interface PostingLine {
  account: AccountRef;
  /** Con signo, unidades mínimas. */
  amount: bigint;
}

export type LedgerPosting = readonly PostingLine[];

export function isPlayerAccount(kind: LedgerAccountKind): boolean {
  return PLAYER_ACCOUNT_KINDS.has(kind);
}

/**
 * Reglas del asiento: al menos 2 líneas, sin montos 0 y suma exactamente 0.
 * La moneda es única por transacción y se valida con assertSameCurrency.
 */
export function assertBalancedPosting(posting: LedgerPosting): void {
  if (posting.length < 2) throw AppError.validation('Un asiento necesita al menos dos líneas');
  let sum = 0n;
  for (const l of posting) {
    if (typeof l.amount !== 'bigint') throw AppError.validation('Los montos del asiento deben ser bigint');
    if (l.amount === 0n) throw AppError.validation('Las líneas del asiento no pueden ser cero');
    sum += l.amount;
  }
  if (sum !== 0n) throw AppError.validation(`El asiento no suma cero (suma=${sum})`);
}

/** Valida que todas las entradas compartan moneda con la de la transacción. */
export function assertSameCurrency(currency: string, entryCurrencies: readonly string[]): void {
  if (!currency) throw AppError.validation('La moneda es obligatoria');
  for (const c of entryCurrencies) {
    if (c !== currency) throw AppError.validation('Todas las entradas deben usar la moneda de la transacción');
  }
}

function positive(amount: bigint): bigint {
  if (typeof amount !== 'bigint' || amount <= 0n) throw AppError.validation('El monto debe ser un bigint positivo');
  return amount;
}

const line = (type: LedgerAccountKind, amount: bigint): PostingLine => ({ account: { type }, amount });

/** Plantillas de asiento (docs/contracts.md §2). */
export const postings = {
  /** CASH +X / PSP_CLEARING −X */
  deposit(x: bigint): LedgerPosting {
    positive(x);
    return [line('PLAYER_CASH', x), line('PSP_CLEARING', -x)];
  },
  /** CASH −B / HOUSE +B */
  bet(b: bigint): LedgerPosting {
    positive(b);
    return [line('PLAYER_CASH', -b), line('HOUSE', b)];
  },
  /** CASH +W / HOUSE −W */
  win(w: bigint): LedgerPosting {
    positive(w);
    return [line('PLAYER_CASH', w), line('HOUSE', -w)];
  },
  /** CASH −X / WITHDRAWAL_PENDING +X */
  withdrawalReserve(x: bigint): LedgerPosting {
    positive(x);
    return [line('PLAYER_CASH', -x), line('WITHDRAWAL_PENDING', x)];
  },
  /** WITHDRAWAL_PENDING −X / CASH +X */
  withdrawalRelease(x: bigint): LedgerPosting {
    positive(x);
    return [line('WITHDRAWAL_PENDING', -x), line('PLAYER_CASH', x)];
  },
  /** WITHDRAWAL_PENDING −X / PSP_CLEARING +X */
  withdrawalPayout(x: bigint): LedgerPosting {
    positive(x);
    return [line('WITHDRAWAL_PENDING', -x), line('PSP_CLEARING', x)];
  },
  /** x>0: CASH +x / MANUAL_ADJUSTMENT −x · x<0: CASH −|x| / MANUAL_ADJUSTMENT +|x| */
  manualAdjustment(x: bigint): LedgerPosting {
    if (typeof x !== 'bigint' || x === 0n) throw AppError.validation('El ajuste debe ser un bigint distinto de cero');
    return [line('PLAYER_CASH', x), line('MANUAL_ADJUSTMENT', -x)];
  },
  /** CASH +X / DEMO_FUNDING −X */
  demoCredit(x: bigint): LedgerPosting {
    positive(x);
    return [line('PLAYER_CASH', x), line('DEMO_FUNDING', -x)];
  },
  /** Traspaso simple: FROM −X / TO +X (cuentas distintas). */
  transfer(from: LedgerAccountKind, to: LedgerAccountKind, x: bigint): LedgerPosting {
    positive(x);
    if (from === to) throw AppError.validation('Las cuentas de la transferencia deben ser distintas');
    return [line(from, -x), line(to, x)];
  },
  /**
   * Varias cuentas origen hacia un destino: cada origen −parte, destino +suma. Se omiten las partes 0
   * (p. ej. apuesta que sale solo de CASH o solo de BONUS).
   */
  split(sources: readonly { from: LedgerAccountKind; amount: bigint }[], to: LedgerAccountKind): LedgerPosting {
    let total = 0n;
    const lines: PostingLine[] = [];
    for (const s of sources) {
      if (typeof s.amount !== 'bigint' || s.amount < 0n) throw AppError.validation('Las partes deben ser bigint no negativos');
      if (s.amount === 0n) continue;
      if (s.from === to) throw AppError.validation('Las cuentas de la transferencia deben ser distintas');
      total += s.amount;
      lines.push(line(s.from, -s.amount));
    }
    positive(total);
    return [...lines, line(to, total)];
  },
};

/** Línea concreta de una transacción ya existente (para el rollback). */
export interface ConcreteEntry {
  accountId: string;
  amount: bigint;
}

/** Rollback = asiento inverso exacto de la transacción original. */
export function reverseEntries(original: readonly ConcreteEntry[]): ConcreteEntry[] {
  if (original.length === 0) throw AppError.validation('No se puede revertir una transacción sin asientos');
  return original.map((e) => ({ accountId: e.accountId, amount: -e.amount }));
}
