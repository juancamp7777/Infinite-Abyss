import type { DemoContext, LaunchContext } from '../../domain/ProviderAdapter';
import type { GameDTO } from '../../domain/types';
import type { WinRequest } from '../../domain/walletProtocol';
import { StandardProviderAdapter } from './StandardProviderAdapter';

export const MOCK_PROVIDER_ID = 'mock-provider';

/**
 * Catálogo del proveedor simulado "Mock Play" (estilo de un proveedor de slots grande).
 * Nombres y temática 100 % ficticios y propios.
 */
export const MOCK_GAMES: GameDTO[] = [
  { externalId: 'mp-golden-oasis', title: 'Golden Oasis', category: 'slots', mechanic: 'ways-243', rtp: 96.2, volatility: 'medium', tags: ['egipto', 'free-spins'], releasedAt: '2026-01-15' },
  { externalId: 'mp-sugar-comet', title: 'Sugar Comet', category: 'slots', mechanic: 'pay-anywhere', rtp: 96.4, volatility: 'high', tags: ['dulces', 'tumble', 'bonus-buy'], releasedAt: '2026-09-20' },
  { externalId: 'mp-wolf-ridge', title: 'Wolf Ridge Megaways', category: 'slots', mechanic: 'megaways', rtp: 96.0, volatility: 'very_high', tags: ['animales', 'bonus-buy'], releasedAt: '2025-11-02' },
  { externalId: 'mp-neon-fruits', title: 'Neon Fruits 40', category: 'slots', mechanic: 'lines-40', rtp: 95.8, volatility: 'low', tags: ['frutas', 'clasico'], releasedAt: '2025-06-10' },
  { externalId: 'mp-pirate-cove', title: 'Pirate Cove Cluster', category: 'slots', mechanic: 'cluster', rtp: 96.1, volatility: 'high', tags: ['piratas', 'cluster'], releasedAt: '2026-10-05' },
  { externalId: 'mp-dragon-pearls', title: 'Dragon Pearls Hold&Win', category: 'slots', mechanic: 'hold-and-win', rtp: 96.3, volatility: 'high', tags: ['asia', 'jackpot'], releasedAt: '2026-03-12', allowedMarkets: ['CO', 'PE', 'MX'] },
  { externalId: 'mp-viking-rage', title: 'Viking Rage', category: 'slots', mechanic: 'ways-1024', rtp: 96.5, volatility: 'very_high', tags: ['nordico', 'multiplicadores'], releasedAt: '2026-07-01' },
  { externalId: 'mp-lucky-clover', title: 'Lucky Clover Coins', category: 'slots', mechanic: 'coin-collect', rtp: 95.9, volatility: 'medium', tags: ['irlanda', 'coin'], releasedAt: '2025-03-17' },
  { externalId: 'mp-speed-roulette', title: 'Mock Speed Roulette', category: 'live', mechanic: 'roulette', rtp: 97.3, volatility: 'low', tags: ['ruleta', 'en-vivo'], releasedAt: '2025-09-01', hasDemo: false },
  { externalId: 'mp-blackjack-vip', title: 'Mock Blackjack VIP', category: 'live', mechanic: 'blackjack', rtp: 99.3, volatility: 'low', tags: ['cartas', 'en-vivo'], releasedAt: '2025-09-01', hasDemo: false },
  { externalId: 'mp-baccarat', title: 'Mock Baccarat Squeeze', category: 'table', mechanic: 'baccarat', rtp: 98.9, volatility: 'low', tags: ['cartas'], releasedAt: '2025-12-01' },
  { externalId: 'mp-space-miner', title: 'Space Miner Drops', category: 'slots', mechanic: 'lines-20', rtp: 96.0, volatility: 'medium', tags: ['espacio', 'drops'], releasedAt: '2026-05-22', allowedMarkets: ['CO', 'BR'] },
];

/**
 * Proveedor simulado completo: habla el protocolo seamless estándar de Infinite Abyss con firma HMAC,
 * expone catálogo y, si HUB_MOCK_PROVIDER=1, un mini servidor de juego en /hub/mock-provider/game/:gameId
 * (ver infrastructure/http/mockProviderServer.ts) que llama a nuestra billetera para hacer bet y win.
 * Acepta wins sin apuesta previa solo si traen `bonus.type = 'free_rounds'`.
 */
export class MockProviderAdapter extends StandardProviderAdapter {
  readonly id = MOCK_PROVIDER_ID;

  constructor(secret: string | undefined) {
    super(secret);
  }

  /** El servidor mock firma sus callbacks con el mismo secreto. */
  get signingSecret(): string | undefined {
    return this.secret;
  }

  async launchGame(ctx: LaunchContext): Promise<{ url: string }> {
    const q = new URLSearchParams({ session: ctx.session.token, currency: ctx.session.currency, mode: 'real' });
    if (ctx.returnUrl) q.set('returnUrl', ctx.returnUrl);
    if (ctx.language) q.set('lang', ctx.language);
    return { url: `${ctx.publicApiUrl}/hub/mock-provider/game/${encodeURIComponent(ctx.game.externalId)}?${q}` };
  }

  async launchDemo(ctx: DemoContext): Promise<{ url: string }> {
    const q = new URLSearchParams({ currency: ctx.currency, mode: 'demo' });
    if (ctx.returnUrl) q.set('returnUrl', ctx.returnUrl);
    return { url: `${ctx.publicApiUrl}/hub/mock-provider/game/${encodeURIComponent(ctx.game.externalId)}?${q}` };
  }

  async syncCatalog(): Promise<GameDTO[]> {
    return MOCK_GAMES.map((g) => ({ ...g, tags: [...(g.tags ?? [])] }));
  }

  allowsWinWithoutBet(req: WinRequest): boolean {
    return req.bonus?.type === 'free_rounds';
  }
}
