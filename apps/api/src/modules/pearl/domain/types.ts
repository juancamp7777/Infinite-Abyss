/** Pearl: caja asistida. Comprobantes conciliados contra el feed bancario del operador. */

export type FeedType = 'quikipay' | 'hgcash' | 'generic';
export type BankTxStatus = 'available' | 'used' | 'ignored';
/**
 * credited = fichas cargadas · pending_review = a revisión humana · waiting_bank = el pago aún no llegó al feed
 * needs_info = falta un dato del contacto · rejected · duplicate · error = fallo técnico (revisión humana)
 */
export type ReceiptStatus = 'credited' | 'pending_review' | 'waiting_bank' | 'needs_info' | 'rejected' | 'duplicate' | 'error';

export interface PearlSettings {
  operatorId: string;
  /** auto = acredita sola si todo cuadra; review_all = todo pasa por un humano. */
  mode: 'auto' | 'review_all';
  currency: string;
  /** Tope de acreditación automática (unidades mínimas); por encima, revisión humana. */
  autoMaxAmount: bigint;
  minAmount: bigint;
  /** Antigüedad máxima del comprobante. */
  maxAgeHours: number;
  /** Cuánto esperar a que el pago aparezca en el feed antes de pasar a revisión. */
  waitBankMinutes: number;
  /** Desfase horario de los comprobantes respecto a UTC (Argentina: -180). */
  utcOffsetMinutes: number;
  /** Crear la cuenta de casino del lead que manda su primer comprobante (y enviarle usuario y contraseña). */
  autoRegisterLeads: boolean;
  updatedAt: Date;
}

export interface BankAccount {
  id: string;
  operatorId: string;
  holderName: string;
  alias?: string;
  accountNumber: string;
  /** Clave del método de cobro (ver accountMethods) o el nombre libre de cuentas antiguas. */
  bank?: string;
  country?: string;
  holderDocument?: string;
  bankName?: string;
  active: boolean;
  createdAt: Date;
}

export interface Feed {
  id: string;
  operatorId: string;
  type: FeedType;
  name: string;
  /** sha256 del token de la URL del webhook (el token en claro se muestra una sola vez). */
  tokenHash: string;
  enabled: boolean;
  lastEventAt?: Date;
  createdAt: Date;
}

export interface BankTx {
  id: string;
  operatorId: string;
  feedId: string;
  externalId: string;
  amount: bigint;
  currency: string;
  senderName: string;
  senderTaxId?: string;
  senderAccount?: string;
  receiverAccount?: string;
  occurredAt: Date;
  status: BankTxStatus;
  receiptId?: string;
  createdAt: Date;
}

/** Datos leídos del comprobante (por IA o cargados por un cajero). */
export interface ExtractedReceipt {
  amount: string;
  /** YYYY-MM-DD */
  date?: string;
  /** HH:MM (hora local del comprobante) */
  time?: string;
  senderName: string;
  senderTaxId?: string;
  receiverAccount?: string;
  /** Captura que no es un comprobante terminado (p. ej. pantalla de "confirmar transferencia"). */
  notAReceipt?: boolean;
  /** Indicios de edición detectados al leer la imagen. */
  tamperSignals?: string[];
}

export interface Check {
  code: string;
  ok: boolean;
  detail?: string;
}

export interface Receipt {
  id: string;
  operatorId: string;
  conversationId?: string;
  playerId?: string;
  imageHash?: string;
  extracted: ExtractedReceipt;
  /** Clave normalizada fecha·hora·monto·titular. */
  key?: string;
  amount?: bigint;
  currency: string;
  status: ReceiptStatus;
  reason?: string;
  checks: Check[];
  bankTxId?: string;
  depositId?: string;
  /** Imagen en Sonar (adjunto del mensaje). */
  attachmentId?: string;
  source: 'ai' | 'manual';
  reviewerId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PearlRepository {
  getSettings(operatorId: string): Promise<PearlSettings | null>;
  saveSettings(s: PearlSettings): Promise<PearlSettings>;
  listAccounts(operatorId: string): Promise<BankAccount[]>;
  saveAccount(a: BankAccount): Promise<BankAccount>;
  deleteAccount(operatorId: string, id: string): Promise<boolean>;
  listFeeds(operatorId: string): Promise<Feed[]>;
  findFeed(id: string): Promise<Feed | null>;
  saveFeed(f: Feed): Promise<Feed>;
  deleteFeed(operatorId: string, id: string): Promise<boolean>;
  /** Idempotente por (feedId, externalId): `created=false` si ya existía. */
  insertBankTx(tx: BankTx): Promise<{ tx: BankTx; created: boolean }>;
  listBankTxs(operatorId: string, f: { status?: BankTxStatus; since?: Date; amount?: bigint; limit: number }): Promise<BankTx[]>;
  findBankTx(operatorId: string, id: string): Promise<BankTx | null>;
  /** Atómico: available → used. false si otro proceso ya lo tomó. */
  claimBankTx(operatorId: string, id: string, receiptId: string): Promise<boolean>;
  releaseBankTx(operatorId: string, id: string, receiptId: string): Promise<void>;
  findReceipt(operatorId: string, id: string): Promise<Receipt | null>;
  findReceiptBy(operatorId: string, f: { imageHash?: string; key?: string }): Promise<Receipt | null>;
  /** Alta: lanza DUPLICATE_RECEIPT si choca la huella de imagen o la clave normalizada. */
  insertReceipt(r: Receipt): Promise<Receipt>;
  /** Cambio de estado atómico (solo si sigue en `from`). */
  transitionReceipt(r: Receipt, from: ReceiptStatus[]): Promise<boolean>;
  listReceipts(operatorId: string, f: { status?: ReceiptStatus; limit: number }): Promise<Receipt[]>;
  waitingReceipts(limit: number): Promise<Receipt[]>;
  latestReceiptForConversation(operatorId: string, conversationId: string): Promise<Receipt | null>;
  getAi(operatorId: string): Promise<AiConfig | null>;
  saveAi(c: AiConfig): Promise<AiConfig>;
  /** Titulares con los que el jugador ya pagó antes (nombres conocidos). */
  knownSenderNames(operatorId: string, playerId: string): Promise<string[]>;
}

export const DUPLICATE_RECEIPT = 'DUPLICATE_RECEIPT';

/** IA del operador: proveedor, modelos y API key cifrada (nunca sale por la API). */
export interface AiConfig {
  operatorId: string;
  enabled: boolean;
  provider: 'anthropic' | 'gemini' | 'deepseek';
  readerModel: string;
  judgeModel: string;
  keyEnc?: string;
  updatedAt: Date;
}
