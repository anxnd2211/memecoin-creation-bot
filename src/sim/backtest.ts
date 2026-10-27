import type { DatabaseSync } from 'node:sqlite';
import { STANDARD_LAUNCH_MCAP_SOL } from '../chain/curve.ts';
import { analyseCoin, isSingleWalletClean, loadLaunches } from '../intel/devs.ts';
import { mean, median, share } from '../intel/reports.ts';
import { reconstructFlow } from './flow.ts';
import { neighbours, type GridPolicy } from './policies.ts';
import { simulate, type ExitPolicy, type SimCoin, type SimOptions } from './simulate.ts';

/**
 * Backtest of selling plans on recorded launches. The population is normal (non-Mayhem) launches on the standard
 * curve whose dev bought in the create transaction; each is replayed with our position in place of the dev's.
 */

export interface BacktestCoin extends SimCoin {
  /** The wallet that signed the launch, or the creator when unknown. */
  dev: string;
  /** Drew real trading (the dev screen's definition). */
  active: boolean;
  /** One wallet as creator and signer and no wallets moving with it: launched the way this project launches. */
  clean: boolean;
  /** The recorded dev's trading result from the dev screen, before creator fees. */
  recordedTradingPnl: number;
  graduated: boolean;
  phantoms: number;
  phantomSol: number;
}

export function loadBacktestCoins(db: DatabaseSync, sinceTs: number, untilTs: number): BacktestCoin[] {
  const { launches, agentIds, snipers } = loadLaunches(db, sinceTs, untilTs, true);
  const out: BacktestCoin[] = [];
  for (const l of launches) {
    const { info } = l;
    const standard =
      info.launchMcapSol !== null && Math.abs(info.launchMcapSol - STANDARD_LAUNCH_MCAP_SOL) < 0.01 * STANDARD_LAUNCH_MCAP_SOL;
    if (info.isMayhem || !standard || !l.trades.length) continue;
    const flow = reconstructFlow(l.trades, l.devIds);
    const launchSlot = flow.trades[0]!.slot;
    const launchBuySol = flow.trades.filter((t) => t.dev && t.isBuy && t.slot === launchSlot).reduce((s, t) => s + t.sol, 0);
    if (!(launchBuySol > 0)) continue;
    const d = analyseCoin(info, l.trades, l.devIds, agentIds, snipers);
    out.push({
      mint: info.mint,
      symbol: info.symbol,
      createdTs: info.createdTs,
      dev: info.launcher ?? info.creator,
      trades: flow.trades,
      launchBuySol,
      active: d.active,
      clean: isSingleWalletClean(d),
      recordedTradingPnl: d.devTradingPnl,
      graduated: info.graduatedTs !== null,
      phantoms: flow.phantoms,
      phantomSol: flow.phantomSol,
    });
  }
  return out;
}

export interface PolicyScore {
  policy: string;
  launches: number;
  meanPnl: number | null;
  medianPnl: number | null;
  /** 5th percentile: a bad launch under this plan. */
  p05: number | null;
  profitableShare: number | null;
  totalPnl: number;
  /** Total without the two best launches: how much the plan leans on outliers. */
  totalWithoutTop2: number;
  meanActive: number | null;
  meanDead: number | null;
  activeShare: number | null;
  /** Share of launches that must draw buyers for the plan to break even, from its means on busy and dead launches. */
  breakEvenActiveShare: number | null;
  /** Mean result per SOL of dev buy. */
  meanPerSolBuy: number | null;
}

const quantile = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};

export function runPolicy(coins: BacktestCoin[], policy: ExitPolicy, o?: SimOptions): number[] {
  return coins.map((c) => simulate(c, policy, o).pnl);
}

/**
 * Among plans within this of the best plateau, the simplest is chosen: fewer moving parts, less to overfit. A plan
 * that sells the whole bag at once also counts as simpler than one keeping a moonbag, because the replay cannot show
 * how other wallets react to our first partial sell, and a full sell keeps the dev's loss bounded by the fees.
 */
export const SIMPLER_WITHIN_SOL = 0.005;
const FAMILY_COMPLEXITY = ['time', 'dump', 'flow', 'ladder'];

export interface PlanChoice {
  chosen: GridPolicy;
  /** Plans by plateau, best first. */
  ranked: GridPolicy[];
  means: Map<string, number>;
  /** A plan's mean together with its one-step neighbours', so a lucky spike does not win. */
  plateau: Map<string, number>;
  results: Map<string, number[]>;
}

export function choosePlan(coins: BacktestCoin[], grid: GridPolicy[], o?: SimOptions): PlanChoice {
  const results = new Map(grid.map((p) => [p.name, runPolicy(coins, p, o)] as const));
  const means = new Map([...results].map(([name, xs]) => [name, mean(xs) ?? 0] as const));
  const plateau = new Map(
    grid.map((p) => {
      const xs = [p, ...neighbours(p, grid)].map((q) => means.get(q.name)!);
      return [p.name, xs.reduce((a, b) => a + b, 0) / xs.length] as const;
    }),
  );
  const ranked = [...grid].sort((a, b) => plateau.get(b.name)! - plateau.get(a.name)!);
  const bar = plateau.get(ranked[0]!.name)! - SIMPLER_WITHIN_SOL;
  const complexity = (p: GridPolicy) => FAMILY_COMPLEXITY.indexOf(p.family);
  const chosen = ranked
    .filter((p) => plateau.get(p.name)! >= bar)
    .sort(
      (a, b) =>
        complexity(a) - complexity(b) ||
        Number(a.moonbagShare > 0) - Number(b.moonbagShare > 0) ||
        plateau.get(b.name)! - plateau.get(a.name)!,
    )[0]!;
  return { chosen, ranked, means, plateau, results };
}

/** Stretches of over five minutes in [from, to] with no recorded trade: the observer was down or asleep. */
export function feedGaps(db: DatabaseSync, from: number, to: number): [number, number][] {
  const rows = db
    .prepare(
      `SELECT prev, ts FROM (SELECT ts, LAG(ts) OVER (ORDER BY ts) AS prev FROM trades WHERE ts BETWEEN ? AND ?)
       WHERE ts - prev > 300`,
    )
    .all(from, to) as { prev: number; ts: number }[];
  return rows.map((r) => [r.prev, r.ts]);
}

/** Drops launches whose replay window overlaps a stretch the observer recorded nothing. */
export function awayFromGaps(coins: BacktestCoin[], gaps: [number, number][], horizonSec: number): BacktestCoin[] {
  return coins.filter((c) => !gaps.some(([a, b]) => c.createdTs < b && c.createdTs + horizonSec > a));
}

export function scoreResults(coins: BacktestCoin[], policy: ExitPolicy, pnls: number[]): PolicyScore {
  const total = pnls.reduce((a, b) => a + b, 0);
  const top2 = [...pnls].sort((a, b) => b - a).slice(0, 2);
  const active = pnls.filter((_, i) => coins[i]!.active);
  const dead = pnls.filter((_, i) => !coins[i]!.active);
  const meanActive = mean(active);
  const meanDead = mean(dead);
  const breakEven =
    meanActive === null || meanDead === null
      ? null
      : meanDead >= 0
        ? 0
        : meanActive <= meanDead
          ? null
          : -meanDead / (meanActive - meanDead);
  const buys = coins.map((c) => policy.devBuySol ?? c.launchBuySol);
  return {
    policy: policy.name,
    launches: pnls.length,
    meanPnl: mean(pnls),
    medianPnl: median(pnls),
    p05: quantile(pnls, 0.05),
    profitableShare: share(pnls.map((x) => x > 0)),
    totalPnl: total,
    totalWithoutTop2: total - top2.reduce((a, b) => a + Math.max(0, b), 0),
    meanActive,
    meanDead,
    activeShare: share(coins.map((c) => c.active)),
    breakEvenActiveShare: breakEven,
    meanPerSolBuy: mean(pnls.map((x, i) => x / buys[i]!)),
  };
}

/** Deterministic random numbers, so a backtest gives the same answer every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Mean of a - b over the same launches with a 90% bootstrap interval: the plan beats the benchmark beyond noise when
 * the whole interval is above zero.
 */
export function pairedDifference(a: number[], b: number[], iterations = 2000, seed = 7): { mean: number; lo: number; hi: number } | null {
  const d = a.map((x, i) => x - b[i]!);
  if (!d.length) return null;
  const rand = rng(seed);
  const means: number[] = [];
  for (let k = 0; k < iterations; k++) {
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[Math.floor(rand() * d.length)]!;
    means.push(s / d.length);
  }
  means.sort((x, y) => x - y);
  return { mean: d.reduce((x, y) => x + y, 0) / d.length, lo: means[Math.floor(0.05 * iterations)]!, hi: means[Math.floor(0.95 * iterations)]! };
}

/** Spearman rank correlation: do plans that did well in one period do well in the other? */
export function rankCorrelation(a: number[], b: number[]): number | null {
  if (a.length < 3) return null;
  const ranks = (xs: number[]) => {
    const order = xs.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(xs.length);
    order.forEach(([, i], k) => (r[i] = k));
    return r;
  };
  const ra = ranks(a);
  const rb = ranks(b);
  const n = a.length;
  const d2 = ra.reduce((s, r, i) => s + (r - rb[i]!) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}
