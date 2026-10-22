import { parseAmountToMinor } from './matching';
import type { FeedType } from './types';

/** Movimiento entrante normalizado de un feed bancario. */
export interface IncomingTx {
  externalId: string;
  amount: bigint;
  senderName: string;
  senderTaxId?: string;
  senderAccount?: string;
  receiverAccount?: string;
  occurredAt: Date;
  /** Solo los ingresos acreditados se pueden conciliar. */
  usable: boolean;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const FAILED = /rechaz|fail|error|cancel|revers|devuel|pend/i;

function date(raw: string, utcOffsetMinutes: number): Date {
  if (!raw) return new Date();
  // ISO con zona → tal cual; sin zona → hora local del operador.
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }
  const d = new Date(`${raw.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? new Date() : new Date(d.getTime() - utcOffsetMinutes * 60_000);
}

/**
 * Normaliza el cuerpo del webhook de cada proveedor.
 * - quikipay: transferencia entrante a un CVU (`monto`, `origen.titular/cuit/cvu`, `cvu.cvu`, `coelsa_id`).
 * - hgcash: `amount`, `direction`, `fromName/fromCUIT/fromCBU`, `toCBU`, `date` + `timezone`; los Outbound se ignoran.
 * - generic: `{ id, amount, senderName, senderTaxId?, senderAccount?, receiverAccount?, occurredAt? , status? }`.
 */
export function parseFeedPayload(type: FeedType, body: any, decimals: number, utcOffsetMinutes: number): IncomingTx[] {
  const list = Array.isArray(body) ? body : [body];
  const out: IncomingTx[] = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    let tx: IncomingTx | null = null;
    if (type === 'quikipay') {
      const id = str(p.coelsa_id) || str(p.id);
      const amount = parseAmountToMinor(str(p.monto), decimals);
      if (id && amount) tx = {
        externalId: id, amount, senderName: str(p.origen?.titular), senderTaxId: str(p.origen?.cuit) || undefined, senderAccount: str(p.origen?.cvu) || undefined,
        receiverAccount: str(p.cvu?.cvu) || undefined, occurredAt: date(str(p.fecha) || str(p.date), utcOffsetMinutes), usable: !FAILED.test(str(p.status)),
      };
    } else if (type === 'hgcash') {
      const id = str(p.id) || str(p.externalID);
      const amount = parseAmountToMinor(str(p.amount), decimals);
      const outbound = /outbound/i.test(str(p.direction)) || /outbound/i.test(str(p.type));
      if (id && amount) tx = {
        externalId: id, amount, senderName: str(p.fromName), senderTaxId: str(p.fromCUIT) || undefined, senderAccount: str(p.fromCBU) || undefined,
        receiverAccount: str(p.toCBU) || undefined, occurredAt: date(str(p.date), utcOffsetMinutes), usable: !outbound && !FAILED.test(str(p.status)) && !str(p.error),
      };
    } else {
      const id = str(p.id) || str(p.externalId);
      const amount = parseAmountToMinor(str(p.amount), decimals);
      if (id && amount) tx = {
        externalId: id, amount, senderName: str(p.senderName), senderTaxId: str(p.senderTaxId) || undefined, senderAccount: str(p.senderAccount) || undefined,
        receiverAccount: str(p.receiverAccount) || undefined, occurredAt: date(str(p.occurredAt), utcOffsetMinutes), usable: !FAILED.test(str(p.status)),
      };
    }
    if (tx) out.push({ ...tx, externalId: tx.externalId.slice(0, 120), senderName: tx.senderName.slice(0, 120) });
  }
  return out;
}
