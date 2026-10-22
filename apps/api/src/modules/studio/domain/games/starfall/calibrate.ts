/**
 * Calibración de Starfall (herramienta de desarrollo, no se usa en producción).
 *   npx tsx src/modules/studio/domain/games/starfall/calibrate.ts estimate [--seed n] [--scale 1]
 *   npx tsx src/modules/studio/domain/games/starfall/calibrate.ts direct --spins 50000000 [--workers 2] [--bonus-buy] [--seed n]
 * "estimate" usa el estimador descompuesto (estimate.ts); "direct" simula rondas completas (sin construir outcome)
 * repartidas en workers y reporta con el mismo formato que el simulador de Studio.
 */
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import os from 'os';
import { SeededRng } from '../../fairness/Rng';
import { DIST_BUCKETS, finalizeReport, mergeAccumulators, emptyAccumulator, SimAccumulator } from '../../simulator';
import { starfall, starfallFastRound } from './math';
import { estimateStarfallRtp } from './estimate';

interface Job {
  spins: number;
  seed: number;
  bonusBuy: boolean;
}

function runDirect(job: Job): SimAccumulator {
  const rng = new SeededRng(job.seed);
  const acc = emptyAccumulator();
  for (let i = 0; i < job.spins; i++) {
    const r = starfallFastRound(rng, job.bonusBuy);
    const m = r.total / 100;
    acc.sum += m;
    acc.sumSq += m * m;
    if (m > 0) acc.hits++;
    if (r.bonus) acc.bonus++;
    if (m > acc.max) acc.max = m;
    // Mismo criterio que bucketIndex del simulador: '0' y luego tramos [min, max).
    let b = 0;
    if (m > 0) for (let j = 1; j < DIST_BUCKETS.length; j++) if (m >= DIST_BUCKETS[j].min) b = j;
    acc.counts[b]++;
    acc.sums[b] += m;
  }
  acc.spins = job.spins;
  return acc;
}

function inWorker(job: Job): Promise<SimAccumulator> {
  return new Promise((resolve, reject) => {
    const w = __filename.endsWith('.ts')
      ? new Worker(`require('tsx/cjs'); require(${JSON.stringify(__filename)});`, { eval: true, workerData: job })
      : new Worker(__filename, { workerData: job });
    w.once('message', resolve);
    w.once('error', reject);
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (k: string, d: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const seed = Number(get('seed', '12345'));
  if (argv[0] === 'direct') {
    const spins = Number(get('spins', '10000000'));
    const workers = Number(get('workers', String(Math.min(os.cpus().length, 8))));
    const bonusBuy = argv.includes('--bonus-buy');
    const t0 = Date.now();
    const per = Math.floor(spins / workers);
    const jobs = Array.from({ length: workers }, (_, i) => ({ spins: i === workers - 1 ? spins - per * (workers - 1) : per, seed: (seed + Math.imul(i, 0x9e3779b1)) >>> 0, bonusBuy }));
    const acc = mergeAccumulators(await Promise.all(jobs.map(inWorker)));
    const rep = finalizeReport(starfall, acc, { seed, bonusBuy, durationMs: Date.now() - t0 });
    console.log(JSON.stringify({ ...rep, se: rep.stdDev / Math.sqrt(rep.spins) }, null, 2));
    return;
  }
  const est = estimateStarfallRtp({
    seed,
    baseSpins: Number(get('base', '3000000')),
    freeSpins: Number(get('fs', '2000000')),
    bonusBuySpins: Number(get('bb', '300000')),
  });
  console.log(JSON.stringify(est, null, 2));
}

if (isMainThread) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  parentPort!.postMessage(runDirect(workerData as Job));
}
