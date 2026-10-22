import type { WalletTxRepository, ReportFilter } from '../domain/repositories';
import type { CatalogService } from './CatalogService';

export interface ReportLine {
  bets: bigint;
  wins: bigint;
  /** GGR = apuestas − ganancias. */
  ggr: bigint;
  rounds: number;
  openRounds: number;
}

export interface ProviderReport {
  from?: Date;
  to?: Date;
  operatorId?: string;
  totals: ReportLine;
  providers: Array<ReportLine & { providerId: string; providerName: string }>;
  games: Array<ReportLine & { gameId: string; providerId: string; title: string }>;
}

const empty = (): ReportLine => ({ bets: 0n, wins: 0n, ggr: 0n, rounds: 0, openRounds: 0 });

const add = (acc: ReportLine, r: { bets: bigint; wins: bigint; rounds: number; openRounds: number }) => {
  acc.bets += r.bets;
  acc.wins += r.wins;
  acc.ggr = acc.bets - acc.wins;
  acc.rounds += r.rounds;
  acc.openRounds += r.openRounds;
};

/** Reportes por proveedor y por juego sobre las rondas registradas por el seamless wallet. */
export class ReportService {
  constructor(
    private readonly txs: WalletTxRepository,
    private readonly catalog: CatalogService,
  ) {}

  async providers(filter: ReportFilter): Promise<ProviderReport> {
    const rows = await this.txs.aggregate(filter);
    const providers = new Map((await this.catalog.listProviders(true)).map((p) => [p.id, p.name]));
    const byProvider = new Map<string, ReportLine & { providerId: string; providerName: string }>();
    const games: ProviderReport['games'] = [];
    const totals = empty();
    for (const r of rows) {
      add(totals, r);
      let p = byProvider.get(r.providerId);
      if (!p) {
        p = { ...empty(), providerId: r.providerId, providerName: providers.get(r.providerId) ?? r.providerId };
        byProvider.set(r.providerId, p);
      }
      add(p, r);
      const game = await this.catalog.findGame(r.gameId);
      const line = { ...empty(), gameId: r.gameId, providerId: r.providerId, title: game?.title ?? r.gameId };
      add(line, r);
      games.push(line);
    }
    const byGgr = (a: ReportLine, b: ReportLine) => (b.ggr > a.ggr ? 1 : b.ggr < a.ggr ? -1 : 0);
    return {
      ...(filter.from ? { from: filter.from } : {}),
      ...(filter.to ? { to: filter.to } : {}),
      ...(filter.operatorId ? { operatorId: filter.operatorId } : {}),
      totals,
      providers: [...byProvider.values()].sort(byGgr),
      games: games.sort(byGgr),
    };
  }
}
