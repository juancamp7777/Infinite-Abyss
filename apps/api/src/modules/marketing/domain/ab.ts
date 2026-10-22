import { createHash } from 'crypto';
import type { CampaignVariant } from './types';

/** Asignación determinista por hash(playerId + campaignId): el mismo jugador siempre cae en la misma variante. */
export function assignVariant(variants: CampaignVariant[], playerId: string, campaignId: string): CampaignVariant {
  if (variants.length === 0) throw new Error('La campaña no tiene variantes');
  const total = variants.reduce((s, v) => s + v.weight, 0);
  const h = createHash('sha256').update(`${playerId}:${campaignId}`).digest().readUInt32BE(0);
  const point = (h / 0x100000000) * total;
  let acc = 0;
  for (const v of variants) {
    acc += v.weight;
    if (point < acc) return v;
  }
  return variants[variants.length - 1];
}
