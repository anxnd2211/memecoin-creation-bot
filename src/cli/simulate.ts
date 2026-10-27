import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import { mean, median } from '../intel/reports.ts';
import {
  SIMPLER_WITHIN_SOL,
  awayFromGaps,
  choosePlan,
  feedGaps,
  loadBacktestCoins,
  pairedDifference,
  rankCorrelation,
  runPolicy,
  scoreResults,
  type BacktestCoin,
  type PolicyScore,
} from '../sim/backtest.ts';
import { RECORDED_DEV, dumpPolicy, policyGrid } from '../sim/policies.ts';
import { DEFAULT_SIM, SLOT_SEC, simulate, type SimOptions } from '../sim/simulate.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag('help')) {
  console.log(`usage: npm run simulate -- [--fit <from>..<to>[,<from>..<to>]] [--test <from>..<to>] | [--folds 3]
                            [--cohort clean|normal] [--min-dev-buy 0] [--latency 2] [--horizon 30] [--top 8] [--json]

Backtests selling plans on recorded normal (non-Mayhem) launches. Each launch is replayed with our dev position in
place of the recorded dev's, under every plan in the grid; everyone else trades as recorded. A plan is chosen on
the --fit launches and scored on the --test launches, which it was not chosen on. Dates are like
2026-10-27T04:22Z. Without dates, all live-recorded launches are split two thirds / one third by launch count.

--folds N splits the launches into N blocks in time order and holds out each block in turn: the plan is chosen on
the other blocks and scored on the held-out one. The pooled held-out results are the honest estimate of choosing
plans this way.

--cohort clean (default) keeps launches made the way this project launches: one wallet, no wallets moving with
it. --min-dev-buy keeps launches whose dev bought at least that much SOL (fees included) in the create transaction. --latency is slots (${SLOT_SEC} s each) between a trade and our sell landing; --horizon is minutes after
launch that are replayed. Launches whose replay would run into a stretch with no recorded trades are left out.`);
  process.exit(0);
}

if (!existsSync(config.dbPath)) {
  console.error(`No database at ${config.dbPath}. Run "npm run observe" first.`);
  process.exit(1);
}

const db = new DatabaseSync(config.dbPath, { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000;');
const nowTs = Math.floor(Date.now() / 1000);
const options: SimOptions = {
  ...DEFAULT_SIM,
  latencySlots: Number(opt('latency') ?? DEFAULT_SIM.latencySlots),
  horizonSec: Number(opt('horizon') ?? DEFAULT_SIM.horizonSec / 60) * 60,
};
const cohort = opt('cohort') ?? 'clean';
const top = Number(opt('top') ?? 8);
const folds = Number(opt('folds') ?? 0);
const minDevBuy = Number(opt('min-dev-buy') ?? 0);

function ranges(name: string): [number, number][] | null {
  const v = opt(name);
  if (!v) return null;
  return v.split(',').map((part) => {
    const [a, b] = part.split('..').map((s) => Date.parse(s) / 1000);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a! >= b!) {
      console.error(`--${name} expects <from>..<to>, such as 2026-10-27T04:22Z..2026-10-27T06:35Z`);
      process.exit(1);
    }
    return [Math.floor(a!), Math.floor(b!)];
  });
}

const liveSince = Number(
  (db.prepare("SELECT value FROM meta WHERE key = 'creator_fees_since'").get() as { value: string } | undefined)?.value ?? nowTs - 86400,
);
const lastLaunch = nowTs - options.horizonSec;
const fitRanges = ranges('fit');
const testRanges = ranges('test');
const all = [...(fitRanges ?? []), ...(testRanges ?? []), ...(fitRanges && testRanges ? [] : [[liveSince, lastLaunch] as [number, number]])];
const gaps = feedGaps(db, Math.min(...all.map((r) => r[0])), Math.max(...all.map((r) => r[1])) + options.horizonSec);
const load = (rs: [number, number][]) =>
  awayFromGaps(
    rs
      .flatMap(([a, b]) => loadBacktestCoins(db, a, b))
      .filter((c) => (cohort === 'normal' || c.clean) && c.launchBuySol >= minDevBuy),
    gaps,
    options.horizonSec,
  ).sort((a, b) => a.createdTs - b.createdTs);

const grid = policyGrid();
const simple = dumpPolicy(0.01, 10, null);

// ---- Plain-text helpers ----

const utc = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ');
const hm = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 16);
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '-' : `${Math.round(x * 100)}%`);
const num = (x: number | null | undefined, d = 3) => (x === null || x === undefined ? '-' : x.toFixed(d));

function table(rows: Record<string, string | number>[]): void {
  if (!rows.length) {
    console.log('  (no data)');
    return;
  }
  const cols = Object.keys(rows[0]!);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const line = (vals: string[]) => '  ' + vals.map((v, i) => v.padEnd(widths[i]!)).join('  ');
  console.log(line(cols));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) console.log(line(cols.map((c) => String(r[c]))));
}
const heading = (t: string) => console.log(`\n== ${t} ==`);
const scoreCols = (s: PolicyScore) => ({
  launches: s.launches,
  'mean SOL': num(s.meanPnl),
  'median SOL': num(s.medianPnl),
  profitable: pct(s.profitableShare),
  'bad launch (p05)': num(s.p05),
  'mean busy': num(s.meanActive),
  'mean dead': num(s.meanDead),
  'busy share': pct(s.activeShare),
  'break-even busy share': pct(s.breakEvenActiveShare),
  'total SOL': num(s.totalPnl, 1),
  'total w/o best 2': num(s.totalWithoutTop2, 1),
});
const scoreRow = (plan: string, s: PolicyScore) => ({ plan, ...scoreCols(s) });
const verdict = (d: { lo: number; hi: number } | null) =>
  !d ? '' : d.lo > 0 ? 'better beyond noise' : d.hi < 0 ? 'worse beyond noise' : 'within noise';
const intro = () => {
  heading('Exit backtest');
  console.log(
    `  ${cohort === 'clean' ? 'Single-wallet clean' : 'All'} normal launches with a dev buy` +
      `${minDevBuy ? ` of at least ${minDevBuy} SOL` : ''}, replayed ${options.horizonSec / 60} min with our` +
      ` position in place of the dev's. Latency ${options.latencySlots} slots; costs ${options.launchCostSol} SOL per launch,` +
      ` ${options.txCostSol} per sell. Plans in the grid: ${grid.length}.`,
  );
  for (const [a, b] of gaps) console.log(`  No trades recorded ${utc(a)} to ${utc(b)} UTC: launches whose replay runs into it are left out.`);
};

// ---- Rolling check: each block held out in turn ----

if (folds > 1) {
  const coins = load(fitRanges ?? [[liveSince, lastLaunch]]);
  const size = Math.ceil(coins.length / folds);
  const blocks = Array.from({ length: folds }, (_, k) => coins.slice(k * size, (k + 1) * size)).filter((b) => b.length);
  const pooled = { chosen: [] as number[], recorded: [] as number[], simple: [] as number[], coins: [] as BacktestCoin[] };
  const rows = blocks.map((test, k) => {
    const fit = blocks.filter((_, j) => j !== k).flat();
    const choice = choosePlan(fit, grid, options);
    const chosen = runPolicy(test, choice.chosen, options);
    const recorded = runPolicy(test, RECORDED_DEV, options);
    const easy = runPolicy(test, simple, options);
    pooled.chosen.push(...chosen);
    pooled.recorded.push(...recorded);
    pooled.simple.push(...easy);
    pooled.coins.push(...test);
    const testMeans = grid.map((p) => mean(runPolicy(test, p, options)) ?? 0);
    const d = pairedDifference(chosen, recorded);
    return {
      block: `${hm(test[0]!.createdTs)}-${hm(test.at(-1)!.createdTs)}`,
      launches: test.length,
      busy: test.filter((c) => c.active).length,
      'chosen on the other blocks': choice.chosen.name,
      'chosen mean': num(mean(chosen)),
      'recorded devs': num(mean(recorded)),
      'simple dump': num(mean(easy)),
      'chosen - recorded (90%)': d ? `${num(d.mean)} (${num(d.lo)} to ${num(d.hi)})` : '-',
      'rank agreement': num(rankCorrelation(grid.map((p) => choice.means.get(p.name)!), testMeans), 2),
    };
  });
  const report = {
    options,
    cohort,
    blocks: rows,
    pooled: {
      chosen: scoreResults(pooled.coins, { ...simple, name: 'chosen in each block' }, pooled.chosen),
      recordedDev: scoreResults(pooled.coins, RECORDED_DEV, pooled.recorded),
      simple: scoreResults(pooled.coins, simple, pooled.simple),
      chosenVsRecorded: pairedDifference(pooled.chosen, pooled.recorded),
      chosenVsSimple: pairedDifference(pooled.chosen, pooled.simple),
    },
  };
  if (flag('json')) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }
  intro();
  heading(`Rolling check: ${blocks.length} blocks in time order, each held out in turn (plan chosen on the others)`);
  console.log('  Rank agreement: Spearman correlation of all plans\' results in the other blocks and the held-out block.');
  table(rows);
  heading('All held-out blocks together: the honest estimate of choosing plans this way');
  const p = report.pooled;
  table([
    scoreRow('recorded devs, as they traded', p.recordedDev),
    scoreRow(`simple: ${simple.name}`, p.simple),
    scoreRow('plan chosen in each block', p.chosen),
  ]);
  for (const [label, d] of [
    ['recorded devs', p.chosenVsRecorded],
    ['the simple plan', p.chosenVsSimple],
  ] as const) {
    if (d) console.log(`  Chosen minus ${label}: ${num(d.mean)} SOL per launch, 90% interval ${num(d.lo)} to ${num(d.hi)} (${verdict(d)}).`);
  }
  console.log();
  process.exit(0);
}

// ---- One fit period and one test period ----

const allCoins = fitRanges && testRanges ? null : load([[liveSince, lastLaunch]]);
const splitAt = allCoins ? Math.floor((allCoins.length * 2) / 3) : 0;
const fitCoins = allCoins ? allCoins.slice(0, splitAt) : load(fitRanges!);
const testCoins = allCoins ? allCoins.slice(splitAt) : load(testRanges!);
if (!fitCoins.length || !testCoins.length) {
  console.error('Not enough launches in the fit or test period.');
  process.exit(1);
}

// Replay check: the recorded devs' own trades must reproduce their recorded results.
const checkCoins = [...fitCoins, ...testCoins].filter((c) => !c.graduated);
const replayErrors = checkCoins.map((c) => {
  const r = simulate(c, RECORDED_DEV, { ...options, horizonSec: Infinity, launchCostSol: 0, txCostSol: 0 });
  return Math.abs(r.received - r.spent + r.bagSol - c.recordedTradingPnl);
});

const choice = choosePlan(fitCoins, grid, options);
const chosen = choice.chosen;
const testResults = new Map(grid.map((p) => [p.name, runPolicy(testCoins, p, options)] as const));
const testMean = (name: string) => mean(testResults.get(name)!) ?? 0;
const stability = rankCorrelation(
  grid.map((p) => choice.means.get(p.name)!),
  grid.map((p) => testMean(p.name)),
);
const recordedTest = runPolicy(testCoins, RECORDED_DEV, options);
const simpleTest = runPolicy(testCoins, simple, options);
const chosenTest = testResults.get(chosen.name)!;
const bestInHindsight = [...grid].sort((a, b) => testMean(b.name) - testMean(a.name))[0]!;

const latency = [1, 2, 5, 12, 25].map((slots) => ({
  slots,
  score: scoreResults(testCoins, chosen, runPolicy(testCoins, chosen, { ...options, latencySlots: slots })),
}));
// Sniper bots react to the dev buy: a 3 SOL buy (about 10% of supply) draws far more launch-second buying than 2.5,
// and a 5 SOL buy as much again while the bigger bag takes more of it (SOL paid, fees included).
const buckets = [
  ['<1 SOL', 0, 1],
  ['1-2.95', 1, 2.95],
  ['2.95-3.1', 2.95, 3.1],
  ['3.1-4.9', 3.1, 4.9],
  ['4.9-5.2', 4.9, 5.2],
  ['5.2-8', 5.2, 8],
  ['>=8', 8, Infinity],
] as const;
const everyCoin = [...fitCoins, ...testCoins];
const everyResult = [...choice.results.get(chosen.name)!, ...chosenTest];
const byDevBuy = buckets.map(([label, lo, hi]) => {
  const idx = everyCoin.map((c, i) => [c, i] as const).filter(([c]) => c.launchBuySol >= lo && c.launchBuySol < hi);
  const coins = idx.map(([c]) => c);
  return {
    devBuy: label,
    devs: new Set(coins.map((c) => c.dev)).size,
    outsideBuy3s: median(coins.map((c) => c.trades.filter((t) => !t.dev && t.isBuy && t.ts - c.createdTs <= 3).reduce((s, t) => s + t.sol, 0))),
    score: scoreResults(
      coins,
      chosen,
      idx.map(([, i]) => everyResult[i]!),
    ),
  };
});

const span = (xs: BacktestCoin[]) => ({
  from: xs[0]!.createdTs,
  to: xs.at(-1)!.createdTs,
  launches: xs.length,
  active: xs.filter((c) => c.active).length,
});
const report = {
  options,
  cohort,
  fit: span(fitCoins),
  test: span(testCoins),
  feedGaps: gaps,
  replayCheck: {
    coins: checkCoins.length,
    within001Sol: replayErrors.filter((e) => e <= 0.01).length,
    medianErrorSol: median(replayErrors),
    phantomCoins: [...fitCoins, ...testCoins].filter((c) => c.phantoms > 0).length,
  },
  plans: grid.length,
  stability,
  chosen: chosen.name,
  top: choice.ranked.slice(0, top).map((p) => ({
    policy: p.name,
    fitMean: choice.means.get(p.name)!,
    fitPlateau: choice.plateau.get(p.name)!,
    test: scoreResults(testCoins, p, testResults.get(p.name)!),
  })),
  benchmarks: {
    fit: {
      recordedDev: scoreResults(fitCoins, RECORDED_DEV, runPolicy(fitCoins, RECORDED_DEV, options)),
      chosen: scoreResults(fitCoins, chosen, choice.results.get(chosen.name)!),
    },
    test: {
      recordedDev: scoreResults(testCoins, RECORDED_DEV, recordedTest),
      simple: scoreResults(testCoins, simple, simpleTest),
      chosen: scoreResults(testCoins, chosen, chosenTest),
      bestInHindsight: scoreResults(testCoins, bestInHindsight, testResults.get(bestInHindsight.name)!),
    },
  },
  chosenVsRecordedDev: pairedDifference(chosenTest, recordedTest),
  chosenVsSimple: pairedDifference(chosenTest, simpleTest),
  latency,
  byDevBuy,
};

if (flag('json')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

intro();
console.log(`  Fit:  ${utc(report.fit.from)} to ${utc(report.fit.to)} UTC, ${report.fit.launches} launches (${report.fit.active} busy). The plan is chosen here.`);
console.log(`  Test: ${utc(report.test.from)} to ${utc(report.test.to)} UTC, ${report.test.launches} launches (${report.test.active} busy). Scored here only.`);
const rc = report.replayCheck;
console.log(
  `  Replay check: the recorded devs' own trades reproduce their recorded result within 0.01 SOL on ${rc.within001Sol} of ${rc.coins}` +
    ` launches; ${rc.phantomCoins} launches needed trades inferred for feed gaps.`,
);

heading('Best plans on the fit period, and how they did on the test period');
console.log('  Fit plateau = mean of the plan and its one-step neighbours on the fit period, so lucky spikes do not win.');
console.log(`  Chosen: the simplest plan within ${SIMPLER_WITHIN_SOL} SOL of the best plateau: ${chosen.name}.`);
table(
  report.top.map((t) => ({
    plan: t.policy,
    'fit mean': num(t.fitMean),
    'fit plateau': num(t.fitPlateau),
    'test mean': num(t.test.meanPnl),
    'test median': num(t.test.medianPnl),
    'test profitable': pct(t.test.profitableShare),
    'test p05': num(t.test.p05),
  })),
);
console.log(`  Do plans rank the same in both periods? Spearman ${num(stability, 2)} across all ${report.plans} plans (1 = identical order).`);

heading('Test period: chosen plan against benchmarks (SOL per launch)');
const b = report.benchmarks.test;
table([
  scoreRow('recorded devs, as they traded', b.recordedDev),
  scoreRow(`simple: ${simple.name}`, b.simple),
  scoreRow(`chosen: ${chosen.name}`, b.chosen),
  scoreRow(`best in hindsight: ${bestInHindsight.name}`, b.bestInHindsight),
]);
for (const [label, d] of [
  ['recorded devs', report.chosenVsRecordedDev],
  ['the simple plan', report.chosenVsSimple],
] as const) {
  if (d) console.log(`  Chosen minus ${label}: ${num(d.mean)} SOL per launch, 90% interval ${num(d.lo)} to ${num(d.hi)} (${verdict(d)}).`);
}

heading('Chosen plan on the test period: sell latency');
table(latency.map((l) => ({ 'latency slots': l.slots, seconds: (l.slots * SLOT_SEC).toFixed(1), ...scoreCols(l.score) })));

heading('Chosen plan on all launches, by the recorded dev buy (fees included; the early buying reacted to it)');
table(
  byDevBuy.map((x) => ({
    'dev buy': x.devBuy,
    devs: x.devs,
    'median outside buy SOL in 3s': num(x.outsideBuy3s, 2),
    ...scoreCols(x.score),
  })),
);
console.log();
