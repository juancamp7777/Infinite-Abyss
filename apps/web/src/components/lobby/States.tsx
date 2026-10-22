import type { ReactNode } from 'react';
import { AlertTriangle, Inbox } from 'lucide-react';

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`nf-skeleton ${className}`} />;
}
export function CardSkeletons({ n = 8 }: { n?: number }) {
  return (
    <div role="status" aria-label="Cargando" className="nf-grid">
      {Array.from({ length: n }, (_, i) => <Skeleton key={i} className="aspect-[3/2]" />)}
    </div>
  );
}
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="nf-panel flex flex-col items-center gap-2 py-10 text-center">
      <Inbox aria-hidden className="h-8 w-8 opacity-60" />
      <p className="font-semibold">{title}</p>
      {hint && <p className="text-sm opacity-70">{hint}</p>}
      {action}
    </div>
  );
}
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="nf-panel flex flex-col items-center gap-2 py-8 text-center">
      <AlertTriangle aria-hidden className="h-8 w-8 text-red-400" />
      <p className="text-sm">{message}</p>
      {onRetry && <button type="button" className="nf-btn" onClick={onRetry}>Reintentar</button>}
    </div>
  );
}

const TOURNAMENT_STATUS: Record<string, string> = {
  open: 'Abierto', active: 'Activo', running: 'En curso', scheduled: 'Programado',
  finished: 'Finalizado', cancelled: 'Cancelado', closing: 'Cerrando', draft: 'Borrador',
};
/** Etiqueta en español del estado de un torneo. */
export function tournamentStatusLabel(status: string): string {
  return TOURNAMENT_STATUS[status] ?? status;
}
