import { io, Socket } from "socket.io-client";
import { refreshSession, socketTarget, tokens, api, type Balances } from "./api";
import { formatMoney, parseMinor } from "./money";

export type SpinResult = { number: number; color: "red" | "black" | "green"; payout?: string };
export type SlotResult = { reels: string[]; payoutMultiplier: number };
export type BlackjackSession = { id: string; status: string; playerScore: number; dealerScore: number; playerCards: { rank: string; suit: string; value: number }[]; dealerCards: { rank: string; suit: string; value: number }[] };
export type MinesSession = { id: string; status: string; revealed: boolean[]; numMines: number; multiplier: number; revealedDiamonds: number; grid: boolean[] };

/** Respuesta cruda del servidor: los montos llegan como strings de dígitos (unidades mínimas). */
type RawResponse =
  | { success: true; data: Record<string, unknown> & { newBalance?: string; payout?: string } }
  | { success: false; error: { message: string; code?: string | number; errorCode?: string } };

/** Datos ya tipados: payout y newBalance como bigint (unidades mínimas). */
type WithMoney<T> = T & { payout: bigint; newBalance?: bigint };

const ACK_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 3;

function newRequestId(): string {
  return crypto.randomUUID();
}

export class CasinoSDK {
  private static instance: CasinoSDK;
  public socket: Socket | null = null;

  /** Saldo en unidades mínimas, siempre proveniente del servidor. */
  public balance: bigint = BigInt(0);
  public currency = "COP";
  public decimals = 2;
  public isConnected = false;
  public isAuthenticated = false;
  private listeners: Set<() => void> = new Set();
  private unsubscribeTokens: (() => void) | null = null;
  private started = false;

  // Crash global
  public crashState = "WAITING";
  public crashMultiplier = 1.0;
  public crashNextTime = 5;

  private constructor() {}

  public static getInstance(): CasinoSDK {
    if (!CasinoSDK.instance) CasinoSDK.instance = new CasinoSDK();
    return CasinoSDK.instance;
  }

  /** Arranca el SDK (solo en el navegador): escucha el token y conecta el socket cuando existe. */
  public start() {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    this.unsubscribeTokens = tokens.onAccessChange((token) => {
      if (token) {
        this.isAuthenticated = true;
        this.connect();
        void this.refreshBalance();
      } else {
        this.disconnect();
      }
      this.notifyListeners();
    });
    if (tokens.getAccess()) {
      this.isAuthenticated = true;
      this.connect();
      void this.refreshBalance();
    }
  }

  public setFormat(currency: string, decimals: number) {
    this.currency = currency;
    this.decimals = decimals;
    this.notifyListeners();
  }

  public format(minor: bigint): string {
    return formatMoney(minor, this.currency, this.decimals);
  }

  /** Lee el saldo de /api/me (fuente de verdad del servidor). */
  public async refreshBalance() {
    try {
      const me = await api.get<{ balances?: Balances }>("/api/me");
      if (me.balances?.cash !== undefined) this.balance = parseMinor(me.balances.cash);
      if (typeof me.balances?.currency === "string") this.currency = me.balances.currency;
      this.notifyListeners();
    } catch {
      /* se reintentará en la próxima operación */
    }
  }

  private connect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    const target = socketTarget();
    const socket = io(target.url, {
      path: target.path,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      // websocket primero con respaldo a polling (proxies que no pasan Upgrade).
      transports: ["websocket", "polling"],
      // Función: cada reconexión usa el access token más reciente (nunca un userId del cliente).
      auth: (cb) => cb({ token: tokens.getAccess() ?? "", host: window.location.host }),
    });
    this.socket = socket;

    socket.on("connect", () => {
      this.isConnected = true;
      this.notifyListeners();
    });
    socket.on("disconnect", () => {
      this.isConnected = false;
      this.notifyListeners();
    });
    socket.on("connect_error", async (err: Error) => {
      this.isConnected = false;
      this.notifyListeners();
      if (/UNAUTHORIZED/i.test(err.message)) {
        // Token vencido: renueva y reconecta una vez; si falla, la sesión termina.
        socket.disconnect();
        const fresh = await refreshSession();
        if (fresh && this.socket === socket) socket.connect();
      }
    });

    socket.on("crash:state", (data: { state: string; timeUntilNext: number }) => {
      this.crashState = data.state;
      this.crashNextTime = data.timeUntilNext;
      if (this.crashState === "WAITING") this.crashMultiplier = 1.0;
      this.notifyListeners();
    });
    socket.on("crash:tick", (data: { multiplier: number }) => {
      this.crashState = "CRASHING";
      this.crashMultiplier = data.multiplier;
      this.notifyListeners();
    });
    socket.on("crash:crashed", (data: { crashPoint: number }) => {
      this.crashState = "CRASHED";
      this.crashMultiplier = data.crashPoint;
      this.notifyListeners();
    });
  }

  private disconnect() {
    this.socket?.disconnect();
    this.socket = null;
    this.isConnected = false;
    this.isAuthenticated = false;
    this.balance = BigInt(0);
  }

  /**
   * Emite un evento y espera el ack. Si se agota el tiempo o no hay conexión se reintenta con el
   * MISMO requestId (el servidor es idempotente), nunca con uno nuevo.
   */
  private async call<T>(event: string, payload: Record<string, unknown>, opts: { retry: boolean; requestId?: string }): Promise<WithMoney<T>> {
    const requestId = opts.requestId ?? newRequestId();
    const body = { ...payload, requestId };
    const attempts = opts.retry ? MAX_ATTEMPTS : 1;
    let lastError = "Sin conexión con el servidor";

    for (let attempt = 0; attempt < attempts; attempt++) {
      const socket = this.socket;
      if (socket && socket.connected) {
        try {
          const res = (await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(event, body)) as RawResponse;
          if (!res.success) throw new RemoteError(res.error?.message ?? "Error desconocido");
          const data = res.data;
          const out = { ...data, payout: parseMinor(data.payout) } as WithMoney<T>;
          if (data.newBalance !== undefined) {
            out.newBalance = parseMinor(data.newBalance);
            this.balance = out.newBalance;
            this.notifyListeners();
          }
          return out;
        } catch (e) {
          if (e instanceof RemoteError) throw e.message;
          lastError = "El servidor no respondió a tiempo";
        }
      }
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 1500));
    }
    throw lastError;
  }

  /** Apuesta: comprueba el saldo localmente, descuenta de forma optimista y revierte si falla. */
  private async bet<T>(event: string, amount: bigint, extra: Record<string, unknown>): Promise<WithMoney<T>> {
    if (amount <= BigInt(0)) throw "Monto inválido";
    if (this.balance < amount) throw "Saldo insuficiente";
    const before = this.balance;
    this.balance -= amount;
    this.notifyListeners();
    try {
      return await this.call<T>(event, { amount: amount.toString(), ...extra }, { retry: true });
    } catch (e) {
      // Si no hubo newBalance del servidor, se restaura el saldo previo y se confirma con /api/me.
      this.balance = before;
      this.notifyListeners();
      void this.refreshBalance();
      throw e;
    }
  }

  // --- ROULETTE ---
  public placeRouletteBet(type: string, value: number | string, amount: bigint) {
    return this.bet<{ result: SpinResult }>("placeBet", amount, { type, value });
  }

  // --- SLOTS ---
  public playSlots(amount: bigint) {
    return this.bet<{ result: SlotResult }>("playSlots", amount, {});
  }

  // --- BLACKJACK ---
  public startBlackjack(amount: bigint) {
    return this.bet<{ session: BlackjackSession }>("blackjack:start", amount, {});
  }
  public hitBlackjack(sessionId: string) {
    return this.call<{ session: BlackjackSession }>("blackjack:hit", { sessionId }, { retry: false });
  }
  public standBlackjack(sessionId: string) {
    return this.call<{ session: BlackjackSession }>("blackjack:stand", { sessionId }, { retry: false });
  }

  // --- MINES ---
  public startMines(amount: bigint, numMines: number) {
    return this.bet<{ session: MinesSession }>("mines:start", amount, { numMines });
  }
  public revealMine(sessionId: string, index: number) {
    return this.call<{ session: MinesSession; isMine: boolean }>("mines:reveal", { sessionId, index }, { retry: false });
  }
  public cashoutMines(sessionId: string) {
    return this.call<{ session: MinesSession }>("mines:cashout", { sessionId }, { retry: false });
  }

  // --- CRASH ---
  public placeCrashBet(amount: bigint) {
    return this.bet<{ session: { id: string; betAmount: string } }>("crash:placeBet", amount, {});
  }
  public cashoutCrash(sessionId: string) {
    return this.call<{ session: unknown }>("crash:cashout", { sessionId }, { retry: false });
  }

  // --- PLINKO ---
  public dropPlinko(amount: bigint, rows: 8 | 12 | 16, risk: "LOW" | "MEDIUM" | "HIGH") {
    return this.bet<{ session: unknown; result: { path: ("L" | "R")[]; bin: number; multiplier: number } }>("plinko:drop", amount, { rows, risk });
  }

  public subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners() {
    this.listeners.forEach((listener) => listener());
  }
}

class RemoteError {
  constructor(public message: string) {}
}

export const casinoSDK = CasinoSDK.getInstance();
