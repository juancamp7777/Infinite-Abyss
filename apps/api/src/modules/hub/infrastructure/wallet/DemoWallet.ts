import { InMemoryWallet } from '../../../shared/adapters/InMemoryWallet';
import type { DemoWallet } from '../../application/SessionService';

/** Billetera de modo demo: dinero ficticio, aislada de la billetera real. */
export class InMemoryDemoWallet extends InMemoryWallet implements DemoWallet {
  private readonly seen = new Set<string>();

  constructor(private readonly initialBalance: bigint) {
    super();
  }

  ensure(operatorId: string, playerId: string, currency: string): void {
    const k = `${operatorId}\u0000${playerId}\u0000${currency}`;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.seed(operatorId, playerId, currency, this.initialBalance);
  }
}
