import { HttpError } from '../../shared/http/errors';
import { COL, GamiContext, loadSettings } from './context';
import type { RewardService } from './rewards';
import { WheelPrize, validateWheel } from '../domain/types';

interface WheelState {
  lastSpinAt: number;
  spinKey: string;
  prizeId: string;
  paid: boolean;
}

/**
 * Rueda diaria. El resultado usa RNG criptográfico (crypto.randomInt) y NO provably fair: es un premio promocional
 * de valor esperado acotado (maxExpectedValue), no una apuesta con dinero del jugador, por lo que no requiere
 * verificación pública; la auditoría se hace por el registro de pagos (gami:wheel:<jugador>:<instante>).
 */
export class WheelService {
  constructor(private readonly ctx: GamiContext, private readonly rewards: RewardService) {}

  async status(op: string, player: string) {
    const s = await loadSettings(this.ctx, op);
    const st = await this.ctx.store.get<WheelState>(COL.wheel, op, player);
    const cooldownMs = s.wheel.cooldownHours * 3_600_000;
    const next = st ? st.lastSpinAt + cooldownMs : 0;
    return {
      enabled: s.wheel.enabled,
      canSpin: s.wheel.enabled && this.ctx.clock() >= next,
      nextSpinAt: next > this.ctx.clock() ? next : null,
      prizes: s.wheel.prizes.map((p) => ({ id: p.id, label: p.label, weight: p.weight, reward: p.reward })),
    };
  }

  async spin(op: string, player: string) {
    return this.ctx.locks.run(`wheel:${op}:${player}`, async () => {
      const s = await loadSettings(this.ctx, op);
      if (!s.wheel.enabled) throw new HttpError(409, 'WHEEL_DISABLED', 'La rueda está desactivada');
      const invalid = validateWheel(s.wheel);
      if (invalid) throw new HttpError(409, 'WHEEL_MISCONFIGURED', invalid);
      const now = this.ctx.clock();
      const cooldownMs = s.wheel.cooldownHours * 3_600_000;
      let st = await this.ctx.store.get<WheelState>(COL.wheel, op, player);
      let resumed = false;
      if (st && now < st.lastSpinAt + cooldownMs) {
        if (st.paid) throw new HttpError(429, 'WHEEL_COOLDOWN', 'Ya giraste la rueda hoy', { nextSpinAt: st.lastSpinAt + cooldownMs });
        resumed = true; // giro previo con pago pendiente: se completa el mismo premio
      } else {
        const prize = this.pick(s.wheel.prizes);
        st = { lastSpinAt: now, spinKey: `gami:wheel:${player}:${now}`, prizeId: prize.id, paid: false };
        await this.ctx.store.put(COL.wheel, op, player, st, player);
      }
      const prize = s.wheel.prizes.find((p) => p.id === st!.prizeId) ?? s.wheel.prizes[0];
      await this.rewards.pay(op, player, prize.reward, st.spinKey, 'wheel');
      st.paid = true;
      await this.ctx.store.put(COL.wheel, op, player, st, player);
      return { prize: { id: prize.id, label: prize.label, reward: prize.reward }, nextSpinAt: st.lastSpinAt + cooldownMs, resumed };
    });
  }

  private pick(prizes: WheelPrize[]): WheelPrize {
    const total = prizes.reduce((a, p) => a + p.weight, 0);
    let r = this.ctx.rng.int(total);
    for (const p of prizes) {
      if (r < p.weight) return p;
      r -= p.weight;
    }
    return prizes[prizes.length - 1];
  }
}
