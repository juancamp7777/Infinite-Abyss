import { Server } from 'socket.io';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

export type CrashState = 'WAITING' | 'CRASHING' | 'CRASHED';

export class CrashGameEngine {
  private static instance: CrashGameEngine;
  private io: Server | null = null;
  
  public state: CrashState = 'WAITING';
  public currentMultiplier: number = 1.00;
  public crashPoint: number = 1.00;
  public currentRoundId: string = '';
  
  private startTime: number = 0;
  private timeoutId: NodeJS.Timeout | null = null;

  private constructor() {}

  public static getInstance(): CrashGameEngine {
    if (!CrashGameEngine.instance) {
      CrashGameEngine.instance = new CrashGameEngine();
    }
    return CrashGameEngine.instance;
  }

  /** Detiene el ciclo de rondas (apagado ordenado y tests). */
  public stop() {
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.timeoutId = null;
  }

  public initialize(io: Server) {
    this.io = io;
    this.startWaitingPhase();
  }

  private startWaitingPhase() {
    this.state = 'WAITING';
    this.currentMultiplier = 1.00;
    this.currentRoundId = uuidv4();
    
    // Clear any existing timeouts to prevent memory leaks or dual-loops
    if (this.timeoutId) clearTimeout(this.timeoutId);
    
    // Broadcast waiting status
    if (this.io) {
      this.io.emit('crash:state', {
        state: this.state,
        timeUntilNext: 5,
        roundId: this.currentRoundId
      });
    }

    this.timeoutId = setTimeout(() => this.startGame(), 5000);
  }

  private startGame() {
    this.state = 'CRASHING';
    this.crashPoint = this.generateCrashPoint();
    this.startTime = Date.now();
    
    const tick = () => {
      if (this.state !== 'CRASHING') return;

      const elapsedMs = Date.now() - this.startTime;
      // Exponential curve: multiplier = Math.pow(Math.E, 0.00006 * elapsedMs)
      this.currentMultiplier = Math.max(1.00, Number(Math.pow(Math.E, 0.00006 * elapsedMs).toFixed(2)));

      if (this.currentMultiplier >= this.crashPoint) {
        this.crash();
        return;
      }

      if (this.io) {
        this.io.emit('crash:tick', { multiplier: this.currentMultiplier });
      }

      this.timeoutId = setTimeout(tick, 100);
    };

    tick();
  }

  private crash() {
    this.state = 'CRASHED';
    this.currentMultiplier = this.crashPoint;

    if (this.timeoutId) clearTimeout(this.timeoutId);

    if (this.io) {
      this.io.emit('crash:crashed', { crashPoint: this.crashPoint });
    }

    this.timeoutId = setTimeout(() => this.startWaitingPhase(), 3000); // Wait 3 seconds before next round
  }

  private generateCrashPoint(): number {
    // E.g., 1% instant crash, otherwise 0.99 / random
    // We want a provably fair style generation
    const hash = crypto.randomBytes(32).toString('hex');
    const h = parseInt(hash.slice(0, 13), 16);
    const e = Math.pow(2, 52);

    const point = (100 * e - h) / (e - h);
    
    // Floor to 2 decimals, max 1000x for safety
    return Math.min(1000, Math.max(1.00, Math.floor(point) / 100));
  }
}

export const crashEngine = CrashGameEngine.getInstance();
