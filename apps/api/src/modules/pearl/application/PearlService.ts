import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { currencyDecimals } from '../../../domain/money/currencies';
import { HttpError } from '../../shared/http/errors';
import type { ModuleLogger } from '../../shared/module';
import { ExternalDepositError, type ExternalDepositPort } from '../../shared/ports/ExternalDepositPort';
import { parseFeedPayload } from '../domain/feeds';
import { isOwnAccount, isWalletOrOwnName, matchBankTx, parseAmountToMinor, receiptKey } from '../domain/matching';
import {
  DUPLICATE_RECEIPT, type BankAccount, type BankTx, type Check, type ExtractedReceipt, type Feed, type FeedType, type PearlRepository,
  type PearlSettings, type Receipt, type ReceiptStatus,
} from '../domain/types';

/** Avisos al contacto (los envía el inbox Sonar por el canal de la conversación). */
export type PearlOutcome = 'credited' | 'pending_review' | 'waiting_bank' | 'needs_info' | 'rejected' | 'duplicate';
export type PearlNotifier = (receipt: Receipt, outcome: PearlOutcome) => Promise<void>;
/** Juez (IA) previo a mover dinero: puede vetar con un motivo. Sin juez, deciden solo las reglas. */
export type PearlJudge = (ctx: { receipt: Receipt; bankTx: BankTx; settings: PearlSettings }) => Promise<{ approve: boolean; reason?: string }>;

const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const TERMINAL: ReceiptStatus[] = ['credited', 'rejected', 'duplicate'];
/** Hora local de los comprobantes por moneda (mercados de arranque: Argentina y Colombia); editable por operador. */
const UTC_OFFSET_BY_CURRENCY: Record<string, number> = { ARS: -180, BRL: -180, COP: -300, CLP: -180, PEN: -300, MXN: -360, USD: 0 };

export interface SubmitReceipt {
  operatorId: string;
  conversationId?: string;
  playerId?: string;
  image?: Buffer;
  extracted: ExtractedReceipt;
  attachmentId?: string;
  source: 'ai' | 'manual';
}

/**
 * Pearl decide en este orden (todo determinista; la IA solo lee y juzga):
 * 1. Duplicados: misma imagen (sha256) o misma clave fecha·hora·monto·titular.
 * 2. Comprobante válido: no es una pantalla de confirmación, sin indicios de edición, monto ≥ mínimo, fecha reciente,
 *    cuenta destino nuestra, titular que no es una billetera ni un titular propio.
 * 3. Conciliación: UN único movimiento del feed con monto exacto y mismo titular (la hora solo desempata).
 * 4. Modo auto + monto ≤ tope + jugador vinculado + juez conforme → reserva atómica del movimiento y depósito idempotente.
 * Cualquier duda → revisión humana. Si el pago aún no llegó → espera y reintenta (después, revisión humana).
 */
export class PearlService {
  private notifier?: PearlNotifier;
  private judge?: PearlJudge;
  private readonly reviewed: Array<(r: Receipt) => Promise<unknown>> = [];

  constructor(
    private readonly repo: PearlRepository,
    private readonly opts: { deposits?: ExternalDepositPort; logger: ModuleLogger; defaultCurrency: string; now?: () => Date },
  ) {}

  setNotifier(n: PearlNotifier) {
    this.notifier = n;
  }
  setJudge(j: PearlJudge) {
    this.judge = j;
  }
  /** Comprobantes acreditados por un cajero (para KPIs y gamificación del equipo). */
  onReviewed(cb: (r: Receipt) => Promise<unknown>) {
    this.reviewed.push(cb);
  }
  private now() {
    return this.opts.now?.() ?? new Date();
  }

  // ───────────────────────── configuración ─────────────────────────

  async settings(operatorId: string): Promise<PearlSettings> {
    const s = await this.repo.getSettings(operatorId);
    if (s) return s;
    const currency = this.opts.defaultCurrency;
    const unit = 10n ** BigInt(currencyDecimals(currency));
    // Arranque seguro: todo a revisión humana hasta que el operador active el modo automático.
    return { operatorId, mode: 'review_all', currency, autoMaxAmount: 100_000n * unit, minAmount: 1n * unit, maxAgeHours: 48, waitBankMinutes: 20, utcOffsetMinutes: UTC_OFFSET_BY_CURRENCY[currency] ?? 0, autoRegisterLeads: true, updatedAt: this.now() };
  }

  async updateSettings(operatorId: string, patch: Partial<Omit<PearlSettings, 'operatorId' | 'updatedAt'>>): Promise<PearlSettings> {
    const cur = await this.settings(operatorId);
    if (patch.currency) currencyDecimals(patch.currency); // valida
    return this.repo.saveSettings({ ...cur, ...patch, operatorId, updatedAt: this.now() });
  }

  listAccounts(operatorId: string) {
    return this.repo.listAccounts(operatorId);
  }
  async saveAccount(operatorId: string, a: { id?: string; holderName: string; alias?: string; accountNumber: string; bank?: string; active?: boolean }): Promise<BankAccount> {
    if (a.id && !(await this.repo.listAccounts(operatorId)).some((x) => x.id === a.id)) throw new HttpError(404, 'NOT_FOUND', 'Cuenta no encontrada');
    return this.repo.saveAccount({ id: a.id ?? randomUUID(), operatorId, holderName: a.holderName, alias: a.alias || undefined, accountNumber: a.accountNumber, bank: a.bank || undefined, active: a.active ?? true, createdAt: this.now() });
  }
  async deleteAccount(operatorId: string, id: string) {
    if (!(await this.repo.deleteAccount(operatorId, id))) throw new HttpError(404, 'NOT_FOUND', 'Cuenta no encontrada');
  }

  listFeeds(operatorId: string) {
    return this.repo.listFeeds(operatorId);
  }
  /** Crea un feed y devuelve el token del webhook UNA sola vez (se guarda su hash). */
  async createFeed(operatorId: string, type: FeedType, name: string): Promise<{ feed: Feed; token: string }> {
    const token = randomBytes(24).toString('base64url');
    const feed = await this.repo.saveFeed({ id: randomUUID(), operatorId, type, name: name.trim().slice(0, 80) || type, tokenHash: sha256(token), enabled: true, createdAt: this.now() });
    return { feed, token };
  }
  async setFeedEnabled(operatorId: string, id: string, enabled: boolean): Promise<Feed> {
    const f = (await this.repo.listFeeds(operatorId)).find((x) => x.id === id);
    if (!f) throw new HttpError(404, 'NOT_FOUND', 'Feed no encontrado');
    return this.repo.saveFeed({ ...f, enabled });
  }
  async deleteFeed(operatorId: string, id: string) {
    if (!(await this.repo.deleteFeed(operatorId, id))) throw new HttpError(404, 'NOT_FOUND', 'Feed no encontrado');
  }

  // ───────────────────────── feed bancario ─────────────────────────

  /** Webhook del proveedor: token de la URL obligatorio; movimientos idempotentes por id externo. */
  async ingest(feedId: string, token: string, body: unknown): Promise<{ received: number; created: number }> {
    const feed = await this.repo.findFeed(feedId);
    if (!feed || !feed.enabled || !safeEq(sha256(token), feed.tokenHash)) throw new HttpError(404, 'NOT_FOUND', 'Feed no encontrado');
    const s = await this.settings(feed.operatorId);
    const items = parseFeedPayload(feed.type, body, currencyDecimals(s.currency), s.utcOffsetMinutes);
    let created = 0;
    for (const it of items) {
      const r = await this.repo.insertBankTx({
        id: randomUUID(), operatorId: feed.operatorId, feedId: feed.id, externalId: it.externalId, amount: it.amount, currency: s.currency, senderName: it.senderName,
        senderTaxId: it.senderTaxId, senderAccount: it.senderAccount, receiverAccount: it.receiverAccount, occurredAt: it.occurredAt,
        status: it.usable ? 'available' : 'ignored', createdAt: this.now(),
      });
      if (r.created) created++;
    }
    await this.repo.saveFeed({ ...feed, lastEventAt: this.now() });
    // Un pago nuevo puede destrabar comprobantes que lo estaban esperando.
    if (created) await this.retryWaiting(feed.operatorId);
    return { received: items.length, created };
  }

  listBankTxs(operatorId: string, status?: BankTx['status']) {
    return this.repo.listBankTxs(operatorId, { status, limit: 200 });
  }

  // ───────────────────────── comprobantes ─────────────────────────

  listReceipts(operatorId: string, status?: ReceiptStatus) {
    return this.repo.listReceipts(operatorId, { status, limit: 200 });
  }

  async getReceipt(operatorId: string, id: string): Promise<Receipt> {
    const r = await this.repo.findReceipt(operatorId, id);
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'Comprobante no encontrado');
    return r;
  }

  async submit(input: SubmitReceipt): Promise<Receipt> {
    const s = await this.settings(input.operatorId);
    const imageHash = input.image ? sha256(input.image) : undefined;
    if (imageHash) {
      const prev = await this.repo.findReceiptBy(input.operatorId, { imageHash });
      if (prev) return this.duplicateOf(prev);
    }
    const x = input.extracted;
    const a = await this.assess(input.operatorId, x, s);
    if (a.key) {
      const prev = await this.repo.findReceiptBy(input.operatorId, { key: a.key });
      if (prev) return this.duplicateOf(prev);
    }
    const base: Receipt = {
      id: randomUUID(), operatorId: input.operatorId, conversationId: input.conversationId, playerId: input.playerId, imageHash, extracted: x, key: a.key, amount: a.amount,
      ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}), currency: s.currency, checks: a.checks, source: input.source, createdAt: this.now(), updatedAt: this.now(),
      ...a.outcome,
    };
    const failed = a.failed;

    let saved: Receipt;
    try {
      saved = await this.repo.insertReceipt(base);
    } catch (e) {
      if ((e as { code?: string }).code !== DUPLICATE_RECEIPT) throw e;
      const prev = await this.repo.findReceiptBy(input.operatorId, { imageHash, key: a.key });
      if (prev) return this.duplicateOf(prev);
      throw e;
    }
    if (failed.length) {
      await this.notify(saved, saved.status === 'rejected' ? 'rejected' : saved.status === 'needs_info' ? 'needs_info' : 'pending_review');
      return saved;
    }
    return this.reconcile(saved, s, true);
  }

  /** Aprobación humana: con movimiento bancario elegido (o el único que coincida) acredita; registra quién aprobó. */
  async approve(operatorId: string, id: string, reviewerId: string, bankTxId?: string): Promise<Receipt> {
    const r = await this.getReceipt(operatorId, id);
    if (TERMINAL.includes(r.status)) throw new HttpError(409, 'ALREADY_FINAL', 'El comprobante ya está resuelto');
    if (!r.playerId) throw new HttpError(409, 'NO_PLAYER', 'Vincula la conversación a un jugador antes de acreditar');
    if (!r.amount) throw new HttpError(409, 'NO_AMOUNT', 'El comprobante no tiene un monto válido');
    let tx: BankTx | null = null;
    const chosen = bankTxId ?? r.bankTxId;
    if (chosen) {
      tx = await this.repo.findBankTx(operatorId, chosen);
      if (!tx || tx.status !== 'available') throw new HttpError(409, 'TX_UNAVAILABLE', 'Ese movimiento no está disponible');
      if (tx.amount !== r.amount) throw new HttpError(409, 'AMOUNT_MISMATCH', 'El monto del movimiento no coincide con el comprobante');
    }
    const out = await this.credit({ ...r, reviewerId }, tx, r.status);
    if (out.status === 'credited') for (const cb of this.reviewed) await cb(out).catch(() => undefined);
    return out;
  }

  async reject(operatorId: string, id: string, reviewerId: string, reason: string): Promise<Receipt> {
    const r = await this.getReceipt(operatorId, id);
    const next: Receipt = { ...r, status: 'rejected', reason: reason.slice(0, 300) || 'rechazado', reviewerId, updatedAt: this.now() };
    if (!(await this.repo.transitionReceipt(next, ['pending_review', 'waiting_bank', 'needs_info', 'error']))) throw new HttpError(409, 'ALREADY_FINAL', 'El comprobante ya está resuelto');
    await this.notify(next, 'rejected');
    return next;
  }

  /** Comprobantes esperando al banco: reintenta; vencida la espera, a revisión humana. */
  async tick(): Promise<number> {
    const waiting = await this.repo.waitingReceipts(100);
    for (const r of waiting) {
      try {
        await this.reconcile(r, await this.settings(r.operatorId), false);
      } catch (e) {
        this.opts.logger.error('[pearl] reintento de conciliación', { receiptId: r.id, error: (e as Error).message });
      }
    }
    return waiting.length;
  }

  /**
   * Corrige los datos leídos (cajero, o el titular que responde el contacto) y vuelve a evaluar y conciliar.
   * Solo sobre comprobantes abiertos.
   */
  async updateExtracted(operatorId: string, id: string, x: ExtractedReceipt): Promise<Receipt> {
    const r = await this.getReceipt(operatorId, id);
    if (!['pending_review', 'needs_info', 'error'].includes(r.status)) throw new HttpError(409, 'NOT_EDITABLE', 'El comprobante ya no se puede editar');
    const s = await this.settings(operatorId);
    const a = await this.assess(operatorId, x, s);
    if (a.key) {
      const other = await this.repo.findReceiptBy(operatorId, { key: a.key });
      if (other && other.id !== r.id) throw new HttpError(409, 'DUPLICATE', 'Esos datos ya corresponden a otro comprobante');
    }
    const next: Receipt = { ...r, extracted: x, amount: a.amount, key: a.key, checks: a.checks, reason: undefined, updatedAt: this.now(), ...a.outcome };
    if (!(await this.repo.transitionReceipt(next, [r.status]))) throw new HttpError(409, 'CONFLICT', 'El comprobante cambió; recarga');
    if (a.failed.length) {
      await this.notify(next, next.status === 'rejected' ? 'rejected' : next.status === 'needs_info' ? 'needs_info' : 'pending_review');
      return next;
    }
    return this.reconcile(next, s, true);
  }

  // ───────────────────────── internos ─────────────────────────

  /** Controles deterministas del comprobante y su estado inicial. */
  private async assess(operatorId: string, x: ExtractedReceipt, s: PearlSettings) {
    const amount = parseAmountToMinor(x.amount, currencyDecimals(s.currency)) ?? undefined;
    const key = amount && x.senderName ? receiptKey({ amount, senderName: x.senderName, date: x.date, time: x.time }) : undefined;
    const accounts = (await this.repo.listAccounts(operatorId)).filter((acc) => acc.active);
    const at = this.receiptDate(x, s);
    const checks: Check[] = [];
    const add = (code: string, ok: boolean, detail?: string) => checks.push({ code, ok, ...(detail ? { detail } : {}) });
    add('es_comprobante', !x.notAReceipt, x.notAReceipt ? 'Parece una pantalla previa a la transferencia, no un comprobante final' : undefined);
    add('sin_edicion', !x.tamperSignals?.length, x.tamperSignals?.join('; '));
    add('monto_legible', !!amount);
    if (amount) add('monto_minimo', amount >= s.minAmount);
    add('titular', !!x.senderName && !isWalletOrOwnName(x.senderName, accounts.map((acc) => acc.holderName)), x.senderName ? undefined : 'Sin titular');
    if (x.receiverAccount) add('cuenta_destino', isOwnAccount(x.receiverAccount, accounts), x.receiverAccount);
    if (at) {
      const age = this.now().getTime() - at.getTime();
      add('fecha_reciente', age <= s.maxAgeHours * 3_600_000 && age >= -10 * 60_000, at.toISOString());
    }
    const failed = checks.filter((c) => !c.ok).map((c) => c.code);
    let outcome: { status: ReceiptStatus; reason?: string } = { status: 'pending_review' };
    if (failed.includes('es_comprobante')) outcome = { status: 'rejected', reason: 'no_es_comprobante' };
    // Titular de billetera o sin titular legible: se le pide al contacto (el monto sí debe leerse).
    else if (failed.includes('titular') && amount && failed.length === 1) outcome = { status: 'needs_info', reason: x.senderName ? 'titular_billetera' : 'falta_titular' };
    else if (failed.length) outcome = { status: 'pending_review', reason: failed.join(',') };
    return { amount, key, checks, failed, outcome };
  }

  private async retryWaiting(operatorId: string) {
    const s = await this.settings(operatorId);
    for (const r of await this.repo.listReceipts(operatorId, { status: 'waiting_bank', limit: 100 })) await this.reconcile(r, s, false);
  }

  private async reconcile(r: Receipt, s: PearlSettings, first: boolean): Promise<Receipt> {
    const names = [r.extracted.senderName, ...(r.playerId ? await this.repo.knownSenderNames(r.operatorId, r.playerId) : [])];
    const since = new Date(this.now().getTime() - Math.max(s.maxAgeHours, 24) * 3_600_000);
    const feed = await this.repo.listBankTxs(r.operatorId, { status: 'available', since, amount: r.amount, limit: 200 });
    // La hora desempata solo si el comprobante la trae (sin hora no se inventa una).
    const m = matchBankTx({ amount: r.amount!, names, at: r.extracted.time ? this.receiptDate(r.extracted, s) ?? undefined : undefined }, feed);
    if (m.kind === 'unique') {
      if (s.mode !== 'auto') return this.toReview(r, 'modo_revision', m.tx);
      if (r.amount! > s.autoMaxAmount) return this.toReview(r, 'supera_tope_automatico', m.tx);
      if (!r.playerId) return this.toReview(r, 'sin_jugador_vinculado', m.tx);
      if (this.judge) {
        const verdict = await this.judge({ receipt: r, bankTx: m.tx, settings: s }).catch((e: Error) => ({ approve: false, reason: `juez no disponible: ${e.message}` }));
        if (!verdict.approve) return this.toReview(r, `juez: ${verdict.reason ?? 'vetado'}`.slice(0, 300), m.tx);
      }
      return this.credit(r, m.tx, r.status);
    }
    if (m.kind === 'ambiguous') return this.toReview(r, 'varios_pagos_coinciden');
    // Sin pago todavía: esperar al feed y luego, revisión humana.
    const waitedMs = this.now().getTime() - r.createdAt.getTime();
    if (waitedMs >= s.waitBankMinutes * 60_000) return this.toReview(r, 'pago_no_encontrado');
    if (r.status !== 'waiting_bank') {
      const next = { ...r, status: 'waiting_bank' as const, reason: 'esperando_banco', updatedAt: this.now() };
      if (await this.repo.transitionReceipt(next, [r.status])) {
        if (first) await this.notify(next, 'waiting_bank');
        return next;
      }
    }
    return r;
  }

  private async toReview(r: Receipt, reason: string, tx?: BankTx): Promise<Receipt> {
    const next: Receipt = { ...r, status: 'pending_review', reason, ...(tx ? { bankTxId: tx.id } : {}), updatedAt: this.now() };
    if (!(await this.repo.transitionReceipt(next, [r.status]))) return (await this.repo.findReceipt(r.operatorId, r.id)) ?? r;
    await this.notify(next, 'pending_review');
    return next;
  }

  /** Reserva atómica del movimiento + depósito idempotente (`pearl:<id>`). Un fallo técnico deja el caso a un humano. */
  private async credit(r: Receipt, tx: BankTx | null, from: ReceiptStatus): Promise<Receipt> {
    if (!this.opts.deposits) return this.toReview(r, 'acreditacion_no_disponible', tx ?? undefined);
    if (tx && !(await this.repo.claimBankTx(r.operatorId, tx.id, r.id))) return this.toReview(r, 'pago_ya_utilizado');
    try {
      const dep = await this.opts.deposits.credit({
        operatorId: r.operatorId, playerId: r.playerId!, currency: r.currency, amount: r.amount!, reference: `pearl:${r.id}`, ...(tx ? { externalId: `${tx.feedId}:${tx.externalId}` } : {}),
      });
      const next: Receipt = { ...r, status: 'credited', reason: undefined, bankTxId: tx?.id ?? r.bankTxId, depositId: dep.depositId, updatedAt: this.now() };
      await this.repo.transitionReceipt(next, [from]);
      await this.notify(next, 'credited');
      return next;
    } catch (e) {
      if (tx) await this.repo.releaseBankTx(r.operatorId, tx.id, r.id);
      const code = e instanceof ExternalDepositError ? e.code : 'ERROR';
      this.opts.logger.error('[pearl] acreditación fallida', { receiptId: r.id, code, error: (e as Error).message });
      const next: Receipt = { ...r, status: e instanceof ExternalDepositError ? 'pending_review' : 'error', reason: `acreditacion: ${code}`, updatedAt: this.now() };
      await this.repo.transitionReceipt(next, [from]);
      await this.notify(next, 'pending_review');
      return next;
    }
  }

  private async duplicateOf(prev: Receipt): Promise<Receipt> {
    await this.notify(prev, 'duplicate');
    return { ...prev, status: 'duplicate' };
  }

  private receiptDate(x: ExtractedReceipt, s: PearlSettings): Date | null {
    if (!x.date || !/^\d{4}-\d{2}-\d{2}$/.test(x.date)) return null;
    const t = x.time && /^\d{2}:\d{2}$/.test(x.time) ? x.time : '12:00';
    const d = new Date(`${x.date}T${t}:00Z`);
    return Number.isNaN(d.getTime()) ? null : new Date(d.getTime() - s.utcOffsetMinutes * 60_000);
  }

  private async notify(r: Receipt, outcome: PearlOutcome) {
    try {
      await this.notifier?.(r, outcome);
    } catch (e) {
      this.opts.logger.warn('[pearl] aviso al contacto fallido', { receiptId: r.id, error: (e as Error).message });
    }
  }
}
