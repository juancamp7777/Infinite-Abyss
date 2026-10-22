import { randomBytes } from 'crypto';
import type { ModuleLogger } from '../../../shared/module';
import type { ProviderAdapter } from '../../domain/ProviderAdapter';
import { InMemoryNonceStore, type NonceStore } from '../../domain/replayGuard';
import { ApiMaticAdapter } from './aggregators/ApiMaticAdapter';
import { ApiSlotsAdapter } from './aggregators/ApiSlotsAdapter';
import { EvolutionAdapter, GenericAggregatorAdapter, PragmaticPlayAdapter } from './ContractAdapters';
import { MockProviderAdapter } from './MockProviderAdapter';
import { NymfoStudiosAdapter } from './NymfoStudiosAdapter';
import { providerSecret } from './StandardProviderAdapter';

export class ProviderAdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }
}

export interface BuiltAdapters {
  registry: ProviderAdapterRegistry;
  studios: NymfoStudiosAdapter;
  mock?: MockProviderAdapter;
  /** Agregadores configurados (API-Matic, API-Slots): se dan de alta en el catálogo al arrancar. */
  aggregators: Array<{ id: string; name: string }>;
}

const silent: ModuleLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * Construye los adaptadores según el entorno:
 * - nymfo-studios: siempre.
 * - mock-provider: fuera de producción, o si HUB_MOCK_PROVIDER=1. Usa HUB_PROVIDER_MOCK_PROVIDER_SECRET
 *   o, en desarrollo, un secreto aleatorio por proceso (el servidor mock lo conoce porque corre en el mismo proceso).
 * - pragmatic-play, evolution y el agregador genérico: solo si están todas sus credenciales.
 * - api-matic (HUB_APIMATIC_*) y api-slots (HUB_APISLOTS_*): agregadores reales; configuración parcial = error de arranque.
 */
export function buildAdapters(env: NodeJS.ProcessEnv, deps: { logger?: ModuleLogger; nonces?: NonceStore } = {}): BuiltAdapters {
  const logger = deps.logger ?? silent;
  const nonces = deps.nonces ?? new InMemoryNonceStore();
  const registry = new ProviderAdapterRegistry();
  const studios = new NymfoStudiosAdapter(env.HUB_STUDIO_LAUNCH_PATH || '/studio');
  registry.register(studios);

  let mock: MockProviderAdapter | undefined;
  const isProd = env.NODE_ENV === 'production';
  if (!isProd || env.HUB_MOCK_PROVIDER === '1') {
    const secret = providerSecret(env, 'mock-provider') ?? (isProd ? undefined : randomBytes(32).toString('hex'));
    mock = new MockProviderAdapter(secret);
    if (mock.enabled) registry.register(mock);
    else mock = undefined;
  }

  for (const a of [new PragmaticPlayAdapter(env), new EvolutionAdapter(env), new GenericAggregatorAdapter(env)]) {
    if (a.enabled) registry.register(a);
  }

  const aggregators: BuiltAdapters['aggregators'] = [];
  const apiMatic = ApiMaticAdapter.fromEnv(env, { nonces, logger });
  if (apiMatic) {
    registry.register(apiMatic);
    aggregators.push({ id: apiMatic.id, name: 'API-Matic' });
    logger.info('hub: API-Matic habilitado', { environment: apiMatic.environment, host: apiMatic.apiHost });
  }
  const apiSlots = ApiSlotsAdapter.fromEnv(env, { logger });
  if (apiSlots) {
    registry.register(apiSlots);
    aggregators.push({ id: apiSlots.id, name: 'API-Slots' });
    logger.info('hub: API-Slots habilitado');
  }
  return { registry, studios, mock, aggregators };
}
