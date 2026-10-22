import { HttpError, notFound } from '../../shared/http/errors';
import type { OperatorConfigRepository, StudioOperatorConfig } from '../domain/rounds/types';
import { rtpToProfile } from '../domain/originals';
import { defaultProfile, findGame, listGames, rtpMode, StudioGameEntry } from './catalog';

/** Configuración efectiva de un juego para un operador. */
export interface EffectiveGameConfig {
  operatorId: string;
  gameId: string;
  enabled: boolean;
  /** RTP efectivo (fracción). */
  rtp: number;
  /** Perfil que se pasa a GameMath.play (porcentaje como string) o undefined = por defecto. */
  rtpProfile?: string;
  minBet: bigint | null;
  maxBet: bigint | null;
  rtpMode: 'range' | 'profiles' | 'fixed';
  rtpRange?: { min: number; max: number };
  rtpProfiles?: string[];
  defaultRtp: number;
  customized: boolean;
}

export interface ConfigUpdate {
  gameId: string;
  rtp?: number | null;
  rtpProfile?: string | null;
  minBet?: bigint | null;
  maxBet?: bigint | null;
  enabled?: boolean;
}

const rtpError = (msg: string, details?: unknown) => new HttpError(400, 'RTP_OUT_OF_RANGE', msg, details);

export class StudioConfigService {
  constructor(private readonly repo: OperatorConfigRepository) {}

  private effective(g: StudioGameEntry, operatorId: string, c: StudioOperatorConfig | null): EffectiveGameConfig {
    const mode = rtpMode(g);
    let rtp = g.rtpTarget;
    let rtpProfile: string | undefined;
    if (mode === 'range' && c?.rtp != null) {
      rtp = c.rtp;
      rtpProfile = rtpToProfile(c.rtp);
    } else if (mode === 'profiles' && c?.rtpProfile) {
      rtpProfile = c.rtpProfile;
      rtp = Number(c.rtpProfile) / 100;
    }
    return {
      operatorId,
      gameId: g.id,
      enabled: c?.enabled ?? true,
      rtp,
      rtpProfile,
      minBet: c?.minBet ?? null,
      maxBet: c?.maxBet ?? null,
      rtpMode: mode,
      rtpRange: g.rtpRange,
      rtpProfiles: g.rtpProfiles,
      defaultRtp: g.rtpTarget,
      customized: !!c,
    };
  }

  async resolve(operatorId: string, gameId: string): Promise<EffectiveGameConfig> {
    const g = findGame(gameId);
    if (!g) throw notFound(`Juego desconocido: ${gameId}`);
    return this.effective(g, operatorId, await this.repo.get(operatorId, gameId));
  }

  async list(operatorId: string): Promise<EffectiveGameConfig[]> {
    const saved = new Map((await this.repo.list(operatorId)).map((c) => [c.gameId, c]));
    return listGames().map((g) => this.effective(g, operatorId, saved.get(g.id) ?? null));
  }

  /** Valida y guarda. Rechaza RTP fuera de rango o perfiles no soportados con 400 RTP_OUT_OF_RANGE. */
  async update(operatorId: string, u: ConfigUpdate): Promise<EffectiveGameConfig> {
    const g = findGame(u.gameId);
    if (!g) throw notFound(`Juego desconocido: ${u.gameId}`);
    const prev = await this.repo.get(operatorId, u.gameId);
    const mode = rtpMode(g);
    let rtp = u.rtp === undefined ? prev?.rtp ?? null : u.rtp;
    let rtpProfile = u.rtpProfile === undefined ? prev?.rtpProfile ?? null : u.rtpProfile;

    if (mode === 'range') {
      if (rtp === null && rtpProfile !== null) rtp = Number(rtpProfile) / 100;
      if (rtp !== null) {
        const range = g.rtpRange!;
        const rounded = Math.round(rtp * 10000) / 10000;
        if (!Number.isFinite(rtp) || Math.abs(rounded - rtp) > 1e-9 || rtp < range.min - 1e-9 || rtp > range.max + 1e-9) {
          throw rtpError(`RTP fuera del rango permitido (${range.min}–${range.max}, 4 decimales)`, { range });
        }
        rtp = rounded;
      }
      rtpProfile = null;
    } else if (mode === 'profiles') {
      if (rtpProfile === null && rtp !== null) rtpProfile = g.rtpProfiles!.find((p) => Math.abs(Number(p) / 100 - rtp!) < 1e-9) ?? `rtp:${rtp}`;
      if (rtpProfile !== null && !g.rtpProfiles!.includes(rtpProfile)) {
        throw rtpError('Perfil de RTP no soportado por el juego', { profiles: g.rtpProfiles });
      }
      rtp = null;
    } else {
      const wanted = rtp ?? (rtpProfile !== null ? Number(rtpProfile) / 100 : null);
      if (wanted !== null && Math.abs(wanted - g.rtpTarget) > 1e-6) {
        throw rtpError('El juego solo admite su RTP por defecto', { rtp: g.rtpTarget, profile: defaultProfile(g) });
      }
      rtp = null;
      rtpProfile = null;
    }

    const minBet = u.minBet === undefined ? prev?.minBet ?? null : u.minBet;
    const maxBet = u.maxBet === undefined ? prev?.maxBet ?? null : u.maxBet;
    if (minBet !== null && maxBet !== null && minBet > maxBet) throw new HttpError(400, 'BAD_REQUEST', 'minBet no puede superar maxBet');

    const saved = await this.repo.upsert({
      operatorId,
      gameId: g.id,
      rtp,
      rtpProfile,
      minBet,
      maxBet,
      enabled: u.enabled ?? prev?.enabled ?? true,
      updatedAt: new Date(),
    });
    return this.effective(g, operatorId, saved);
  }
}
