import type { Leaderboard } from '@/lib/lobby/types';
import { formatScore } from '@/lib/lobby/format';
import { EmptyState } from './States';

export function TournamentTable({ lb, currency = '' }: { lb: Leaderboard; currency?: string }) {
  if (lb.top.length === 0) return <EmptyState title="Aún no hay puntuaciones" hint="Sé el primero en apostar en este torneo." />;
  return (
    <div className="nf-panel overflow-x-auto p-0">
      <table className="w-full text-sm">
        <caption className="sr-only">Clasificación del torneo</caption>
        <thead><tr className="text-left text-xs uppercase opacity-60"><th scope="col" className="p-2">#</th><th scope="col" className="p-2">Jugador</th><th scope="col" className="p-2 text-right">Puntuación</th></tr></thead>
        <tbody>
          {lb.top.map((r) => (
            <tr key={r.rank} className={r.isMe ? 'nf-me' : 'border-t border-white/5'}>
              <td className="p-2 font-bold">{r.rank}</td><td className="p-2">{r.player}{r.isMe && ' (tú)'}</td>
              <td className="p-2 text-right tabular-nums">{formatScore(lb.metric, r.score, currency)}</td>
            </tr>
          ))}
        </tbody>
        {lb.me && !lb.top.some((r) => r.isMe) && (
          <tfoot><tr className="nf-me"><td className="p-2 font-bold">{lb.me.rank}</td><td className="p-2">Tú</td><td className="p-2 text-right tabular-nums">{formatScore(lb.metric, lb.me.score, currency)}</td></tr></tfoot>
        )}
      </table>
    </div>
  );
}
