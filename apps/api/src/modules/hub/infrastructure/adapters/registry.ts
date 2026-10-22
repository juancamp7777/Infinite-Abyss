import { randomBytes } from 'crypto';
import type { ProviderAdapter } from '../../domain/ProviderAdapter';
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
}

/**
 * Construye los adaptadores según el entorno:
 * - nymfo-studios: siempre.
 * - mock-provider: fuera de producción, o si HUB_MOCK_PROVIDER=1. Usa HUB_PROVIDER_MOCK_PROVIDER_SECRET
 *   o, en desarrollo, un secreto aleatorio por proceso (el servidor mock lo conoce porque corre en el mismo proceso).
 * - pragmatic-play, evolution y el agregador genérico: solo si están todas sus credenciales.
 */
export function buildAdapters(env: NodeJS.ProcessEnv): BuiltAdapters {
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
  return { registry, studios, mock };
}
