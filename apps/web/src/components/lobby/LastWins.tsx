'use client';
import { useT } from "@/lib/i18n";
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { assetUrl } from '@/lib/lobby/api';
import { fallbackThumb, formatMoney } from '@/lib/lobby/format';
import { useLiveBets } from '@/lib/lobby/liveBets';
import { profitOf } from '@/lib/lobby/liveFeed';
import type { Game } from '@/lib/lobby/types';

const MAX = 14;

/** Tira de últimas ganancias reales (feed en vivo): solo apuestas con ganancia neta positiva. */
export function LastWins({ games }: { games: Game[] }) {
  const { t } = useT();
  const { lists, connected, fresh } = useLiveBets();
  const thumbs = new Map(games.map((g) => [g.id, assetUrl(g.images?.thumb)]));
  const wins = lists.all.filter((b) => profitOf(b) > BigInt(0)).slice(0, MAX);
  return (
    <section aria-label={t("Últimas ganancias")} className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--nf-win)] text-[#04130a]"><Sparkles aria-hidden className="h-4 w-4" /></span>
          {t("Últimas ganancias")}
        </h2>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-[var(--nf-muted)]">
          <span aria-hidden className="nf-live-dot" data-off={!connected} />{connected ? 'En vivo' : 'Conectando…'}
        </span>
      </div>
      {wins.length === 0 ? (
        <p className="nf-panel py-5 text-center text-sm text-[var(--nf-muted)]">{t("Las ganancias aparecerán aquí en tiempo real.")}</p>
      ) : (
        <ul className="nf-row" aria-live="off">
          {wins.map((b) => (
            <li key={b.id}>
              <Link href={`/lobby/game/${encodeURIComponent(b.gameId)}`} className={`nf-win hover:border-[var(--nf-primary)] ${fresh.has(b.id) ? 'is-new' : ''}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={thumbs.get(b.gameId) || fallbackThumb(b.gameTitle, b.provider)} alt="" loading="lazy" />
                <span className="min-w-0">
                  <span className="nf-win-amt">+{formatMoney(profitOf(b).toString(), b.currency)}</span>
                  <span className="mt-1 block truncate text-[13px] font-bold">{b.gameTitle}</span>
                  <span className="block truncate text-[11px] text-[var(--nf-muted)]">{b.isMe ? 'Tú' : b.player} · {b.multiplier.toFixed(2)}x</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
