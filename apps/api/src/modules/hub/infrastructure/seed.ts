import type { CatalogService, GameInput } from '../application/CatalogService';
import { MOCK_GAMES, MOCK_PROVIDER_ID } from './adapters/MockProviderAdapter';
import { STUDIO_PROVIDER_ID } from './adapters/NymfoStudiosAdapter';

type StudioSeed = Omit<GameInput, 'providerId'> & { id: string };

/** Juegos de Abyss Studios (ids estables que usan Studio, el lobby y el backoffice). */
export const STUDIO_GAMES: StudioSeed[] = [
  { id: 'nymfo-starfall', title: 'Starfall', category: 'slots', mechanic: 'pay-anywhere-tumble', rtp: 96.5, volatility: 'high', tags: ['tumble', 'multiplicadores', 'bonus-buy', 'free-spins'], popularity: 980 },
  { id: 'nymfo-verdant-grid', title: 'Verdant Grid', category: 'slots', mechanic: 'cluster-7x7', rtp: 96.4, volatility: 'high', tags: ['cluster', 'multiplicadores'], popularity: 920 },
  { id: 'nymfo-ember-lines', title: 'Ember Lines 20', category: 'slots', mechanic: 'lines-20', rtp: 96.2, volatility: 'medium', tags: ['clasico', 'wilds-expansivos', 'free-spins'], popularity: 860 },
  { id: 'nymfo-crash', title: 'Abyss Crash', category: 'originals', mechanic: 'crash', rtp: 99, volatility: 'high', tags: ['provably-fair', 'multijugador'], popularity: 990 },
  { id: 'nymfo-mines', title: 'Abyss Mines', category: 'originals', mechanic: 'mines', rtp: 99, volatility: 'medium', tags: ['provably-fair'], popularity: 950 },
  { id: 'nymfo-plinko', title: 'Abyss Plinko', category: 'originals', mechanic: 'plinko', rtp: 99, volatility: 'medium', tags: ['provably-fair'], popularity: 940 },
  { id: 'nymfo-dice', title: 'Abyss Dice', category: 'originals', mechanic: 'dice', rtp: 99, volatility: 'low', tags: ['provably-fair'], popularity: 900 },
  { id: 'nymfo-roulette', title: 'Abyss Roulette', category: 'table', mechanic: 'roulette-european', rtp: 97.3, volatility: 'low', tags: ['provably-fair', 'ruleta'], popularity: 820 },
  { id: 'nymfo-blackjack', title: 'Abyss Blackjack', category: 'table', mechanic: 'blackjack', rtp: 99.4, volatility: 'low', tags: ['provably-fair', 'cartas'], popularity: 840 },
];

/** Popularidad inicial del MockProvider (para que "populares" mezcle propios y terceros). */
const MOCK_POPULARITY = [700, 890, 760, 500, 650, 810, 730, 480, 600, 580, 420, 550];

/** Siembra idempotente del catálogo: proveedores internos/mock y sus juegos. */
export async function seedCatalog(catalog: CatalogService, opts: { mock: boolean; releasedAt?: Date }): Promise<void> {
  const providers = await catalog.listProviders(true);
  if (!providers.some((p) => p.id === STUDIO_PROVIDER_ID)) {
    await catalog.upsertProvider({
      id: STUDIO_PROVIDER_ID,
      name: 'Abyss Studios',
      type: 'internal',
      config: { accent: '#8b5cf6', provablyFair: true },
    });
    const releasedAt = opts.releasedAt ?? new Date('2026-10-01T00:00:00Z');
    for (const g of STUDIO_GAMES) {
      await catalog.upsertGame({ ...g, providerId: STUDIO_PROVIDER_ID, externalId: g.id, releasedAt, hasDemo: true });
    }
  }
  if (opts.mock && !providers.some((p) => p.id === MOCK_PROVIDER_ID)) {
    await catalog.upsertProvider({ id: MOCK_PROVIDER_ID, name: 'Mock Play', type: 'external', config: { accent: '#f59e0b', sandbox: true } });
    await catalog.syncProvider(MOCK_PROVIDER_ID, MOCK_GAMES);
    for (let i = 0; i < MOCK_GAMES.length; i++) {
      const id = `${MOCK_PROVIDER_ID}-${MOCK_GAMES[i].externalId}`;
      await catalog.patchGame(id, { popularity: MOCK_POPULARITY[i] ?? 400 });
    }
  }
}
