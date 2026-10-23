import { api } from "@/lib/api";

/** Cliente de Leviathan (concursos de fichas sobre deportes). Montos en unidades mínimas como texto. */
export type LevStatus = "OPEN" | "RUNNING" | "SETTLING" | "SETTLED" | "CANCELLED";
export interface LevGame {
  id: string;
  mode: "QUICK" | "FRIENDS";
  title: string;
  currency: string;
  entry: string;
  pot: string;
  rakePpm: number;
  minBets: number;
  maxBets: number;
  maxPlayers: number;
  players: number;
  status: LevStatus;
  roomCode: string | null;
  entriesCloseAt: string;
  endsAt: string;
}
export interface LevEntry { id: string; chips: string; bets: number; rank: number | null; prize: string | null; qualified: boolean | null }
export interface LevSelection { id: string; market: string; line: string | null; key: string; label: string; oddsE2: number; result: string }
export interface LevEvent { id: string; sport: string; league: string; home: string; away: string; startsAt: string; endsAt: string; status: string; homeScore: number | null; awayScore: number | null; selections: LevSelection[] }
export interface LevBet { id: string; selectionId: string; stake: string; oddsE2: number; returnChips: string; status: string; createdAt: string }
export interface LevDetail {
  game: LevGame;
  events: LevEvent[];
  me: LevEntry | null;
  myBets: LevBet[];
  leaderboard: Array<{ position: number; name: string; chips: string; bets: number; prize: string | null; isMe: boolean }>;
}

const B = "/leviathan/v1";
export const lev = {
  lobby: () => api.get<{ items: LevGame[] }>(`${B}/games`).then((r) => r.items),
  mine: () => api.get<{ items: Array<LevGame & { me: LevEntry }> }>(`${B}/me/games`).then((r) => r.items),
  detail: (id: string) => api.get<LevDetail>(`${B}/games/${id}`),
  join: (id: string) => api.post<LevEntry>(`${B}/games/${id}/join`),
  bet: (id: string, b: { selectionId: string; stake: string; oddsE2: number }) => api.post<LevBet>(`${B}/games/${id}/bets`, b),
  createFriends: (b: { title: string; entry: string; maxPlayers: number }) => api.post<LevGame>(`${B}/friends`, b),
  joinCode: (code: string) => api.post<{ game: LevGame }>(`${B}/rooms/${encodeURIComponent(code)}/join`),
};

/** Premios que se reparten: el pozo menos la comisión. */
export const prizePool = (g: Pick<LevGame, "pot" | "rakePpm">) => (BigInt(g.pot) * BigInt(1_000_000 - g.rakePpm)) / BigInt(1_000_000);
export const odds = (e2: number) => (e2 / 100).toFixed(2);
export const SPORT_ICON: Record<string, string> = { football: "⚽", basketball: "🏀", baseball: "⚾" };
export const STATUS_LABEL: Record<LevStatus, string> = { OPEN: "Inscripciones abiertas", RUNNING: "En juego", SETTLING: "Cerrando", SETTLED: "Terminado", CANCELLED: "Cancelado" };
export const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
