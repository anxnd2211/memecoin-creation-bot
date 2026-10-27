import { pairedDifference } from './sim/backtest.ts';

/**
 * Batch post-mortem: one question, where did the batch's profit gap come from, and what is the one thing to change.
 *
 * A batch's mean result minus what the playbook expected splits exactly into three parts:
 *   picking    (our hit rate - expected hit rate) x (expected busy result - expected dead result): too few (or more)
 *              of our launches drew buyers than other devs' launches made under the same rules;
 *   coins      our busy and dead launches, replayed under the playbook's exit, against other devs' busy and dead
 *              launches under it: the flow our coins drew once they drew any (narrative and design);
 *   execution  what we actually made minus that replay: late or failed sells, slippage, fees.
 * The exit itself is checked separately in hindsight (the best plan on this batch), and only flagged when it wins
 * beyond noise, because a plan picked on ten launches is noise until the daily backtest agrees.
 */

export interface LaunchOutcome {
  mint: string;
  symbol: string | null;
  /** What the launch made: wallet deltas live, simulated fills on paper, the recorded dev in shadow mode. */
  pnl: number;
  drew: boolean;
  /** The same coin replayed under the playbook's exit at standard latency. */
  planPnl: number;
  postAgeSec: number | null;
  firstOnPost: boolean | null;
}

/** Other devs' launches matching the playbook in the hours before the batch, under the playbook's exit. */
export interface Expectation {
  launches: number;
  hitRate: number;
  meanBusy: number;
  meanDead: number;
}

export interface PostMortem {
  launches: number;
  total: number;
  mean: number;
  expectedMean: number;
  hitRate: number;
  /** 90% Wilson interval of our hit rate. */
  hitRateLo: number;
  hitRateHi: number;
  gap: { picking: number; coins: number; execution: number };
  /** Best single plan on this batch in hindsight, against the playbook's exit; null when it does not win beyond noise. */
  exitHindsight: { plan: string; mean: number; lo: number; hi: number } | null;
  deadInARow: number;
  actions: string[];
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Wilson score interval (90%) for k successes in n. */
export function wilson(k: number, n: number, z = 1.645): [number, number] {
  if (!n) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - r) / d, (c + r) / d];
}

/**
 * `hindsight` maps plan names to their results on the batch's launches (same order); `pauseAfter` is the playbook's
 * dead-in-a-row limit.
 */
export function postMortem(
  batch: LaunchOutcome[],
  exp: Expectation,
  hindsight: Map<string, number[]>,
  pauseAfter: number,
): PostMortem {
  const n = batch.length;
  const hits = batch.filter((l) => l.drew).length;
  const h = n ? hits / n : 0;
  const [lo, hi] = wilson(hits, n);
  const busyPlan = avg(batch.filter((l) => l.drew).map((l) => l.planPnl));
  const deadPlan = avg(batch.filter((l) => !l.drew).map((l) => l.planPnl));
  const picking = (h - exp.hitRate) * (exp.meanBusy - exp.meanDead);
  const coins = (hits ? h * (busyPlan - exp.meanBusy) : 0) + (n - hits ? (1 - h) * (deadPlan - exp.meanDead) : 0);
  const execution = avg(batch.map((l) => l.pnl - l.planPnl));
  const expectedMean = exp.hitRate * exp.meanBusy + (1 - exp.hitRate) * exp.meanDead;

  const plan = batch.map((l) => l.planPnl);
  let exitHindsight: PostMortem['exitHindsight'] = null;
  let best: [string, number[]] | null = null;
  for (const [name, xs] of hindsight) if (!best || avg(xs) > avg(best[1])) best = [name, xs];
  if (best && n >= 2) {
    const d = pairedDifference(best[1], plan);
    if (d && d.lo > 0) exitHindsight = { plan: best[0], mean: avg(best[1]), lo: d.lo, hi: d.hi };
  }

  let deadInARow = 0;
  for (let i = n - 1; i >= 0 && !batch[i]!.drew; i--) deadInARow++;

  // At most three actions, biggest SOL gap first, each only when the evidence clears noise.
  const candidates: [number, string][] = [];
  if (hi < exp.hitRate) {
    const dead = batch.filter((l) => !l.drew);
    const slow = dead.filter((l) => l.postAgeSec !== null && l.postAgeSec > 30).length;
    const notFirst = dead.filter((l) => l.firstOnPost === false).length;
    candidates.push([
      -picking,
      `Picking: ${hits}/${n} launches drew buyers (90% ${pct(lo)}-${pct(hi)}) against ${pct(exp.hitRate)} for other devs ` +
        `under the same rules, ${fmt(picking)} SOL a launch. Of the ${dead.length} dead launches, ${slow} came over 30 s after ` +
        `the post and ${notFirst} were not first on it: cut the time from post to launch before changing anything else.`,
    ]);
  }
  if (coins < -0.25 && hits >= 3) {
    candidates.push([
      -coins,
      `Coins: our busy launches drew less flow than other devs' busy launches (${fmt(busyPlan)} vs ${fmt(exp.meanBusy)} SOL ` +
        `under the same exit), ${fmt(coins)} SOL a launch: compare their names, art and sources with the batch's winners.`,
    ]);
  }
  if (execution < -0.05) {
    candidates.push([
      -execution,
      `Execution: we made ${fmt(execution)} SOL a launch less than the plan replayed on the same coins: check sell ` +
        `latency, feed lag and slippage on the launches with the biggest shortfall.`,
    ]);
  }
  if (exitHindsight) {
    candidates.push([
      exitHindsight.lo,
      `Exit: "${exitHindsight.plan}" would have made ${fmt(exitHindsight.lo)} to ${fmt(exitHindsight.hi)} SOL a launch more ` +
        `on this batch. Run the daily backtest; change the exit only if it also wins there on held-out blocks.`,
    ]);
  }
  const actions = candidates.sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, s]) => s);
  if (deadInARow >= pauseAfter) {
    actions.unshift(`Pause: the last ${deadInARow} launches drew no buyers; the playbook stops launching until this review is done.`);
  }
  if (!actions.length) actions.push('No change: every gap is within noise. Keep the playbook and launch the next batch.');

  return {
    launches: n,
    total: batch.reduce((s, l) => s + l.pnl, 0),
    mean: avg(batch.map((l) => l.pnl)),
    expectedMean,
    hitRate: h,
    hitRateLo: lo,
    hitRateHi: hi,
    gap: { picking, coins, execution },
    exitHindsight,
    deadInARow,
    actions,
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const fmt = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;
