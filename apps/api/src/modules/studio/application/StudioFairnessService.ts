import { randomUUID } from 'crypto';
import { HttpError, notFound } from '../../shared/http/errors';
import { createFairRng, createSeedPair, generateClientSeed, verifyRound } from '../domain/fairness/ProvablyFair';
import { GameParamError, rtpToProfile } from '../domain/originals';
import type { RoundRepository, SeedPairRepository, StudioSeedPair } from '../domain/rounds/types';
import { findGame } from './catalog';

export interface FairnessView {
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

export interface ReservedNonce {
  seedPairId: string;
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

export interface VerifyInput {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  gameId: string;
  serverSeedHash?: string;
  params?: Record<string, unknown>;
  /** RTP (fracción) con el que se jugó la ronda; por defecto el del juego. */
  rtp?: number;
  rtpProfile?: string;
  bonusBuy?: boolean;
  /** Si se indica, se coteja con la ronda guardada (hash, clientSeed, nonce, parámetros y resultado). */
  roundId?: string;
}

const CLIENT_SEED_RE = /^[\x21-\x7e]{1,64}$/;

/** Pares de semillas por jugador: serverSeed oculto (solo su hash es público) hasta la rotación. */
export class StudioFairnessService {
  constructor(
    private readonly seeds: SeedPairRepository,
    private readonly rounds: RoundRepository,
  ) {}

  async active(operatorId: string, playerId: string): Promise<StudioSeedPair> {
    const current = await this.seeds.getActive(operatorId, playerId);
    if (current) return current;
    const { serverSeed, serverSeedHash } = createSeedPair();
    return this.seeds.create({
      id: randomUUID(),
      operatorId,
      playerId,
      serverSeed,
      serverSeedHash,
      clientSeed: generateClientSeed(),
      nonce: 0,
      active: true,
      createdAt: new Date(),
      revealedAt: null,
    });
  }

  async view(operatorId: string, playerId: string): Promise<FairnessView> {
    const p = await this.active(operatorId, playerId);
    return { serverSeedHash: p.serverSeedHash, clientSeed: p.clientSeed, nonce: p.nonce };
  }

  async setClientSeed(operatorId: string, playerId: string, clientSeed: string): Promise<FairnessView> {
    if (!CLIENT_SEED_RE.test(clientSeed)) throw new HttpError(400, 'BAD_REQUEST', 'clientSeed: 1–64 caracteres ASCII visibles');
    await this.ensureNoOpenRounds(operatorId, playerId);
    const p = await this.active(operatorId, playerId);
    await this.seeds.setClientSeed(p.id, clientSeed);
    return { serverSeedHash: p.serverSeedHash, clientSeed, nonce: p.nonce };
  }

  /** Revela el serverSeed actual y crea un par nuevo (conserva el clientSeed salvo que se indique otro). */
  async rotate(operatorId: string, playerId: string, clientSeed?: string): Promise<{ previous: StudioSeedPair; current: FairnessView }> {
    if (clientSeed !== undefined && !CLIENT_SEED_RE.test(clientSeed)) {
      throw new HttpError(400, 'BAD_REQUEST', 'clientSeed: 1–64 caracteres ASCII visibles');
    }
    await this.ensureNoOpenRounds(operatorId, playerId);
    const prev = await this.active(operatorId, playerId);
    const at = new Date();
    await this.seeds.deactivate(prev.id, at);
    const { serverSeed, serverSeedHash } = createSeedPair();
    const next = await this.seeds.create({
      id: randomUUID(),
      operatorId,
      playerId,
      serverSeed,
      serverSeedHash,
      clientSeed: clientSeed ?? prev.clientSeed,
      nonce: 0,
      active: true,
      createdAt: at,
      revealedAt: null,
    });
    return {
      previous: { ...prev, active: false, revealedAt: at },
      current: { serverSeedHash: next.serverSeedHash, clientSeed: next.clientSeed, nonce: next.nonce },
    };
  }

  /** Reserva el siguiente nonce del par activo (atómico). */
  async reserve(operatorId: string, playerId: string): Promise<ReservedNonce> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const p = await this.active(operatorId, playerId);
      const nonce = await this.seeds.consumeNonce(p.id);
      if (nonce !== null) {
        return { seedPairId: p.id, serverSeed: p.serverSeed, serverSeedHash: p.serverSeedHash, clientSeed: p.clientSeed, nonce };
      }
    }
    throw new HttpError(409, 'SEED_ROTATING', 'Semilla en rotación, reintenta');
  }

  /** serverSeed revelado de un par (null si sigue activo). */
  async revealed(seedPairId: string): Promise<string | null> {
    const p = await this.seeds.get(seedPairId);
    return p && !p.active ? p.serverSeed : null;
  }

  /** Verificación pública: recalcula el resultado desde las semillas. */
  async verify(input: VerifyInput) {
    const g = findGame(input.gameId);
    if (!g) throw notFound(`Juego desconocido: ${input.gameId}`);
    const round = input.roundId ? await this.rounds.get(input.roundId) : null;
    if (input.roundId && !round) throw notFound('Ronda no encontrada');
    const expectedHash = input.serverSeedHash ?? round?.serverSeedHash;
    const params = input.params ?? round?.params ?? {};
    const rtp = input.rtp ?? round?.rtp ?? g.rtpTarget;
    const rtpProfile = input.rtpProfile ?? round?.rtpProfile ?? (g.kind === 'original' ? rtpToProfile(rtp) : undefined);
    const bonusBuy = input.bonusBuy ?? round?.bonusBuy ?? false;
    const check = verifyRound({ serverSeed: input.serverSeed, serverSeedHash: expectedHash ?? '', clientSeed: input.clientSeed, nonce: input.nonce });
    const rng = createFairRng(input.serverSeed, input.clientSeed, input.nonce);

    let outcome: unknown;
    let multiplier: number | undefined;
    try {
      if (g.interactive && (!g.math || (round && round.state !== null))) {
        outcome = g.interactive.verify(rng, params, { rtp });
      } else {
        const r = g.math!.play(rng, { params, rtpProfile: rtpProfile ?? undefined, bonusBuy });
        outcome = r.outcome;
        multiplier = r.multiplier;
      }
    } catch (e) {
      if (e instanceof GameParamError) throw new HttpError(400, 'INVALID_PARAMS', e.message);
      throw e;
    }

    const roundCheck = round
      ? {
          roundId: round.id,
          clientSeedMatches: round.clientSeed === input.clientSeed,
          nonceMatches: round.nonce === input.nonce,
          ...(multiplier !== undefined && round.status === 'SETTLED'
            ? { outcomeMatches: JSON.stringify(round.outcome) === JSON.stringify(outcome), multiplierMatches: round.multiplier === multiplier }
            : {}),
        }
      : undefined;

    return {
      gameId: g.id,
      computedHash: check.computedHash,
      serverSeedHash: expectedHash ?? null,
      hashMatches: expectedHash ? check.valid : null,
      nonce: input.nonce,
      clientSeed: input.clientSeed,
      floats: check.floats,
      outcome,
      ...(multiplier !== undefined ? { multiplier } : {}),
      ...(roundCheck ? { round: roundCheck } : {}),
    };
  }

  private async ensureNoOpenRounds(operatorId: string, playerId: string): Promise<void> {
    if ((await this.rounds.countOpen(operatorId, playerId)) > 0) {
      throw new HttpError(409, 'ROUND_OPEN', 'Termina las rondas abiertas antes de cambiar la semilla');
    }
  }
}
