"use client";

import { Award, Crown, Medal, Timer, Trophy, Zap } from "lucide-react";
import { useState } from "react";
import { useApi } from "@/lib/hooks";
import { Card, Empty, ErrorBox, Spinner, Tabs } from "@/components/ui";

interface League { key: string; label: string; minWeeklyXp: number }
interface Profile {
  xp: number; level: number; currentLevelXp: number; nextLevelXp: number; weeklyXp: number; league: League; rank: number | null; teamSize: number;
  badges: Array<{ key: string; label: string; description: string; earned: boolean }>;
  kpis30d: { firstResponses: number; avgFirstResponseSec: number | null; depositsApproved: number; checklist: number; tasksDone: number; onTime: number; cashPerfect: number };
}
interface Row {
  rank: number; xp: number; totalXp: number; level: number; league: League; member: { id: string; name: string; role: string };
  kpis: { firstResponses: number; avgFirstResponseSec: number | null; fastResponses: number; depositsApproved: number; checklist: number; tasksDone: number; onTime: number; cashPerfect: number };
}

const LEAGUE_COLOR: Record<string, string> = { abismo: "#a78bfa", diamante: "#3cc8f0", oro: "#f4b73f", plata: "#cbd5e1", bronce: "#d97706" };
const secs = (s: number | null) => (s === null ? "—" : s < 60 ? `${s} s` : `${Math.round(s / 60)} min`);

/** Nivel, progreso, liga de la semana, puesto en el equipo e insignias de la persona. */
export function AscendCard() {
  const p = useApi<Profile>("/crew/v1/me/ascend");
  if (p.loading) return <Card><Spinner /></Card>;
  if (p.error || !p.data) return null;
  const d = p.data;
  const pct = Math.min(100, Math.round(((d.xp - d.currentLevelXp) / Math.max(1, d.nextLevelXp - d.currentLevelXp)) * 100));
  const color = LEAGUE_COLOR[d.league.key] ?? "#fff";
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-4">
        <div className="grid h-16 w-16 place-items-center rounded-2xl border-2 text-2xl font-black" style={{ borderColor: color, color }}>{d.level}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-bold">Nivel {d.level}</span>
            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: `${color}22`, color }}><Crown aria-hidden className="h-3 w-3" /> Liga {d.league.label}</span>
            {d.rank && <span className="text-xs text-white/50">#{d.rank} de {d.teamSize} esta semana</span>}
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Progreso al siguiente nivel">
            <div className="h-full rounded-full bg-gradient-to-r from-[var(--color-brand2)] to-[var(--color-brand)] transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 text-xs text-white/45">{d.xp} XP · faltan {d.nextLevelXp - d.xp} para el nivel {d.level + 1} · {d.weeklyXp} XP esta semana</div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div className="rounded-lg bg-white/[.03] p-2"><Timer aria-hidden className="mb-1 h-4 w-4 text-[var(--color-brand2)]" />Respuesta media<br /><b className="text-sm">{secs(d.kpis30d.avgFirstResponseSec)}</b></div>
        <div className="rounded-lg bg-white/[.03] p-2"><Zap aria-hidden className="mb-1 h-4 w-4 text-[var(--color-brand)]" />Atenciones (30 d)<br /><b className="text-sm">{d.kpis30d.firstResponses}</b></div>
        <div className="rounded-lg bg-white/[.03] p-2"><Medal aria-hidden className="mb-1 h-4 w-4 text-emerald-400" />Cargas aprobadas<br /><b className="text-sm">{d.kpis30d.depositsApproved}</b></div>
        <div className="rounded-lg bg-white/[.03] p-2"><Award aria-hidden className="mb-1 h-4 w-4 text-violet-300" />Puntualidad<br /><b className="text-sm">{d.kpis30d.onTime} entradas</b></div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {d.badges.map((b) => (
          <span key={b.key} title={b.description} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${b.earned ? "border-[var(--color-brand)]/60 text-[var(--color-brand)]" : "border-white/10 text-white/30"}`}>
            <Trophy aria-hidden className="h-3 w-3" /> {b.label}
          </span>
        ))}
      </div>
    </Card>
  );
}

/** Ranking del equipo con KPIs reales (Sonar, Pearl, Crew). */
export function Leaderboard({ compact = false }: { compact?: boolean }) {
  const [period, setPeriod] = useState<"week" | "month" | "all">("week");
  const l = useApi<{ items: Row[] }>("/crew/v1/leaderboard", { period });
  return (
    <Card title="Ranking del equipo" actions={<Tabs tabs={[{ id: "week", label: "Semana" }, { id: "month", label: "Mes" }, { id: "all", label: "Histórico" }]} value={period} onChange={setPeriod} />}>
      {l.loading ? <Spinner /> : l.error ? <ErrorBox message={l.error} onRetry={l.reload} /> : !l.data?.items.length ? <Empty>Agrega integrantes al equipo para competir.</Empty> : (
        <div className="overflow-x-auto">
          <table className={`w-full text-sm ${compact ? "" : "min-w-[760px]"}`}>
            <thead className="text-left text-xs text-white/45"><tr><th className="py-2">#</th><th>Integrante</th><th>Liga</th><th className="text-right">XP</th>{!compact && <><th className="text-right">Atenciones</th><th className="text-right">Resp. media</th><th className="text-right">Cargas</th><th className="text-right">Checklist</th><th className="text-right">Tareas</th><th className="text-right">Puntual</th></>}</tr></thead>
            <tbody>{l.data.items.map((r) => (
              <tr key={r.member.id} className="border-t border-white/5">
                <td className="py-2 font-bold" style={{ color: r.rank <= 3 ? ["#f4b73f", "#cbd5e1", "#d97706"][r.rank - 1] : undefined }}>{r.rank}</td>
                <td><b>{r.member.name}</b> <span className="text-xs text-white/40">nv. {r.level}</span></td>
                <td><span className="text-xs font-bold" style={{ color: LEAGUE_COLOR[r.league.key] }}>{r.league.label}</span></td>
                <td className="text-right font-mono font-bold">{r.xp}</td>
                {!compact && <>
                  <td className="text-right">{r.kpis.firstResponses}</td><td className="text-right">{secs(r.kpis.avgFirstResponseSec)}</td><td className="text-right">{r.kpis.depositsApproved}</td>
                  <td className="text-right">{r.kpis.checklist}</td><td className="text-right">{r.kpis.tasksDone}</td><td className="text-right">{r.kpis.onTime}</td>
                </>}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
