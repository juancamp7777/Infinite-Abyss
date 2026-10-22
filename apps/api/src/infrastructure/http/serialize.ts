/**
 * Serialización JSON segura: bigint → string de dígitos (los montos viajan como string).
 * Úsalo como `res.json(toJsonSafe(payload))` o `app.set('json replacer', bigintReplacer)`.
 */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** Copia profunda con bigint → string (Date → ISO). */
export function toJsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, bigintReplacer));
}
