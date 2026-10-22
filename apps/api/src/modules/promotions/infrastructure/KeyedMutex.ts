/**
 * Serializa operaciones asíncronas por clave dentro del proceso (pools de jackpot, stock de drops,
 * bonos de un jugador). Las claves distintas corren en paralelo.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(
      () => fn(),
      () => fn(),
    );
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
