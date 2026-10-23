import type { PaymentProvider, PaymentProviderName } from '../../domain/contracts';
import type { AppConfig } from '../../config/env';
import { PassimpayProvider } from './PassimpayProvider';
import { WompiProvider } from './WompiProvider';
import { BoldProvider, type BoldDeps } from './BoldProvider';
import { FetchLike, defaultFetch } from './types';

/** Catálogo de pasarelas. Las que no tienen credenciales quedan deshabilitadas. */
export class PaymentProviderRegistry {
  private readonly byCode = new Map<PaymentProviderName, PaymentProvider>();

  constructor(providers: PaymentProvider[]) {
    for (const p of providers) this.byCode.set(p.code, p);
  }

  static fromConfig(
    config: Pick<AppConfig, 'passimpay' | 'wompi' | 'publicWebUrl'>,
    fetchFn: FetchLike = defaultFetch,
    bold?: Omit<BoldDeps, 'returnUrl'>,
  ): PaymentProviderRegistry {
    return new PaymentProviderRegistry([
      ...(bold ? [new BoldProvider({ ...bold, returnUrl: config.publicWebUrl ? `${config.publicWebUrl}/cashier` : undefined }, fetchFn)] : []),
      new PassimpayProvider(config.passimpay, fetchFn),
      new WompiProvider(
        {
          ...config.wompi,
          redirectUrl: config.publicWebUrl ? `${config.publicWebUrl}/cashier` : undefined,
        },
        fetchFn,
      ),
    ]);
  }

  get(code: string): PaymentProvider | undefined {
    return this.byCode.get(code as PaymentProviderName);
  }

  /** El adaptador solo si existe y está habilitado. */
  getEnabled(code: string): PaymentProvider | undefined {
    const p = this.get(code);
    return p && p.isEnabled() ? p : undefined;
  }

  listEnabled(): PaymentProvider[] {
    return [...this.byCode.values()].filter((p) => p.isEnabled());
  }

  /** Las habilitadas para un casino (las de llaves por casino, solo si las conectó). */
  async listEnabledFor(operatorId: string): Promise<PaymentProvider[]> {
    const out: PaymentProvider[] = [];
    for (const p of this.listEnabled()) if (!p.isEnabledFor || (await p.isEnabledFor(operatorId))) out.push(p);
    return out;
  }
}
