/**
 * Simulador de RTP/volatilidad de Nymfo Studios.
 *   npm run sim -- --game <id> [--spins 10000000] [--seed n] [--bonus-buy] [--workers n] [--profile 96.5] [--params '{"mines":3}'] [--json]
 * Busca el juego en el registro (GAMES) y, si no está, en los juegos de prueba (dummy-coin, dummy-bonus).
 */
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import os from 'os';
import { GAMES } from '../domain/games/registry';
import type { GameMath } from '../domain/GameMath';
import { finalizeReport, mergeAccumulators, runAccumulate, SimAccumulator, SimOptions, SimReport } from '../domain/simulator';
import { DUMMY_GAMES } from './dummyGames';

interface CliArgs {
  game: string;
  spins: number;
  seed: number;
  bonusBuy: boolean;
  workers: number;
  profile?: string;
  params?: Record<string, unknown>;
  jsonOnly: boolean;
}

function resolveGame(id: string): GameMath<any, any> | undefined {
  return GAMES[id] ?? DUMMY_GAMES[id];
}

function parseArgs(argv: string[]): CliArgs {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    return eq ? eq.slice(name.length + 3) : undefined;
  };
  const game = get('game');
  if (!game) {
    const ids = [...Object.keys(GAMES), ...Object.keys(DUMMY_GAMES)].join(', ');
    throw new Error(`Falta --game <id>. Disponibles: ${ids}`);
  }
  const spins = Number(get('spins') ?? 1_000_000);
  if (!Number.isSafeInteger(spins) || spins <= 0) throw new Error('--spins debe ser entero > 0');
  const seed = get('seed') !== undefined ? Number(get('seed')) : Date.now() % 2147483647;
  if (!Number.isFinite(seed)) throw new Error('--seed inválido');
  const defaultWorkers = spins >= 2_000_000 ? Math.max(1, Math.min(os.cpus().length, 8)) : 1;
  const workers = Math.max(1, Math.floor(Number(get('workers') ?? defaultWorkers)));
  const rawParams = get('params');
  return {
    game,
    spins,
    seed,
    bonusBuy: argv.includes('--bonus-buy'),
    workers,
    profile: get('profile'),
    params: rawParams ? (JSON.parse(rawParams) as Record<string, unknown>) : undefined,
    jsonOnly: argv.includes('--json'),
  };
}

interface WorkerJob {
  gameId: string;
  opts: SimOptions;
}

function runInWorker(job: WorkerJob): Promise<SimAccumulator> {
  return new Promise((resolve, reject) => {
    // En .ts (ejecutado con tsx) el worker registra tsx/cjs antes de cargar este archivo.
    const w = __filename.endsWith('.ts')
      ? new Worker(`require('tsx/cjs'); require(${JSON.stringify(__filename)});`, { eval: true, workerData: job })
      : new Worker(__filename, { workerData: job });
    w.once('message', (m: SimAccumulator) => resolve(m));
    w.once('error', reject);
    w.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker terminó con código ${code}`));
    });
  });
}

const pct = (x: number, d = 3) => `${(x * 100).toFixed(d)} %`;

function printTable(r: SimReport, game: GameMath<any, any>): void {
  const rows: Array<[string, string]> = [
    ['Juego', `${game.name} (${r.gameId})`],
    ['Rondas', r.spins.toLocaleString('es')],
    ['Semilla', String(r.seed)],
    ['Bonus buy', r.bonusBuy ? `sí (${game.bonusBuy?.costMultiplier}x)` : 'no'],
    ['RTP', pct(r.rtp)],
    ['RTP objetivo', pct(game.rtpTarget)],
    ['IC 95 %', `${pct(r.ci95[0])} – ${pct(r.ci95[1])}`],
    ['Hit rate', pct(r.hitRate, 2)],
    ['Desv. estándar', r.stdDev.toFixed(3)],
    ['Máx. multiplicador', `${r.maxMultiplier.toFixed(2)}x (tope ${game.maxWinMultiplier}x)`],
    ['Frecuencia de bonus', r.bonusFrequency > 0 ? `${pct(r.bonusFrequency, 4)} (1 de cada ${Math.round(r.bonusEvery).toLocaleString('es')})` : '—'],
    ['Duración', `${(r.durationMs / 1000).toFixed(2)} s`],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  console.log('\n=== Nymfo Studios · Simulación ===');
  rows.forEach(([k, v]) => console.log(`${k.padEnd(w)}  ${v}`));
  console.log('\nDistribución de ganancias (x apuesta):');
  console.log(`${'Bucket'.padEnd(12)}${'Rondas'.padStart(14)}${'% rondas'.padStart(12)}${'% del RTP'.padStart(12)}`);
  r.distribution.forEach((b) =>
    console.log(`${b.label.padEnd(12)}${b.count.toLocaleString('es').padStart(14)}${pct(b.share, 3).padStart(12)}${pct(b.rtpShare, 2).padStart(12)}`),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const game = resolveGame(args.game);
  if (!game) throw new Error(`Juego desconocido: ${args.game}`);
  const base: Omit<SimOptions, 'spins' | 'seed'> = { bonusBuy: args.bonusBuy, params: args.params, rtpProfile: args.profile };
  const t0 = Date.now();
  let acc: SimAccumulator;
  if (args.workers <= 1) {
    acc = runAccumulate(game, { ...base, spins: args.spins, seed: args.seed });
  } else {
    const per = Math.floor(args.spins / args.workers);
    const jobs: WorkerJob[] = Array.from({ length: args.workers }, (_, i) => ({
      gameId: game.id,
      opts: {
        ...base,
        spins: i === args.workers - 1 ? args.spins - per * (args.workers - 1) : per,
        seed: (args.seed + Math.imul(i, 0x9e3779b1)) >>> 0,
      },
    }));
    acc = mergeAccumulators(await Promise.all(jobs.map(runInWorker)));
  }
  const report = finalizeReport(game, acc, { seed: args.seed, bonusBuy: args.bonusBuy, durationMs: Date.now() - t0 });
  if (!args.jsonOnly) printTable(report, game);
  console.log(JSON.stringify({ ...report, bonusEvery: Number.isFinite(report.bonusEvery) ? report.bonusEvery : null, workers: args.workers }, null, args.jsonOnly ? 0 : 2));
}

if (isMainThread) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
} else {
  const job = workerData as WorkerJob;
  const game = resolveGame(job.gameId);
  if (!game) throw new Error(`Juego desconocido en worker: ${job.gameId}`);
  parentPort!.postMessage(runAccumulate(game, job.opts));
}
